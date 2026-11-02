import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// The promise holds on every runtime only if no code ever reads an IP: a dynamic test cannot prove a header is never read, this scan can.
describe('server source', () => {
  it('never mentions an IP header or a connection info helper', () => {
    const offending = files(src).filter((file) =>
      /cf-connecting-ip|cf-ipcountry|x-forwarded-for|x-real-ip|true-client-ip|getConnInfo|remoteAddress|\bforwarded\b/i.test(readFileSync(file, 'utf8')),
    );

    expect(offending).toEqual([]);
  });

  // Only the store can seal and open blobs: code that read a blob column itself could store a payload in clear, or bound to the wrong row.
  it('reads and writes the encrypted catalog’s tables in src/catalog/vault.ts only', () => {
    const offending = files(src).filter(
      (file) => !file.endsWith('/catalog/vault.ts') && /(selectFrom|updateTable|insertInto|deleteFrom|replaceInto)\(\s*['"](slots|vault|thumbnails|stream|handles)['"]/.test(readFileSync(file, 'utf8')),
    );

    expect(offending).toEqual([]);
  });

  // The connection check is the one exception the owner allowed: only the Worker entry reads Cloudflare's view of the request, and hands it to that route alone.
  it('reads Cloudflare’s request properties in the Worker entry only', () => {
    const offending = files(src).filter((file) => !file.endsWith('/entry/worker.ts') && /\.cf\b|\bcf\?\./.test(readFileSync(file, 'utf8')));

    expect(offending).toEqual([]);
  });

  it('logs only through src/log.ts', () => {
    const offending = files(src).filter((file) => !file.endsWith('log.ts') && !file.includes('/entry/') && /console\./.test(readFileSync(file, 'utf8')));

    expect(offending).toEqual([]);
  });
});
