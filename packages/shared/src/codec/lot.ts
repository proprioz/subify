import { type Codec, CodecError, reader, utf8, writer } from './bytes';
import type { SlotImage, SlotImageType } from './slot';

/**
 * The thumbnail lots (docs/FEATURES.md, D3): every hour, for each group of the sync stream, a
 * fixed number of fixed-size fragments, each one part of a thumbnail sealed under its channel's
 * transit key K_c behind a tag that changes every hour, or random bytes. A device downloads its
 * groups' lots whole and keeps the fragments its channels' tags match, as it does with the stream.
 * Shared with the PWA.
 */

/** One part of a thumbnail. */
export interface LotFragment {
  itemId: string;
  type: SlotImageType;
  /** Its place among the thumbnail's parts, from 0. */
  part: number;
  parts: number;
  bytes: Uint8Array;
}

/** Bytes of one fragment: its tag, a nonce, the sealed part and the AES-GCM tag. */
export const LOT_FRAGMENT_SIZE = 1024;
const TAG = 16;
const NONCE = 12;
const GCM_TAG = 16;
const MAX_ID = 64;
/** The image bytes a fragment holds: the sealed part, less its version, item id, type, part, parts and length. */
export const LOT_CHUNK = LOT_FRAGMENT_SIZE - TAG - NONCE - GCM_TAG - 1 - (1 + MAX_ID) - 1 - 1 - 1 - 2;
/**
 * A channel's fragments in one lot are told apart by an index in their tag. A device tries this
 * many: about 8 thumbnails; more wait for the next lot.
 */
export const LOT_MAX_PER_CHANNEL = 64;
/** A thumbnail cut in more parts than this is too large for a lot. */
const MAX_PARTS = 32;

const IMAGE_TYPES: readonly SlotImageType[] = ['image/jpeg', 'image/png', 'image/webp'];

export const lotFragmentCodec: Codec<LotFragment> = {
  kind: 11,
  version: 1,
  size: LOT_FRAGMENT_SIZE - TAG - NONCE - GCM_TAG,

  encode(value) {
    if (value.itemId.length > MAX_ID || value.bytes.length > LOT_CHUNK || value.parts > MAX_PARTS || value.part >= value.parts) {
      throw new CodecError('Payload too large');
    }

    return writer(lotFragmentCodec).text(value.itemId).u8(IMAGE_TYPES.indexOf(value.type)).u8(value.part).u8(value.parts).blob(value.bytes).finish();
  },

  decode(bytes) {
    const read = reader(lotFragmentCodec, bytes);
    const itemId = read.text(MAX_ID);
    const type = IMAGE_TYPES[read.upTo(read.u8(), IMAGE_TYPES.length - 1)]!;
    const part = read.u8();
    const count = read.upTo(read.u8(), MAX_PARTS);

    if (part >= count) {
      throw new CodecError('Number out of range');
    }

    const chunk = read.blob(LOT_CHUNK);
    read.end();

    return { itemId, type, part, parts: count, bytes: chunk };
  },
};

/** A thumbnail in the parts a lot carries; empty when it would take more than a lot holds for a channel. */
export function splitThumbnail(itemId: string, image: SlotImage): LotFragment[] {
  const parts = Math.max(1, Math.ceil(image.bytes.length / LOT_CHUNK));

  if (parts > MAX_PARTS) {
    return [];
  }

  return Array.from({ length: parts }, (_, part) => ({ itemId, type: image.type, part, parts, bytes: image.bytes.subarray(part * LOT_CHUNK, (part + 1) * LOT_CHUNK) }));
}

/** The tag of a channel's `index`-th fragment in the lot of `hour`: unlinkable across hours without K_c. */
export async function lotTag(transitKey: Uint8Array, hour: number, index: number): Promise<Uint8Array> {
  const key = await tagKeyOf(transitKey);
  const message = new Uint8Array([...utf8('subify/lot\0'), 0, 0, 0, 0, index]);
  new DataView(message.buffer).setUint32(message.length - 5, hour);

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message)).slice(0, TAG);
}

/** K_c as an HMAC key, imported once per key: a device computes dozens of tags per channel. */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const tagKeys = new WeakMap<Uint8Array, Promise<HmacKey>>();

export function tagKeyOf(transitKey: Uint8Array): Promise<HmacKey> {
  let key = tagKeys.get(transitKey);

  if (key === undefined) {
    key = crypto.subtle.importKey('raw', new Uint8Array(transitKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    tagKeys.set(transitKey, key);
  }

  return key;
}

/** Server side: a fragment sealed under K_c, as the channel's `index`-th of the lot of `hour`. */
export async function sealFragment(transitKey: Uint8Array, hour: number, index: number, fragment: LotFragment): Promise<Uint8Array> {
  return sealTaggedFragment(transitKey, await lotTag(transitKey, hour, index), fragment);
}

/** A fragment sealed under K_c behind `tag`: the lots' and the snapshots' thumbnails alike. */
export async function sealTaggedFragment(transitKey: Uint8Array, tag: Uint8Array, fragment: LotFragment): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(tag) }, await aesKey(transitKey), new Uint8Array(lotFragmentCodec.encode(fragment))));
  const entry = new Uint8Array(LOT_FRAGMENT_SIZE);
  entry.set(tag);
  entry.set(nonce, TAG);
  entry.set(sealed, TAG + NONCE);

  return entry;
}

