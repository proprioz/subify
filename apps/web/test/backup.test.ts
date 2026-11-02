import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportBackup, readBackup, restoreBackup } from '../src/data/backup';
import { BackupError, seal } from '../src/data/backup-cipher';
import { connectionCheckOn, setConnectionCheck } from '../src/data/connection-check';
import { getMeta, setMeta } from '../src/data/db';
import { loadShowUpcoming, loadTypeFilter } from '../src/data/feed';
import { checkSecretCode, setSecretCode } from '../src/data/secret';
import { channel, FakeServer, freshDb, item, NOW } from './fake-server';

const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ';
const KURZGESAGT = 'UCsXVk37bltHxD1rDPwtNM8Q';
const PASSWORD = 'correct horse battery';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** A sealed backup carrying this payload, as anyone with a password could write by hand. */
function sealedBackup(payload: Record<string, unknown>): Promise<string> {
  return seal(JSON.stringify({ version: 1, exportedAt: '2026-10-20T00:00:00Z', channels: [], typeFilter: { video: true, live: true, short: true }, ...payload }), PASSWORD);
}

// A backup is often the user's only copy: a file in any format version must keep restoring.
// backup-v1.json is a file in format version 1 and must never be regenerated.
describe('a backup in format version 1', () => {
  it('opens with its password and restores channels, filters, sort, theme and the secret code', async () => {
    const server = new FakeServer().publish(channel(NASA, 'NASA'), item(NASA, 'n1', 1));
    server.online(KURZGESAGT, channel(KURZGESAGT, 'Kurzgesagt'), [item(KURZGESAGT, 'k1', 2)]);
    const db = freshDb();

    const backup = await readBackup(fixture('backup-v1.json'), PASSWORD);
    const result = await restoreBackup(db, server.api(), backup, NOW);

    expect(result).toEqual({ known: 1, queued: 1, skipped: 0 });
    expect(await db.subscriptions.get(`youtube:${NASA}`)).toMatchObject({ status: 'ready', types: ['video', 'live'], secret: false });
    expect(await db.subscriptions.get(`youtube:${KURZGESAGT}`)).toMatchObject({ status: 'pending_submit', secret: true, handle: 'kurzgesagt' });
    expect(await loadTypeFilter(db)).toEqual({ video: true, short: true, live: false });
    expect(await loadShowUpcoming(db)).toBe(false);
    expect(await getMeta(db, 'channelSort')).toBe('name');
    expect(await getMeta(db, 'theme')).toBe('dark');
    expect(await checkSecretCode(db, '2468', NOW)).toEqual({ ok: true });
    expect(await connectionCheckOn(db)).toBe(false);
  });

  it('refuses a wrong password without touching the device', async () => {
    await expect(readBackup(fixture('backup-v1.json'), 'not the password')).rejects.toThrow('Wrong password');
  });

  it.each([
    ['a file that is not a backup', '{"hello": 1}'],
    ['a sealed file whose limits were raised', fixture('backup-v1.json').replace('"memlimit": 67108864', '"memlimit": 1073741824')],
    ['broken JSON', '{"format": "subify-backup"'],
  ])('refuses %s', async (_, file) => {
    await expect(readBackup(file, PASSWORD)).rejects.toThrow(BackupError);
  });
});

// The device computes the backup's hash at every unlock: one asking for gigabytes of memory or
// hundreds of passes would freeze the app each time the user types the code.
describe('the secret code hash of a backup', () => {
  it.each([
    ['Argon2id asking for 4 GiB', '$argon2id$v=19$m=4194304,t=2,p=1$c29tZXNhbHQ$aGFzaA'],
    ['Argon2id asking for 100 passes', '$argon2id$v=19$m=19456,t=100,p=1$c29tZXNhbHQ$aGFzaA'],
    ['Argon2i', '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA'],
    ['a broken hash', '$argon2id$short'],
  ])('refuses %s', async (_, hash) => {
    await expect(readBackup(await sealedBackup({ secretCodeHash: hash }), PASSWORD)).rejects.toThrow('The secret code in this backup is invalid.');
  });

  it('accepts this app’s hashes', async () => {
    const db = freshDb();
    await setSecretCode(db, '2468');

    await expect(readBackup(await sealedBackup({ secretCodeHash: await getMeta<string>(db, 'secretCodeHash') }), PASSWORD)).resolves.toBeDefined();
  });
});

// The backup is the user's only copy of their subscriptions: a round trip must lose nothing.
describe('this app’s backups', () => {
  it('give back channels, kinds, secrets, filters, sort, code, theme and the connection check', async () => {
    const server = new FakeServer().publish(channel(NASA, 'NASA'), item(NASA, 'n1', 1)).publish(channel(KURZGESAGT, 'Kurzgesagt'), item(KURZGESAGT, 'k1', 1));
    const source = freshDb();
    await restoreBackup(source, server.api(), await readBackup(fixture('backup-v1.json'), PASSWORD), NOW);
    await source.subscriptions.update(`youtube:${NASA}`, { types: ['live'] });
    await setSecretCode(source, '97531');
    await setMeta(source, 'theme', 'light');
    await setConnectionCheck(source, true);
    await setMeta(source, 'showUpcoming', true);

    const file = await exportBackup(source, 'a long password', NOW);
    const target = freshDb();
    await restoreBackup(target, server.api(), await readBackup(file, 'a long password'), NOW);

    const strip = (db: typeof source) => db.subscriptions.toArray().then((all) => all.map(({ key, title, types, secret, handle }) => ({ key, title, types, secret, handle })));
    expect(await strip(target)).toEqual(await strip(source));
    expect(await loadTypeFilter(target)).toEqual(await loadTypeFilter(source));
    expect(await loadShowUpcoming(target)).toBe(true);
    expect(await getMeta(target, 'channelSort')).toBe('name');
    expect(await getMeta(target, 'theme')).toBe('light');
    expect(await connectionCheckOn(target)).toBe(true);
    expect(await checkSecretCode(target, '97531', NOW)).toEqual({ ok: true });
    expect(file).not.toContain('NASA');
  });

  it('need a password of 8 characters at least', async () => {
    await expect(exportBackup(freshDb(), 'short', NOW)).rejects.toThrow(BackupError);
  });
});
