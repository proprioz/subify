import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The tests in test/shared run twice: on Node (better-sqlite3) and in workerd (local D1), each
 * through its own `#harness`. `pnpm test:all` runs both projects; a change that breaks one
 * runtime fails there.
 */
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        resolve: { alias: { '#harness': local('./test/harness/node.ts') } },
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/shared/**/*.test.ts', 'test/node/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
            // wrangler.toml names no instance: the tests give the Worker a name. PUBLIC_BASE_URL,
            // WIKIDATA_USER_AGENT and SEARCH_SOURCES stay empty, whatever wrangler.toml says: with them, the Cron Trigger test would turn WebSub on and could ask the hub to
            // subscribe, query Wikidata, or read the Invidious and Piped lists, and no test may reach
            // the network. MASTER_SECRET is a test value, the tests'
            // own (test/harness/common.ts): the Worker refuses to serve without one.
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(local('./migrations')),
                INSTANCE_NAME: 'Subify test',
                PUBLIC_BASE_URL: '',
                WIKIDATA_USER_AGENT: '',
                SEARCH_SOURCES: 'none',
                MASTER_SECRET: 'Xl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl4=',
              },
            },
          }),
        ],
        resolve: { alias: { '#harness': local('./test/harness/workers.ts') } },
        test: {
          name: 'workers',
          include: ['test/shared/**/*.test.ts', 'test/workers/**/*.test.ts'],
          setupFiles: ['./test/workers/setup.ts'],
          // @cloudflare/vitest-plugin 1.4 cannot read Vitest 5's on-disk module cache yet.
          fsModuleCache: false,
        },
      },
    ],
  },
}));
