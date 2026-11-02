import { describe, expect, it } from 'vitest';
import { loadFeed } from '../src/data/feed';
import { checkSecretCode, forgetSecretChannels, setSecretCode } from '../src/data/secret';
import { channel, FakeServer, freshDb, item, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const query = { types: { video: true, short: true, live: true }, showUpcoming: true, channel: null, search: '', limit: 50 };

async function withSecretB() {
  const server = new FakeServer().publish(channel(A), item(A, 'a1', 1)).publish(channel(B), item(B, 'b1', 2));
  const db = freshDb();
  await subscribe(db, server.api(), A, NOW);
  await subscribe(db, server.api(), B, NOW);
  await db.subscriptions.update(`youtube:${B}`, { secret: true });

  return db;
}

// The feature's whole point: a secret channel and its videos stay out of the feed until the user shows them.
describe('secret channels', () => {
  it('are left out of the feed unless shown', async () => {
    const db = await withSecretB();

    expect((await loadFeed(db, { ...query, showSecret: false })).entries.map((e) => e.item.key)).toEqual(['youtube:a1']);
    expect((await loadFeed(db, { ...query, showSecret: true })).entries).toHaveLength(2);
  });

  it('are removed with their videos when the code is forgotten', async () => {
    const db = await withSecretB();
    await setSecretCode(db, '2468');

    await forgetSecretChannels(db);

    expect(await db.subscriptions.count()).toBe(1);
    expect(await db.items.where('channel').equals(`youtube:${B}`).count()).toBe(0);
    expect(await checkSecretCode(db, '2468', NOW)).toMatchObject({ ok: false });
  });
});

// Guessing a 4-digit code takes seconds without a delay between attempts.
describe('the secret code', () => {
  it('makes the user wait after five wrong codes, longer each time', async () => {
    const db = freshDb();
    await setSecretCode(db, '2468');

    for (let i = 0; i < 4; i++) {
      expect(await checkSecretCode(db, '0000', NOW)).toEqual({ ok: false, waitUntil: null });
    }

    expect(await checkSecretCode(db, '0000', NOW)).toEqual({ ok: false, waitUntil: NOW + 30_000 });
    expect(await checkSecretCode(db, '2468', NOW + 10_000)).toEqual({ ok: false, waitUntil: NOW + 30_000 });
    expect(await checkSecretCode(db, '0000', NOW + 30_000)).toEqual({ ok: false, waitUntil: NOW + 90_000 });
    expect(await checkSecretCode(db, '2468', NOW + 90_000)).toEqual({ ok: true });
  });

  it('is stored only as a hash', async () => {
    const db = freshDb();
    await setSecretCode(db, '2468');

    expect(JSON.stringify(await db.meta.toArray())).not.toContain('2468');
  });

  it('refuses codes that are not 4 to 8 digits', async () => {
    await expect(setSecretCode(freshDb(), '12a4')).rejects.toThrow();
    await expect(setSecretCode(freshDb(), '123')).rejects.toThrow();
  });
});
