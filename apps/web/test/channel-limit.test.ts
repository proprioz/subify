import { MAX_SYNC_CHANNELS } from '@subify/shared';
import { describe, expect, it } from 'vitest';
import { readBackup } from '../src/data/backup';
import { seal } from '../src/data/backup-cipher';
import type { Subscription, SubifyDb } from '../src/data/db';
import { followMany } from '../src/data/follow-many';
import { follow, TooManyChannels } from '../src/data/subscriptions';
import { channel, FakeServer, freshDb, NOW } from './fake-server';

const id = (i: number) => `UC${String(i).padStart(22, '0')}`;

async function following(db: SubifyDb, count: number): Promise<void> {
  await db.subscriptions.bulkPut(
    Array.from({ length: count }, (_, i): Subscription => ({
      key: `youtube:${id(i)}`,
      source: 'youtube',
      title: id(i),
      handle: null,
      icon: null,
      avatar: null,
      types: ['video', 'short', 'live'],
      addedAt: NOW + i,
      // Gone, with a slot under the server's key already: 5,000 blind evaluations and snapshot
      // lookups would only slow the test down, and the limit counts them all the same.
      status: 'gone',
      secret: false,
      slot: { keyId: 1, id: crypto.getRandomValues(new Uint8Array(16)), key: crypto.getRandomValues(new Uint8Array(32)) },
    })),
  );
}

// The app follows at most MAX_SYNC_CHANNELS channels: it stops before passing it, without asking
// the server anything.
describe('the channel limit', () => {
  it('refuses an import that would pass it, before any request', async () => {
    const db = freshDb();
    const server = new FakeServer();
    await following(db, MAX_SYNC_CHANNELS - 1);
    const two = [MAX_SYNC_CHANNELS, MAX_SYNC_CHANNELS + 1].map((i) => ({ key: `youtube:${id(i)}`, title: id(i), handle: null }));

    await expect(followMany(db, server.api(), two, NOW)).rejects.toThrow(TooManyChannels);
    expect(server.paths).toEqual([]);
    expect(await db.subscriptions.count()).toBe(MAX_SYNC_CHANNELS - 1);

    await expect(followMany(db, server.api(), two.slice(0, 1), NOW)).resolves.toMatchObject({ queued: 1 });
  });

  it('refuses one more channel once it is reached', async () => {
    const db = freshDb();
    await following(db, MAX_SYNC_CHANNELS);

    await expect(follow(db, { channel: channel(id(MAX_SYNC_CHANNELS)), items: [], retryAt: null, start: { pass: 1 }, thumbnails: [] }, NOW)).rejects.toThrow(TooManyChannels);
  });

  it('refuses a backup with more channels, before the restore replaces anything', async () => {
    const payload = {
      version: 1,
      exportedAt: '2026-10-20T00:00:00Z',
      typeFilter: { video: true, live: true, short: true },
      channels: Array.from({ length: MAX_SYNC_CHANNELS + 1 }, (_, i) => ({ key: `youtube:${id(i)}`, title: id(i), handle: null, secret: false, types: ['video'] })),
    };
    const backup = await seal(JSON.stringify(payload), 'a long password');

    await expect(readBackup(backup, 'a long password')).rejects.toThrow('the app can follow up to 5,000');
  });
});
