import type { StreamResponse } from '@subify/shared';
import { decoyEntry, type SlotChannel, toBase64Url, sealEntry, STREAM_ENTRY_SIZE, STREAM_MAX_PER_CHANNEL, type StreamBatch, type StreamDelta } from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, groupOf } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { retryAtOf } from './schedule';
import { STREAM_ROWS, type StreamPlan } from './sizing';
import { readBatches, readState } from './vault';

/**
 * The sync stream during one pass (docs/FEATURES.md, D16): the pass tells it what changed for each
 * channel, and it builds the pass's batch, exactly `perGroup` entries in each group whatever
 * happened. A change it has no room for waits in the coordinator and goes first at the next pass.
 */

/** A change waiting for a batch, with the channel it is about. */
export interface WaitingDelta {
  source: string;
  externalId: string;
  delta: StreamDelta;
}

/** What a channel's slot became at a pass, as devices following it must learn it. */
export function deltasOf(before: SlotChannel, after: SlotChannel | null): StreamDelta[] {
  if (after === null) {
    return [{ kind: 'gone' }];
  }

  const deltas: StreamDelta[] = after.title !== before.title || after.handle !== before.handle ? [{ kind: 'channel', title: after.title, handle: after.handle }] : [];
  const retryAt = retryAtOf(after);

  if (retryAt !== retryAtOf(before)) {
    deltas.push({ kind: 'retry', retryAt });
  }
  const known = new Map(before.items.map((item) => [item.id, item]));

  for (const item of [...after.items].reverse()) {
    const previous = known.get(item.id);
    const changed =
      previous === undefined ||
      previous.title !== item.title ||
      previous.published !== item.published ||
      previous.type !== item.type ||
      previous.deleted !== item.deleted ||
      previous.upcoming !== item.upcoming;

    if (changed) {
      deltas.push({ kind: 'item', id: item.id, title: item.title, published: item.published, type: item.type, deleted: item.deleted, upcoming: item.upcoming });
    }
  }

  return deltas;
}

export class PassStream {
  /** By channel, in the order they came: changes that waited were added first. */
  private readonly changes = new Map<string, WaitingDelta[]>();

  constructor(
    private readonly plan: StreamPlan,
    private readonly pass: number,
  ) {}

  add(source: string, externalId: string, deltas: readonly StreamDelta[]): void {
    if (deltas.length === 0) {
      return;
    }

    const key = `${source}:${externalId}`;
    const list = this.changes.get(key) ?? [];
    list.push(...deltas.map((delta) => ({ source, externalId, delta })));
    this.changes.set(key, list);
  }

  /** The pass's batch, and the changes it had no room for. */
  async build(keys: ServerKeys, random: () => number): Promise<{ batch: StreamBatch; waiting: WaitingDelta[] }> {
    const { groups, perGroup } = this.plan;
    const byGroup: Uint8Array[][] = Array.from({ length: groups }, () => []);
    const waiting: WaitingDelta[] = [];

    for (const list of this.changes.values()) {
      const { source, externalId } = list[0]!;
      const secrets = await channelSecrets(evaluate(keys.voprf, channelInput(source, externalId)));
      const group = byGroup[groupOf(secrets.slotId, groups)]!;
      const room = Math.min(STREAM_MAX_PER_CHANNEL, perGroup - group.length);

      for (const [index, change] of list.entries()) {
        if (index < room) {
          group.push(await sealEntry(secrets.transitKey, this.pass, index, change.delta));
        } else {
          waiting.push(change);
        }
      }
    }

    const entries = new Uint8Array(groups * perGroup * STREAM_ENTRY_SIZE);

    byGroup.forEach((real, group) => {
      const all = [...real, ...Array.from({ length: perGroup - real.length }, decoyEntry)];
      // Shuffled: real entries first would tell how many there are.
      shuffle(all, random);
      all.forEach((entry, i) => entries.set(entry, (group * perGroup + i) * STREAM_ENTRY_SIZE));
    });

    return { batch: { pass: this.pass, groups, perGroup, entries }, waiting };
  }
}

/** Batches per answer: a day of 10-minute passes. */
const PAGE = 144;

/**
 * A group's entries in the batches after `since`, as a device downloads them: whole groups only,
 * every entry of the group, so that what it fetches says nothing about which channels it follows.
 * Null when the group is out of range, or the encrypted catalog has no pass yet.
 */
export async function readStream(platform: Platform, keys: ServerKeys, since: number, group: number): Promise<StreamResponse | null> {
  const state = await readState(platform.db, keys);

  if (state === undefined) {
    return null;
  }

  const latest = state.passes;
  // The grouping devices must use is the latest batch's, as written.
  const last = (await readBatches(platform.db, keys, [latest % STREAM_ROWS])).get(latest % STREAM_ROWS);

  if (last === undefined || last.pass !== latest || group >= last.groups) {
    return null;
  }

  const answer = { v: 4 as const, latest, groups: last.groups, k: Math.floor((state.tableSize / 2) / last.groups) };

  if (since + 1 <= latest - STREAM_ROWS) {
    return { ...answer, expired: true, more: false, batches: [] };
  }

  const passes = Array.from({ length: Math.max(0, Math.min(latest, since + PAGE) - since) }, (_, i) => since + 1 + i);
  const stored = await readBatches(platform.db, keys, passes.map((pass) => pass % STREAM_ROWS));
  const batches = passes.flatMap((pass) => {
    const batch = stored.get(pass % STREAM_ROWS);

    if (batch === undefined || batch.pass !== pass) {
      return [];
    }

    // A batch from before the last growth has fewer groups: groups nest, so the device's group in it is this one, halved.
    const at = (group >>> Math.log2(last.groups / batch.groups)) * batch.perGroup * STREAM_ENTRY_SIZE;

    return [{ pass, entries: toBase64Url(batch.entries.subarray(at, at + batch.perGroup * STREAM_ENTRY_SIZE)) }];
  });

  return { ...answer, expired: false, more: since + PAGE < latest, batches };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
}
