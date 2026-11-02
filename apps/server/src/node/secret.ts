import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MASTER_SECRET_BYTES } from '../crypto/keys';

export interface MasterSecret {
  secret: Uint8Array;
  /** True when this start created the file: the entry logs that it did, never the secret. */
  generated: boolean;
}

/**
 * The Node server's master secret (docs/SELF-HOSTING.md): `MASTER_SECRET` (32 bytes in base64)
 * when it is set, otherwise the file at `path`, created at the first start with mode 0600.
 *
 * A file that exists but can't be read, or doesn't hold a secret, stops the server: generating a
 * new secret over it would silently make the whole catalog unreadable.
 */
export function loadMasterSecret(fromEnv: string | null, path: string): MasterSecret {
  if (fromEnv !== null) {
    return { secret: decode(fromEnv, 'MASTER_SECRET'), generated: false };
  }

  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`The master secret file ${path} exists but can't be read`, { cause: error });
    }

    const secret = randomBytes(MASTER_SECRET_BYTES);
    // 'wx': never overwrite a file another process created meanwhile.
    writeFileSync(path, `${secret.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });

    return { secret: new Uint8Array(secret), generated: true };
  }

  return { secret: decode(text.trim(), path), generated: false };
}

function decode(base64: string, where: string): Uint8Array {
  const secret = Buffer.from(base64, 'base64');

  if (secret.length !== MASTER_SECRET_BYTES || secret.toString('base64') !== base64) {
    throw new Error(`${where} must hold ${MASTER_SECRET_BYTES} bytes in base64`);
  }

  return new Uint8Array(secret);
}
