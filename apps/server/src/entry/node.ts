import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp } from '../app';
import { MemoryCoordinator } from '../catalog/coordinator';
import { loadConfig } from '../config';
import { deriveKeys } from '../crypto/keys';
import { DetachedWork } from '../node/detached-work';
import { smtpMailer } from '../node/mail';
import { startScheduler } from '../node/scheduler';
import { loadMasterSecret } from '../node/secret';
import { migrate, openSqlite, SqliteAdapter } from '../node/sqlite';
import { serveWeb } from '../node/web';
import { systemClock, type Platform } from '../platform';
import { sources } from '../sources';
import { runDueTasks } from '../tasks';

/**
 * Node entry point, for development and the self-hosted Docker image. It applies the database
 * migrations at startup, serves the API and, when WEB_DIST is set, the built PWA on the same
 * origin. It never logs requests.
 */

const port = Number(process.env.PORT ?? 8787);
const webDist = process.env.WEB_DIST ?? '';
const databasePath = process.env.DATABASE_PATH ?? 'data/subify.sqlite';
// Next to src/ in development, next to dist/ in the build and the Docker image.
const migrationsDir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../migrations', import.meta.url));

mkdirSync(dirname(databasePath), { recursive: true });
const sqlite = openSqlite(databasePath);
let applied: string[];

try {
  applied = migrate(sqlite, migrationsDir);
} catch (error) {
  console.error(`${databasePath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(', ')}`);
}

const config = loadConfig(process.env);

// Every server names itself (docs/SELF-HOSTING.md): its app would otherwise pass for another one.
if (config.instanceName === null) {
  console.error('INSTANCE_NAME is not set: give this server a name (see docs/SELF-HOSTING.md).');
  process.exit(1);
}
// Next to the database by default, in a file of its own: back it up apart from the database,
// since a copy of both reveals the catalog.
const master = loadMasterSecret(process.env.MASTER_SECRET?.trim() || null, process.env.SECRET_PATH ?? join(dirname(databasePath), 'subify.secret'));

if (master.generated) {
  console.log('Generated a master secret: back it up, apart from the database');
}

const keys = deriveKeys(master.secret);

const detached = new DetachedWork();

const platform: Platform = {
  clock: systemClock,
  fetch: (url, init) => fetch(url, init),
  afterResponse: (work) => detached.track(work),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  db: new SqliteAdapter(sqlite),
  config,
  keys,
  coordinator: new MemoryCoordinator(),
  // The contact form's messages go out through the admin's mail account (docs/SELF-HOSTING.md).
  mailer: process.env.SMTP_URL?.trim() ? smtpMailer(process.env.SMTP_URL.trim()) : null,
};

const api = createApp({ sources });
const root = new Hono();

root.all('/api/*', (c) => api.fetch(c.req.raw, { platform }));

if (webDist !== '') {
  serveWeb(root, webDist);
}

const server = serve({ fetch: root.fetch, port }, () => {
  console.log(`Subify server listening on port ${port}`);
});

const scheduler = startScheduler({
  intervalMs: 60_000,
  tick: () => runDueTasks(platform, sources),
});

async function shutdown(): Promise<void> {
  await scheduler.stop();
  server.close();
  await detached.settle();
  sqlite.close();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
