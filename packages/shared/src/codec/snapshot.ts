import type { ItemType } from '../index';
import { type Codec, CodecError, fitUtf8, flags, reader, utf8, utf8Length, writer } from './bytes';
import type { SlotImage, SlotImageType } from './slot';
import { type ThumbnailPayload, thumbnailCodec } from './thumbnail';

/**
 * Group snapshots (docs/FEATURES.md, D16): how a device reads a channel the catalog has without
 * naming it. It downloads every slot of the channel's group, each channel sealed under its own
 * transit key K_c, decoys as random bytes of the same size, and keeps the one whose slot id it
 * knows. With them, optionally, the group's thumbnails of the last 7 days, under tags only K_c
 * finds. Shared with the PWA.
 */

/** What a device gets for a channel: as an addition gives it, the latest items of each type and the avatar. */
export interface SnapshotChannel {
  source: string;
  externalId: string;
  title: string;
  handle: string | null;
  avatar: SlotImage | null;
  /** Newest first. */
  items: SnapshotItem[];
}

export interface SnapshotItem {
  id: string;
  title: string;
  published: number;
  type: ItemType;
  upcoming: boolean;
}

const ID = 16;
const NONCE = 12;
const GCM_TAG = 16;
/** Bytes of one channel's entry: its slot id, a nonce, the sealed channel and the AES-GCM tag. */
export const SNAPSHOT_ENTRY_SIZE = 16 * 1024;
const PAYLOAD = SNAPSHOT_ENTRY_SIZE - ID - NONCE - GCM_TAG;
/** Bytes of one thumbnail's entry: its tag, a nonce, the sealed case and the AES-GCM tag. */
export const SNAPSHOT_THUMBNAIL_SIZE = ID + NONCE + thumbnailCodec.size + GCM_TAG;
/** Thumbnails a device looks for per channel: 7 days of a busy channel. */
export const SNAPSHOT_MAX_THUMBNAILS = 32;

const MAX_TEXT = 255;
const MAX_ID = 64;
const MAX_AVATAR = 12 * 1024;
const ITEM_TYPES: readonly ItemType[] = ['video', 'short', 'live', 'unknown'];
const IMAGE_TYPES: readonly SlotImageType[] = ['image/jpeg', 'image/png', 'image/webp'];
const UPCOMING = 1;

export const snapshotChannelCodec: Codec<SnapshotChannel> = {
  kind: 10,
  version: 1,
  size: PAYLOAD,

  encode(value) {
    const title = fitUtf8(value.title, MAX_TEXT);
    const handle = value.handle === null ? '' : fitUtf8(value.handle, MAX_TEXT);
    const avatar = value.avatar !== null && value.avatar.bytes.length <= MAX_AVATAR ? value.avatar : null;

    if (utf8Length(value.source) > MAX_ID || utf8Length(value.externalId) > MAX_ID) {
      throw new CodecError('Payload too large');
    }

    const items = value.items.filter((item) => item.id.length <= MAX_ID).map((item) => ({ ...item, title: fitUtf8(item.title, MAX_TEXT) }));
    // The rule when everything doesn't fit: the oldest items go first.
    let room = PAYLOAD - (1 + 1 + utf8Length(value.source) + 1 + utf8Length(value.externalId) + 1 + utf8Length(title) + 1 + utf8Length(handle) + 1 + 2 + (avatar?.bytes.length ?? 0) + 1);
    let kept = 0;

    for (const item of items) {
      const size = 1 + utf8Length(item.id) + 1 + utf8Length(item.title) + 4 + 1 + 1;

      if (size > room || kept === 0xff) {
        break;
      }

      room -= size;
      kept++;
    }

    const out = writer(snapshotChannelCodec).text(value.source).text(value.externalId).text(title).text(handle);
    out.u8(avatar === null ? 0 : IMAGE_TYPES.indexOf(avatar.type) + 1).blob(avatar?.bytes ?? new Uint8Array());
    out.u8(kept);
    items.slice(0, kept).forEach((item) => {
      out.text(item.id).text(item.title).u32(Math.floor(item.published / 1000)).u8(ITEM_TYPES.indexOf(item.type)).u8(item.upcoming ? UPCOMING : 0);
    });

    return out.finish();
  },

  decode(bytes) {
    const read = reader(snapshotChannelCodec, bytes);
    const source = read.text(MAX_ID);
    const externalId = read.text(MAX_ID);
    const title = read.text(MAX_TEXT);
    const handle = read.text(MAX_TEXT);
    const avatarType = read.upTo(read.u8(), IMAGE_TYPES.length);
    const avatarBytes = read.blob(MAX_AVATAR);

    if ((avatarType === 0) !== (avatarBytes.length === 0)) {
      throw new CodecError('Malformed avatar');
    }

    const items: SnapshotItem[] = [];

    for (let i = read.u8(); i > 0; i--) {
      const id = read.text(MAX_ID);
      const itemTitle = read.text(MAX_TEXT);
      const published = read.u32() * 1000;
      const type = ITEM_TYPES[read.upTo(read.u8(), ITEM_TYPES.length - 1)]!;
      const upcoming = flags(read.u8(), UPCOMING) === UPCOMING;
      items.push({ id, title: itemTitle, published, type, upcoming });
    }

    read.end();

    return {
      source,
      externalId,
      title,
      handle: handle === '' ? null : handle,
      avatar: avatarType === 0 ? null : { type: IMAGE_TYPES[avatarType - 1]!, bytes: avatarBytes },
      items,
    };
  },
};

