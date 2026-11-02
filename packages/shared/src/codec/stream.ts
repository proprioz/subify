import { type Codec, CodecError, fitUtf8, flags, reader, utf8, writer } from './bytes';
import type { ItemType } from '../index';

/**
 * The encrypted sync stream (docs/FEATURES.md, D16). Each pass publishes a batch of entries of a
 * fixed number per group: the changes of that pass, each sealed under its channel's transit key
 * K_c, padded with random entries. Anyone may download it; only a device that knows K_c can tell
 * which entries are its channels', and read them. Shared with the PWA.
 */

/** What changed for one channel at a pass. */
export type StreamDelta =
  /** A new item, or one whose title, flags or type changed. */
  | { kind: 'item'; id: string; title: string; published: number; type: ItemType; deleted: boolean; upcoming: boolean }
  /** The channel's title or handle changed. */
  | { kind: 'channel'; title: string; handle: string | null }
  /** The channel is gone from the platform: the app says so and keeps its history. */
  | { kind: 'gone' };

/** Bytes of one entry: its tag, a nonce, the sealed delta and the AES-GCM tag. */
export const STREAM_ENTRY_SIZE = 512;
const TAG = 16;
const NONCE = 12;
const GCM_TAG = 16;
export const STREAM_DELTA_SIZE = STREAM_ENTRY_SIZE - TAG - NONCE - GCM_TAG;
/**
 * A channel's entries in one batch are told apart by an index in their tag, so that a batch doesn't
 * show that two entries belong to the same channel. A device tries this many; more changes wait.
 */
export const STREAM_MAX_PER_CHANNEL = 8;

const MAX_ID = 64;
const MAX_TEXT = 255;
const MAX_HANDLE = 100;
const ITEM_TYPES: readonly ItemType[] = ['video', 'short', 'live', 'unknown'];
const KINDS = ['item', 'channel', 'gone'] as const;
const DELETED = 1;
const UPCOMING = 2;

export const streamDeltaCodec: Codec<StreamDelta> = {
  kind: 7,
  version: 1,
  size: STREAM_DELTA_SIZE,

  encode(value) {
    const out = writer(streamDeltaCodec).u8(KINDS.indexOf(value.kind) + 1);

    switch (value.kind) {
      case 'item':
        if (value.id.length > MAX_ID) {
          throw new CodecError('Payload too large');
        }

        return out
          .text(value.id)
          .text(fitUtf8(value.title, MAX_TEXT))
          .u32(Math.floor(value.published / 1000))
          .u8(ITEM_TYPES.indexOf(value.type))
          .u8((value.deleted ? DELETED : 0) | (value.upcoming ? UPCOMING : 0))
          .finish();
      case 'channel':
        return out
          .text(fitUtf8(value.title, MAX_TEXT))
          .text(value.handle === null ? '' : fitUtf8(value.handle, MAX_HANDLE))
          .finish();
      case 'gone':
        return out.finish();
    }
  },

  decode(bytes) {
    const read = reader(streamDeltaCodec, bytes);
    const kind = KINDS[read.upTo(read.u8(), KINDS.length) - 1];
    let delta: StreamDelta;

    switch (kind) {
      case 'item': {
        const id = read.text(MAX_ID);
        const title = read.text(MAX_TEXT);
        const published = read.u32() * 1000;
        const type = ITEM_TYPES[read.upTo(read.u8(), ITEM_TYPES.length - 1)]!;
        const itemFlags = flags(read.u8(), DELETED | UPCOMING);
        delta = { kind, id, title, published, type, deleted: (itemFlags & DELETED) !== 0, upcoming: (itemFlags & UPCOMING) !== 0 };
        break;
      }
      case 'channel': {
        const title = read.text(MAX_TEXT);
        const handle = read.text(MAX_HANDLE);
        delta = { kind, title, handle: handle === '' ? null : handle };
        break;
      }
      case 'gone':
        delta = { kind };
        break;
      default:
        throw new CodecError('Unknown kind');
    }

    read.end();

    return delta;
  },
};

