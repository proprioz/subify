import { ENTRY_DELAY } from '@subify/shared';
import type { SnapshotChannel } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { type Backup, restoreBackup } from '../src/data/backup';
import { getMeta } from '../src/data/db';
import { unfinishedSync } from '../src/data/encrypted';
import { followMany, followOne } from '../src/data/follow-many';
import { findChannel, follow } from '../src/data/subscriptions';
import { syncUpdates } from '../src/data/sync';
import { FakeCatalog } from './fake-catalog';
import { FakeServer, freshDb, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const HOUR = 60 * 60_000;

function snapshotChannel(id: string, itemCount: number, handle: string | null = null): SnapshotChannel {
  return {
    source: 'youtube',
    externalId: id,
    title: `Channel ${id}`,
    handle,
    avatar: null,
    items: Array.from({ length: itemCount }, (_, i) => ({ id: `${id.slice(2, 6)}${i}`, title: `Video ${i}`, published: NOW - i * HOUR, type: 'video' as const, upcoming: false, preview: null })),
    retryAt: null,
  };
}

function encryptedServer(catalog = new FakeCatalog()): { server: FakeServer; catalog: FakeCatalog } {
  const server = new FakeServer();
  server.encrypted = catalog;

  return { server, catalog };
}

/** Whether any request the app sent names this channel, in its URL or its body. */
function named(server: FakeServer, id: string): boolean {
  return server.requests.some((request) => request.url.includes(id) || (request.body ?? '').includes(id));
}

async function itemsOf(db: ReturnType<typeof freshDb>, id: string): Promise<string[]> {
  return (await db.items.where('channel').equals(`youtube:${id}`).toArray()).map((item) => item.title).sort();
}

describe('the encrypted catalog', () => {
  // The point of D16: a channel the catalog has is found and followed without the server learning which one.
  it('finds a channel by its id without naming it to the server', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 3), { [`${A.slice(2, 6)}0`]: { type: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) } });
    const db = freshDb();

    const subscription = await subscribe(db, server.api(), `https://www.youtube.com/channel/${A}`, NOW);

    expect(subscription).toMatchObject({ key: `youtube:${A}`, title: `Channel ${A}`, status: 'ready', slot: { keyId: 1 } });
    expect(await itemsOf(db, A)).toEqual(['Video 0', 'Video 1', 'Video 2']);
    expect(await db.thumbnails.count()).toBe(1);
    expect(await getMeta(db, 'streamPass')).toBe(catalog.pass);
    expect(named(server, A)).toBe(false);
    expect(server.paths).not.toContain('POST /api/add');
  });

  // A @handle goes through the handle index: it must lead to the right channel, still without naming it.
  it('finds a channel by its handle through the handle index', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(B, 1)).publish(snapshotChannel(A, 2, 'NewChannel'));
    const db = freshDb();

    const found = await findChannel(db, server.api(), '@newchannel');

    expect(found).toMatchObject({ submitted: { channel: { key: `youtube:${A}`, handle: 'NewChannel' } } });
    expect(named(server, A) || named(server, 'newchannel')).toBe(false);
  });

  // A name the dictionary doesn't list is the next try: its likely handles, guessed on the device, must find the channel without the name reaching the server.
  it('finds a channel by its name through the handles it likely has', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(B, 1, 'other')).publish(snapshotChannel(A, 2, 'lena_situations'));
    const db = freshDb();

    const found = await findChannel(db, server.api(), 'Léna Situations');

    expect(found).toMatchObject({ submitted: { channel: { key: `youtube:${A}` } } });
    expect(server.paths).not.toContain('POST /api/add');
    expect(named(server, 'situations') || named(server, 'Situations')).toBe(false);
  });

  // The set of chunks a name's guesses fall in would point the server to the name: spread guesses read the whole index, a single handle one chunk.
  it('reads every chunk of the handle index for a name, one chunk for a handle', async () => {
    const { server, catalog } = encryptedServer();
    catalog.handleChunks = 8;
    catalog.publish(snapshotChannel(A, 1, 'newchannel'));
    const db = freshDb();
    const chunksRead = () => server.paths.filter((path) => /^GET \/api\/handles\/\d+$/.test(path)).length;

    await findChannel(db, server.api(), '@newchannel');
    const forHandle = chunksRead();
    catalog.online.set('Some Unknown Name', snapshotChannel(B, 1));
    await findChannel(db, server.api(), 'Some Unknown Name');

    expect(forHandle).toBe(1);
    expect(chunksRead() - forHandle).toBe(8);
  });

  // When no guess is in the catalog, the server gets the name as before: it is the only way left to find the channel.
  it('sends the name in clear when no guessed handle is in the catalog', async () => {
    const { server, catalog } = encryptedServer();
    catalog.online.set('Léna Situations', snapshotChannel(A, 1, 'lenasituations'));
    const db = freshDb();

    const found = await findChannel(db, server.api(), 'Léna Situations');

    expect(found).toMatchObject({ submitted: { channel: { key: `youtube:${A}` } } });
    expect(server.posted('/api/add')).toEqual([{ url: 'Léna Situations' }]);
  });

  // The log the user reads while adding must tell the truth: a channel the catalog has is found without the step that sends it in clear, and a name gets that step only when it is sent.
  it('reports the steps a lookup really goes through', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(B, 1));
    catalog.online.set('Léna Situations', snapshotChannel(A, 1, 'lenasituations'));
    server.searchResults = [];
    const db = freshDb();
    const steps = async (input: string) => {
      const kinds: string[] = [];
      const before = server.paths.length;
      await findChannel(db, server.api(), input, { onStep: (step) => kinds.push(step.kind) });

      return { kinds, sent: server.paths.slice(before) };
    };

    const known = await steps(`https://www.youtube.com/channel/${B}`);
    const name = await steps('Léna Situations');

    expect(known.kinds).toEqual(['catalog', 'blind', 'group']);
    expect(known.sent).not.toContain('POST /api/add');
    expect(name.kinds).toEqual(['catalog', 'blind', 'handles', 'search', 'add']);
    expect(name.sent.slice(-2)).toEqual(['POST /api/search', 'POST /api/add']);
  });

  // The search services come after everything that names nothing: only a name the handle index doesn't know goes there, and its results are offered to choose from.
  it('searches a name on the server’s search services only when no guessed handle is in the catalog', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(B, 1, 'knownchannel'));
    server.searchResults = [{ id: A, name: 'Léna Situations', handle: 'lena', description: 'Vlogs' }];
    const db = freshDb();

    const known = await findChannel(db, server.api(), 'Known Channel');
    const searched = await findChannel(db, server.api(), 'Léna Situations');

    expect(known).toMatchObject({ submitted: { channel: { key: `youtube:${B}` } } });
    expect(searched).toEqual({ matches: [{ id: A, name: 'Léna Situations', handle: 'lena', description: 'Vlogs' }] });
    expect(server.posted('/api/search')).toEqual([{ q: 'Léna Situations' }]);
    expect(server.paths).not.toContain('POST /api/add');
  });

  // “Not listed?” after the search's results, or a search that found nothing, must still reach the last resort: the server's guessed handles.
  it('goes on to the server’s guessed handles when the search found nothing, or is skipped', async () => {
    const { server, catalog } = encryptedServer();
    catalog.online.set('Léna Situations', snapshotChannel(A, 1, 'lenasituations'));
    server.searchResults = [];
    const db = freshDb();

    const empty = await findChannel(db, server.api(), 'Léna Situations');
    server.searchResults = [{ id: B, name: 'Other', handle: null, description: '' }];
    const skipped = await findChannel(db, server.api(), 'Léna Situations', { search: false });

    expect(empty).toMatchObject({ submitted: { channel: { key: `youtube:${A}` } } });
    expect(skipped).toMatchObject({ submitted: { channel: { key: `youtube:${A}` } } });
    expect(server.posted('/api/search')).toHaveLength(1);
  });

  // A channel the catalog lacks is the only case where the server learns the link, and the device must still get it whole.
  it('adds a channel the catalog lacks by its link', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(B, 1));
    catalog.online.set('@newchannel', snapshotChannel(A, 4, 'newchannel'));
    const db = freshDb();

    const subscription = await subscribe(db, server.api(), '@newchannel', NOW);

    expect(subscription).toMatchObject({ key: `youtube:${A}`, status: 'ready' });
    expect(subscription.slot).toBeUndefined();
    expect(catalog.added).toEqual([`youtube:${A}`]);
    expect(await itemsOf(db, A)).toHaveLength(4);
  });

  // A server answering with another key than the one it publishes could tag the device: its answers must be refused.
  it('refuses an evaluation whose proof does not match the published key', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 1));
    catalog.otherKey = true;
    const db = freshDb();

    await expect(findChannel(db, server.api(), `https://www.youtube.com/channel/${A}`)).rejects.toThrow();
    expect(await db.subscriptions.count()).toBe(0);
  });

  // The stream is how followed channels stay up to date: a new video, a new title and a removed channel must all reach the device.
  it('applies the stream to the channels followed and to them only', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 1)).publish(snapshotChannel(B, 1));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, `https://www.youtube.com/channel/${A}`, NOW);
    catalog.passWith(
      { key: `youtube:${A}`, deltas: [{ kind: 'item', id: 'new1', title: 'New video', published: NOW, type: 'video', deleted: false, upcoming: false, preview: null }, { kind: 'channel', title: 'Renamed', handle: 'renamed' }] },
      { key: `youtube:${B}`, deltas: [{ kind: 'item', id: 'other', title: 'Not mine', published: NOW, type: 'video', deleted: false, upcoming: false, preview: null }] },
    );
    catalog.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'gone' }] });

    const result = await syncUpdates(db, api, NOW);

    expect(result.written).toBe(1);
    expect(await itemsOf(db, A)).toEqual(['New video', 'Video 0']);
    expect(await itemsOf(db, B)).toEqual([]);
    expect(await db.subscriptions.get(`youtube:${A}`)).toMatchObject({ title: 'Renamed', handle: 'renamed', status: 'gone' });
    expect(await getMeta(db, 'streamPass')).toBe(catalog.pass);
    expect(named(server, A)).toBe(false);
  });

  // A channel the server couldn't read yet shows when it is read again instead of an empty list, until its videos come.
  it('keeps the retry time of a channel without videos until the stream brings them', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish({ ...snapshotChannel(A, 0), retryAt: NOW + HOUR });
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, `https://www.youtube.com/channel/${A}`, NOW);

    expect(await db.subscriptions.get(`youtube:${A}`)).toMatchObject({ retryAt: NOW + HOUR });

    catalog.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'retry', retryAt: NOW + 2 * HOUR }] });
    await syncUpdates(db, api, NOW);
    expect(await db.subscriptions.get(`youtube:${A}`)).toMatchObject({ retryAt: NOW + 2 * HOUR });

    catalog.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'retry', retryAt: null }, { kind: 'item', id: 'first', title: 'First video', published: NOW, type: 'video', deleted: false, upcoming: false, preview: null }] });
    await syncUpdates(db, api, NOW);
    expect((await db.subscriptions.get(`youtube:${A}`))?.retryAt).toBeUndefined();
    expect(await itemsOf(db, A)).toEqual(['First video']);
  });

  // After an absence longer than the stream keeps, the passes missed are gone: the snapshots must fill the gap.
  it('catches up from the snapshots when the stream has expired', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 1));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, `https://www.youtube.com/channel/${A}`, NOW);
    catalog.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'item', id: 'missed', title: 'Missed video', published: NOW, type: 'video', deleted: false, upcoming: false, preview: null }] });
    catalog.passWith();
    catalog.keptFrom = catalog.pass;

    await syncUpdates(db, api, NOW);

    expect(await itemsOf(db, A)).toEqual(['Missed video', 'Video 0']);
    expect(await getMeta(db, 'streamPass')).toBe(catalog.pass);
  });

  // The safety net: a channel added in clear that never reached the catalog must be submitted again, but not before its first pass had time to run.
  // The server lets a new channel enter up to ENTRY_DELAY later: sent again sooner, it would be read and seen once more.
  it('puts a channel the catalog still lacks back in the queue once its entry time is past, never before', async () => {
    const { server, catalog } = encryptedServer();
    catalog.online.set('@newchannel', snapshotChannel(A, 1));
    catalog.online.set('@entered', snapshotChannel(B, 1));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, '@newchannel', NOW);
    await subscribe(db, api, '@entered', NOW);
    catalog.publish(snapshotChannel(B, 1));

    await syncUpdates(db, api, NOW + ENTRY_DELAY + 50 * 60_000);
    const early = await db.subscriptions.get(`youtube:${A}`);
    await syncUpdates(db, api, NOW + ENTRY_DELAY + 2 * HOUR);
    const snapshots = server.paths.filter((path) => path.startsWith('GET /api/snapshot')).length;
    await syncUpdates(db, api, NOW + ENTRY_DELAY + 3 * HOUR);

    expect(early).toMatchObject({ status: 'ready', slot: { keyId: 1 } });
    expect(await db.subscriptions.get(`youtube:${A}`)).toMatchObject({ status: 'pending_submit' });
    expect(await db.subscriptions.get(`youtube:${B}`)).toMatchObject({ status: 'ready' });
    expect((await db.subscriptions.get(`youtube:${B}`))?.submittedAt).toBeUndefined();
    expect(server.paths.filter((path) => path.startsWith('GET /api/snapshot'))).toHaveLength(snapshots);
  });

  // A restored backup lists every channel: those the catalog has must be filled without naming any, the others queued.
  it('restores a backup through the snapshots', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 2));
    const db = freshDb();

    const result = await followMany(db, server.api(), [{ key: `youtube:${A}`, title: 'Old A', handle: null }, { key: `youtube:${B}`, title: 'Old B', handle: null }], NOW);

    expect(result).toEqual({ known: 1, queued: 1, skipped: 0 });
    expect(await db.subscriptions.get(`youtube:${A}`)).toMatchObject({ title: `Channel ${A}`, status: 'ready' });
    expect(await db.subscriptions.get(`youtube:${B}`)).toMatchObject({ title: 'Old B', status: 'pending_submit' });
    expect(await itemsOf(db, A)).toHaveLength(2);
    expect(named(server, A) || named(server, B)).toBe(false);
  });

  // A backup holds no thumbnail: a restored device gets those of its channels' last 7 days from every group it read, with their blurred previews at once, and doesn't download again a week of lots that hold nothing more; following one channel from the dictionary mustn't cost every group's thumbnails.
  it('restores the thumbnails of the last 7 days and their previews from the groups read, and skips the lots they cover', async () => {
    const { server, catalog } = encryptedServer();
    const a = snapshotChannel(A, 2);
    a.items[0]!.preview = Uint8Array.of(1, 2, 3);
    catalog.publish(a, { [a.items[0]!.id]: { type: 'image/webp', bytes: new Uint8Array(2_000).fill(7) } });
    catalog.publish(snapshotChannel(B, 1));
    catalog.lotAt(catalog.hour - 30);
    const db = freshDb();
    const api = server.api();
    const backup: Backup = {
      channels: [{ key: `youtube:${A}`, title: 'Old A', handle: null, secret: false, types: ['video'] }],
      typeFilter: { video: true, short: true, live: true },
      showUpcoming: true,
      channelSort: 'recent',
      secretCodeHash: null,
      theme: 'system',
      checkConnection: false,
      thumbnailKeep: 30,
    };

    await restoreBackup(db, api, backup, NOW);

    // The restore ends with the channels, blurred; their thumbnails come with the refresh that follows.
    expect((await db.items.get(`youtube:${a.items[0]!.id}`))?.preview).toEqual(Uint8Array.of(1, 2, 3));
    expect(await db.thumbnails.count()).toBe(0);
    expect(await unfinishedSync(db)).toBe(true);

    await syncUpdates(db, api, NOW);
    expect(server.paths).toContain('GET /api/snapshot/thumbnails?group=0');
    expect((await db.thumbnails.get(`youtube:${a.items[0]!.id}`))?.data?.byteLength).toBe(2_000);
    expect(await db.thumbnails.count()).toBe(1);
    expect(await unfinishedSync(db)).toBe(false);
    expect(named(server, A)).toBe(false);
    // The first page of lots only: the hours before the restore are covered.
    expect(server.paths.filter((path) => path.startsWith('GET /api/lots'))).toEqual(['GET /api/lots?group=0']);
  });

  // A channel followed from the dictionary must come with its thumbnails as one typed would, and read its group alone rather than every group the device follows.
  it('follows a channel from the dictionary with its thumbnails, through its group alone, and queues one the catalog lacks', async () => {
    const { server, catalog } = encryptedServer();
    const b = snapshotChannel(B, 2);
    b.items[0]!.preview = Uint8Array.of(4, 5);
    catalog.publish(snapshotChannel(A, 1)).publish(b, { [b.items[0]!.id]: { type: 'image/webp', bytes: new Uint8Array(2_000).fill(8) } });
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, `https://www.youtube.com/channel/${A}`, NOW);
    const before = server.paths.length;

    expect(await followOne(db, api, { key: `youtube:${B}`, title: 'B', handle: null }, NOW)).toEqual({ known: 1, queued: 0, skipped: 0 });
    expect((await db.thumbnails.get(`youtube:${b.items[0]!.id}`))?.data?.byteLength).toBe(2_000);
    expect((await db.items.get(`youtube:${b.items[0]!.id}`))?.preview).toEqual(Uint8Array.of(4, 5));
    expect(server.paths.slice(before).filter((path) => path.startsWith('GET /api/snapshot'))).toEqual(['GET /api/snapshot?group=0', 'GET /api/snapshot/thumbnails?group=0']);
    expect(named(server, B)).toBe(false);

    const missing = 'UCcccccccccccccccccccccc';
    const asked = server.paths.length;
    expect(await followOne(db, api, { key: `youtube:${missing}`, title: 'C', handle: null }, NOW)).toEqual({ known: 0, queued: 1, skipped: 0 });
    expect(server.paths.slice(asked).filter((path) => path.startsWith('GET /api/snapshot'))).toEqual(['GET /api/snapshot?group=0']);
  });

  // Following a second channel must not move the cursor the first one relies on, or its changes in between would be lost.
  it('keeps the stream cursor when another channel is followed', async () => {
    const { server, catalog } = encryptedServer();
    catalog.publish(snapshotChannel(A, 1)).publish(snapshotChannel(B, 1));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, `https://www.youtube.com/channel/${A}`, NOW);
    const cursor = await getMeta<number>(db, 'streamPass');
    catalog.passWith({ key: `youtube:${A}`, deltas: [{ kind: 'item', id: 'between', title: 'Between', published: NOW, type: 'video', deleted: false, upcoming: false, preview: null }] });

    const found = await findChannel(db, api, `https://www.youtube.com/channel/${B}`);
    await follow(db, 'submitted' in found ? found.submitted : (undefined as never), NOW);
    const after = await getMeta<number>(db, 'streamPass');
    await syncUpdates(db, api, NOW);

    expect(after).toBe(cursor);
    expect(await itemsOf(db, A)).toEqual(['Between', 'Video 0']);
  });
});
