import { fileURLToPath } from 'node:url';
import { migrate, openSqlite, SqliteAdapter } from '../../src/node/sqlite';
import { buildHarness } from './common';
import type { Harness, HarnessOptions } from './types';

export type { Harness } from './types';

const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const sqlite = openSqlite(':memory:');
  migrate(sqlite, migrations);
  const pending: Promise<unknown>[] = [];

  return buildHarness(
    new SqliteAdapter(sqlite),
    options,
    async (app, request, bindings) => {
      const response = await app.request(request, undefined, bindings);
      await Promise.all(pending.splice(0));

      return response;
    },
    (work) => pending.push(work),
  );
}