function aesKey(key: Uint8Array) {
  return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealWith(key: Uint8Array, head: Uint8Array, payload: Uint8Array, size: number): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(head) }, await aesKey(key), new Uint8Array(payload)));
  const entry = new Uint8Array(size);
  entry.set(head);
  entry.set(nonce, ID);
  entry.set(sealed, ID + NONCE);

  return entry;
}

async function openWith(key: Uint8Array, entry: Uint8Array): Promise<Uint8Array> {
  const head = entry.slice(0, ID);

  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.slice(ID, ID + NONCE), additionalData: head }, await aesKey(key), entry.slice(ID + NONCE)));
}

/**
 * The tag of a channel's `index`-th thumbnail in a snapshot taken at `pass`: a new one at each
 * pass, so that two downloads of the same group can't be matched thumbnail by thumbnail.
 */
export async function snapshotThumbnailTag(transitKey: Uint8Array, pass: number, index: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(transitKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new Uint8Array([...utf8('subify/snapshot-thumbnail\0'), 0, 0, 0, 0, index]);
  new DataView(message.buffer).setUint32(message.length - 5, pass);

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message)).slice(0, ID);
}

/** Server side: a channel's entry, under its slot id. */
export function sealSnapshotEntry(slotId: Uint8Array, transitKey: Uint8Array, channel: SnapshotChannel): Promise<Uint8Array> {
  return sealWith(transitKey, slotId.subarray(0, ID), snapshotChannelCodec.encode(channel), SNAPSHOT_ENTRY_SIZE);
}

/** A decoy slot's entry: its id, then random bytes. */
export function decoySnapshotEntry(slotId: Uint8Array): Uint8Array {
  const entry = crypto.getRandomValues(new Uint8Array(SNAPSHOT_ENTRY_SIZE));
  entry.set(slotId.subarray(0, ID));

  return entry;
}

/** Server side: one of a channel's thumbnails. */
export async function sealSnapshotThumbnail(transitKey: Uint8Array, pass: number, index: number, thumbnail: ThumbnailPayload): Promise<Uint8Array> {
  return sealWith(transitKey, await snapshotThumbnailTag(transitKey, pass, index), thumbnailCodec.encode(thumbnail), SNAPSHOT_THUMBNAIL_SIZE);
}

export function decoySnapshotThumbnail(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SNAPSHOT_THUMBNAIL_SIZE));
}

function findHead(entries: Uint8Array, size: number, head: Uint8Array): Uint8Array | null {
  for (let at = 0; at < entries.length; at += size) {
    if (head.every((byte, i) => entries[at + i] === byte)) {
      return entries.subarray(at, at + size);
    }
  }

  return null;
}

/**
 * Device side: a channel in its group's snapshot, or null when the group has no slot with its id
 * (the catalog doesn't have it). An entry under its id that doesn't open is refused.
 */
export async function openSnapshotEntry(slotId: Uint8Array, transitKey: Uint8Array, entries: Uint8Array): Promise<SnapshotChannel | null> {
  const entry = findHead(entries, SNAPSHOT_ENTRY_SIZE, slotId.subarray(0, ID));

  return entry === null ? null : snapshotChannelCodec.decode(await openWith(transitKey, entry));
}

/** Device side: a channel's thumbnails in a snapshot taken at `pass`, by item id. */
export async function openSnapshotThumbnails(transitKey: Uint8Array, pass: number, thumbnails: Uint8Array): Promise<Map<string, SlotImage>> {
  const found = new Map<string, SlotImage>();

  for (let index = 0; index < SNAPSHOT_MAX_THUMBNAILS; index++) {
    const entry = findHead(thumbnails, SNAPSHOT_THUMBNAIL_SIZE, await snapshotThumbnailTag(transitKey, pass, index));

    if (entry === null) {
      break;
    }

    const payload = thumbnailCodec.decode(await openWith(transitKey, entry));

    if (payload.kind === 'thumbnail') {
      found.set(payload.itemId, payload.image);
    }
  }

  return found;
}
