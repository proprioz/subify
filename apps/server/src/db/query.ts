import { type Compilable, type DatabaseConnection, DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { SqlValue, Statement } from './db';
import type { Database } from './schema';

/**
 * Kysely's DummyDriver answers `.execute()` with no rows and no error: a write run that way
 * would be silently dropped. This one refuses, so the mistake fails on the first test that
 * reaches it.
 */
class CompileOnlyDriver extends DummyDriver {
  override acquireConnection(): Promise<DatabaseConnection> {
    return Promise.reject(new Error('Kysely only compiles here: pass the query through compile() to Db.'));
  }
}

/**
 * Builds queries typed from schema.ts. It only compiles them, through a driver that refuses to
 * run anything: the Db adapters run the result, so D1 and SQLite keep one code path and a batch
 * stays one transaction.
 */
export const query = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new CompileOnlyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** A built query as a statement for Db, carrying the type of the rows it returns. */
export function compile<Row>(builder: Compilable<Row>): Statement<Row> {
  const { sql, parameters } = builder.compile();

  return { sql, params: parameters as readonly SqlValue[] };
}
