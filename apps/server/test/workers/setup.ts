import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// The same migration files as Node, applied to the local D1 before the Workers tests run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
