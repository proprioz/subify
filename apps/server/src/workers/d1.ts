import { type BatchRows, checked, type Db, type SqlValue, type Statement, toStatement } from '../db/db';

/** Db over Cloudflare D1. Types come from @cloudflare/workers-types only through this file and the Worker entry. */
export class D1Adapter implements Db {
  constructor(private readonly d1: D1Database) {}

  async all<Row>(query: Statement<Row> | string, bound?: readonly SqlValue[]): Promise<Row[]> {
    const { sql, params } = toStatement(query, bound);
    const { results } = await this.d1.prepare(sql).bind(...params).all<Row>();

    return results.map(row);
  }

  async first<Row>(query: Statement<Row> | string, bound?: readonly SqlValue[]): Promise<Row | undefined> {
    const { sql, params } = toStatement(query, bound);

    const found = await this.d1.prepare(sql).bind(...params).first<Row>();

    return found === null ? undefined : row(found);
  }

  async run(query: Statement | string, bound?: readonly SqlValue[]): Promise<number> {
    const { sql, params } = toStatement(query, bound);
    const { meta } = await this.d1.prepare(sql).bind(...params).run();

    return meta.changes;
  }

  async batch<const S extends readonly Statement[]>(statements: S): Promise<BatchRows<S>> {
    if (statements.length === 0) {
      return [] as BatchRows<S>;
    }

    const results = await this.d1.batch(statements.map(checked).map(({ sql, params }) => this.d1.prepare(sql).bind(...params)));

    return results.map((result) => result.results.map(row)) as BatchRows<S>;
  }
}

/** D1 gives a BLOB back as an ArrayBuffer or an array of bytes: the app sees a Uint8Array, as on Node. */
function row<Row>(values: Row): Row {
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (value instanceof ArrayBuffer || Array.isArray(value)) {
      (values as Record<string, unknown>)[name] = new Uint8Array(value);
    }
  }

  return values;
}
