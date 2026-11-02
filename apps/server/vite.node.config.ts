import { defineConfig } from 'vite';

// Bundles the Node entry point and its dependencies into one file for the Docker image.
// better-sqlite3 loads a native binding at runtime: it stays external and is installed in the image.
export default defineConfig({
  build: {
    ssr: 'src/entry/node.ts',
    outDir: 'dist/node',
    target: 'node24',
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'node.js' },
    },
  },
  ssr: {
    noExternal: true,
    external: ['better-sqlite3'],
  },
});
