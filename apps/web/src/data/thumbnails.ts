import type { StoredItem, SubifyDb } from './db';

/** Thumbnails are kept for the videos of the last 30 days, and for upcoming ones. */
export const THUMBNAIL_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

/** Whether the device keeps a thumbnail for this item; the feed says why when it has none. */
export function keepsThumbnail(item: Pick<StoredItem, 'published' | 'upcoming'>, now = Date.now()): boolean {
  return item.upcoming === 1 || item.published >= now - THUMBNAIL_DAYS * DAY;
}

/**
 * Drops the thumbnails of videos gone from the device, or published before the window and not
 * upcoming. Thumbnails come only with an addition or a snapshot: asking for them by
 * item would name the videos the device shows, so the app never downloads them on their own.
 */
export async function dropOldThumbnails(db: SubifyDb, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.items, db.thumbnails, async () => {
    const keys = await db.thumbnails.toCollection().primaryKeys();
    const items = await db.items.bulkGet(keys);
    const old = keys.filter((_, i) => {
      const item = items[i];

      return item === undefined || !keepsThumbnail(item, now);
    });

    await db.thumbnails.bulkDelete(old);
  });
}
