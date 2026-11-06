import { describe, expect, it, vi } from 'vitest';
import { ServerError } from '../src/data/api';
import { getMeta } from '../src/data/db';
import { unsubscribe } from '../src/data/subscriptions';
import { syncToTheEnd, syncUpdates, type Visibility } from '../src/data/sync';
import { channel, FakeServer, freshDb, many, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

async function followedA(server: FakeServer) {
  const db = freshDb();
  const api = server.api();
  await subscribe(db, api, A, NOW);

  return { db, api };
}

/** Publishes these videos one pass each, so that a sync gets them over several pages of the stream. */
function onePassEach(server: FakeServer, count: number): void {
  many(A, 'v', count).forEach((video) => server.publish(null, video));
}

/** The ids of the items kept, in order. */
async function ids(db: ReturnType<typeof freshDb>): Promise<string[]> {
  return (await db.items.toArray()).map((item) => item.key.slice(item.key.indexOf(':') + 1)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// iOS may suspend the app in the middle of a sync: there must be neither a duplicate nor a gap when it resumes.
describe('a sync cut short', () => {
  // After an absence, the latest videos matter most: they must be the first written, and a sync cut short must go on back from there.
  it('writes the newest page first and resumes back from the last one written', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const cursor = await getMeta<number>(db, 'streamPass');
    onePassEach(server, 25);
    server.encrypted.streamPage = 10;
    // The first request asks for the latest pass, the second brings the newest page.
    server.failStreamAt = 3;

    await expect(syncUpdates(db, api, NOW)).rejects.toThrow();
    expect(await ids(db)).toEqual(many(A, 'v', 25).slice(15).map((video) => video.key.slice(video.key.indexOf(':') + 1)));
    expect(await getMeta<number>(db, 'streamPass')).toBe(cursor);

    await syncUpdates(db, api, NOW);

    expect(await db.items.count()).toBe(25);
    expect(await getMeta<number>(db, 'streamPass')).toBe(server.encrypted.pass);
    expect(await getMeta(db, 'streamRun')).toBeUndefined();
  });

  // Read newest first, an older change comes after a newer one: it must not undo it.
  it('keeps the newest change of an item read before an older one', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const [video] = many(A, 'v', 1);
    // One pass a page: the passes are read from the last to the first.
    server.encrypted.streamPage = 1;
    server.publish(null, { ...video!, title: 'First title', upcoming: true });
    server.publish(channel(A, 'Old name'));
    server.publish(null, { ...video!, title: 'Final title' });
    server.publish(channel(A, 'New name'));

    await syncUpdates(db, api, NOW);

    expect(await db.items.get(video!.key)).toMatchObject({ title: 'Final title' });
    expect((await db.items.get(video!.key))?.upcoming).toBeUndefined();
    expect((await db.subscriptions.get(`youtube:${A}`))?.title).toBe('New name');
  });

  it('keeps the cursor when writing a page fails', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const before = await getMeta<number>(db, 'streamPass');
    server.publish(null, ...many(A, 'v', 5));
    const write = vi.spyOn(db.items, 'bulkPut').mockRejectedValueOnce(new Error('Quota exceeded'));

    await expect(syncUpdates(db, api, NOW)).rejects.toThrow('Quota exceeded');
    expect(await getMeta<number>(db, 'streamPass')).toBe(before);
    expect(await db.items.count()).toBe(0);

    write.mockRestore();
    await syncUpdates(db, api, NOW);
    expect(await db.items.count()).toBe(5);
  });

  it('writes an item received twice only once', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const cursor = await getMeta<number>(db, 'streamPass');
    server.publish(null, ...many(A, 'v', 3));

    await syncUpdates(db, api, NOW);
    await db.meta.put({ key: 'streamPass', value: cursor });
    await syncUpdates(db, api, NOW);

    expect(await db.items.count()).toBe(3);
  });
});

describe('what a sync keeps', () => {
  // Removing a channel while a sync is on its way must not bring its videos back into the feed.
  it('nothing of a channel removed meanwhile', async () => {
    const server = new FakeServer().publish(channel(A)).publish(channel(B));
    const { db, api } = await followedA(server);
    await subscribe(db, api, B, NOW);
    server.publish(null, ...many(A, 'a', 3), ...many(B, 'b', 4));
    const stream = api.stream.bind(api);
    api.stream = async (since, group) => {
      const page = await stream(since, group);
      await unsubscribe(db, `youtube:${B}`);

      return page;
    };

    await syncUpdates(db, api, NOW);

    expect(await db.items.where('channel').equals(`youtube:${A}`).count()).toBe(3);
    expect(await db.items.where('channel').equals(`youtube:${B}`).count()).toBe(0);
  });

  it('updates the name of a followed channel', async () => {
    const server = new FakeServer().publish(channel(A, 'Old name'));
    const { db, api } = await followedA(server);
    server.publish(channel(A, 'New name'));

    await syncUpdates(db, api, NOW);

    expect((await db.subscriptions.get(`youtube:${A}`))?.title).toBe('New name');
  });
});

/** A screen the test turns off and back on. */
class FakeScreen implements Visibility {
  private listeners = new Set<() => void>();
  private on = true;

  visible(): boolean {
    return this.on;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  set(on: boolean): void {
    this.on = on;
    this.listeners.forEach((listener) => listener());
  }
}

// A sync the user started must not be lost because they left the app while it ran, nor retried behind their back when it failed in front of them.
describe('a sync started by the user', () => {
  it('starts again once the app is back on screen when the phone dropped it off screen, and ends without a gap', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    onePassEach(server, 25);
    server.encrypted.streamPage = 10;
    server.failStreamAt = 3;
    const screen = new FakeScreen();
    let calls = 0;
    // The user leaves the app while the first page is on its way.
    server.onStream = (call) => {
      calls = call;

      if (call === 2) {
        screen.set(false);
      }
    };

    const done = syncToTheEnd(() => syncUpdates(db, api, NOW), screen);
    await vi.waitFor(() => expect(calls).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(3);
    expect(await db.items.count()).toBe(10);

    screen.set(true);
    await done;

    expect(await db.items.count()).toBe(25);
    expect(await getMeta<number>(db, 'streamPass')).toBe(server.encrypted.pass);
  });

  it('reports a failure while the app stayed on screen, without trying again', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    onePassEach(server, 25);
    server.encrypted.streamPage = 10;
    server.failStreamAt = 3;

    await expect(syncToTheEnd(() => syncUpdates(db, api, NOW), new FakeScreen())).rejects.toThrow();
    expect(await db.items.count()).toBe(10);
  });

  it('reports an answer from the server even if the app went off screen', async () => {
    const screen = new FakeScreen();
    let runs = 0;
    const run = async () => {
      runs += 1;
      screen.set(false);
      throw new ServerError('The server refused the request.', 'invalid_request');
    };

    await expect(syncToTheEnd(run, screen)).rejects.toThrow('refused');
    expect(runs).toBe(1);
  });
});
