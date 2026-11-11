import { describe, expect, it } from 'vitest';
import { forgetSecretChannels } from '../src/data/secret';
import { unsubscribe } from '../src/data/subscriptions';
import { deleteThumbnailsOlderThan, dropOldThumbnails, loadThumbnailKeep, setThumbnailKeep, thumbnailSpace } from '../src/data/thumbnails';
import { channel, FakeServer, freshDb, item, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const DAY = 24 * 60 * 60 * 1000;
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function followed(server: FakeServer) {
  const db = freshDb();
  const api = server.api();
  await subscribe(db, api, A, NOW);

  return { db, api };
}

// The device keeps thumbnails for what the user scrolls through, not six months of videos.
describe('kept thumbnails', () => {
  it('come with the channel’s snapshot', async () => {
    const server = new FakeServer().publish(channel(A), item(A, 'v', 1)).thumbnail('youtube:v', `youtube:${A}`, IMAGE);
    const { db } = await followed(server);

    expect(new Uint8Array((await db.thumbnails.get('youtube:v'))!.data!)).toEqual(IMAGE);
  });

  it('are dropped once their videos leave the window', async () => {
    const server = new FakeServer().publish(channel(A), item(A, 'v', 1)).thumbnail('youtube:v', `youtube:${A}`, IMAGE);
    const { db } = await followed(server);

    await dropOldThumbnails(db, NOW);
    expect(await db.thumbnails.count()).toBe(1);
    await dropOldThumbnails(db, NOW + 30 * DAY);

    expect(await db.thumbnails.count()).toBe(0);
  });

  it('stay as long as the user chose, and a shorter time deletes them at once', async () => {
    const server = new FakeServer().publish(channel(A), item(A, 'v', 1)).thumbnail('youtube:v', `youtube:${A}`, IMAGE);
    const { db } = await followed(server);
    await setThumbnailKeep(db, 90, NOW);

    await dropOldThumbnails(db, NOW + 60 * DAY);
    expect(await db.thumbnails.count()).toBe(1);

    await setThumbnailKeep(db, 30, NOW + 60 * DAY);
    expect(await db.thumbnails.count()).toBe(0);
  });
});

// The cleanup frees space now without changing what the device keeps from then on.
describe('deleting older thumbnails', () => {
  it('deletes only those past the age chosen, upcoming ones aside', async () => {
    const server = new FakeServer()
      .publish(channel(A), item(A, 'old', 40), item(A, 'new', 1), { ...item(A, 'soon', 50), upcoming: true })
      .thumbnail('youtube:old', `youtube:${A}`, IMAGE)
      .thumbnail('youtube:new', `youtube:${A}`, IMAGE)
      .thumbnail('youtube:soon', `youtube:${A}`, IMAGE);
    const { db } = await followed(server);
    await setThumbnailKeep(db, 365, NOW);
    expect(await db.thumbnails.count()).toBe(3);

    await deleteThumbnailsOlderThan(db, 30, NOW);

    expect((await db.thumbnails.toCollection().primaryKeys()).sort()).toEqual(['youtube:new', 'youtube:soon']);
    expect(await loadThumbnailKeep(db)).toBe(365);
  });
});

// The numbers in Settings must not hint at hidden secret channels.
describe('thumbnail space', () => {
  it('leaves hidden secret channels out', async () => {
    const server = new FakeServer()
      .publish(channel(A), item(A, 'a1', 40))
      .publish(channel(B), item(B, 'b1', 40), item(B, 'b2', 2))
      .thumbnail('youtube:a1', `youtube:${A}`, IMAGE)
      .thumbnail('youtube:b1', `youtube:${B}`, IMAGE)
      .thumbnail('youtube:b2', `youtube:${B}`, IMAGE);
    const { db, api } = await followed(server);
    await subscribe(db, api, B, NOW);
    await setThumbnailKeep(db, 365, NOW);
    await db.subscriptions.update(`youtube:${B}`, { secret: true });
    const size = IMAGE.byteLength;

    expect(await thumbnailSpace(db, false, NOW)).toEqual({ used: size, perDay: 0, olderThan: { 30: size, 90: 0, 180: 0, 365: 0 } });
    expect(await thumbnailSpace(db, true, NOW)).toEqual({ used: 3 * size, perDay: size / 30, olderThan: { 30: 2 * size, 90: 0, 180: 0, 365: 0 } });
  });
});

// Removing a channel must leave no trace of what it was, a secret one above all.
describe('thumbnails of a removed channel', () => {
  async function twoChannels() {
    const server = new FakeServer()
      .publish(channel(A), item(A, 'a1', 1))
      .publish(channel(B), item(B, 'b1', 1))
      .thumbnail('youtube:a1', `youtube:${A}`, IMAGE)
      .thumbnail('youtube:b1', `youtube:${B}`, IMAGE);
    const { db, api } = await followed(server);
    await subscribe(db, api, B, NOW);

    return db;
  }

  it('go when it is unfollowed', async () => {
    const db = await twoChannels();

    await unsubscribe(db, `youtube:${A}`);

    expect(await db.thumbnails.toCollection().primaryKeys()).toEqual(['youtube:b1']);
  });

  it('go when the secret code is forgotten', async () => {
    const db = await twoChannels();
    await db.subscriptions.update(`youtube:${B}`, { secret: true });

    await forgetSecretChannels(db);

    expect(await db.thumbnails.toCollection().primaryKeys()).toEqual(['youtube:a1']);
  });
});

// The avatar is shown from the device: it must come with the channel the user follows.
describe('channel avatars', () => {
  it('come with the channel', async () => {
    const server = new FakeServer().publish({ ...channel(A), avatar: 'data:image/jpeg;base64,AAAA' });
    const { db } = await followed(server);

    expect((await db.subscriptions.get(`youtube:${A}`))?.avatar).toBe('data:image/jpeg;base64,AAAA');
  });
});
