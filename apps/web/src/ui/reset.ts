import type { SubifyDb } from '../data/db';

/** Deletes the database and the offline copy of the app, then starts over. */
export async function resetEverything(db: SubifyDb): Promise<void> {
  db.close();
  await db.delete();

  if ('caches' in window) {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  }

  location.replace('/feed');
}
