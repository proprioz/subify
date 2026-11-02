import { createHarness } from '#harness';
import { describe, expect, it } from 'vitest';
import { query } from '../../src/db/query';

function placeholders(count: number): string {
  return `SELECT 1 WHERE 1 IN (${Array.from({ length: count }, () => '?').join(', ')})`;
}

// SQLite takes thousands of parameters and D1 only 100: a statement over the limit must fail in
// the Node tests too, not only in production.
describe('bound parameters', () => {
  it('accepts 100 and refuses 101, alone or in a batch', async () => {
    const { db } = await createHarness();
    const params = (count: number) => Array.from({ length: count }, (_, i) => i);

    await expect(db.all(placeholders(100), params(100))).resolves.toEqual([{ 1: 1 }]);
    await expect(db.all(placeholders(101), params(101))).rejects.toThrow('at most 100');
    await expect(db.batch([{ sql: placeholders(101), params: params(101) }])).rejects.toThrow('at most 100');
  });
});

// The query builder only compiles: an `.execute()` that succeeded without running anything would
// silently drop a write.
describe('query builder', () => {
  it('refuses to run a query itself', async () => {
    await expect(query.deleteFrom('slots').execute()).rejects.toThrow('compile()');
  });
});
