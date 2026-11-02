import type { Context } from 'hono';
import type { Config } from './config';

/**
 * What tells one Subify server from another (docs/FEATURES.md, §2 “Instance”): the installed
 * app's name, from INSTANCE_NAME, and its icon. The official server, recognized by the host the
 * request came to, keeps the red icon; every other host gets the same icon in blue, so that a
 * self-hosted app is never mistaken for the official one on a home screen. The app's build is the
 * same for every server: the manifest and the icon links are answered here, at request time.
 */

export const OFFICIAL_HOST = 'subify.tv';

/** The icon files, in both colours, under /icons/red/ and /icons/blue/ in the PWA's build. */
export const ICON_FILES = new Set(['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png']);

function iconSet(c: Context): 'red' | 'blue' {
  return new URL(c.req.url).hostname === OFFICIAL_HOST ? 'red' : 'blue';
}

/** Where an icon of this server is: index.html and the manifest name /api/icons/{file}, which leads here. */
export function iconPath(c: Context, file: string): string {
  return `/icons/${iconSet(c)}/${file}`;
}

export function manifest(c: Context, config: Config & { instanceName: string }) {
  return {
    id: '/feed',
    name: config.instanceName,
    short_name: config.instanceName,
    description: 'The latest videos of your channels, and nothing else. No account, no recommendations.',
    start_url: '/feed',
    scope: '/',
    display: 'standalone',
    background_color: '#fafafa',
    theme_color: '#fafafa',
    icons: [
      { src: iconPath(c, 'pwa-192.png'), sizes: '192x192', type: 'image/png' },
      { src: iconPath(c, 'pwa-512.png'), sizes: '512x512', type: 'image/png' },
      { src: iconPath(c, 'pwa-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
