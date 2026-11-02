import { getMeta, setMeta, type SubifyDb } from './db';

/** At most one warning a day: it reminds, it doesn't nag. */
export const STORAGE_WARNING_PAUSE = 24 * 60 * 60 * 1000;

/**
 * Whether to warn, as the app opens, that the browser may clear the user's channels, and records
 * the warning when so. Only when the data is at risk (the app runs in a browser tab that made no
 * promise to keep its storage) and something would be lost: a channel added since the last backup.
 */
export async function takeStorageWarning(db: SubifyDb, atRisk: boolean, now: number): Promise<boolean> {
  if (!atRisk) {
    return false;
  }

  const lastWarningAt = await getMeta<number>(db, 'storageWarningAt');

  if (lastWarningAt !== undefined && now - lastWarningAt < STORAGE_WARNING_PAUSE) {
    return false;
  }

  const lastExportAt = (await getMeta<number>(db, 'lastExportAt')) ?? 0;

  if ((await db.subscriptions.where('addedAt').above(lastExportAt).count()) === 0) {
    return false;
  }

  await setMeta(db, 'storageWarningAt', now);

  return true;
}
