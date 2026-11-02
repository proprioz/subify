import type { Codec } from '@subify/shared/codec';
import type { ServerKeys } from './keys';

/**
 * Seals a payload for the database: `key id | format version | nonce | AES-256-GCM(payload)`. The
 * associated data binds the blob to its place, its kind, its key and its format, so that a blob
 * copied into another row, or read as another kind, fails authentication. A fresh nonce at every
 * write makes two writes of the same payload look unrelated.
 */
const HEADER = 1 + 1 + 12;
const TAG = 16;

/** The size of a blob holding a payload of this codec. */
export function sealedSize(codec: Codec<unknown>): number {
  return HEADER + codec.size + TAG;
}

/** Authentication failed: a wrong key, a tampered blob, or one moved from another row or kind. */
export class SealError extends Error {
  override readonly name = 'SealError';
}

export async function seal<T>(keys: ServerKeys, codec: Codec<T>, rowId: Uint8Array, value: T): Promise<Uint8Array> {
  const payload = codec.encode(value);
  const blob = new Uint8Array(sealedSize(codec));
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  blob[0] = keys.keyId;
  blob[1] = codec.version;
  blob.set(nonce, 2);

  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: associatedData(codec.kind, keys.keyId, codec.version, rowId) }, keys.aes, new Uint8Array(payload));
  blob.set(new Uint8Array(sealed), HEADER);

  return blob;
}

/** Opens a blob sealed for this row and kind, then decodes it. A decode failure past this point is a bug. */
export async function open<T>(keys: ServerKeys, codec: Codec<T>, rowId: Uint8Array, blob: Uint8Array): Promise<T> {
  if (blob.length !== sealedSize(codec) || blob[0] !== keys.keyId) {
    throw new SealError('Not a blob of this kind and key');
  }

  const version = blob[1]!;
  let payload: Uint8Array;

  try {
    payload = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.slice(2, HEADER), additionalData: associatedData(codec.kind, keys.keyId, version, rowId) },
        keys.aes,
        blob.slice(HEADER),
      ),
    );
  } catch {
    throw new SealError('Authentication failed');
  }

  // The payload's own first byte is its version: it must be the one the header promised.
  if (payload[0] !== version) {
    throw new SealError('Version mismatch');
  }

  return codec.decode(payload);
}

function associatedData(kind: number, keyId: number, version: number, rowId: Uint8Array): Uint8Array<ArrayBuffer> {
  if (rowId.length > 0xff) {
    throw new RangeError('Row id too long');
  }

  const data = new Uint8Array(4 + rowId.length);

  data.set([kind, keyId, version, rowId.length]);
  data.set(rowId, 4);

  return data;
}

/** Sealed messages carry this version: their shape is the TypeScript type of their kind. */
const MESSAGE_VERSION = 1;

/**
 * Seals a message of any size that never reaches the database, such as an update waiting for the
 * pass. Same layout and associated data as a stored payload, with no row id.
 */
export async function sealMessage(keys: ServerKeys, kind: number, payload: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(kind, keys.keyId, MESSAGE_VERSION, new Uint8Array()) },
    keys.aes,
    new Uint8Array(payload),
  );
  const blob = new Uint8Array(HEADER + sealed.byteLength);

  blob.set([keys.keyId, MESSAGE_VERSION]);
  blob.set(nonce, 2);
  blob.set(new Uint8Array(sealed), HEADER);

  return blob;
}

export async function openMessage(keys: ServerKeys, kind: number, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < HEADER + TAG || blob[0] !== keys.keyId || blob[1] !== MESSAGE_VERSION) {
    throw new SealError('Not a message of this key');
  }

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.slice(2, HEADER), additionalData: associatedData(kind, keys.keyId, MESSAGE_VERSION, new Uint8Array()) },
        keys.aes,
        blob.slice(HEADER),
      ),
    );
  } catch {
    throw new SealError('Authentication failed');
  }
}