/** A decoy fragment: random bytes, which look like a sealed one. */
export function decoyFragment(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(LOT_FRAGMENT_SIZE));
}

/**
 * Device side: one channel's thumbnails in the lot of `hour` (its fragments, concatenated), by
 * item id. A fragment whose tag matches but doesn't open is refused: it was not sealed with K_c.
 */
export function openLot(transitKey: Uint8Array, hour: number, fragments: Uint8Array): Promise<Map<string, SlotImage>> {
  return openFragments(transitKey, (index) => lotTag(transitKey, hour, index), LOT_MAX_PER_CHANNEL, fragments);
}

/**
 * Device side: one channel's thumbnails among `fragments`, by item id: those behind the tags
 * `tagOf` gives for 0, 1, 2…, up to the first it doesn't find or `max`.
 */
export async function openFragments(transitKey: Uint8Array, tagOf: (index: number) => Promise<Uint8Array>, max: number, fragments: Uint8Array): Promise<Map<string, SlotImage>> {
  if (fragments.length % LOT_FRAGMENT_SIZE !== 0) {
    throw new CodecError('Truncated payload');
  }

  const key = await aesKey(transitKey);
  const parts = new Map<string, LotFragment[]>();

  for (let index = 0; index < max; index++) {
    const tag = await tagOf(index);
    const entry = find(fragments, tag);

    if (entry === null) {
      break;
    }

    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.slice(TAG, TAG + NONCE), additionalData: new Uint8Array(tag) }, key, entry.slice(TAG + NONCE));
    const fragment = lotFragmentCodec.decode(new Uint8Array(plain));
    parts.set(fragment.itemId, [...(parts.get(fragment.itemId) ?? []), fragment]);
  }

  const images = new Map<string, SlotImage>();

  for (const [itemId, list] of parts) {
    const ordered = [...list].sort((a, b) => a.part - b.part);

    // A thumbnail is whole or isn't: the server never splits one across lots or snapshots.
    if (ordered.length === ordered[0]!.parts && ordered.every((fragment, i) => fragment.part === i)) {
      const bytes = new Uint8Array(ordered.reduce((sum, fragment) => sum + fragment.bytes.length, 0));
      ordered.reduce((at, fragment) => (bytes.set(fragment.bytes, at), at + fragment.bytes.length), 0);
      images.set(itemId, { type: ordered[0]!.type, bytes });
    }
  }

  return images;
}

/** Each answer's fragments by tag, built once: a device looks for every channel's in the same answer. */
const indexes = new WeakMap<Uint8Array, Map<string, number>>();

function find(fragments: Uint8Array, tag: Uint8Array): Uint8Array | null {
  let index = indexes.get(fragments);

  if (index === undefined) {
    index = new Map();

    for (let at = 0; at < fragments.length; at += LOT_FRAGMENT_SIZE) {
      const key = tagKey(fragments.subarray(at, at + TAG));

      // The first one, should two random fragments share a tag.
      if (!index.has(key)) {
        index.set(key, at);
      }
    }

    indexes.set(fragments, index);
  }

  const at = index.get(tagKey(tag));

  return at === undefined ? null : fragments.subarray(at, at + LOT_FRAGMENT_SIZE);
}

function tagKey(tag: Uint8Array): string {
  return String.fromCharCode(...tag);
}

function aesKey(transitKey: Uint8Array) {
  return crypto.subtle.importKey('raw', new Uint8Array(transitKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** One group's lot as the server stores it: its hour, the grouping it was built for, and its fragments. */
export interface StoredLot {
  hour: number;
  groups: number;
  /** `count` fragments. */
  fragments: Uint8Array;
}

const LOT_HEADER = 1 + 4 + 2;

/** The codec of a lot of `count` fragments: its size changes only when the table grows. */
export function lotCodec(count: number): Codec<StoredLot> {
  const codec: Codec<StoredLot> = {
    kind: 12,
    version: 1,
    size: LOT_HEADER + count * LOT_FRAGMENT_SIZE,

    encode(value) {
      if (value.fragments.length !== count * LOT_FRAGMENT_SIZE) {
        throw new CodecError('Payload too large');
      }

      return writer(codec).u32(value.hour).u16(value.groups).raw(value.fragments).finish();
    },

    decode(bytes) {
      const read = reader(codec, bytes);

      return { hour: read.u32(), groups: read.u16(), fragments: read.raw(count * LOT_FRAGMENT_SIZE) };
    },
  };

  return codec;
}

/** The fragments a lot's size class holds, from its sealed length. */
export function lotCount(sealedLength: number, overhead: number): number {
  return (sealedLength - overhead - LOT_HEADER) / LOT_FRAGMENT_SIZE;
}
