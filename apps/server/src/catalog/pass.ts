import type { CatalogState, SlotChannel, StreamDelta } from '@subify/shared/codec';
import type { ServerKeys } from '../crypto/keys';
import type { Statement } from '../db/db';
import type { Platform } from '../platform';
import type { SourceAdapter } from '../sources/source';
import { DAY, HOUR, MINUTE, retentionCutoff } from './schedule';
import { buildHandleIndex, type Handle } from './handles';
import { buildLots, lotDue, lotPosition, type LotThumbnail } from './lots';
import { PassRing, ringPositions } from './ring';
import { countHours, emptyHours, harvest, type Mention, packPool, POOL_ROWS } from './seed-pool';
import { FIRST_TABLE_SIZE, GROWTH_WINDOW, grownSize, type LotPlan, lotPlan, needsGrowth, passPeriod, type RingPlan, ringPlan, STREAM_ROWS, type StreamPlan, streamPlan } from './sizing';
import { deltasOf, PassStream } from './stream';
import { slotIdOf } from './slot-id';
import { hex, type PassBudget, tend } from './tend';
import { enqueueUpdate, openUpdates, type Update } from './updates';
import { batchWrite, caseWrite, clearSlots, handleIndexWrites, lotWrite, readHandleBounds, decoyId, decoyInserts, readCases, readHours, readPool, readSlots, seedingWrites, readState, type Slot, slotReplace, slotWrite, stateWrite } from './vault';

/**
 * The pass (docs/FEATURES.md, D16): every few minutes, every slot of the encrypted catalog is
 * read and written back under a fresh nonce, whether it changed or not, so that two snapshots of
 * the database never tell which rows changed. On the way, it applies the updates that waited in
 * the coordinator, enters new channels in place of decoys drawn at random, polls the channels
 * whose turn has come, renews WebSub subscriptions, applies retention and removes channels gone
 * for good. It is the only code that writes the encrypted catalog.
 */

/** Slots read at a time: about 4 MB, far under D1’s 50 MB per result, and under a Worker’s 128 MB once sealed again. */
const READ_CHUNK = 100;
/** Writes per batch: about 2 MB, so that a batch stays well within D1's 30 seconds. */
const WRITE_BATCH = 50;
/** Updates applied per pass; the rest wait for the next one. */
const MAX_UPDATES = 1_000;
/** WebSub (re)subscriptions per 5 minutes of period. */
const RENEWALS_PER_5_MINUTES = 3;

export interface PassOptions {
  /** The table's first size. Tests start smaller than the real 2,500 slots. */
  firstTableSize?: number;
  /** The thumbnail ring's size. Tests take a small one, to see it wrap. */
  ring?: RingPlan;
  /** The stream's shape. Tests take a small one, to see a batch fill up. */
  stream?: StreamPlan;
  /** The seed pool's rows. Tests take fewer: each is 40 KB to seal at every pass. */
  poolRows?: number;
  /** The thumbnail lots' shape. Tests take a small one, to see a lot fill up. */
  lots?: LotPlan;
}

/**
 * The scheduled task, every minute: runs the pass when its period comes round.
 */
export async function runPassIfDue(platform: Platform, sources: readonly SourceAdapter[] = [], options: PassOptions = {}): Promise<boolean> {
  const keys = await platform.keys;
  const state = await readState(platform.db, keys);

  if (state !== undefined && Math.floor(platform.clock.now() / MINUTE) % (periodOf(state.tableSize) / MINUTE) !== 0) {
    return false;
  }

  await runPass(platform, keys, state, options, sources);

  return true;
}

/**
 * The time between two passes, from the rows each writes: every slot, the state row, seeding's
 * rows, the stream's batch, the ring's cases and its share of the hour's thumbnail lots. The ring's
 * and the lots' shares depend on the period, hence two steps.
 */
