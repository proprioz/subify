import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMasterSecret } from '../../src/node/secret';

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'subify-secret-'));
  dirs.push(dir);

  return join(dir, 'subify.secret');
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Losing or replacing the master secret makes the whole catalog unreadable, and a readable copy reveals it.
describe('the Node master secret', () => {
  it('is generated once, readable by its owner only, and the same at the next start', () => {
    const path = tempPath();
    const first = loadMasterSecret(null, path);
    const second = loadMasterSecret(null, path);

    expect(first.generated).toBe(true);
    expect(second.generated).toBe(false);
    expect(second.secret).toEqual(first.secret);
    expect(first.secret.length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('comes from MASTER_SECRET when it is set, and nothing is written', () => {
    const path = tempPath();
    const value = Buffer.alloc(32, 5).toString('base64');

    expect(loadMasterSecret(value, path)).toEqual({ secret: new Uint8Array(32).fill(5), generated: false });
    expect(() => statSync(path)).toThrow();
  });

  // Generating a new secret over one the server can't read would silently orphan the catalog.
  it('stops the server rather than replace a file it can’t read or that holds no secret', () => {
    const path = tempPath();
    writeFileSync(path, 'not a secret\n');

    expect(() => loadMasterSecret(null, path)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('not a secret\n');
    expect(() => loadMasterSecret('c2hvcnQ=', path)).toThrow();

    // Root reads any file: the unreadable case can only be checked as another user.
    if (process.getuid?.() !== 0) {
      chmodSync(path, 0o000);
      expect(() => loadMasterSecret(null, path)).toThrow(/can't be read/);
    }
  });
});
