import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openSqlite } from '../../src/node/sqlite';

const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Columns a CHECK constraint narrows further than their SQL type, and the type they get. */
const NARROWED: Record<string, string> = {};

const SQL_TYPES: Record<string, string> = { INTEGER: 'number', TEXT: 'string', BLOB: 'Uint8Array' };

function interfaceName(table: string): string {
  return `${table.replace(/(^|_)(\w)/g, (_, __, letter: string) => letter.toUpperCase())}Table`;
}

function withoutRowid(sqlite: ReturnType<typeof openSqlite>, table: string): boolean {
  const { sql } = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };

  return /WITHOUT\s+ROWID\s*$/i.test(sql.trim());
}

/**
 * The Kysely types of the database the migrations build. A column with a default (or an integer
 * primary key, which SQLite fills) is Generated: an insert may leave it out.
 */
function generateSchema(): string {
  const sqlite = openSqlite(':memory:');
  migrate(sqlite, migrations);
  const tables = (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name")
      .all() as { name: string }[]
  ).map(({ name }) => name);

  const interfaces = tables.map((table) => {
    const columns = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((column) => {
      let type = NARROWED[`${table}.${column.name}`] ?? SQL_TYPES[column.type];

      if (type === undefined) {
        throw new Error(`No TypeScript type for ${table}.${column.name} (${column.type})`);
      }

      if (column.notnull === 0 && column.pk === 0) {
        type += ' | null';
      }

      // An integer primary key is the rowid, which SQLite fills, unless the table has none.
      if (column.dflt_value !== null || (column.pk === 1 && column.type === 'INTEGER' && !withoutRowid(sqlite, table))) {
        type = `Generated<${type}>`;
      }

      return `  ${column.name}: ${type};`;
    });

    return `export interface ${interfaceName(table)} {\n${columns.join('\n')}\n}`;
  });
  sqlite.close();

  return [
    '// Generated from migrations/ by test/node/db-schema.test.ts: do not edit. After a migration, run',
    '// `pnpm --filter @subify/server exec vitest run --project node -u` to update it.',
    '',
    "import type { ItemType } from '@subify/shared';",
    "import type { Generated } from 'kysely';",
    '',
    ...interfaces.flatMap((declaration) => [declaration, '']),
    'export interface Database {',
    ...tables.map((table) => `  ${table}: ${interfaceName(table)};`),
    '}',
    '',
  ].join('\n');
}

// Queries are typed from src/db/schema.ts: a migration that changes a column without updating it would let a query read a column that no longer exists, or the wrong type, unnoticed.
describe('the database types', () => {
  it('match the migrations (run `pnpm --filter @subify/server exec vitest run --project node -u` after a migration)', async () => {
    await expect(generateSchema()).toMatchFileSnapshot('../../src/db/schema.ts');
  });
});
