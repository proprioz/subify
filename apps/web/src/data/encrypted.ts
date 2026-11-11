import { type ApiChannel, type ApiItem, BLIND_BATCH_SIZES, ENTRY_DELAY, type OprfKeyResponse, STREAM_KEPT_PASSES } from '@subify/shared';
import {
  chunkOf,
  fromBase64Url,
  openEntries,
  openHandleEntry,
  openLot,
  openSnapshotEntry,
  openSnapshotThumbnails,
  type SlotImage,
  type SnapshotChannel,
  type StreamDelta,
  snapshotChannelCodec,
  thumbnailCodec,
  toBase64Url,
} from '@subify/shared/codec';
import { type Api, ServerError } from './api';
import { itemUrl } from './channel-link';
import type { OnStep } from './subscriptions';
import { getMeta, putItems, setRetryAt, type Slot, type StoredThumbnail, type Subscription, type SubifyDb, setMeta } from './db';
import { keepsThumbnail, loadThumbnailKeep } from './thumbnails';

/**
 * The app on a server with the encrypted catalog (docs/FEATURES.md, D16). It finds its channels
 * without naming them: a blind evaluation gives each one's slot and key, and it then downloads
 * whole groups (snapshots and the sync stream) and opens only its own entries. A channel is named
 * to the server only when the catalog doesn't have it, through POST /api/add.
 */

export type CatalogKey = OprfKeyResponse;

/** The VOPRF code, loaded only once the app needs it. */
const oprf = () => import('@subify/shared/oprf');

/** A channel found online, kept in memory until the user follows it. */
export interface NewChannel {
  channel: ApiChannel;
  items: ApiItem[];
  /** See Subscription.retryAt. */
  retryAt: number | null;
  /** Where following it starts the sync: a pass of the stream, or nothing to start from. */
  start: { pass: number } | null;
  slot?: Slot;
  thumbnails: Omit<StoredThumbnail, 'channel'>[];
}

/** Slots of these VOPRF inputs, in batches padded with random inputs to an allowed size. */
async function evaluate(api: Api, catalog: CatalogKey, inputs: readonly Uint8Array[]): Promise<Slot[]> {
  const { blind, channelSecrets, finalize } = await oprf();
  const largest = BLIND_BATCH_SIZES.at(-1)!;
  const slots: Slot[] = [];

  for (let i = 0; i < inputs.length; i += largest) {
    const chunk = inputs.slice(i, i + largest);
    const size = BLIND_BATCH_SIZES.find((allowed) => allowed >= chunk.length)!;
    const request = blind([...chunk, ...Array.from({ length: size - chunk.length }, () => crypto.getRandomValues(new Uint8Array(32)))]);
    const answer = await api.evaluate(request.blinded.map(toBase64Url));
    // Throws when the proof doesn't match the published key: such an answer would give wrong slots.
    const outputs = finalize(request, { evaluated: answer.evaluated.map(fromBase64Url), proof: fromBase64Url(answer.proof) }, fromBase64Url(catalog.publicKey));

    for (const output of outputs.slice(0, chunk.length)) {
      const secrets = await channelSecrets(output);
      slots.push({ keyId: catalog.keyId, id: secrets.slotId, key: secrets.transitKey });
    }
  }

  return slots;
}

/** Computes the slots the followed channels lack, or have under an older key. */
export async function ensureSlots(db: SubifyDb, api: Api, catalog: CatalogKey): Promise<void> {
  const { channelInput } = await oprf();
  const missing = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot?.keyId !== catalog.keyId);

  if (missing.length === 0) {
    return;
  }

  const slots = await evaluate(api, catalog, missing.map((subscription) => channelInput(subscription.source, externalId(subscription.key))));

  await db.transaction('rw', db.subscriptions, async () => {
    for (const [i, subscription] of missing.entries()) {
      await db.subscriptions.update(subscription.key, { slot: slots[i]! });
    }
  });
}

