import type { LotsResponse } from '@subify/shared';
import { decoyFragment, LOT_FRAGMENT_SIZE, LOT_MAX_PER_CHANNEL, sealFragment, type SlotImage, splitThumbnail, type StoredLot, toBase64Url } from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, groupOf } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { HOUR } from './schedule';
import { LOT_HOURS, type LotPlan, lotPlan, STREAM_ROWS } from './sizing';
import { readBatches, readLots, readState } from './vault';

/**
 * The thumbnail lots (docs/FEATURES.md, D3): at the first pass of each hour, every group of the
 * sync stream gets exactly `perGroup` fragments, the thumbnails the ring took since the last lot
 * sealed for their channels' devices, random fragments for the rest. A thumbnail without room
 * waits in the coordinator for the next hour's lot, the oldest first.
 */

/** A thumbnail of the ring, with its channel: what a lot carries. */
export interface LotThumbnail {
  source: string;
  externalId: string;
  itemId: string;
  /** Its case in the ring, where a thumbnail that waits is read again. */
  position: number;
  image: SlotImage;
}

/** A lot's row: its hour of the week, then its group. Groups fit in 16 bits (the stream's batches). */
export function lotPosition(hour: number, group: number): number {
  return (hour % LOT_HOURS) * 0x10000 + group;
}

/** Whether the pass at `now` is the first of its hour, the one that builds the hour's lots. */
export function lotDue(now: number, period: number): boolean {
  return Math.floor(now / HOUR) !== Math.floor((now - period) / HOUR);
}

/** Every group's lot of the hour, and the thumbnails they had no room for. */
export async function buildLots(
  keys: ServerKeys,
  plan: LotPlan,
  hour: number,
  thumbnails: readonly LotThumbnail[],
  random: () => number,
): Promise<{ lots: StoredLot[]; waiting: LotThumbnail[] }> {
  const byGroup: Uint8Array[][] = Array.from({ length: plan.groups }, () => []);
  const channels = new Map<string, { transitKey: Uint8Array; group: number; sealed: number }>();
  const waiting: LotThumbnail[] = [];

  for (const thumbnail of thumbnails) {
    const key = `${thumbnail.source}:${thumbnail.externalId}`;
    let channel = channels.get(key);

    if (channel === undefined) {
      const secrets = await channelSecrets(evaluate(keys.voprf, channelInput(thumbnail.source, thumbnail.externalId)));
      channel = { transitKey: secrets.transitKey, group: groupOf(secrets.slotId, plan.groups), sealed: 0 };
      channels.set(key, channel);
    }

    const fragments = splitThumbnail(thumbnail.itemId, thumbnail.image);
    const group = byGroup[channel.group]!;

    // Too large for any lot: the device keeps the preview.
    if (fragments.length === 0) {
      continue;
    }

    if (group.length + fragments.length > plan.perGroup || channel.sealed + fragments.length > LOT_MAX_PER_CHANNEL) {
      waiting.push(thumbnail);
      continue;
    }

    for (const fragment of fragments) {
      group.push(await sealFragment(channel.transitKey, hour, channel.sealed++, fragment));
    }
  }

  const lots = byGroup.map((real) => {
    const all = [...real, ...Array.from({ length: plan.perGroup - real.length }, decoyFragment)];
    // Shuffled: real fragments first would tell how many there are.
    shuffle(all, random);
    const fragments = new Uint8Array(plan.perGroup * LOT_FRAGMENT_SIZE);
    all.forEach((fragment, i) => fragments.set(fragment, i * LOT_FRAGMENT_SIZE));

    return { hour, groups: plan.groups, fragments };
  });

  return { lots, waiting };
}

/**
 * A group's lots of the `page` hours up to `until` (the latest hour when absent), the newest
 * first, as a device downloads them: whole lots only. Null when the group is out of range, or the
 * encrypted catalog has no pass yet. An hour without a lot (no pass ran then) is left out.
 */
export async function readLotPage(platform: Platform, keys: ServerKeys, group: number, until: number | undefined): Promise<LotsResponse | null> {
  const state = await readState(platform.db, keys);

  if (state === undefined) {
    return null;
  }

  // The grouping devices use is the stream's latest batch's, which the lots share.
  const last = (await readBatches(platform.db, keys, [state.passes % STREAM_ROWS])).get(state.passes % STREAM_ROWS);
  const plan = { ...lotPlan({ slots: state.tableSize }), groups: last?.groups ?? 0 };

  if (last === undefined || group >= plan.groups) {
    return null;
  }

  const latest = Math.floor(platform.clock.now() / HOUR);
  const top = Math.min(until ?? latest, latest);
  const hours = Array.from({ length: plan.page }, (_, i) => top - i).filter((hour) => hour > latest - LOT_HOURS && hour >= 0);
  // A lot from before the last growth has fewer groups: groups nest, so the device's group in it is this one, halved.
  const shifts = Array.from({ length: Math.log2(plan.groups) + 1 }, (_, shift) => shift);
  const stored = await readLots(platform.db, keys, hours.flatMap((hour) => shifts.map((shift) => lotPosition(hour, group >>> shift))));
  const lots = hours.flatMap((hour) => {
    const lot = shifts.map((shift) => stored.get(lotPosition(hour, group >>> shift))).find((candidate, shift) => candidate?.hour === hour && candidate.groups === plan.groups >>> shift);

    return lot === undefined ? [] : [{ hour, fragments: toBase64Url(lot.fragments) }];
  });

  return { v: 3, latest, groups: plan.groups, page: plan.page, lots };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
}
