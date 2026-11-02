import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
