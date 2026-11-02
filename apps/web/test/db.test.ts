import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { SubifyDb } from '../src/data/db';

// Users keep the app installed across schema changes: an upgrade must not lose a subscription or a video.
describe('database upgrades', () => {
  it('opens a version 1 database without losing anything, and marks no channel secret', async () => {
    const name = `upgrade-${Math.random()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    await v1.table('subscriptions').put({ key: 'youtube:a', source: 'youtube', idHash: 'h', title: 'A', handle: null, icon: null, types: ['video'], addedAt: 1, status: 'known' });
    await v1.table('items').put({ key: 'youtube:v', channel: 'youtube:a', title: 'V', url: 'u', thumbnail: null, published: 1, type: 'video' });
    await v1.table('meta').put({ key: 'cursor', value: 42 });
    v1.close();

    const db = new SubifyDb(name);

    expect(await db.subscriptions.get('youtube:a')).toMatchObject({ title: 'A', types: ['video'], status: 'ready', secret: false });
    expect(await db.items.count()).toBe(1);
  });

  it('opens a version 2 database, merges the statuses of filled channels and keeps the queue', async () => {
    const name = `upgrade-${Math.random()}`;
    const v2 = new Dexie(name);
    v2.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    v2.version(2).stores({ subscriptions: 'key, idHash, addedAt, status' });
    const base = { source: 'youtube', handle: null, icon: null, types: ['video'], addedAt: 1, secret: true };
    await v2.table('subscriptions').bulkPut([
      { ...base, key: 'youtube:a', idHash: 'ha', title: 'A', status: 'known' },
      { ...base, key: 'youtube:b', idHash: 'hb', title: 'B', status: 'submitted' },
      { ...base, key: 'youtube:c', idHash: 'hc', title: 'C', status: 'pending_submit' },
      { ...base, key: 'youtube:d', idHash: 'hd', title: 'D', status: 'failed' },
    ]);
    v2.close();

    const db = new SubifyDb(name);
    const subscriptions = await db.subscriptions.orderBy('key').toArray();

    expect(subscriptions.map((s) => s.status)).toEqual(['ready', 'ready', 'pending_submit', 'failed']);
    expect(subscriptions.every((s) => !('idHash' in s) && s.secret)).toBe(true);
    expect(await db.subscriptions.where('status').equals('pending_submit').count()).toBe(1);
  });

  it('opens a version 3 database with its videos, and finds none upcoming until the server says so', async () => {
    const name = `upgrade-${Math.random()}`;
    const v3 = new Dexie(name);
    v3.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    v3.version(2).stores({ subscriptions: 'key, idHash, addedAt, status' });
    v3.version(3).stores({ subscriptions: 'key, addedAt, status' });
    await v3.table('items').put({ key: 'youtube:v', channel: 'youtube:a', title: 'V', url: 'u', thumbnail: null, published: 1, type: 'live' });
    v3.close();

    const db = new SubifyDb(name);

    expect(await db.items.get('youtube:v')).toMatchObject({ title: 'V', type: 'live' });
    expect(await db.items.where('upcoming').equals(1).count()).toBe(0);
  });

  it('opens a version 4 database, gives its channels no avatar yet, and starts with no thumbnail', async () => {
    const name = `upgrade-${Math.random()}`;
    const v4 = new Dexie(name);
    v4.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    v4.version(2).stores({ subscriptions: 'key, idHash, addedAt, status' });
    v4.version(3).stores({ subscriptions: 'key, addedAt, status' });
    v4.version(4).stores({ items: 'key, channel, published, [channel+published], upcoming' });
    await v4.table('subscriptions').put({ key: 'youtube:a', source: 'youtube', title: 'A', handle: null, icon: 'https://yt3.ggpht.com/a', types: ['video'], addedAt: 1, status: 'ready', secret: false });
    v4.close();

    const db = new SubifyDb(name);

    expect(await db.subscriptions.get('youtube:a')).toMatchObject({ title: 'A', icon: 'https://yt3.ggpht.com/a', avatar: null });
    expect(await db.thumbnails.count()).toBe(0);
  });

  it('opens a version 5 database with its channels, videos and thumbnails, and no dictionary yet', async () => {
    const name = `upgrade-${Math.random()}`;
    const v5 = new Dexie(name);
    v5.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    v5.version(2).stores({ subscriptions: 'key, idHash, addedAt, status' });
    v5.version(3).stores({ subscriptions: 'key, addedAt, status' });
    v5.version(4).stores({ items: 'key, channel, published, [channel+published], upcoming' });
    v5.version(5).stores({ thumbnails: 'key, channel' });
    await v5.table('subscriptions').put({ key: 'youtube:a', source: 'youtube', title: 'A', handle: null, icon: null, avatar: null, types: ['video'], addedAt: 1, status: 'ready', secret: false });
    await v5.table('items').put({ key: 'youtube:v', channel: 'youtube:a', title: 'V', url: 'u', thumbnail: null, published: 1, type: 'video' });
    await v5.table('thumbnails').put({ key: 'youtube:v', channel: 'youtube:a', type: 'image/jpeg', data: new ArrayBuffer(3) });
    v5.close();

    const db = new SubifyDb(name);

    expect(await db.subscriptions.get('youtube:a')).toMatchObject({ title: 'A', status: 'ready' });
    expect(await db.items.count()).toBe(1);
    expect(await db.thumbnails.count()).toBe(1);
    expect(await db.dictionary.count()).toBe(0);
  });

  it('opens a version 6 database with its channels and videos, and drops its sync cursor', async () => {
    const name = `upgrade-${Math.random()}`;
    const v6 = new Dexie(name);
    v6.version(1).stores({ subscriptions: 'key, idHash, addedAt', items: 'key, channel, published, [channel+published]', meta: 'key' });
    v6.version(2).stores({ subscriptions: 'key, idHash, addedAt, status' });
    v6.version(3).stores({ subscriptions: 'key, addedAt, status' });
    v6.version(4).stores({ items: 'key, channel, published, [channel+published], upcoming' });
    v6.version(5).stores({ thumbnails: 'key, channel' });
    v6.version(6).stores({ dictionary: 'slice' });
    await v6.table('subscriptions').put({ key: 'youtube:a', source: 'youtube', title: 'A', handle: null, icon: null, avatar: null, types: ['video'], addedAt: 1, status: 'ready', secret: true });
    await v6.table('items').put({ key: 'youtube:v', channel: 'youtube:a', title: 'V', url: 'u', thumbnail: null, published: 1, type: 'video' });
    await v6.table('thumbnails').put({ key: 'youtube:v', channel: 'youtube:a', type: 'image/jpeg', data: new ArrayBuffer(3) });
    await v6.table('meta').bulkPut([
      { key: 'cursor', value: 42 },
      { key: 'theme', value: 'dark' },
    ]);
    v6.close();

    const db = new SubifyDb(name);

    expect(await db.subscriptions.get('youtube:a')).toMatchObject({ title: 'A', status: 'ready', secret: true });
    expect((await db.subscriptions.get('youtube:a'))?.slot).toBeUndefined();
    expect(await db.items.count()).toBe(1);
    expect(await db.thumbnails.count()).toBe(1);
    expect(await db.meta.get('cursor')).toBeUndefined();
    expect(await db.meta.get('theme')).toEqual({ key: 'theme', value: 'dark' });
  });
});
