import { type AppEnv, createApp } from '../../src/app';
import { MemoryCoordinator } from '../../src/catalog/coordinator';
import { deriveKeys } from '../../src/crypto/keys';
import type { Db } from '../../src/db/db';
import type { AfterResponse, Platform } from '../../src/platform';
import { sources as defaultSources } from '../../src/sources';
import {
  type Config,
  DEFAULT_BLIND_BATCHES_PER_MINUTE,
  DEFAULT_MESSAGES_PER_DAY,
  DEFAULT_MESSAGES_PER_HOUR,
  DEFAULT_NEW_CHANNELS_PER_DAY,
  DEFAULT_NEW_CHANNELS_PER_HOUR,
  DEFAULT_ONLINE_LOOKUPS_PER_MINUTE,
  DEFAULT_POLL_BATCH_SIZE,
  DEFAULT_SEEDED_CHANNELS_PER_DAY,
  DEFAULT_SEARCH_DECOYS_PER_HOUR,
  DEFAULT_WIKIDATA_REFRESH_DAYS,
} from '../../src/config';
import { FakeFetch } from '../support/fake-fetch';
import { type Harness, type HarnessOptions, START } from './types';

const defaultConfig: Config = {
  instanceName: 'Subify test',
  commit: null,
  operatorName: null,
  operatorContact: null,
  messagesTo: null,
  messagesFrom: null,
  messagesPerHour: DEFAULT_MESSAGES_PER_HOUR,
  messagesPerDay: DEFAULT_MESSAGES_PER_DAY,
  publicBaseUrl: null,
  contactUrl: null,
  pollBatchSize: DEFAULT_POLL_BATCH_SIZE,
  // The recorded feeds hold videos years old: tests that are not about retention keep them all.
  retentionDays: 100 * 365,
  newChannelsPerHour: DEFAULT_NEW_CHANNELS_PER_HOUR,
  newChannelsPerDay: DEFAULT_NEW_CHANNELS_PER_DAY,
  onlineLookupsPerMinute: DEFAULT_ONLINE_LOOKUPS_PER_MINUTE,
  blindBatchesPerMinute: DEFAULT_BLIND_BATCHES_PER_MINUTE,
  seededChannelsPerDay: DEFAULT_SEEDED_CHANNELS_PER_DAY,
  searchSources: new Set(['wikidata']),
  // Without it nothing reads Wikidata: the dictionary's tests set one.
  wikidataUserAgent: null,
  wikidataRefreshDays: DEFAULT_WIKIDATA_REFRESH_DAYS,
  invidiousInstances: null,
  pipedInstances: null,
  searchDecoysPerHour: DEFAULT_SEARCH_DECOYS_PER_HOUR,
};

/** The tests' master secret: any 32 bytes do. */
const TEST_SECRET = new Uint8Array(32).fill(0x5e);

/** The part of a harness that does not depend on the runtime. */
export async function buildHarness(
  db: Db,
  options: HarnessOptions,
  send: (app: ReturnType<typeof createApp>, request: Request, bindings: AppEnv['Bindings']) => Promise<Response>,
  afterResponse: AfterResponse,
): Promise<Harness> {
  await resetCatalog(db);

  const fake = options.fake ?? new FakeFetch();
  let now = START;
  const platform: Platform = {
    clock: { now: () => now },
    fetch: fake.fetch,
    afterResponse,
    sleep: async () => {},
    random: () => 0.5,
    db,
    config: { ...defaultConfig, ...options.config },
    keys: deriveKeys(TEST_SECRET),
    coordinator: new MemoryCoordinator(() => now),
    mailer: options.mailer ?? null,
  };
  let countryReads = 0;
  const { country } = options;
  const bindings: AppEnv['Bindings'] = {
    platform,
    ...(country === undefined
      ? {}
      : {
          connectionCountry: () => {
            countryReads += 1;

            return country;
          },
        }),
  };
  const app = createApp({ sources: options.sources ?? defaultSources });
  const request = (path: string, init?: RequestInit) => send(app, new Request(new URL(path, 'http://localhost'), init), bindings);
  const post = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  return {
    request,
    post,
    add: (url) => post('/api/add', { url }),
    db,
    platform,
    fake,
    setNow: (ms) => {
      now = ms;
    },
    dump: async () => {
      const tables = await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      );
      const rows = await Promise.all(tables.map(async ({ name }) => [name, await db.all(`SELECT * FROM "${name}"`)]));

      return JSON.stringify(rows);
    },
    countryReads: () => countryReads,
  };
}

/** Each test starts from an empty catalog, on both runtimes (the D1 database outlives a test). */
async function resetCatalog(db: Db): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM slots', params: [] },
    { sql: 'DELETE FROM vault', params: [] },
    { sql: 'DELETE FROM thumbnails', params: [] },
    { sql: 'DELETE FROM stream', params: [] },
    { sql: 'DELETE FROM handles', params: [] },
    { sql: 'DELETE FROM dictionary', params: [] },
    { sql: 'DELETE FROM dictionary_state', params: [] },
  ]);
}
