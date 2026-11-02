/**
 * Fills the development catalog with the recorded NASA and Kurzgesagt channels, through the
 * real addition and pass code but without any request: handy to try the app offline or while
 * YouTube's feeds are down. Run it while the dev server is stopped. Never used in production.
 *
 *   pnpm --filter @subify/server dev:seed
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addByLink } from '../src/catalog/add';
import { MemoryCoordinator } from '../src/catalog/coordinator';
import { runPass } from '../src/catalog/pass';
import { readState } from '../src/catalog/vault';
import { loadConfig } from '../src/config';
import { deriveKeys } from '../src/crypto/keys';
import { loadMasterSecret } from '../src/node/secret';
import { migrate, openSqlite, SqliteAdapter } from '../src/node/sqlite';
import { type Platform, systemClock } from '../src/platform';
import { sources } from '../src/sources';
import { NASA_AVATAR } from '../test/fixtures/ids';
import { FakeFetch } from '../test/support/fake-fetch-core';
import { registerRecorded } from '../test/support/recorded';

const databasePath = process.env.DATABASE_PATH ?? 'data/subify.sqlite';
mkdirSync(dirname(databasePath), { recursive: true });
const sqlite = openSqlite(databasePath);
migrate(sqlite, fileURLToPath(new URL('../migrations', import.meta.url)));

const file = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');
const recorded = registerRecorded(new FakeFetch(), {
  nasaChannel: file('nasa-channel.xml'),
  nasaVideos: file('nasa-videos.xml'),
  nasaShorts: file('nasa-shorts.xml'),
  nasaLives: file('nasa-lives.xml'),
  nasaPage: file('nasa-page.html'),
  oembedNasa: file('oembed-nasa.json'),
  kurzgesagtChannel: file('kurzgesagt-channel.xml'),
  kurzgesagtVideos: file('kurzgesagt-videos.xml'),
  kurzgesagtShorts: file('kurzgesagt-shorts.xml'),
  kurzgesagtLives: file('kurzgesagt-lives.html'),
  page404: file('page-404.html'),
  // The real avatar, not the tests' made-up one: the running server reads it within minutes.
}).on(NASA_AVATAR, { status: 503 });

// The dev server's own secret: it reads back what this writes.
const keys = deriveKeys(loadMasterSecret(process.env.MASTER_SECRET?.trim() || null, process.env.SECRET_PATH ?? join(dirname(databasePath), 'subify.secret')).secret);
const platform: Platform = {
  clock: systemClock,
  fetch: recorded.fetch,
  afterResponse: () => {},
  sleep: async () => {},
  random: Math.random,
  db: new SqliteAdapter(sqlite),
  config: loadConfig(process.env),
  keys,
  coordinator: new MemoryCoordinator(),
    mailer: null,
};
const resolved = await keys;

// A new catalog's first pass only lays out its decoys.
if ((await readState(platform.db, resolved)) === undefined) {
  await runPass(platform, resolved, undefined, {}, sources);
}

for (const url of ['@NASA', 'https://www.youtube.com/channel/UCsXVk37bltHxD1rDPwtNM8Q']) {
  await addByLink(platform, resolved, sources, url);
  console.log(`Read ${url}`);
}

// The channels wait in this script's coordinator: a pass gives them their slots.
await runPass(platform, resolved, await readState(platform.db, resolved), {}, sources);
console.log('The channels are in the catalog.');