/** The tag of a channel's `index`-th entry in the batch of `pass`: unlinkable across passes without K_c. */
export async function streamTag(transitKey: Uint8Array, pass: number, index: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(transitKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new Uint8Array([...utf8('subify/stream\0'), 0, 0, 0, 0, index]);
  new DataView(message.buffer).setUint32(message.length - 5, pass);

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message)).slice(0, TAG);
}

/** Server side: a delta sealed under K_c, as one entry of the batch of `pass`. */
export async function sealEntry(transitKey: Uint8Array, pass: number, index: number, delta: StreamDelta): Promise<Uint8Array> {
  const tag = await streamTag(transitKey, pass, index);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const key = await aesKey(transitKey);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(tag) }, key, new Uint8Array(streamDeltaCodec.encode(delta))));
  const entry = new Uint8Array(STREAM_ENTRY_SIZE);
  entry.set(tag);
  entry.set(nonce, TAG);
  entry.set(sealed, TAG + NONCE);

  return entry;
}

/** A decoy entry: random bytes, which look like a sealed one. */
export function decoyEntry(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(STREAM_ENTRY_SIZE));
}

/**
 * Device side: the deltas of one channel in a batch's entries (concatenated), in index order.
 * An entry whose tag matches but doesn't open is refused: it was not sealed with K_c.
 */
export async function openEntries(transitKey: Uint8Array, pass: number, entries: Uint8Array): Promise<StreamDelta[]> {
  if (entries.length % STREAM_ENTRY_SIZE !== 0) {
    throw new CodecError('Truncated payload');
  }

  const key = await aesKey(transitKey);
  const deltas: StreamDelta[] = [];

  for (let index = 0; index < STREAM_MAX_PER_CHANNEL; index++) {
    const tag = await streamTag(transitKey, pass, index);
    const at = findEntry(entries, tag);

    if (at === -1) {
      break;
    }

    const entry = entries.subarray(at, at + STREAM_ENTRY_SIZE);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.slice(TAG, TAG + NONCE), additionalData: new Uint8Array(tag) }, key, entry.slice(TAG + NONCE));
    deltas.push(streamDeltaCodec.decode(new Uint8Array(plain)));
  }

  return deltas;
}

function findEntry(entries: Uint8Array, tag: Uint8Array): number {
  for (let at = 0; at < entries.length; at += STREAM_ENTRY_SIZE) {
    if (tag.every((byte, i) => entries[at + i] === byte)) {
      return at;
    }
  }

  return -1;
}

function aesKey(transitKey: Uint8Array) {
  return crypto.subtle.importKey('raw', new Uint8Array(transitKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A batch as the server stores it: its pass, its grouping and its entries, group after group. */
export interface StreamBatch {
  pass: number;
  groups: number;
  perGroup: number;
  /** groups × perGroup entries. */
  entries: Uint8Array;
}

const BATCH_HEADER = 1 + 4 + 2 + 2;

/** The codec of a batch of `count` entries: its size changes only when the table grows. */
export function streamBatchCodec(count: number): Codec<StreamBatch> {
  const codec: Codec<StreamBatch> = {
    kind: 6,
    version: 1,
    size: BATCH_HEADER + count * STREAM_ENTRY_SIZE,

    encode(value) {
      if (value.groups * value.perGroup !== count || value.entries.length !== count * STREAM_ENTRY_SIZE) {
        throw new CodecError('Payload too large');
      }

      return writer(codec).u32(value.pass).u16(value.groups).u16(value.perGroup).raw(value.entries).finish();
    },

    decode(bytes) {
      const read = reader(codec, bytes);
      const pass = read.u32();
      const groups = read.u16();
      const perGroup = read.u16();

      if (groups * perGroup !== count) {
        throw new CodecError('Number out of range');
      }

      return { pass, groups, perGroup, entries: read.raw(count * STREAM_ENTRY_SIZE) };
    },
  };

  return codec;
}

/** The entries a batch's size class holds, from its sealed length. */
export function streamBatchCount(sealedLength: number, overhead: number): number {
  return (sealedLength - overhead - BATCH_HEADER) / STREAM_ENTRY_SIZE;
}