/**
 * A channel the catalog has, by its key or by the first of these @handles the handle index knows
 * (a handle typed, or those a name gives), or null. Two blind evaluations for handles.
 */
export async function findInCatalog(
  api: Api,
  catalog: CatalogKey,
  input: { key: string } | { handles: readonly string[] },
  onStep: OnStep = () => {},
): Promise<NewChannel | null> {
  const { channelInput, handleInput } = await oprf();
  let key: string;

  if ('key' in input) {
    key = input.key;
  } else {
    if (input.handles.length === 0) {
      return null;
    }

    onStep({ kind: 'blind', inputs: input.handles.length });
    const entries = await evaluate(api, catalog, input.handles.map((handle) => handleInput('youtube', handle)));
    const found = await readHandles(api, entries, onStep);

    if (found === null) {
      return null;
    }

    key = `${found.source}:${found.externalId}`;
  }

  onStep({ kind: 'blind', inputs: 1 });
  const [slot] = await evaluate(api, catalog, [channelInput(key.slice(0, key.indexOf(':')), externalId(key))]);
  onStep({ kind: 'group' });
  const found = await readSnapshots(api, [slot!]);
  const channel = found.channels.get(hexOf(slot!.id));

  if (channel === undefined) {
    return null;
  }

  const converted = toApi(channel);
  // The same group again, for its thumbnails: an addition asks for them as a restore does.
  const thumbnails = await groupThumbnailsOf(api, slot!, found.groups);

  return { ...converted, start: { pass: found.pass }, slot: slot!, thumbnails: thumbnailsOf(converted.channel.key, thumbnails) };
}

/**
 * The channel the first of these handles' entries leads to in the handle index, with that entry's
 * place, or null. The chunks read are those of the entries when they all fall in one, else every
 * chunk: the set of chunks a name's guesses fall in would point the server to the name.
 */
