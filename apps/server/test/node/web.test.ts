import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { readHeaders, serveWeb } from '../../src/node/web';

const appHeaders = fileURLToPath(new URL('../../../web/public/_headers', import.meta.url));

// A self-hosted server must send the PWA with the same Content-Security-Policy as Workers, read
// from the same file, or the Docker image runs without it.
describe('serving the PWA on Node', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function builtApp(): Hono {
    dir = mkdtempSync(join(tmpdir(), 'subify-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Subify</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'export {};');
    copyFileSync(appHeaders, join(dir, '_headers'));
    const root = new Hono();
    serveWeb(root, dir);

    return root;
  }

  it('sends every file and route with the headers of _headers, and never the file itself', async () => {
    const root = builtApp();
    const expected = readHeaders(readFileSync(appHeaders, 'utf8'));

    for (const path of ['/', '/feed', '/assets/app.js']) {
      const response = await root.request(path);

      expect(response.status).toBe(200);
      expect(expected.map(([name]) => [name, response.headers.get(name)])).toEqual(expected);
    }

    expect((await root.request('/_headers')).status).toBe(404);
  });

  it('keeps the policy that holds the app to its own origin and its own images', () => {
    const policy = new Map(readHeaders(readFileSync(appHeaders, 'utf8'))).get('Content-Security-Policy') ?? '';

    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('refuses a rule it would not apply as Workers does', () => {
    expect(() => readHeaders('/assets/*\n  Cache-Control: immutable\n')).toThrow('only the "/*" rule');
  });
});
