import type { NewChannel } from '../src/data/encrypted';
import { describe, expect, it } from 'vitest';
import { getMeta } from '../src/data/db';
import { AlreadyFollowing, findChannel, follow, unsubscribe } from '../src/data/subscriptions';
import { channel, FakeServer, freshDb, item, many, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';

describe('following a channel', () => {
  // Closing the results without following must leave the device as it was: no channel, no items, no cursor.
  it('stores nothing until the user follows what was found', async () => {
    const server = new FakeServer().online('@newchannel', channel(A, 'New'), many(A, 'a', 4));
    const db = freshDb();

    const found = await findChannel(db, server.api(), '@newchannel');

    expect(found).toMatchObject({ submitted: { channel: { key: `youtube:${A}` } } });
    expect(await db.subscriptions.count()).toBe(0);
    expect(await db.items.count()).toBe(0);
    expect(await getMeta(db, 'streamPass')).toBeUndefined();
  });

  // A second subscription to the same channel would show every video twice; the results show it as followed instead.
  it('finds a channel already followed, whatever the link, without going online for its id', async () => {
    const server = new FakeServer().online('@newchannel', channel(A, 'New'));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, '@newchannel', NOW);
    const sent = server.paths.length;

    expect(await findChannel(db, api, `https://www.youtube.com/channel/${A}`)).toMatchObject({ following: { key: `youtube:${A}` } });
    expect(server.paths).toHaveLength(sent);
    expect(await findChannel(db, api, '@newchannel')).toMatchObject({ following: { key: `youtube:${A}` } });
  });

  // The results may stay open while an import adds the same channel: following it again must not duplicate it.
  it('refuses to follow a channel added since it was found', async () => {
    const server = new FakeServer().online('@newchannel', channel(A, 'New'));
    const db = freshDb();
    const api = server.api();
    const found = await findChannel(db, api, '@newchannel');
    await subscribe(db, api, '@newchannel', NOW);

    await expect(follow(db, (found as { submitted: NewChannel }).submitted, NOW)).rejects.toBeInstanceOf(AlreadyFollowing);
    expect(await db.subscriptions.count()).toBe(1);
  });
});

// With nothing left to follow, the next channel must start the stream from its own snapshot, not catch up from an old cursor.
describe('the stream cursor', () => {
  it('is forgotten once the last channel is removed', async () => {
    const server = new FakeServer().publish(channel(A), item(A, 'a0', 0));
    const db = freshDb();
    await subscribe(db, server.api(), A, NOW);

    await unsubscribe(db, `youtube:${A}`);

    expect(await getMeta(db, 'streamPass')).toBeUndefined();
    expect(await db.items.count()).toBe(0);
  });
});
