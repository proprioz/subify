import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Serves the built PWA as Workers assets do: every file with the headers of its `_headers` file
 * (the Content-Security-Policy among them), and index.html for the PWA's own routes. A build
 * without that file is refused: the app would run without its policy.
 */
export function serveWeb(root: Hono, webDist: string): void {
  const headers = readHeaders(readFileSync(join(webDist, '_headers'), 'utf8'));

  root.use('*', async (c, next) => {
    await next();

    for (const [name, value] of headers) {
      c.header(name, value);
    }
  });
  // The file configures the host: Workers never serves it either.
  root.get('/_headers', (c) => c.notFound());
  root.use('*', serveStatic({ root: webDist }));
  // The PWA's own routes (/feed, /channels…) all load its index.html.
  root.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

/**
 * The headers of the `/*` rule. Any other rule is refused rather than applied to every path, so a
 * rule added for Workers cannot silently differ on Node.
 */
export function readHeaders(file: string): [string, string][] {
  const headers: [string, string][] = [];
  let rule: string | null = null;

  for (const line of file.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    if (!/^\s/.test(line)) {
      rule = line.trim();

      if (rule !== '/*') {
        throw new Error(`_headers: only the "/*" rule is supported on Node, not "${rule}".`);
      }

      continue;
    }

    const separator = line.indexOf(':');

    if (rule === null || separator === -1) {
      throw new Error(`_headers: cannot read "${line.trim()}".`);
    }

    headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }

  return headers;
}
