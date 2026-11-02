import { describe, expect, it } from 'vitest';
import { Api } from '../src/data/api';
import { followMany, runImportQueue } from '../src/data/follow-many';
import { SubifyDb } from '../src/data/db';
import { channel, FakeServer, freshDb, item, NOW } from './fake-server';

const ids = Array.from({ length: 4 }, (_, i) => `UC${String(i).repeat(22)}`);
const toFollow = ids.map((id) => ({ key: `youtube:${id}`, title: `Channel ${id}`, handle: null }));

function serverKnowing(...known: string[]): FakeServer {
  const server = new FakeServer();
  known.forEach((id) => server.publish(channel(id), item(id, `${id}-v`, 1)));
  ids.forEach((id) => server.online(id, channel(id), [item(id, `${id}-v`, 1)]));

  return server;
}

describe('following many channels', () => {
  // An import must not cost the server a read online for channels its catalog already has, nor name any of them.
  it('fills the known ones at once and queues the others, without submitting anything', async () => {
    const server = serverKnowing(ids[0]!, ids[1]!);
    const db = freshDb();

    expect(await followMany(db, server.api(), toFollow, NOW)).toEqual({ known: 2, queued: 2, skipped: 0 });
    expect(server.paths).not.toContain('POST /api/add');
    expect(server.requests.some((request) => ids.some((id) => request.url.includes(id) || (request.body ?? '').includes(id)))).toBe(false);
    expect(await db.items.count()).toBe(2);
  });

  // The server refuses an evaluation of another size than BLIND_BATCH_SIZES: a long restored list would fail as a whole.
  it('evaluates a long list in batches the server accepts', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `UC${String(i).padStart(22, '0')}`);
    const server = new FakeServer();
    long.slice(0, 60).forEach((id) => server.publish(channel(id)));
    const db = freshDb();

    const result = await followMany(db, server.api(), long.map((id) => ({ key: `youtube:${id}`, title: id, handle: null })), NOW);

    expect(result).toEqual({ known: 60, queued: 60, skipped: 0 });
    expect(server.posted<{ blinded: string[] }>('/api/oprf/evaluate').map((body) => body.blinded.length)).toEqual([50, 50, 50]);
  });

  // Each new channel costs the server several reads online: the queue sends them one per call, in the list's order.
  it('submits queued channels one at a time', async () => {
    const server = serverKnowing();
    const db = freshDb();
    const api = server.api();
    await followMany(db, api, toFollow, NOW);

    expect(await runImportQueue(db, api, NOW)).toBe('done');
    expect(await runImportQueue(db, api, NOW)).toBe('done');

    expect(server.posted('/api/add')).toEqual([{ url: ids[0] }, { url: ids[1] }]);
    expect((await db.subscriptions.get(`youtube:${ids[0]}`))?.status).toBe('ready');
    expect(await db.items.where('channel').equals(`youtube:${ids[0]}`).count()).toBe(1);
  });

  // The app is often closed before the queue is done: it must carry on at the next launch.
  it('resumes after the app restarts', async () => {
    const server = serverKnowing();
    const name = `queue-${Math.random()}`;
    const first = new SubifyDb(name);
    await followMany(first, server.api(), toFollow, NOW);
    await runImportQueue(first, server.api(), NOW);
    first.close();

    const reopened = new SubifyDb(name);

    while ((await runImportQueue(reopened, server.api(), NOW)) === 'done');

    expect(await reopened.subscriptions.where('status').equals('pending_submit').count()).toBe(0);
    expect(server.posted('/api/add')).toHaveLength(4);
  });

  it('marks a channel the server cannot find, and keeps the others going', async () => {
    const server = serverKnowing();
    server.encrypted.online.delete(ids[0]!);
    const db = freshDb();
    await followMany(db, server.api(), toFollow.slice(0, 2), NOW);

    await runImportQueue(db, server.api(), NOW);

    expect((await db.subscriptions.get(`youtube:${ids[0]}`))?.status).toBe('failed');
    expect(await runImportQueue(db, server.api(), NOW)).toBe('done');
    expect((await db.subscriptions.get(`youtube:${ids[1]}`))?.status).toBe('ready');
  });

  // While the server or the network is down, retrying at every tick would hammer it for nothing.
  it('waits a while after a failure it may recover from', async () => {
    const server = serverKnowing();
    const db = freshDb();
    await followMany(db, server.api(), toFollow.slice(0, 1), NOW);
    const offline = new Api(async () => {
      throw new TypeError('Offline');
    });

    expect(await runImportQueue(db, offline, NOW)).toBe('done');
    expect(await runImportQueue(db, server.api(), NOW + 60_000)).toBe('waiting');
    expect((await db.subscriptions.get(`youtube:${ids[0]}`))?.status).toBe('pending_submit');
  });

  // A server that says it is busy for an hour would otherwise be asked again every five minutes.
  it('waits as long as a busy server asks', async () => {
    const server = serverKnowing();
    const db = freshDb();
    await followMany(db, server.api(), toFollow.slice(0, 1), NOW);
    const busy = new Api(async () => new Response('Too many requests', { status: 429, headers: { 'Retry-After': '3600' } }));

    expect(await runImportQueue(db, busy, NOW)).toBe('done');
    expect(await runImportQueue(db, server.api(), NOW + 30 * 60_000)).toBe('waiting');
    expect(await runImportQueue(db, server.api(), NOW + 61 * 60_000)).toBe('done');
    expect((await db.subscriptions.get(`youtube:${ids[0]}`))?.status).toBe('ready');
  });
});
