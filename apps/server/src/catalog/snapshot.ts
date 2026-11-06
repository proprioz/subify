import type { SnapshotResponse, SnapshotThumbnailsResponse } from '@subify/shared';
import {
  decoyFragment,
  decoySnapshotEntry,
  SNAPSHOT_MAX_FRAGMENTS,
  SNAPSHOT_MAX_THUMBNAILS,
  type SlotChannel,
  type SlotImage,
  type SnapshotChannel,
  sealSnapshotEntry,
  sealSnapshotFragment,
  splitThumbnail,
  toBase64Url,
} from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { BudgetError } from './budgets';
import { HOUR, MINUTE, retryAtOf } from './schedule';
import { THUMBNAILS_ON_ADD } from './tend';
import { readCases, readSlotsInGroup, readState, type Slot } from './vault';

/**
 * Group snapshots (docs/FEATURES.md, D16, decisions C, N, P, Q): computed on request, never
 * stored. A device reads the snapshot of its channel's group to add a channel the catalog has,
 * to restore a backup, or after more than the stream keeps, and then the group's thumbnails.
 */

/** About this many channels per snapshot group: the group a device reads hides its channel among them. */
export const SNAPSHOT_CHANNELS = 40;
/** Items of each type a channel brings, the latest, in a snapshot and in an addition by link. */
export const LATEST_PER_TYPE = 15;
/**
 * Fragments a group's thumbnails carry per slot of the group, real and decoys: 0.44 videos a day,
 * over 7 days, with a 1.5 margin, for half the slots, each about 7 KB of WebP in 8 fragments.
 */
const FRAGMENTS_PER_SLOT = Math.ceil(((0.44 * 7 * 1.5) / 2) * 8);
/**
 * Snapshots per minute, all devices together, and as many groups' thumbnails: each reads a
 * group's slots. A restore of 300 channels reads every group once of each.
 */
const SNAPSHOTS_PER_MINUTE = 120;
const BUSY = 'The server answers few of these at a time, and it has had many lately. Try again in a moment.';

/** Snapshot groups for a table of this size: a power of two, about SNAPSHOT_CHANNELS channels each when half full. */
export function snapshotGroups(tableSize: number): number {
  return 2 ** Math.max(0, Math.round(Math.log2(tableSize / 2 / SNAPSHOT_CHANNELS)));
}

/** A channel as a snapshot gives it: the latest items of each type, upcoming ones, never deleted ones. */
export function snapshotChannel(slot: SlotChannel): SnapshotChannel {
  const counts = new Map<string, number>();
  const items = slot.items.filter((item) => {
    if (item.deleted) {
      return false;
    }

    const count = (counts.get(item.type) ?? 0) + 1;
    counts.set(item.type, count);

    return count <= LATEST_PER_TYPE || item.upcoming;
  });

  return {
    source: slot.source,
    externalId: slot.externalId,
    title: slot.title,
    handle: slot.handle,
    avatar: slot.avatar,
    items: items.map((item) => ({ id: item.id, title: item.title, published: item.published, type: item.type, upcoming: item.upcoming, preview: item.preview })),
    retryAt: retryAtOf(slot),
  };
}

/** Null when the group is out of range, or the encrypted catalog has no pass yet. */
export async function readSnapshot(platform: Platform, keys: ServerKeys, group: number): Promise<SnapshotResponse | null> {
  const read = await readGroup(platform, keys, group, 'snapshots');

  if (read === null) {
    return null;
  }

  const entries: Uint8Array[] = [];

  for (const slot of read.slots) {
    entries.push(slot.payload.kind === 'empty' ? decoySnapshotEntry(slot.id) : await sealSnapshotEntry(slot.id, await transitKeyOf(keys, slot.payload), snapshotChannel(slot.payload)));
  }

  return { v: 5, pass: read.pass, groups: read.groups, entries: toBase64Url(concat(entries)) };
}

