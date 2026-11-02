// Types for `cloudflare:workers` in the Workers tests: the main module's exports and bindings.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('../src/entry/worker');
  }

  interface Env {
    DB: D1Database;
    COORDINATOR: DurableObjectNamespace<import('../src/workers/coordinator').CoordinatorObject>;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** A test value, set in vitest.config.ts. */
    MASTER_SECRET: string;
  }
}
