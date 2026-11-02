import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { type BatchRows, checked, type Db, type SqlValue, type Statement, toStatement } from '../db/db';

/** Db over better-sqlite3, for Node, the Docker image and the Node tests. */
export class SqliteAdapter implements Db {
  constructor(readonly sqlite: Database.Database) {}

  async all<Row>(query: Statement<Row> | string, bound?: readonly SqlValue[]): Promise<Row[]> {
    const { sql, params } = toStatement(query, bound);

    return (this.sqlite.prepare(sql).all(...bind(params)) as Record<string, unknown>[]).map(row) as Row[];
  }

  async first<Row>(query: Statement<Row> | string, bound?: readonly SqlValue[]): Promise<Row | undefined> {
    const { sql, params } = toStatement(query, bound);

    const found = this.sqlite.prepare(sql).get(...bind(params)) as Record<string, unknown> | undefined;

    return (found === undefined ? undefined : row(found)) as Row | undefined;
  }

  async run(query: Statement | string, bound?: readonly SqlValue[]): Promise<number> {
    const { sql, params } = toStatement(query, bound);

    return this.sqlite.prepare(sql).run(...bind(params)).changes;
  }

  async batch<const S extends readonly Statement[]>(statements: S): Promise<BatchRows<S>> {
    return this.sqlite.transaction(() =>
      statements.map(checked).map(({ sql, params }) => {
        const prepared = this.sqlite.prepare(sql);

        if (prepared.reader) {
          return (prepared.all(...bind(params)) as Record<string, unknown>[]).map(row);
        }

        prepared.run(...bind(params));

        return [];
      }),
    )() as BatchRows<S>;
  }

  async compact(): Promise<void> {
    this.sqlite.exec('VACUUM');
  }
}

/** better-sqlite3 binds a BLOB only from a Buffer: a view over the same bytes, not a copy. */
function bind(params: readonly SqlValue[]): unknown[] {
  return params.map((value) => (value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value));
}

/** A BLOB comes back as a Buffer: the app sees a plain Uint8Array, as on D1. */
function row(values: Record<string, unknown>): Record<string, unknown> {
  for (const [name, value] of Object.entries(values)) {
    if (Buffer.isBuffer(value)) {
      values[name] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  }

  return values;
}

/** Opens a database with the settings D1 has: foreign keys on. WAL lets reads go on during a write. */
export function openSqlite(path: string): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');

  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }

  return sqlite;
}

/**
 * Applies the migrations in `directory` that this database has not seen yet, each in its own
 * transaction, and records them in the same table `wrangler d1 migrations` uses. Safe on an
 * empty database and on one that already holds a catalog. A database that recorded a migration
 * this directory doesn't have holds tables this version can't read: it is refused rather than
 * changed, so nothing is half-converted, and the error says what to do.
 */
export function migrate(sqlite: Database.Database, directory: string): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);

  const applied = new Set(
    (sqlite.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((row) => row.name),
  );
  const known = readdirSync(directory).filter((name) => name.endsWith('.sql'));

  if ([...applied].some((name) => !known.includes(name))) {
    throw new Error(
      'This database holds migrations this version of Subify doesn’t have, so it can’t be used. Delete the database file and start again: devices add their channels back on their own.',
    );
  }

  const pending = known.filter((name) => !applied.has(name)).sort();

  for (const name of pending) {
    const sql = readFileSync(join(directory, name), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    })();
  }

  return pending;
}
