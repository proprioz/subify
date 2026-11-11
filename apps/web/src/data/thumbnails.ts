import { getMeta, setMeta, type StoredItem, type SubifyDb } from './db';

/**
 * How long the device keeps a video's thumbnail after its publication, in days, or as long as the
 * video. Thumbnails come only for the last 7 days (docs/FEATURES.md, D3), so a thumbnail dropped
 * never comes back: nothing shorter than a month is offered.
 */
export type ThumbnailKeep = 30 | 90 | 180 | 365 | 'always';

export const THUMBNAIL_KEEP_CHOICES: readonly { value: ThumbnailKeep; label: string }[] = [
  { value: 30, label: '1 month' },
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 'always', label: 'As long as the video' },
];

export const DEFAULT_THUMBNAIL_KEEP: ThumbnailKeep = 30;

/** A thumbnail as the server sends it (WebP, 320×180), when the device has none to measure. */
const TYPICAL_THUMBNAIL_BYTES = 7_000;

/** Thumbnails measured for the average size: enough for an estimate, few enough to read at once. */
const SAMPLE = 50;

const DAY = 24 * 60 * 60 * 1000;

export async function loadThumbnailKeep(db: SubifyDb): Promise<ThumbnailKeep> {
  return (await getMeta<ThumbnailKeep>(db, 'thumbnailKeep')) ?? DEFAULT_THUMBNAIL_KEEP;
}

/** Saves the choice; a shorter one deletes at once the thumbnails it no longer keeps. */
export async function setThumbnailKeep(db: SubifyDb, keep: ThumbnailKeep, now = Date.now()): Promise<void> {
  await setMeta(db, 'thumbnailKeep', keep);
  await dropOldThumbnails(db, now);
}

/** Whether the device keeps a thumbnail for this item; the feed says why when it has none. */
export function keepsThumbnail(item: Pick<StoredItem, 'published' | 'upcoming'>, keep: number | 'always', now = Date.now()): boolean {
  return item.upcoming === 1 || keep === 'always' || item.published >= now - keep * DAY;
}

/** Whether a missing thumbnail may still come: refreshes and snapshots bring those of the last 7 days only (D3). */
export function thumbnailMayCome(item: Pick<StoredItem, 'published' | 'upcoming'>, now = Date.now()): boolean {
  return keepsThumbnail(item, 7, now);
}

/**
 * Drops the thumbnails of videos gone from the device, or published before the chosen time and
 * not upcoming. Thumbnails come only with an addition or a snapshot: asking for them by
 * item would name the videos the device shows, so the app never downloads them on their own.
 */
export async function dropOldThumbnails(db: SubifyDb, now = Date.now()): Promise<void> {
  const keep = await loadThumbnailKeep(db);

  await dropThumbnails(db, (item) => item === undefined || !keepsThumbnail(item, keep, now));
}

/** Deletes the thumbnails of videos published more than `days` ago, upcoming ones aside, whatever the chosen time. */
export async function deleteThumbnailsOlderThan(db: SubifyDb, days: number, now = Date.now()): Promise<void> {
  await dropThumbnails(db, (item) => item === undefined || !keepsThumbnail(item, days, now));
}

async function dropThumbnails(db: SubifyDb, drops: (item: StoredItem | undefined) => boolean): Promise<void> {
  await db.transaction('rw', db.items, db.thumbnails, async () => {
    const keys = await db.thumbnails.toCollection().primaryKeys();
    const items = await db.items.bulkGet(keys);

    await db.thumbnails.bulkDelete(keys.filter((_, i) => drops(items[i])));
  });
}

/** Estimates, in bytes, for the channels the user can see now (Settings, “Thumbnails”). */
export interface ThumbnailSpace {
  /** What the kept thumbnails take on the device. */
  used: number;
  /** What a day of their videos adds, from the last 30 days. */
  perDay: number;
  /** What deleting the thumbnails older than each choice in days would free. */
  olderThan: Record<number, number>;
}

/**
 * Counts the thumbnails kept and the videos of the last 30 days, times the average thumbnail. While
 * secret channels are hidden, their thumbnails are left out: the numbers would hint at them.
 */
export async function thumbnailSpace(db: SubifyDb, showSecret: boolean, now = Date.now()): Promise<ThumbnailSpace> {
  const visible = new Set(
    (await db.subscriptions.toArray()).filter((channel) => showSecret || !channel.secret).map((channel) => channel.key),
  );
  const thumbnails = (await db.thumbnails.toCollection().primaryKeys()) as string[];
  const items = await db.items.bulkGet(thumbnails);
  const kept = items.filter((item): item is StoredItem => item !== undefined && visible.has(item.channel));
  const sample = (await db.thumbnails.limit(SAMPLE).toArray()).flatMap((thumbnail) => (thumbnail.data === null ? [] : [thumbnail.data.byteLength]));
  const size = sample.length === 0 ? TYPICAL_THUMBNAIL_BYTES : sample.reduce((sum, bytes) => sum + bytes, 0) / sample.length;
  const lastMonth = await db.items
    .where('published')
    .between(now - 30 * DAY, now, true, true)
    .filter((item) => item.upcoming !== 1 && visible.has(item.channel))
    .count();
  const olderThan: Record<number, number> = {};

  for (const { value } of THUMBNAIL_KEEP_CHOICES) {
    if (value !== 'always') {
      olderThan[value] = kept.filter((item) => !keepsThumbnail(item, value, now)).length * size;
    }
  }

  return { used: kept.length * size, perDay: (lastMonth / 30) * size, olderThan };
}

/** “about 12 MB”, in the decimal megabytes a phone's storage settings show. */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;

  return mb < 1 ? 'less than 1 MB' : `about ${Math.round(mb)} MB`;
}
