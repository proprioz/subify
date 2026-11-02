import { type Codec, CodecError, fromUtf8, reader, utf8, writer } from './bytes';

/**
 * The handle index (docs/FEATURES.md, D16): how a device finds a channel by its @handle without
 * naming it. A device gets the handle's VOPRF output by blind evaluation; from it come the
 * entry's id and the key its value is sealed with (the `slotId` and `transitKey` of
 * `channelSecrets`). The value is the channel's source and id. The index is sorted by entry id,
 * padded with random entries to one per slot of the table, and cut into chunks of a fixed number
 * of entries. Shared with the PWA.
 */

const ID = 16;
const NONCE = 12;
const GCM_TAG = 16;
/** The sealed value: the source and the id, each with a u8 length, padded. */
const VALUE = 64;
export const HANDLE_ENTRY_SIZE = ID + NONCE + VALUE + GCM_TAG;
/** Entries per chunk: about 430 KB, far under D1's 2 MB per value. */
export const HANDLE_CHUNK_ENTRIES = 4096;

export interface HandleTarget {
  source: string;
  externalId: string;
}

function aesKey(key: Uint8Array) {
  return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Server side: the entry of a handle, from its secrets, naming its channel. */
export async function sealHandleEntry(entryId: Uint8Array, key: Uint8Array, target: HandleTarget): Promise<Uint8Array> {
  const source = utf8(target.source);
  const id = utf8(target.externalId);

  if (2 + source.length + id.length > VALUE) {
    throw new CodecError('Payload too large');
  }

  const value = new Uint8Array(VALUE);
  value.set([source.length, ...source, id.length, ...id]);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(entryId.subarray(0, ID)) }, await aesKey(key), value));
  const entry = new Uint8Array(HANDLE_ENTRY_SIZE);
  entry.set(entryId.subarray(0, ID));
  entry.set(nonce, ID);
  entry.set(sealed, ID + NONCE);

  return entry;
}

/** A decoy entry: random bytes, which look like a sealed one. */
export function decoyHandleEntry(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HANDLE_ENTRY_SIZE));
}

/** Compares two entries by their id, the index's order. */
export function compareEntries(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < ID; i++) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }

  return 0;
}

/** The chunk an entry id falls in, from the chunks' first ids: the last one not above it. */
export function chunkOf(firstIds: readonly Uint8Array[], entryId: Uint8Array): number {
  let chunk = 0;
  firstIds.forEach((first, i) => {
    if (compareEntries(first, entryId) <= 0) {
      chunk = i;
    }
  });

  return chunk;
}

/**
 * Device side: the channel a handle leads to, from the chunk its entry id falls in, or null when
 * the index has no such handle. An entry whose id matches but doesn't open is refused.
 */
export async function openHandleEntry(entryId: Uint8Array, key: Uint8Array, chunk: Uint8Array): Promise<HandleTarget | null> {
  for (let at = 0; at < chunk.length; at += HANDLE_ENTRY_SIZE) {
    if (compareEntries(chunk.subarray(at), entryId) !== 0) {
      continue;
    }

    const entry = chunk.subarray(at, at + HANDLE_ENTRY_SIZE);
    const value = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.slice(ID, ID + NONCE), additionalData: new Uint8Array(entryId.subarray(0, ID)) }, await aesKey(key), entry.slice(ID + NONCE)),
    );
    const sourceEnd = 1 + value[0]!;
    const idEnd = sourceEnd + 1 + value[sourceEnd]!;

    if (idEnd > VALUE) {
      throw new CodecError('Length out of range');
    }

    return { source: fromUtf8(value.subarray(1, sourceEnd)), externalId: fromUtf8(value.subarray(sourceEnd + 1, idEnd)) };
  }

  return null;
}

/** A chunk as stored: its entries, sorted, HANDLE_CHUNK_ENTRIES of them. */
export const handleChunkCodec: Codec<Uint8Array> = {
  kind: 8,
  version: 1,
  size: 1 + HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE,

  encode(value) {
    if (value.length !== HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE) {
      throw new CodecError('Payload too large');
    }

    return writer(handleChunkCodec).raw(value).finish();
  },

  decode(bytes) {
    return reader(handleChunkCodec, bytes).raw(HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE);
  },
};

/** The first entry id of every chunk, in order: what a device reads to choose its chunk. */
export function handleBoundsCodec(chunks: number): Codec<Uint8Array[]> {
  const codec: Codec<Uint8Array[]> = {
    kind: 9,
    version: 1,
    size: 1 + 2 + chunks * ID,

    encode(value) {
      if (value.length !== chunks) {
        throw new CodecError('Number out of range');
      }

      const out = writer(codec).u16(chunks);
      value.forEach((first) => out.raw(first.subarray(0, ID)));

      return out.finish();
    },

    decode(bytes) {
      const read = reader(codec, bytes);

      if (read.u16() !== chunks) {
        throw new CodecError('Number out of range');
      }

      return Array.from({ length: chunks }, () => read.raw(ID));
    },
  };

  return codec;
}

/** Chunks for a table of this many slots: one entry per slot, rounded up to whole chunks. */
export function handleChunks(slots: number): number {
  return Math.max(1, Math.ceil(slots / HANDLE_CHUNK_ENTRIES));
}
