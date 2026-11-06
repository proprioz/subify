import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from '#harness';
import { toBase64Url } from '@subify/shared/codec';
import { blind, channelInput } from '@subify/shared/oprf';
import { runPass } from '../../src/catalog/pass';
import { MINUTE } from '../../src/catalog/schedule';
import { readState } from '../../src/catalog/vault';
import { START } from '../harness/types';
import { FakeSource, item } from '../support/fake-source';

const MARKER = '203.0.113.77';

// The core promise: the server never learns who asks. An IP header sent to any route must end up nowhere.
describe('IP headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never reach a response, the database or the logs', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => logged.push(...args));
    }

    const harness = await createHarness({ sources: [new FakeSource().channel('a', [item('v1', Date.UTC(2026, 9, 1))])] });
    const headers = {
      'CF-Connecting-IP': MARKER,
      'X-Forwarded-For': MARKER,
      'X-Real-IP': MARKER,
      'True-Client-IP': MARKER,
      Forwarded: `for=${MARKER}`,
    };
    const post = (path: string, body: unknown) =>
      harness.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const responses = [
      await post('/api/add', { url: 'fake:a' }),
      await post('/api/add', { url: 'nope' }),
      await harness.request('/api/oprf', { headers }),
      await harness.request('/api/stream?since=0&group=0', { headers }),
      await harness.request('/api/snapshot?group=0&thumbnails=0', { headers }),
      await harness.request('/api/handles', { headers }),
      await harness.request('/api/health', { headers }),
      await harness.request('/api/connection', { headers }),
      await harness.request('/api/missing', { headers }),
    ];

    for (const response of responses) {
      expect(await response.text()).not.toContain(MARKER);
      expect([...response.headers.values()].join(' ')).not.toContain(MARKER);
    }

    expect(await harness.dump()).not.toContain(MARKER);
    expect(JSON.stringify(logged)).not.toContain(MARKER);
  });
});

// A device that syncs, restores or finds a channel by its handle names no channel, and the server must keep nothing of what it asked: these routes write nothing at all.
describe('the encrypted catalog’s read routes', () => {
  it('leave the database exactly as it was', async () => {
    const source = new FakeSource().channel('a', [item('v1', Date.UTC(2026, 9, 1))]);
    const harness = await createHarness({ sources: [source] });
    const keys = await harness.platform.keys;
    const options = { firstTableSize: 8, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };
    await runPass(harness.platform, keys, undefined, options);
    await harness.add('fake:a');
    harness.setNow(START + 10 * MINUTE);
    await runPass(harness.platform, keys, await readState(harness.db, keys), options, [source]);
    const before = await harness.dump();
    const blinded = blind([channelInput('fake', 'a'), ...Array.from({ length: 9 }, () => crypto.getRandomValues(new Uint8Array(32)))]).blinded;

    const statuses = [
      await harness.post('/api/oprf/evaluate', { blinded: blinded.map(toBase64Url) }),
      await harness.request('/api/stream?since=0&group=0'),
      await harness.request('/api/snapshot?group=0&thumbnails=1'),
      await harness.request('/api/handles'),
      await harness.request('/api/handles/0'),
    ].map((response) => response.status);

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(await harness.dump()).toBe(before);
  });
});

/**
 * Every column the catalog may have. A new column fails this test on purpose: whoever adds one
 * has to add it here, and check it holds nothing about users.
 */
const ALLOWED_COLUMNS = {
  slots: ['id', 'blob'],
  vault: ['id', 'blob'],
  thumbnails: ['position', 'blob'],
  stream: ['position', 'blob'],
  handles: ['position', 'blob'],
  lots: ['position', 'blob'],
  // Public data from Wikidata, the same for everyone.
  dictionary: ['slice', 'data'],
  dictionary_state: ['id', 'next_slice', 'next_at', 'version'],
  d1_migrations: ['id', 'name', 'applied_at'],
};

// Keeps user data from creeping into the schema unnoticed.
describe('database schema', () => {
  it('has exactly the reviewed tables and columns, none about clients', async () => {
    const harness = await createHarness();
    const tables = await harness.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    );
    const schema: Record<string, string[]> = Object.fromEntries(
      await Promise.all(
        tables.map(async ({ name }) => [name, (await harness.db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [name])).map((c) => c.name)]),
      ),
    );

    expect(schema).toEqual(ALLOWED_COLUMNS);

    const words = Object.values(schema).flat().flatMap((column) => column.split('_'));
    const aboutClients = ['ip', 'user', 'client', 'device', 'session', 'cookie', 'token', 'agent', 'subscriber', 'address', 'fingerprint'];
    expect(words.filter((word) => aboutClients.includes(word))).toEqual([]);
  });
});
