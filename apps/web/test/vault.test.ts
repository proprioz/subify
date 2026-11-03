import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { SubifyDb } from '../src/data/db';
import { loadFeed } from '../src/data/feed';
import { forgetSecretChannels } from '../src/data/secret';
import { addBiometrics, createVault, forgetKeptKey, isAppPassword, LockedError, readKeyring, removeBiometrics, setLockAfter, setPassword, startVault, unlockWithBiometrics, unlockWithPassword } from '../src/data/vault';
import { channel, FakeServer, item, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const PASSWORD = 'correct horse';
const query = { types: { video: true, short: true, live: true }, showUpcoming: true, showSecret: true, channel: null, search: '', limit: 50 };

let count = 0;

/** Sealed at the first launch, without a password: the key stays on the device. */
async function firstLaunch() {
  const name = `vault-${++count}`;
  const server = new FakeServer().publish(channel(A), item(A, 'a1', 1)).publish(channel(B), item(B, 'b1', 2));
  const db = new SubifyDb(name);
  await subscribe(db, server.api(), A, NOW);
  await createVault(db);
  // Written after the sealing: sealed too.
  await subscribe(db, server.api(), B, NOW);
  await db.subscriptions.update(`youtube:${B}`, { secret: true });

  return { name, db };
}

async function sealedDb() {
  const { name, db } = await firstLaunch();
  await setPassword(db, PASSWORD);
  await setLockAfter(db, 'open');

  return { name, db };
}

/** Every row as IndexedDB holds it, read without the app's sealing. */
async function rawDump(name: string): Promise<string> {
  const raw = new Dexie(name);
  await raw.open();
  const rows = await Promise.all(raw.tables.map((table) => table.toArray()));
  raw.close();

  return JSON.stringify(rows, (_, value: unknown) => (value instanceof Uint8Array ? new TextDecoder('latin1').decode(value) : value));
}

// The promise the Privacy page makes: a copy of the device's database names no channel and no video.
describe('local database encryption', () => {
  it('leaves no channel id, title or video readable at rest, before and after the password', async () => {
    const { name, db } = await sealedDb();
    const dump = await rawDump(name);

    // Whole values only: two random letters can turn up in any ciphertext.
    for (const secret of [A, B, 'youtube:a1', 'Video a1', 'youtube:b1', 'Video b1', channel(A).title, channel(B).title]) {
      expect(dump).not.toContain(secret);
    }

    expect((await loadFeed(db, query)).entries.map((entry) => entry.item.key)).toEqual(['youtube:a1', 'youtube:b1']);
  });

  it('stays locked at the next launch until the right password, then reads by index again', async () => {
    const { name } = await sealedDb();
    const db = new SubifyDb(name);

    expect(await startVault(db)).toBe('locked');
    await expect(db.subscriptions.toArray()).rejects.toBeInstanceOf(LockedError);
    expect(await unlockWithPassword(db, 'wrong password')).toBe(false);
    expect(await isAppPassword(db, PASSWORD)).toBe(true);
    expect(await unlockWithPassword(db, PASSWORD)).toBe(true);

    expect(await db.items.where('channel').equals(`youtube:${A}`).primaryKeys()).toEqual(['youtube:a1']);
    await forgetSecretChannels(db);
    expect(await db.subscriptions.toCollection().primaryKeys()).toEqual([`youtube:${A}`]);
  });

  it('opens without asking only while “never” is chosen, and forgets the kept key otherwise', async () => {
    const { name, db } = await sealedDb();
    await setLockAfter(db, 'never');

    const next = new SubifyDb(name);
    expect(await startVault(next)).toBe('open');
    expect(await next.subscriptions.count()).toBe(2);

    await setLockAfter(next, 15);
    expect(await startVault(new SubifyDb(name))).toBe('locked');
  });

  it('locked by hand with “never”, asks for the password until it is typed, then opens without it again', async () => {
    const { name, db } = await sealedDb();
    await setLockAfter(db, 'never');
    await forgetKeptKey(db);

    const relaunched = new SubifyDb(name);
    expect(await startVault(relaunched)).toBe('locked');
    expect(await unlockWithPassword(relaunched, PASSWORD)).toBe(true);

    expect(await startVault(new SubifyDb(name))).toBe('open');
  });
});

// Without a password the app must still seal, and must never lock itself out of its own data.
describe('a device without a password', () => {
  const salt = new Uint8Array(32).fill(7);
  const output = new Uint8Array(32).fill(1);

  it('is sealed from the first launch, opens without asking, and refuses to lock with nothing to unlock it', async () => {
    const { name } = await firstLaunch();
    const dump = await rawDump(name);

    for (const secret of [A, B, 'Video a1', channel(B).title]) {
      expect(dump).not.toContain(secret);
    }

    const db = new SubifyDb(name);
    expect(await startVault(db)).toBe('open');
    expect(await db.subscriptions.count()).toBe(2);
    await expect(setLockAfter(db, 15)).rejects.toThrow();
    await expect(forgetKeptKey(db)).rejects.toThrow();
    expect(await startVault(new SubifyDb(name))).toBe('open');
  });

  it('locks with a passkey that gives the key, opens only with what it gives, and opens without asking once it is off', async () => {
    const { name, db } = await firstLaunch();
    await addBiometrics(db, 'credential-1', salt, output);
    await setLockAfter(db, 'open');

    const relaunched = new SubifyDb(name);
    expect(await startVault(relaunched)).toBe('locked');
    expect(await unlockWithBiometrics(relaunched, new Uint8Array(32).fill(2))).toBe(false);
    expect(await unlockWithBiometrics(relaunched, output)).toBe(true);
    expect(await relaunched.subscriptions.count()).toBe(2);

    await removeBiometrics(relaunched);
    expect(await startVault(new SubifyDb(name))).toBe('open');
    // Kept, so that turning it on again uses the same passkey instead of adding one.
    expect((await readKeyring(relaunched))?.passkey).toEqual({ credential: 'credential-1', salt });
  });

  it('can’t lock with a passkey that gives no key: it only shows secret channels', async () => {
    const { db } = await firstLaunch();
    await addBiometrics(db, 'credential-1', salt, null);

    await expect(setLockAfter(db, 'open')).rejects.toThrow();
  });

  it('keeps the password working after Face ID is turned off', async () => {
    const { name, db } = await sealedDb();
    await addBiometrics(db, 'credential-1', salt, output);
    await removeBiometrics(db);

    const relaunched = new SubifyDb(name);
    expect(await startVault(relaunched)).toBe('locked');
    expect(await unlockWithPassword(relaunched, PASSWORD)).toBe(true);
  });
});
