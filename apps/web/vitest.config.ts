import { defineConfig } from 'vitest/config';

// The data layer is tested on Node, with fake-indexeddb standing in for the browser's IndexedDB.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