export function periodOf(tableSize: number): number {
  // Every slot, the state row, seeding's rows and the stream's batch.
  const rows = tableSize + 1 + 1 + POOL_ROWS + 1;
  const first = passPeriod({ rowsPerPass: rows });
  const lots = Math.ceil((lotPlan({ slots: tableSize }).groups * first) / HOUR);

  return passPeriod({ rowsPerPass: rows + ringPlan({ slots: tableSize, period: first }).perPass + lots });
}

export async function runPass(
  platform: Platform,
  keys: ServerKeys,
  current: CatalogState | undefined,
  options: PassOptions = {},
  sources: readonly SourceAdapter[] = [],
): Promise<CatalogState> {
  const { db } = platform;
  const now = platform.clock.now();

  if (current === undefined) {
    // A new catalog starts as decoys only: its first size says nothing about its users. In several
    // batches: slots a failed start left are cleared first, and the state row comes last.
    const state: CatalogState = { tableSize: options.firstTableSize ?? FIRST_TABLE_SIZE, passes: 0, growthDueAt: null, feedsAnswered: false, ringNext: 0, channels: 0 };
    await db.batch(clearSlots());
    await addDecoys(platform, keys, state.tableSize);
    await db.run(await stateWrite(keys, state, true));

    return state;
  }

  const period = periodOf(current.tableSize);
  const pending = await platform.coordinator.pending(MAX_UPDATES);
  const { opened, broken } = await openUpdates(keys, pending);
  const waiting = new Map<string, { id: Uint8Array; updates: Update[]; keys: string[] }>();
  const streamShape = options.stream ?? streamPlan({ slots: current.tableSize, period });
  const stream = new PassStream(streamShape, current.passes + 1);
  const mentions: Mention[] = [];
  const handles: Handle[] = [];
  const keep = (channel: SlotChannel) => {
    if (channel.handle !== null) {
      handles.push({ source: channel.source, externalId: channel.externalId, handle: channel.handle });
    }
  };
  const forgotten: Mention[] = [];
  const additions: number[] = [];
  const lotted: { key: string; update: Extract<Update, { kind: 'lot' }> }[] = [];

  for (const { key, update } of opened) {
    if (update.kind === 'lot') {
      lotted.push({ key, update });
      continue;
    }

    if (update.kind === 'forget') {
      forgotten.push(update);
      continue;
    }

    if (update.kind === 'added') {
      additions.push(update.at);
      continue;
    }

    // Changes a batch had no room for go first, before this pass's.
    if (update.kind === 'delta') {
      stream.add(update.source, update.externalId, update.deltas);
      continue;
    }

    const channel = update.kind === 'channel' ? update.channel : update;
    const id = await slotIdOf(keys, channel.source, channel.externalId);
    const entry = waiting.get(hex(id)) ?? { id, updates: [], keys: [] };
    entry.updates.push(update);
    entry.keys.push(key);
    waiting.set(hex(id), entry);
  }

  const budget: PassBudget = {
    polls: platform.config.pollBatchSize * (period / MINUTE),
    renewals: Math.max(1, Math.round((RENEWALS_PER_5_MINUTES * period) / (5 * MINUTE))),
    succeeded: 0,
    attempted: 0,
    answeredBefore: current.feedsAnswered,
  };
  const plan = options.ring ?? ringPlan({ slots: current.tableSize, period });
  const backlog = opened.filter(({ update }) => update.kind === 'thumbnail').length;
  const ring = new PassRing(plan, current.ringNext, await readCases(db, keys, ringPositions(plan, current.ringNext)), backlog);
  const context = { platform, sources, now, cutoff: retentionCutoff(platform), budget, ring, mentions };
  const decoys: Uint8Array[] = [];
  const gone: Uint8Array[] = [];
  let occupied = 0;
  let after: Uint8Array | null = null;

  for (;;) {
    const slots: Slot[] = await readSlots(db, keys, after, READ_CHUNK);

    if (slots.length === 0) {
      break;
    }

    const written: Slot[] = [];

    for (const slot of slots) {
      if (slot.payload.kind === 'empty') {
        decoys.push(slot.id);
        written.push(slot);
        continue;
      }

      const entry = waiting.get(hex(slot.id));
      waiting.delete(hex(slot.id));
      const next = await tend(slot.payload, entry?.updates ?? [], context);
      stream.add(slot.payload.source, slot.payload.externalId, deltasOf(slot.payload, next));

      if (next === null) {
        gone.push(slot.id);
        written.push(slot);
      } else {
        occupied++;
        keep(next);
        written.push({ id: slot.id, payload: next });
      }
    }

    await writeAll(platform, await Promise.all(written.map((slot) => slotWrite(keys, slot))));
    after = slots.at(-1)!.id;
  }

  // Channels new to the table, each in place of a decoy drawn at random. Without a decoy left, they
  // wait in the coordinator for the growth step.
  const deferred: string[] = [];
  const replacements: Statement[] = [];
  // A channel that just entered was read online moments ago: it isn't polled again now.
  budget.polls = 0;
  shuffle(decoys, platform.random);

  for (const { id, updates, keys: updateKeys } of waiting.values()) {
    const entering = updates.find((update): update is Extract<Update, { kind: 'channel' }> => update.kind === 'channel');

    // Updates for a channel the table doesn't have, and isn't getting: nothing to apply them to.
    if (entering === undefined) {
      continue;
    }

    const decoy = decoys.pop();

    if (decoy === undefined) {
      deferred.push(...updateKeys);
      continue;
    }

    const read = new Map((entering.thumbnails ?? []).map(({ itemId, image, preview }) => [itemId, { image, preview: preview ?? null }]));
    const channel: SlotChannel = (await tend(entering.channel, updates.filter((update) => update !== entering), context, true, read)) ?? entering.channel;
    replacements.push(...(await slotReplace(keys, decoy, { id, payload: channel })));
    occupied++;
    keep(channel);
    mentions.push(...(entering.mentions ?? []).map((input) => ({ source: channel.source, input })));
    // A candidate left behind next to its channel would tell that a user added it.
    forgotten.push({ source: channel.source, input: { kind: 'channel', externalId: channel.externalId } });

    if (channel.handle !== null) {
      forgotten.push({ source: channel.source, input: { kind: 'handle', handle: channel.handle } });
    }
  }

  // A channel gone for good leaves a decoy under a new id: its old id would tell it was there.
  for (const id of gone) {
    replacements.push(...(await slotReplace(keys, id, { id: decoyId(), payload: { kind: 'empty' } })));
  }

  await writeAll(platform, replacements);
  const cases = ring.cases();
  await writeAll(platform, await Promise.all(cases.map(([position, payload]) => caseWrite(keys, position, payload))));

  // The hour's thumbnail lots, at its first pass: what waited, the oldest first, then this pass's.
  // At the other passes, this pass's thumbnails join those waiting.
  const placedNow = ring.placed.map(({ source, externalId, itemId, position }) => ({ source, externalId, itemId, position }));

  if (lotDue(now, period)) {
    const held = new Map([...(await readCases(db, keys, lotted.map(({ update }) => update.position))), ...cases]);
    const thumbnails: LotThumbnail[] = [...lotted.map(({ update }) => update), ...placedNow].flatMap((ref) => {
      const payload = held.get(ref.position);

      // The ring may have wrapped over it since.
      return payload?.kind === 'thumbnail' && payload.itemId === ref.itemId ? [{ ...ref, image: payload.image }] : [];
    });
    const lotsPlan = options.lots ?? { ...lotPlan({ slots: current.tableSize }), groups: streamShape.groups };
    const hour = Math.floor(now / HOUR);
    const built = await buildLots(keys, lotsPlan, hour, thumbnails, () => platform.random());
    await writeAll(platform, await Promise.all(built.lots.map((lot, group) => lotWrite(keys, lotPosition(hour, group), lot))));

    for (const { source, externalId, itemId, position } of built.waiting) {
      await enqueueUpdate(platform.coordinator, keys, { kind: 'lot', source, externalId, itemId, position });
    }
  } else {
    deferred.push(...lotted.map(({ key }) => key));

    for (const ref of placedNow) {
      await enqueueUpdate(platform.coordinator, keys, { kind: 'lot', ...ref });
    }
  }

  // A channel entering has no delta: the device that added it got it in the answer.
  const { batch, waiting: overflow } = await stream.build(keys, () => platform.random());
  await db.run(await batchWrite(keys, batch.pass % STREAM_ROWS, batch));

  const leftByChannel = new Map<string, { source: string; externalId: string; deltas: StreamDelta[] }>();

  for (const { source, externalId, delta } of overflow) {
    const key = `${source}:${externalId}`;
    const left = leftByChannel.get(key) ?? { source, externalId, deltas: [] };
    left.deltas.push(delta);
    leftByChannel.set(key, left);
  }

  for (const left of leftByChannel.values()) {
    await enqueueUpdate(platform.coordinator, keys, { kind: 'delta', ...left });
  }

  // The handle index, once an hour, and at the first pass that finds none. Its size depends on the
  // table's alone, so this write tells nothing either.
  if ((current.passes + 1) % Math.max(1, Math.round(HOUR / period)) === 0 || (await readHandleBounds(db, keys)) === undefined) {
    const index = await buildHandleIndex(keys, handles, current.tableSize);
    await writeAll(platform, await handleIndexWrites(keys, index.chunks, index.bounds));
  }

  const today = Math.floor(now / DAY);
  const [hours, pool] = await Promise.all([readHours(db, keys), readPool(db, keys)]);
  await writeAll(platform, await seedingWrites(keys, countHours(hours ?? emptyHours(today), additions, today), packPool(harvest(pool, mentions, forgotten, today), options.poolRows)));

  for (const thumbnail of ring.waiting) {
    await enqueueUpdate(platform.coordinator, keys, { kind: 'thumbnail', ...thumbnail });
  }

  const state = { ...current, passes: current.passes + 1, ringNext: ring.next, channels: occupied, feedsAnswered: budget.attempted === 0 ? current.feedsAnswered : budget.succeeded > 0 };

  // Growth: due at a random time within GROWTH_WINDOW after the table is half full, so that the
  // step doesn't tell when exactly the threshold was crossed.
  if (state.growthDueAt === null && needsGrowth(occupied, state.tableSize)) {
    state.growthDueAt = now + Math.floor(platform.random() * GROWTH_WINDOW);
  }

  if (state.growthDueAt !== null && state.growthDueAt <= now) {
    const grown = grownSize(state.tableSize);
    await addDecoys(platform, keys, grown - state.tableSize);
    state.tableSize = grown;
    state.growthDueAt = null;
  }

  await db.run(await stateWrite(keys, state, false));

  const deferredKeys = new Set(deferred);
  await platform.coordinator.remove([...pending.map((update) => update.key).filter((key) => !deferredKeys.has(key)), ...broken]);

  // On Node, the SQLite file is rewritten once a day, so that its layout keeps no trace of the
  // order rows were inserted in. D1 manages its own storage.
  if (db.compact !== undefined && state.passes % Math.round(DAY / periodOf(state.tableSize)) === 0) {
    await db.compact();
  }

  return state;
}

/** A batch at a time: sealed blobs are built only as they are written, within a Worker's 128 MB. */
async function addDecoys(platform: Platform, keys: ServerKeys, count: number): Promise<void> {
  for (let done = 0; done < count; done += WRITE_BATCH) {
    await platform.db.batch(await decoyInserts(keys, Math.min(WRITE_BATCH, count - done)));
  }
}

async function writeAll(platform: Platform, statements: readonly Statement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += WRITE_BATCH) {
    await platform.db.batch(statements.slice(i, i + WRITE_BATCH));
  }
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
}
