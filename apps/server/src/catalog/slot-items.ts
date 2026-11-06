import { SLOT_MAX_ITEMS, type SlotItem } from '@subify/shared/codec';
import type { IncomingItem } from '../sources/source';

export interface ItemChanges {
  /** What the platform lists now: new items, and known ones with their current title. */
  incoming?: readonly IncomingItem[];
  /** Upcoming items the platform no longer lists anywhere (D13): they stop being upcoming. */
  dropped?: readonly string[];
  /** Items the platform says were deleted: they stay as tombstones, so devices learn about it. */
  deleted?: readonly string[];
}

/**
 * A slot's items after what the platform said: a known item keeps its type unless it was
 * 'unknown'; only a new item can be upcoming; an upcoming item that aired takes `now` as its
 * publication time. Then retention: nothing published before `cutoff`, and the latest
 * SLOT_MAX_ITEMS, newest first.
 */
export function mergeItems(items: readonly SlotItem[], changes: ItemChanges, cutoff: number, now: number): SlotItem[] {
  const byId = new Map(items.map((item) => [item.id, { ...item }]));

  for (const incoming of changes.incoming ?? []) {
    if (incoming.published < cutoff) {
      continue;
    }

    const previous = byId.get(incoming.externalId);

    if (previous === undefined) {
      byId.set(incoming.externalId, {
        id: incoming.externalId,
        title: incoming.title,
        published: incoming.published,
        ingestedAt: now,
        type: incoming.type,
        deleted: false,
        upcoming: incoming.upcoming === true,
        thumbnail: null,
        preview: null,
      });
      continue;
    }

    const upcoming = incoming.upcoming === true && previous.upcoming;
    const aired = previous.upcoming && !upcoming;

    previous.title = incoming.title;
    previous.type = previous.type === 'unknown' ? incoming.type : previous.type;
    previous.deleted = false;
    previous.upcoming = upcoming;

    if (aired) {
      previous.published = Math.max(now, previous.published);
    }
  }

  for (const id of changes.dropped ?? []) {
    const item = byId.get(id);

    if (item !== undefined) {
      item.upcoming = false;
    }
  }

  for (const id of changes.deleted ?? []) {
    const item = byId.get(id);

    if (item !== undefined) {
      item.deleted = true;
    }
  }

  return [...byId.values()]
    .filter((item) => item.published >= cutoff)
    .sort((a, b) => b.published - a.published || (a.id < b.id ? -1 : 1))
    .slice(0, SLOT_MAX_ITEMS);
}
