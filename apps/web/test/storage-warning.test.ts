import { describe, expect, it } from 'vitest';
import { setMeta, type Subscription, SubifyDb } from '../src/data/db';
import { STORAGE_WARNING_PAUSE, takeStorageWarning } from '../src/data/storage-warning';

const channel = (key: string, addedAt: number): Subscription => ({
  key,
  source: 'youtube',
  title: key,
  handle: null,
  icon: null,
  avatar: null,
  types: ['video'],
  addedAt,
  status: 'ready',
  secret: false,
});

// A warning that “everything could disappear” must reach users who would lose channels, and only them, at most once a day.
describe('the warning that the browser may clear the channels', () => {
  it('warns only when the data is at risk and some channel is not in a backup', async () => {
    const db = new SubifyDb(`storage-warning-${Math.random()}`);

    expect(await takeStorageWarning(db, true, 1_000)).toBe(false);

    await db.subscriptions.put(channel('youtube:a', 100));
    expect(await takeStorageWarning(db, false, 1_000)).toBe(false);

    await setMeta(db, 'lastExportAt', 200);
    expect(await takeStorageWarning(db, true, 1_000)).toBe(false);

    await db.subscriptions.put(channel('youtube:b', 300));
    expect(await takeStorageWarning(db, true, 1_000)).toBe(true);
  });

  it('comes back a day later at the soonest', async () => {
    const db = new SubifyDb(`storage-warning-${Math.random()}`);
    await db.subscriptions.put(channel('youtube:a', 100));

    expect(await takeStorageWarning(db, true, 1_000)).toBe(true);
    expect(await takeStorageWarning(db, true, 1_000 + STORAGE_WARNING_PAUSE - 1)).toBe(false);
    expect(await takeStorageWarning(db, true, 1_000 + STORAGE_WARNING_PAUSE)).toBe(true);
  });
});
