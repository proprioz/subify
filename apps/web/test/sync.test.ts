import { describe, expect, it, vi } from 'vitest';
import { ServerError } from '../src/data/api';
import { groupOf } from '@subify/shared/oprf';
import { getMeta, setMeta } from '../src/data/db';
import { syncThumbnails, unfinishedSync } from '../src/data/encrypted';
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
    server.encrypted.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'retry', retryAt: NOW + 60_000 }] });
    server.encrypted.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'retry', retryAt: NOW + 120_000 }] });

    await syncUpdates(db, api, NOW);

    expect(await db.items.get(video!.key)).toMatchObject({ title: 'Final title' });
    expect((await db.items.get(video!.key))?.upcoming).toBeUndefined();
    expect((await db.subscriptions.get(`youtube:${A}`))?.title).toBe('New name');
    expect((await db.subscriptions.get(`youtube:${A}`))?.retryAt).toBe(NOW + 120_000);
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

// The cursor a device sends would tie its refreshes together: it names only the 12 hours its last refresh fell in.
describe('what a sync tells the server', () => {
  it('reads from its cursor rounded down to 72 passes, and writes the new videos once', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    onePassEach(server, 80);
    await syncUpdates(db, api, NOW);
    const cursor = await getMeta<number>(db, 'streamPass');
    many(A, 'w', 3).forEach((video) => server.publish(null, video));
    const sinces: number[] = [];
    const stream = api.stream.bind(api);
    api.stream = async (since, group) => {
      sinces.push(since);

      return stream(since, group);
    };

    await syncUpdates(db, api, NOW);

    expect(cursor! % 72).not.toBe(0);
    // After the request for the latest pass alone.
    expect(sinces.slice(1)).toEqual([cursor! - (cursor! % 72)]);
    expect(await db.items.count()).toBe(83);
    expect(await getMeta<number>(db, 'streamPass')).toBe(server.encrypted.pass);
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

// Videos that arrive after a channel was added get their thumbnails from the hourly lots alone (docs/FEATURES.md, D3): a wrong one, one missed, or a week read again at every refresh would each break that.
describe('thumbnails from the lots', () => {
  const image = (fill: number) => ({ type: 'image/webp' as const, bytes: new Uint8Array(2_000).fill(fill) });
  const thumbnail = async (db: ReturnType<typeof freshDb>, id: string) => {
    const kept = await db.thumbnails.get(`youtube:${id}`);

    return (kept?.data ?? null) === null ? undefined : new Uint8Array(kept!.data!)[0];
  };

  it('keeps those of the followed channels’ videos from the last week of lots, and asks again only for the hours it lacks', async () => {
    const server = new FakeServer().publish(channel(A)).publish(channel(B));
    const { db, api } = await followedA(server);
    const [recent, older, tooOld] = many(A, 'a', 3);
    const [other] = many(B, 'b', 1);
    server.publish(null, recent!, older!, tooOld!, other!);
    const lots = server.encrypted;
    lots
      .lotAt(lots.hour - 1, { key: `youtube:${A}`, itemId: idOf(recent!.key), image: image(1) }, { key: `youtube:${B}`, itemId: idOf(other!.key), image: image(2) })
      .lotAt(lots.hour - 100, { key: `youtube:${A}`, itemId: idOf(older!.key), image: image(3) })
      .lotAt(lots.hour - 170, { key: `youtube:${A}`, itemId: idOf(tooOld!.key), image: image(4) });

    await syncUpdates(db, api, NOW);

    expect(await thumbnail(db, idOf(recent!.key))).toBe(1);
    expect(await thumbnail(db, idOf(older!.key))).toBe(3);
    expect(await thumbnail(db, idOf(tooOld!.key))).toBeUndefined();
    expect(await thumbnail(db, idOf(other!.key))).toBeUndefined();
    // A week in pages of 6 hours, the newest first.
    const asked = server.paths.filter((path) => path.startsWith('GET /api/lots'));
    expect(asked).toHaveLength(1 + 27);
    expect(asked.slice(0, 3)).toEqual(['GET /api/lots?group=0', `GET /api/lots?group=0&until=${lots.hour - 6}`, `GET /api/lots?group=0&until=${lots.hour - 12}`]);

    // An hour later, only the new hour, and the current one, which had no lot yet.
    lots.hour++;
    await syncUpdates(db, api, NOW);
    expect(server.paths.filter((path) => path.startsWith('GET /api/lots'))).toHaveLength(asked.length + 1);
  });

  // A refresh cut short in its thumbnails must be offered again at the next launch, and go on from the hours it read.
  it('resumes after a refresh cut short in its thumbnails', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const [video] = many(A, 'a', 1);
    server.publish(null, video!);
    server.encrypted.lotAt(server.encrypted.hour - 50, { key: `youtube:${A}`, itemId: idOf(video!.key), image: image(5) });
    const lots = api.lots.bind(api);
    let calls = 0;
    api.lots = async (group, until) => {
      if (++calls === 3) {
        throw new ServerError('The app was suspended.', 'network');
      }

      return lots(group, until);
    };

    await expect(syncUpdates(db, api, NOW)).rejects.toThrow();
    expect(await unfinishedSync(db)).toBe(true);
    expect(await thumbnail(db, idOf(video!.key))).toBeUndefined();

    await syncUpdates(db, api, NOW);
    expect(await thumbnail(db, idOf(video!.key))).toBe(5);
    expect(await unfinishedSync(db)).toBe(false);
    // The two pages read before the cut aren't asked for again.
    expect(calls).toBe(3 + 1 + 26);
  });

  // A growth step splits every group in two: the hours read for a group hold the lots of its parts, and asking for a week of them again would cost each device up to 100 MB for nothing.
  it('keeps the hours read when the groups split, and starts over only when they merge', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const lots = server.encrypted;
    const week = Array.from({ length: 168 }, (_, i) => lots.hour - i);
    const asked = () => server.paths.filter((path) => path.startsWith('GET /api/lots'));
    const group = groupOf((await db.subscriptions.get(`youtube:${A}`))!.slot!.id, 2);

    await setMeta(db, 'lotsRead', { groups: 1, hours: { 0: week } });
    await setMeta(db, 'streamGroups', 2);
    await syncThumbnails(db, api, NOW);
    // The first page only, which every refresh asks for to learn the current hour.
    expect(asked()).toEqual([`GET /api/lots?group=${group}`]);
    expect(await getMeta(db, 'lotsRead')).toEqual({ groups: 2, hours: { [group]: week } });

    await setMeta(db, 'streamGroups', 1);
    await syncThumbnails(db, api, NOW);
    expect(asked()).toHaveLength(1 + 28);
  });

  // The blurred preview shows only while the item keeps its ThumbHash: a later change of its title carries none.
  it('keeps an item’s preview when a later change carries none', async () => {
    const server = new FakeServer().publish(channel(A));
    const { db, api } = await followedA(server);
    const preview = Uint8Array.from({ length: 19 }, (_, i) => i);
    const delta = { kind: 'item' as const, id: 'p1', title: 'First', published: NOW, type: 'video' as const, deleted: false, upcoming: false };
    server.encrypted.passWith({ key: `youtube:${A}`, deltas: [{ ...delta, preview }] });
    await syncUpdates(db, api, NOW);
    server.encrypted.passWith({ key: `youtube:${A}`, deltas: [{ ...delta, title: 'Renamed', preview: null }] });
    await syncUpdates(db, api, NOW);

    expect(await db.items.get('youtube:p1')).toMatchObject({ title: 'Renamed', preview });
  });
});

function idOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}
