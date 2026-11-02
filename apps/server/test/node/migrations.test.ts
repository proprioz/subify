import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openSqlite } from '../../src/node/sqlite';

const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));

describe('migrations on Node', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A self-hoster who pulls a new image must keep their catalog: the Node entry migrates both a new and an existing database.
  it('creates the schema on an empty database, then leaves an existing one and its data alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'subify-'));
    const path = join(dir, 'catalog.sqlite');

    const fresh = openSqlite(path);
    expect(migrate(fresh, migrations)).toEqual(['0001_slots.sql']);
    fresh.prepare('INSERT INTO vault (id, blob) VALUES (1, ?)').run(Buffer.from([1, 2, 3]));
    fresh.close();

    const reopened = openSqlite(path);
    expect(migrate(reopened, migrations)).toEqual([]);
    expect(reopened.prepare('SELECT id, blob FROM vault').all()).toEqual([{ id: 1, blob: Buffer.from([1, 2, 3]) }]);
    reopened.close();
  });

  // A database with migrations this directory doesn't have must stop the server with a message saying what to do, and never be half-converted.
  it('refuses a database with unknown migrations and leaves it unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 'subify-'));
    const path = join(dir, 'catalog.sqlite');
    const old = openSqlite(path);
    old.exec(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE channels (key TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO channels VALUES ('youtube:x', 'X');
    INSERT INTO d1_migrations (name) VALUES ('0001_catalog.sql'), ('0002_websub_requested_at.sql');`);
    old.close();
    const before = readFileSync(path);

    const sqlite = openSqlite(path);
    expect(() => migrate(sqlite, migrations)).toThrow(/^This database holds migrations this version of Subify doesn’t have/);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
      { name: 'channels' },
      { name: 'd1_migrations' },
    ]);
    sqlite.close();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
