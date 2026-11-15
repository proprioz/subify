import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The commit the app is built from, shown in Settings as its version: `COMMIT`, as for the server,
 * else the checkout's own. Null when neither says, as in a copy of the code without its history.
 */
function commit(): string | null {
  try {
    const id = process.env.COMMIT || execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    return /^[0-9a-f]{7,40}$/.test(id) ? id.slice(0, 7) : null;
  } catch {
    return null;
  }
}

export default defineConfig({
  define: {
    __COMMIT__: JSON.stringify(commit()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The server answers the manifest, for the name and icon of the server it is (apps/server/src/instance.ts).
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        // The API is never answered from the service worker: the app reads its data from Dexie.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    // In development the Node server runs on its own port; the PWA reaches it on the same origin.
    // docker-compose.yml points API_PROXY_TARGET at the server container.
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:8787',
    },
  },
});
