/**
 * The one database interface the app uses. D1Adapter (Workers) and SqliteAdapter (Node, Docker,
 * tests) implement it over the same SQL, which must stay compatible with D1: SQLite dialect, at
 * most 100 bound parameters per statement.
 */

/** A BLOB is bound and read as a Uint8Array on both runtimes. */
export type SqlValue = string | number | Uint8Array | null;

export interface Statement<Row = unknown> {
  sql: string;
  params: readonly SqlValue[];
  /** Never set: carries the type of the rows the statement returns (see compile in query.ts). */
  readonly rows?: Row;
}

/** The adapters' side of the overloads below: a statement, or SQL and its parameters. */
export function toStatement<Row>(query: Statement<Row> | string, params: readonly SqlValue[] = []): Statement<Row> {
  return checked(typeof query === 'string' ? { sql: query, params } : query);
}

/**
 * Refuses a statement D1 would refuse, on every runtime. SQLite takes thousands of parameters, so
 * without this a statement over D1's limit would pass every Node test and fail only in production.
 */
export function checked<S extends Statement>(statement: S): S {
  if (statement.params.length > MAX_PARAMS) {
    throw new Error(`A statement binds ${statement.params.length} parameters; D1 accepts at most ${MAX_PARAMS}.`);
  }

  return statement;
}

/** The rows each statement of a batch returns, in order. */
export type BatchRows<S extends readonly Statement[]> = { -readonly [K in keyof S]: S[K] extends Statement<infer Row> ? Row[] : never };

/**
 * The app's code passes statements built with query.ts, typed from the schema. Plain SQL is left
 * to the tests, which read the database as it is.
 */
export interface Db {
  all<Row>(query: Statement<Row>): Promise<Row[]>;
  all<Row>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  first<Row>(query: Statement<Row>): Promise<Row | undefined>;
  first<Row>(sql: string, params?: readonly SqlValue[]): Promise<Row | undefined>;
  /** Runs one write and returns how many rows it changed. */
  run(query: Statement): Promise<number>;
  run(sql: string, params?: readonly SqlValue[]): Promise<number>;
  /**
   * Runs the statements in order, in one transaction: all of them or none. Returns each
   * statement's rows (empty for writes). Reads in a batch see one consistent state.
   */
  batch<const S extends readonly Statement[]>(statements: S): Promise<BatchRows<S>>;
  /** Rewrites the database file so that its layout keeps no trace of past writes. Node only: D1 manages its own storage. */
  compact?(): Promise<void>;
}

/** D1 refuses more bound parameters than this in one statement. */
export const MAX_PARAMS = 100;