async function readHandles(api: Api, entries: readonly Slot[], onStep: OnStep): Promise<{ source: string; externalId: string; at: number } | null> {
  try {
    const bounds = (await api.handleBounds()).chunks.map(fromBase64Url);
    const wanted = new Set(entries.map((entry) => chunkOf(bounds, entry.id)));
    const read = wanted.size === 1 ? [...wanted] : bounds.map((_, chunk) => chunk);
    const chunks = new Map<number, Uint8Array>();

    for (const [index, chunk] of read.entries()) {
      onStep({ kind: 'handles', chunk: index + 1, chunks: read.length });
      chunks.set(chunk, fromBase64Url((await api.handleChunk(chunk)).entries));
    }

    for (const [at, entry] of entries.entries()) {
      const target = await openHandleEntry(entry.id, entry.key, chunks.get(chunkOf(bounds, entry.id))!);

      if (target !== null) {
        return { ...target, at };
      }
    }

    return null;
  } catch (error) {
    // No index yet: the server's first hourly build hasn't run.
    if (error instanceof ServerError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

/**
 * The channel one of these handles names in the catalog, found blindly in the handle index, with
 * the handle that found it; null when none does. Lighter than findInCatalog: it reads no group,
 * so a name's guesses can be looked up as the name is typed, and following the channel reads its group.
 */
export async function findHandle(api: Api, catalog: CatalogKey, handles: readonly string[]): Promise<{ key: string; handle: string } | null> {
  if (handles.length === 0) {
    return null;
  }

  const { handleInput } = await oprf();
  const found = await readHandles(api, await evaluate(api, catalog, handles.map((handle) => handleInput('youtube', handle))), () => {});

  return found === null ? null : { key: `${found.source}:${found.externalId}`, handle: handles[found.at]! };
}

/** Adds a channel by link the clear way: the server reads it online if the catalog doesn't have it. */
export async function addByLink(api: Api, url: string): Promise<NewChannel> {
  const answer = await api.add(url);
  const converted = toApi(snapshotChannelCodec.decode(fromBase64Url(answer.channel)));
  const cases = fromBase64Url(answer.thumbnails);
  const images = new Map<string, SlotImage>();

  for (let at = 0; at < cases.length; at += thumbnailCodec.size) {
    const payload = thumbnailCodec.decode(cases.subarray(at, at + thumbnailCodec.size));

    if (payload.kind === 'thumbnail') {
      images.set(payload.itemId, payload.image);
    }
  }

  return { ...converted, start: null, thumbnails: thumbnailsOf(converted.channel.key, images) };
}

interface Snapshots {
  /** By slot id in hex: the channels found. */
  channels: Map<string, SnapshotChannel>;
  /** The earliest pass among the snapshots read: the stream continues from there. */
  pass: number;
  /** The grouping the snapshots were read with. */
  groups: number;
}

/**
 * These slots by snapshot group, the groups in ascending order: the order a device reads them in
 * says nothing about its channels, only their set does.
 */
async function byGroup(slots: readonly Slot[], groups: number): Promise<[number, Slot[]][]> {
  const { groupOf } = await oprf();
  const members = new Map<number, Slot[]>();
  slots.forEach((slot) => members.set(groupOf(slot.id, groups), [...(members.get(groupOf(slot.id, groups)) ?? []), slot]));

  return [...members].sort(([a], [b]) => a - b);
}

/**
 * Reads the snapshots of every group these slots are in, each group once, a few at a time. The
 * number of groups comes from the server's answer: when it changed since the last time, the
 * groups are worked out again.
 */
async function readSnapshots(api: Api, slots: readonly Slot[], knownGroups = 1): Promise<Snapshots> {
  const found: Snapshots = { channels: new Map(), pass: Infinity, groups: knownGroups };
  const groups = await byGroup(slots, knownGroups);
  const answers = await inParallel(groups, PARALLEL, async ([group]) => api.snapshot(group));
  const regrouped = answers.find((answer) => answer.groups !== knownGroups);

  if (regrouped !== undefined) {
    return readSnapshots(api, slots, regrouped.groups);
  }

  for (const [i, [, members]] of groups.entries()) {
    const answer = answers[i]!;
    const entries = fromBase64Url(answer.entries);
    found.pass = Math.min(found.pass, answer.pass);

    for (const slot of members) {
      const channel = await openSnapshotEntry(slot.id, slot.key, entries);

      if (channel !== null) {
        found.channels.set(hexOf(slot.id), channel);
      }
    }
  }

  return found;
}

/** One channel's thumbnails of the last 7 days, from its whole group's (an addition). */
async function groupThumbnailsOf(api: Api, slot: Slot, knownGroups: number): Promise<Map<string, SlotImage>> {
  const [[group]] = await byGroup([slot], knownGroups) as [[number, Slot[]]];
  const answer = await api.snapshotThumbnails(group);

  return answer.groups !== knownGroups ? groupThumbnailsOf(api, slot, answer.groups) : openSnapshotThumbnails(slot.key, answer.pass, fromBase64Url(answer.fragments));
}

/**
 * The groups' thumbnails a catch-up from snapshots still has to read: those of every group whose
 * snapshot it read (see syncGroupThumbnails), with the grouping they were read with.
 */
interface GroupThumbnailsRun {
  groups: number;
  wanted: number[];
  done: number[];
  /** The earliest hour the answers gave so far: the thumbnail lots up to it hold nothing more. */
  latest: number | null;
}

/**
 * Waits this long after adding a channel before resubmitting it for a missing slot: it enters
 * within ENTRY_DELAY, at the pass after its time.
 */
const SLOT_GRACE = ENTRY_DELAY + 60 * 60_000;

/**
 * Fills the followed channels from their groups' snapshots: after a restore, at the first refresh
 * on this server, or after a longer absence than the stream keeps. A channel the catalog lacks
 * goes back to the import queue (the safety net), unless it is gone or was added in clear within
 * SLOT_GRACE.
 * Sets the stream's cursor when it has none, or is past what the snapshots show.
 *
 * With `thumbnails`, the next step of the refresh reads the thumbnails of the same groups, all of
 * them (see syncGroupThumbnails): the channels show at once, blurred, and sharpen as they come.
 * Whether it does depends on the gesture only (a restore, a return), never on what the device has.
 */
export async function catchUp(db: SubifyDb, api: Api, catalog: CatalogKey, now = Date.now(), thumbnails = false): Promise<{ found: number }> {
  await ensureSlots(db, api, catalog);
  const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');
  const slots = subscriptions.map((subscription) => subscription.slot!);
  const snapshots = await readSnapshots(api, slots);
  const read = thumbnails ? (await byGroup(slots, snapshots.groups)).map(([group]) => group) : [];
  let found = 0;

  await db.transaction('rw', db.subscriptions, db.items, db.meta, async () => {
    for (const subscription of subscriptions) {
      const channel = snapshots.channels.get(hexOf(subscription.slot!.id));

      if (channel !== undefined) {
        const converted = toApi(channel);
        await db.subscriptions.update(subscription.key, (stored) => {
          Object.assign(stored, { title: converted.channel.title, handle: converted.channel.handle, avatar: converted.channel.avatar, status: 'ready' });
          delete stored.submittedAt;
          setRetryAt(stored, converted.retryAt);
        });
        await putItems(db, converted.items);
        found++;
      } else if (subscription.status === 'ready' && (subscription.submittedAt ?? 0) < now - SLOT_GRACE) {
        await db.subscriptions.update(subscription.key, { status: 'pending_submit' });
      }
    }

    if (subscriptions.length > 0) {
      await setMeta(db, 'streamPass', snapshots.pass);
      // The snapshots show where every channel stands: a sync cut short has nothing left to read.
      await db.meta.delete('streamRun');
    }

    if (read.length > 0) {
      await setMeta(db, 'groupThumbnails', { groups: snapshots.groups, wanted: read, done: [], latest: null } satisfies GroupThumbnailsRun);
    }
  });

  return { found };
}

/** A `since` past any pass the stream will reach: the answer gives `latest` alone. */
const LATEST_ONLY = 999_999_999;

/** Groups asked for at once, for each page. */
const PARALLEL = 6;

/**
 * The cursor a sync reads from is rounded down to a multiple of this many passes, 12 hours at the
 * 10-minute period: every device whose last refresh fell in the same 12 hours sends the same
 * `since`, so it doesn't tie two refreshes of a device together. The passes read again change
 * nothing, since an older change is skipped.
 */
const SINCE_STEP = 72;

/**
 * A sync under way, kept so that one cut short resumes where it stopped: it has read the passes in
 * (below, top], newest first; those in (streamPass, below] are left.
 */
interface StreamRun {
  top: number;
  below: number;
  /** Batches per answer, as the server pages them. */
  page: number;
}

/** Whether a sync started before was cut short, the app closed meanwhile: the user may resume it. */
export async function unfinishedSync(db: SubifyDb): Promise<boolean> {
  return (
    (await getMeta<StreamRun>(db, 'streamRun')) !== undefined ||
    (await getMeta<GroupThumbnailsRun>(db, 'groupThumbnails')) !== undefined ||
    (await getMeta<boolean>(db, 'lotsRun')) === true
  );
}

/**
 * Brings the followed channels up to date from the sync stream, newest first: it learns the latest
 * pass, then reads its groups' pages back from there to the last pass it has, so the feed shows
 * the latest videos first after a long absence. Each page is written in one transaction with where
 * the sync stands, so an app suspended mid-sync (iOS does that) resumes where it stopped, without a
 * duplicate or a gap. A change older than one already written for the same item or channel is
 * skipped. Without a cursor, or further behind than the stream keeps, it catches up from snapshots
 * instead, as it does once a channel added in clear should have entered the catalog (SLOT_GRACE). `onProgress` gets the share of
 * the passes read, from 0 to 1.
 */
export async function syncStream(db: SubifyDb, api: Api, catalog: CatalogKey, now = Date.now(), onProgress: (share: number) => void = () => {}): Promise<{ written: number }> {
  const { groupOf } = await oprf();
  await ensureSlots(db, api, catalog);
  let written = 0;
  const unchecked = (await db.subscriptions.toArray()).some((subscription) => subscription.status === 'ready' && subscription.submittedAt !== undefined && subscription.submittedAt < now - SLOT_GRACE);

  // A channel added in clear over SLOT_GRACE ago should be in the catalog by now: the snapshots tell.
  if (unchecked && (await getMeta<number>(db, 'streamPass')) !== undefined) {
    await catchUp(db, api, catalog, now);
  }

  for (;;) {
    const since = await getMeta<number>(db, 'streamPass');
    const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');

    if (subscriptions.length === 0) {
      await db.meta.delete('streamRun');

      return { written };
    }

    if (since === undefined) {
      await catchUp(db, api, catalog, now, true);
      continue;
    }

    const start = since - (since % SINCE_STEP);
    let run = await getMeta<StreamRun>(db, 'streamRun');

    if (run === undefined) {
      const latest = await api.stream(LATEST_ONLY, 0);
      await setMeta(db, 'streamGroups', latest.groups);

      // A catalog started over, or further behind than the stream keeps: snapshots tell the rest.
      if (latest.latest < since || start + 1 <= latest.latest - STREAM_KEPT_PASSES) {
        await catchUp(db, api, catalog, now, true);
        continue;
      }

      if (latest.latest === since) {
        onProgress(1);

        return { written };
      }

      run = { top: latest.latest, below: latest.latest, page: latest.page };
      await setMeta(db, 'streamRun', run);
    }

    onProgress((run.top - run.below) / (run.top - start));
    const from = Math.max(start, run.below - run.page);
    const groups = (await getMeta<number>(db, 'streamGroups')) ?? 1;
    const wanted = [...new Set(subscriptions.map((subscription) => groupOf(subscription.slot!.id, groups)))];
    const pages = await inParallel(wanted, PARALLEL, async (group) => ({ group, page: await api.stream(from, group) }));
    const regrouped = pages.find(({ page }) => page.groups !== groups);

    if (regrouped !== undefined) {
      await setMeta(db, 'streamGroups', regrouped.page.groups);
      continue;
    }

    if (pages.some(({ page }) => page.expired || page.latest < from)) {
      await catchUp(db, api, catalog, now, true);
      continue;
    }

    const changes: { subscription: Subscription; pass: number; deltas: StreamDelta[] }[] = [];

    for (const { group, page } of pages) {
      for (const subscription of subscriptions.filter((candidate) => groupOf(candidate.slot!.id, groups) === group)) {
        // Passes after `below` were read already: the page may reach past it on its last range.
        for (const batch of page.batches.filter((candidate) => candidate.pass <= run.below)) {
          const deltas = await openEntries(subscription.slot!.key, batch.pass, fromBase64Url(batch.entries));

          if (deltas.length > 0) {
            changes.push({ subscription, pass: batch.pass, deltas });
          }
        }
      }
    }

    const done = from === start;

    await db.transaction('rw', db.subscriptions, db.items, db.meta, async () => {
      for (const { subscription, pass, deltas } of changes) {
        // A channel removed while the page was on its way must not get its items back.
        if ((await db.subscriptions.get(subscription.key)) !== undefined) {
          written += await apply(db, subscription, pass, deltas);
        }
      }

      if (done) {
        await setMeta(db, 'streamPass', run.top);
        await db.meta.delete('streamRun');
      } else {
        await setMeta(db, 'streamRun', { ...run, below: from });
      }
    });

    if (done) {
      onProgress(1);

      return { written };
    }
  }
}

/** Applies one pass's changes of a channel, but not over a change from a later pass, read before. */
async function apply(db: SubifyDb, subscription: Subscription, pass: number, deltas: readonly StreamDelta[]): Promise<number> {
  const items: (ApiItem & { preview?: Uint8Array })[] = [];

  for (const delta of deltas) {
    switch (delta.kind) {
      case 'item': {
        const item = { ...toApiItem(subscription.key, delta), ...(delta.preview === null ? {} : { preview: delta.preview }) };

        if (((await db.items.get(item.key))?.pass ?? -1) < pass) {
          items.push(item);
        }

        break;
      }
      case 'channel':
        if (((await db.subscriptions.get(subscription.key))?.renamedAt ?? -1) < pass) {
          await db.subscriptions.update(subscription.key, { title: delta.title, handle: delta.handle, renamedAt: pass });
        }

        break;
      case 'gone':
        await db.subscriptions.update(subscription.key, { status: 'gone' });
        break;
      case 'retry':
        await db.subscriptions.update(subscription.key, (stored) => {
          if ((stored.retryPass ?? -1) < pass) {
            setRetryAt(stored, delta.retryAt);
            stored.retryPass = pass;
          }
        });
        break;
    }
  }

  await putItems(db, items, pass);

  return items.length;
}

/** Hours of thumbnail lots the server keeps: a device catches up on a week at most (docs/FEATURES.md, D3). */
const LOT_HOURS = 7 * 24;

/** Which hours' lots the device has read, for the stream's grouping it read them with. */
interface LotsRead {
  groups: number;
  /** By group: the hours read, within the last week. */
  hours: Record<number, number[]>;
}

/**
 * Downloads the thumbnails the followed channels lack, after the stream (docs/FEATURES.md, D3):
 * those of the groups a catch-up read, if one did, then the hourly lots. `onProgress` gets the
 * share done, from 0 to 1.
 */
export async function syncThumbnails(db: SubifyDb, api: Api, now = Date.now(), onProgress: (share: number) => void = () => {}): Promise<{ written: number }> {
  // After a catch-up from snapshots, its groups' thumbnails first: they cover most of the week of lots.
  const pending = (await getMeta<GroupThumbnailsRun>(db, 'groupThumbnails')) !== undefined;
  const fromGroups = pending ? await syncGroupThumbnails(db, api, now, (share) => onProgress(share * 0.9)) : 0;
  const lots = await syncLots(db, api, now, (share) => onProgress(pending ? 0.9 + share * 0.1 : share));

  return { written: fromGroups + lots.written };
}

/**
 * Reads the thumbnails of the last 7 days of every group a catch-up read the snapshot of, a few
 * at a time, each answer written in one transaction with the groups done, so a refresh cut short
 * resumes where it stopped. Every group is read, even one the device expects nothing from: the
 * server knows what each group published, and a group skipped would tell which channels the
 * device lacks. Once all are read, the lots up to then are skipped: they hold nothing more.
 */
async function syncGroupThumbnails(db: SubifyDb, api: Api, now: number, onProgress: (share: number) => void): Promise<number> {
  const { groupOf } = await oprf();
  const run = (await getMeta<GroupThumbnailsRun>(db, 'groupThumbnails'))!;
  const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');
  const left = run.wanted.filter((group) => !run.done.includes(group));
  let regrouped: number | null = null;
  let written = 0;

  onProgress(run.done.length / run.wanted.length);
  await inParallel(left, PARALLEL, async (group) => {
    const answer = await api.snapshotThumbnails(group);

    if (answer.groups !== run.groups) {
      regrouped = answer.groups;

      return;
    }

    const fragments = fromBase64Url(answer.fragments);
    const images = new Map<string, SlotImage>();

    for (const subscription of subscriptions.filter((candidate) => groupOf(candidate.slot!.id, run.groups) === group)) {
      for (const [id, image] of await openSnapshotThumbnails(subscription.slot!.key, answer.pass, fragments)) {
        images.set(`${subscription.source}:${id}`, image);
      }
    }

    await db.transaction('rw', db.items, db.thumbnails, db.meta, async () => {
      written += await putThumbnails(db, images, now);
      run.done.push(group);
      run.latest = Math.min(run.latest ?? Infinity, answer.latest);
      await setMeta(db, 'groupThumbnails', run);
    });
    onProgress(run.done.length / run.wanted.length);
  });

  // The table grew meanwhile: the device's groups, in the new grouping, from the start.
  if (regrouped !== null) {
    const groups: number = regrouped;
    await setMeta(db, 'groupThumbnails', { groups, wanted: [...new Set(subscriptions.map((subscription) => groupOf(subscription.slot!.id, groups)))].sort((a, b) => a - b), done: [], latest: null } satisfies GroupThumbnailsRun);

    return written + (await syncGroupThumbnails(db, api, now, onProgress));
  }

  await db.transaction('rw', db.meta, async () => {
    await setMeta(db, 'lotsCovered', run.latest);
    await db.meta.delete('groupThumbnails');
  });

  return written;
}

/**
 * Downloads the thumbnails of the followed channels' new videos from their groups' hourly lots
 * (docs/FEATURES.md, D3), after the stream: whole lots of the groups the stream reads, the most
 * recent hour first, back a week, skipping the hours read before and those a catch-up covered.
 * Each answer is written in one transaction with the hours it covered, so one cut short resumes
 * where it stopped. A thumbnail goes in only for an item the device has, keeps a thumbnail for
 * and doesn't have one of. `onProgress` gets the share of the hours read, from 0 to 1.
 */
async function syncLots(db: SubifyDb, api: Api, now: number, onProgress: (share: number) => void): Promise<{ written: number }> {
  const { groupOf } = await oprf();
  const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');
  const groups = (await getMeta<number>(db, 'streamGroups')) ?? 1;
  const wanted = [...new Set(subscriptions.map((subscription) => groupOf(subscription.slot!.id, groups)))];
  let written = 0;

  if (wanted.length === 0) {
    onProgress(1);

    return { written };
  }

  await setMeta(db, 'lotsRun', true);
  const kept = await getMeta<LotsRead>(db, 'lotsRead');
  const read: LotsRead = kept === undefined ? { groups, hours: {} } : inGrouping(kept, groups, wanted);
  const firsts = await inParallel(wanted, PARALLEL, (group) => api.lots(group));
  const { latest, page } = firsts[0]!;
  // Hours a catch-up's thumbnails covered hold nothing the device lacks.
  const oldest = Math.max(latest - LOT_HOURS + 1, ((await getMeta<number>(db, 'lotsCovered')) ?? -Infinity) + 1);
  const missing = (group: number, from: number, to: number) => {
    const had = new Set(read.hours[group] ?? []);

    return Array.from({ length: to - from + 1 }, (_, i) => to - i).filter((hour) => hour >= oldest && !had.has(hour));
  };
  const total = wanted.reduce((sum, group) => sum + missing(group, oldest, latest).length, 0);
  let done = 0;

  for (let until = latest; until >= oldest; until -= page) {
    const from = until - page + 1;
    const asked = wanted.filter((group) => missing(group, from, until).length > 0);
    const answers = await inParallel(asked, PARALLEL, async (group) => ({ group, answer: until === latest ? firsts[wanted.indexOf(group)]! : await api.lots(group, until) }));
    const images = new Map<string, SlotImage>();

    for (const { group, answer } of answers) {
      for (const lot of answer.lots.filter((candidate) => candidate.hour >= from && candidate.hour <= until)) {
        const fragments = fromBase64Url(lot.fragments);

        for (const subscription of subscriptions.filter((candidate) => groupOf(candidate.slot!.id, groups) === group)) {
          for (const [id, image] of await openLot(subscription.slot!.key, lot.hour, fragments)) {
            images.set(`${subscription.source}:${id}`, image);
          }
        }
      }

      // An hour without a lot before the current one never gets one: no pass ran then.
      const returned = new Set(answer.lots.map((lot) => lot.hour));
      const covered = missing(group, from, until).filter((hour) => returned.has(hour) || hour < latest);
      read.hours[group] = [...(read.hours[group] ?? []).filter((hour) => hour >= oldest), ...covered];
      done += covered.length;
    }

    await db.transaction('rw', db.items, db.thumbnails, db.meta, async () => {
      written += await putThumbnails(db, images, now);
      await setMeta(db, 'lotsRead', read);
    });

    onProgress(total === 0 ? 1 : Math.min(1, done / total));
  }

  await db.meta.delete('lotsRun');
  onProgress(1);

  return { written };
}

/**
 * The hours read, for these groups of another grouping. Groups only split as the table grows
 * (their ids' first bits, groupOf), and a group's lot of an hour held every channel of the groups
 * it split into: the server gives that same lot again for each of them. So an hour read for a
 * group is read for each of its parts, and a growth step costs no week of lots again. A coarser
 * grouping, which the table never takes, starts over.
 */
function inGrouping(read: LotsRead, groups: number, wanted: readonly number[]): LotsRead {
  if (read.groups === groups) {
    return read;
  }

  if (groups < read.groups) {
    return { groups, hours: {} };
  }

  const shift = Math.log2(groups / read.groups);

  return { groups, hours: Object.fromEntries(wanted.map((group) => [group, [...(read.hours[group >>> shift] ?? [])]])) };
}

/** Keeps these thumbnails, by item key, for the items the device has, keeps a thumbnail for and has none of; gives how many. */
async function putThumbnails(db: SubifyDb, images: ReadonlyMap<string, SlotImage>, now: number): Promise<number> {
  const keys = [...images.keys()];
  const [items, thumbnails, keep] = await Promise.all([db.items.bulkGet(keys), db.thumbnails.bulkGet(keys), loadThumbnailKeep(db)]);
  const fresh = keys.flatMap((key, i) => {
    const item = items[i];

    return item === undefined || (thumbnails[i]?.data ?? null) !== null || !keepsThumbnail(item, keep, now) ? [] : [{ key, channel: item.channel, type: images.get(key)!.type, data: images.get(key)!.bytes.slice().buffer }];
  });
  await db.thumbnails.bulkPut(fresh);

  return fresh.length;
}

/** Runs `run` on every value, at most `limit` at a time, and gives the results in order. */
async function inParallel<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const at = next++;
        results[at] = await run(values[at]!);
      }
    }),
  );

  return results;
}