/**
 * The thumbnails of the last 7 days of every slot of a group, in fragments as the lots carry
 * them (docs/FEATURES.md, D3). A device reads them for every group whose snapshot it read, after
 * it: their number is fixed by the group's size, so the answer is the same size whatever the
 * group's channels published. When they don't all fit, each channel gets its newest in turn, so a
 * busy channel can't leave the others without any. Null as for its snapshot.
 */
export async function readSnapshotThumbnails(platform: Platform, keys: ServerKeys, group: number): Promise<SnapshotThumbnailsResponse | null> {
  const read = await readGroup(platform, keys, group, 'snapshot-thumbnails');

  if (read === null) {
    return null;
  }

  const now = platform.clock.now();
  const channels = read.slots.flatMap((slot) => (slot.payload.kind === 'empty' ? [] : [slot.payload]));
  const recent = channels.map((channel) =>
    channel.items.filter((item) => item.thumbnail !== null && !item.deleted && (item.published >= now - THUMBNAILS_ON_ADD || item.upcoming)).slice(0, SNAPSHOT_MAX_THUMBNAILS),
  );
  const cases = await readCases(platform.db, keys, recent.flat().map((item) => item.thumbnail!));
  // The ring may have wrapped over one: then it holds another item's thumbnail.
  const held = recent.map((items) =>
    items.flatMap((item) => {
      const payload = cases.get(item.thumbnail!);

      return payload?.kind === 'thumbnail' && payload.itemId === item.id ? [{ itemId: item.id, image: payload.image }] : [];
    }),
  );
  const count = read.slots.length * FRAGMENTS_PER_SLOT;
  const sealed: Uint8Array[] = [];
  const owners = await Promise.all(channels.map(async (channel) => ({ transitKey: await transitKeyOf(keys, channel), sealed: 0 })));

  // A round per thumbnail: each channel's newest left, while there is room.
  for (let round = 0; round < SNAPSHOT_MAX_THUMBNAILS; round++) {
    for (const [i, thumbnails] of held.entries()) {
      const thumbnail: { itemId: string; image: SlotImage } | undefined = thumbnails[round];
      const owner = owners[i]!;
      const fragments = thumbnail === undefined ? [] : splitThumbnail(thumbnail.itemId, thumbnail.image);

      if (fragments.length === 0 || sealed.length + fragments.length > count || owner.sealed + fragments.length > SNAPSHOT_MAX_FRAGMENTS) {
        continue;
      }

      for (const fragment of fragments) {
        // Numbered without gaps: a device stops at the first index it doesn't find.
        sealed.push(await sealSnapshotFragment(owner.transitKey, read.pass, owner.sealed++, fragment));
      }
    }
  }

  while (sealed.length < count) {
    sealed.push(decoyFragment());
  }

  // Shuffled: real fragments first would tell how many there are.
  shuffle(sealed, () => platform.random());

  return { v: 5, pass: read.pass, groups: read.groups, latest: Math.floor(now / HOUR), fragments: toBase64Url(concat(sealed)) };
}

/** A group's slots, after the budget all reads of this kind share; null when the group is out of range or there is no pass yet. */
async function readGroup(platform: Platform, keys: ServerKeys, group: number, budget: 'snapshots' | 'snapshot-thumbnails'): Promise<{ slots: Slot[]; pass: number; groups: number } | null> {
  const state = await readState(platform.db, keys);
  const groups = state === undefined ? 0 : snapshotGroups(state.tableSize);

  if (state === undefined || group >= groups) {
    return null;
  }

  const now = platform.clock.now();
  const window = Math.floor(now / MINUTE) * MINUTE;

  if (!(await platform.coordinator.take(budget, window, SNAPSHOTS_PER_MINUTE))) {
    throw new BudgetError('busy', BUSY, Math.ceil((window + MINUTE - now) / 1000));
  }

  return { slots: await readSlotsInGroup(platform.db, keys, group, groups), pass: state.passes, groups };
}

async function transitKeyOf(keys: ServerKeys, channel: SlotChannel): Promise<Uint8Array> {
  return (await channelSecrets(evaluate(keys.voprf, channelInput(channel.source, channel.externalId)))).transitKey;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  parts.forEach((part) => {
    all.set(part, at);
    at += part.length;
  });

  return all;
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
}
