/**
 * Seals and opens backups: a key derived from the password with Argon2id (libsodium's
 * crypto_pwhash settings), the payload encrypted with XChaCha20-Poly1305, which also detects a
 * wrong password or a damaged file. The password is never stored. The libraries load only when a
 * backup is sealed or opened, not with the app.
 *
 * A new FORMAT_VERSION must keep opening the files of every earlier one: a backup is often the
 * user's only copy (test/fixtures/backup-v1.json).
 */

export const FORMAT = 'subify-backup';
export const FORMAT_VERSION = 1;
export const MINIMUM_PASSWORD_LENGTH = 8;

const KDF = 'argon2id13';
const CIPHER = 'xchacha20poly1305-ietf';
const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

/** libsodium's "interactive" and "moderate" limits: a file may not ask for more than the latter. */
const INTERACTIVE = { opsLimit: 2, memLimit: 64 * 1024 * 1024 };
const MODERATE = { opsLimit: 3, memLimit: 256 * 1024 * 1024 };

export class BackupError extends Error {
  override readonly name = 'BackupError';
}

interface Envelope {
  format?: unknown;
  format_version?: unknown;
  encryption?: { cipher?: unknown; kdf?: unknown; opslimit?: unknown; memlimit?: unknown; salt?: unknown; nonce?: unknown };
  ciphertext?: unknown;
}

export async function seal(plaintext: string, password: string, random: (bytes: number) => Uint8Array = randomBytes): Promise<string> {
  const salt = random(SALT_BYTES);
  const nonce = random(NONCE_BYTES);
  const { opsLimit, memLimit } = INTERACTIVE;
  const key = await deriveKey(password, salt, opsLimit, memLimit);
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha.js');
  const ciphertext = xchacha20poly1305(key, nonce, header(opsLimit, memLimit, salt)).encrypt(new TextEncoder().encode(plaintext));
  key.fill(0);

  return JSON.stringify(
    {
      format: FORMAT,
      format_version: FORMAT_VERSION,
      encryption: { cipher: CIPHER, kdf: KDF, opslimit: opsLimit, memlimit: memLimit, salt: toBase64(salt), nonce: toBase64(nonce) },
      ciphertext: toBase64(ciphertext),
    },
    null,
    4,
  );
}

/** Whether the file looks like a backup, before asking for its password. */
export function isSealed(file: string): boolean {
  const envelope = decode(file);

  return envelope?.format === FORMAT && typeof envelope.ciphertext === 'string';
}

export async function open(file: string, password: string): Promise<string> {
  const envelope = decode(file);
  const encryption = envelope?.encryption;

  if (envelope?.format !== FORMAT || encryption === undefined || encryption === null) {
    throw new BackupError('This file isn’t a Subify backup.');
  }

  if (envelope.format_version !== FORMAT_VERSION || encryption.cipher !== CIPHER || encryption.kdf !== KDF) {
    throw new BackupError('This backup was made by a newer version of the app.');
  }

  const { opslimit: opsLimit, memlimit: memLimit } = encryption;
  const salt = fromBase64(encryption.salt);
  const nonce = fromBase64(encryption.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);

  // The limits come from the file: capping them keeps a crafted file from asking the device for
  // more memory or time than a real backup ever needs.
  if (
    typeof opsLimit !== 'number' ||
    typeof memLimit !== 'number' ||
    opsLimit < INTERACTIVE.opsLimit ||
    opsLimit > MODERATE.opsLimit ||
    memLimit < INTERACTIVE.memLimit ||
    memLimit > MODERATE.memLimit ||
    salt?.length !== SALT_BYTES ||
    nonce?.length !== NONCE_BYTES ||
    ciphertext === null ||
    ciphertext.length === 0
  ) {
    throw new BackupError('This backup file is damaged.');
  }

  const key = await deriveKey(password, salt, opsLimit, memLimit);
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha.js');

  try {
    return new TextDecoder().decode(xchacha20poly1305(key, nonce, header(opsLimit, memLimit, salt)).decrypt(ciphertext));
  } catch {
    throw new BackupError('Wrong password, or the file is damaged.');
  } finally {
    key.fill(0);
  }
}

/** libsodium's crypto_pwhash: Argon2id 1.3, `memLimit` in bytes, one lane. */
async function deriveKey(password: string, salt: Uint8Array, opsLimit: number, memLimit: number): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm');

  return argon2id({
    password,
    salt,
    iterations: opsLimit,
    memorySize: memLimit / 1024,
    parallelism: 1,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
}

/** Authenticated with the ciphertext, so the key settings cannot be changed without the password failing. */
function header(opsLimit: number, memLimit: number, salt: Uint8Array): Uint8Array {
  return new TextEncoder().encode([FORMAT, FORMAT_VERSION, KDF, opsLimit, memLimit, toBase64(salt)].join('|'));
}

function decode(file: string): Envelope | null {
  try {
    const value: unknown = JSON.parse(file);

    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Envelope) : null;
  } catch {
    return null;
  }
}

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return btoa(binary);
}

function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
