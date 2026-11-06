import type { SnapshotResponse } from '@subify/shared';
import {
  decoySnapshotEntry,
  decoySnapshotThumbnail,
  SNAPSHOT_MAX_THUMBNAILS,
  type SlotChannel,
  type SnapshotChannel,
  sealSnapshotEntry,
  sealSnapshotThumbnail,
  toBase64Url,
} from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { BudgetError } from './budgets';
import { MINUTE, retryAtOf } from './schedule';
import { THUMBNAILS_ON_ADD } from './tend';
import { readCases, readSlotsInGroup, readState } from './vault';

/**
 * Group snapshots (docs/FEATURES.md, D16, decisions C, N, P, Q): computed on request, never
 * stored. A device reads the snapshot of its channel's group to add a channel the catalog has,
 * to restore a backup, or after more than the stream keeps.
 */

/** About this many channels per snapshot group: the group a device reads hides its channel among them. */
export const SNAPSHOT_CHANNELS = 40;
/** Items of each type a channel brings, the latest, in a snapshot and in an addition by link. */
export const LATEST_PER_TYPE = 15;
/** Thumbnails a group's snapshot carries per slot of the group, real and decoys: 0.44 videos a day, over 7 days, with a 1.5 margin, for half the slots. */
const THUMBNAILS_PER_SLOT = (0.44 * 7 * 1.5) / 2;
/** Snapshots per minute, all devices together: each reads a group's slots. A restore of 300 channels reads every group once. */
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
    items: items.map((item) => ({ id: item.id, title: item.title, published: item.published, type: item.type, upcoming: item.upcoming })),
    retryAt: retryAtOf(slot),
  };
}

/** Null when the group is out of range, or the encrypted catalog has no pass yet. */
export async function readSnapshot(platform: Platform, keys: ServerKeys, group: number, withThumbnails: boolean): Promise<SnapshotResponse | null> {
  const state = await readState(platform.db, keys);
  const groups = state === undefined ? 0 : snapshotGroups(state.tableSize);

  if (state === undefined || group >= groups) {
    return null;
  }

  const now = platform.clock.now();
  const window = Math.floor(now / MINUTE) * MINUTE;

  if (!(await platform.coordinator.take('snapshots', window, SNAPSHOTS_PER_MINUTE))) {
    throw new BudgetError('busy', BUSY, Math.ceil((window + MINUTE - now) / 1000));
  }

  const slots = await readSlotsInGroup(platform.db, keys, group, groups);
  const entries: Uint8Array[] = [];
  const thumbnails: { channel: { transitKey: Uint8Array; sealed: number }; itemId: string; position: number }[] = [];

  for (const slot of slots) {
    if (slot.payload.kind === 'empty') {
      entries.push(decoySnapshotEntry(slot.id));
      continue;
    }

    const channel = slot.payload;
    const { transitKey } = await channelSecrets(evaluate(keys.voprf, channelInput(channel.source, channel.externalId)));
    entries.push(await sealSnapshotEntry(slot.id, transitKey, snapshotChannel(channel)));

    if (withThumbnails) {
      const owner = { transitKey, sealed: 0 };
      channel.items
        .filter((item) => item.thumbnail !== null && !item.deleted && (item.published >= now - THUMBNAILS_ON_ADD || item.upcoming))
        .slice(0, SNAPSHOT_MAX_THUMBNAILS)
        .forEach((item) => thumbnails.push({ channel: owner, itemId: item.id, position: item.thumbnail! }));
    }
  }

  const answer = { v: 4 as const, pass: state.passes, groups, entries: toBase64Url(concat(entries)), thumbnails: '' };

  if (!withThumbnails) {
    return answer;
  }

  // A fixed number per slot of the group, whatever its channels published: the newest first when there are more.
  const count = Math.ceil(slots.length * THUMBNAILS_PER_SLOT);
  const cases = await readCases(platform.db, keys, thumbnails.map((thumbnail) => thumbnail.position));
  const sealed: Uint8Array[] = [];

  for (const thumbnail of thumbnails) {
    const held = cases.get(thumbnail.position);

    // The ring may have wrapped over it: then it holds another item's thumbnail.
    if (sealed.length < count && held?.kind === 'thumbnail' && held.itemId === thumbnail.itemId) {
      // Numbered without gaps: a device stops at the first index it doesn't find.
      sealed.push(await sealSnapshotThumbnail(thumbnail.channel.transitKey, state.passes, thumbnail.channel.sealed++, held));
    }
  }

  while (sealed.length < count) {
    sealed.push(decoySnapshotThumbnail());
  }

  shuffle(sealed, () => platform.random());

  return { ...answer, thumbnails: toBase64Url(concat(sealed)) };
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