function toApiItem(channel: string, item: { id: string; title: string; published: number; type: ApiItem['type']; upcoming: boolean; deleted?: boolean }): ApiItem {
  const source = channel.slice(0, channel.indexOf(':'));

  return {
    key: `${source}:${item.id}`,
    channel,
    title: item.title,
    url: itemUrl(source, item.id, item.type),
    thumbnail: null,
    published: item.published,
    type: item.type,
    ...(item.deleted === true ? { deleted: true as const } : {}),
    ...(item.upcoming ? { upcoming: true as const } : {}),
  };
}

/** A channel as a snapshot or an addition gives it, as the app stores channels and items, with their previews. */
export function toApi(channel: SnapshotChannel): { channel: ApiChannel; items: (ApiItem & { preview?: Uint8Array })[]; retryAt: number | null } {
  const key = `${channel.source}:${channel.externalId}`;

  return {
    channel: { key, source: channel.source, title: channel.title, handle: channel.handle, icon: null, avatar: channel.avatar === null ? null : dataUrl(channel.avatar) },
    items: channel.items.map((item) => ({ ...toApiItem(key, item), ...(item.preview === null ? {} : { preview: item.preview }) })),
    retryAt: channel.retryAt,
  };
}

function thumbnailsOf(channel: string, images: ReadonlyMap<string, SlotImage>): Omit<StoredThumbnail, 'channel'>[] {
  const source = channel.slice(0, channel.indexOf(':'));

  return [...images].map(([id, image]) => ({ key: `${source}:${id}`, type: image.type, data: image.bytes.slice().buffer }));
}

function dataUrl(image: SlotImage): string {
  let binary = '';
  image.bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return `data:${image.type};base64,${btoa(binary)}`;
}

function externalId(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
