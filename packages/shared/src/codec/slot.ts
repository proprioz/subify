import type { ItemType } from '../index';
import { type Codec, CodecError, fitUtf8, flags, reader, utf8Length, writer } from './bytes';

/**
 * A catalog slot (docs/FEATURES.md, D16): one channel with its scheduling state and its items, or
 * an empty decoy. Every slot encodes to the same size, whatever it holds, so that the database
 * can't tell a real slot from a decoy, nor a busy channel from a quiet one.
 *
 * Times are milliseconds since the Unix epoch in the value, kept to the second in the bytes.
 */
export type SlotPayload = { kind: 'empty' } | SlotChannel;

export interface SlotChannel {
  kind: 'channel';
  /** The source adapter's name, such as 'youtube'. */
  source: string;
  /** The channel's id on the platform. */
  externalId: string;
  title: string;
  handle: string | null;
  avatar: SlotImage | null;
  schedule: SlotSchedule;
  /** Newest first: when they don't all fit, the oldest go. */
  items: SlotItem[];
}

export type SlotImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface SlotImage {
  type: SlotImageType;
  bytes: Uint8Array;
}

export type WebSubStatus = 'off' | 'pending' | 'active';

export interface SlotSchedule {
  nextPollAt: number;
  consecutiveFailures: number;
  websubStatus: WebSubStatus;
  websubExpiresAt: number | null;
  websubRequestedAt: number | null;
  /** The HMAC secret given to the hub, 32 bytes. */
  websubSecret: Uint8Array | null;
  /** The random token that names the channel in the WebSub callback URL, 16 bytes. */
  callbackToken: Uint8Array | null;
  /** Consecutive days the platform said the channel doesn't exist (D16, dead channels). */
  notFoundDays: number;
  /** The last of those days, as days since the Unix epoch; 0 when there is none. */
  notFoundDay: number;
}

export interface SlotItem {
  /** The item's id on the platform. */
  id: string;
  title: string;
  published: number;
  /** When the server first saw it. */
  ingestedAt: number;
  type: ItemType;
  deleted: boolean;
  upcoming: boolean;
  /** Its case in the thumbnail ring, or null when it has none. */
  thumbnail: number | null;
}

/**
 * 40 KB per stored slot, the AEAD's 14-byte header and 16-byte tag included (apps/server/src/crypto/aead.ts).
 * Measured: 400 items with Latin titles of about 50 characters and a 7 KB avatar, 390 with the
 * largest avatar; about 100 with CJK or emoji titles at the limit.
 */
export const SLOT_SIZE = 40 * 1024 - 30;
/** The latest items kept, at most (the server also drops those older than its retention). */
export const SLOT_MAX_ITEMS = 400;
/** Larger avatars are left out rather than cut. The measured largest is about 10.7 KB. */
export const SLOT_MAX_AVATAR = 12 * 1024;
/** Titles are cut to this many bytes of UTF-8, at a character boundary. */
const MAX_TEXT = 255;
const MAX_ID = 64;
const SECRET = 32;
const TOKEN = 16;

const ITEM_TYPES: readonly ItemType[] = ['video', 'short', 'live', 'unknown'];
const IMAGE_TYPES: readonly SlotImageType[] = ['image/jpeg', 'image/png', 'image/webp'];
const STATUSES: readonly WebSubStatus[] = ['off', 'pending', 'active'];
const DELETED = 1;
const UPCOMING = 2;
const HAS_SECRET = 1;
const HAS_TOKEN = 2;

export const slotCodec: Codec<SlotPayload> = {
  kind: 1,
  version: 1,
  size: SLOT_SIZE,

  encode(value) {
    const out = writer(slotCodec);

    if (value.kind === 'empty') {
      return out.u8(0).finish();
    }

    const title = fitUtf8(value.title, MAX_TEXT);
    const handle = value.handle === null ? '' : fitUtf8(value.handle, MAX_TEXT);
    const avatar = value.avatar !== null && value.avatar.bytes.length <= SLOT_MAX_AVATAR ? value.avatar : null;
    const items = value.items.slice(0, SLOT_MAX_ITEMS).map((item) => ({ ...item, title: fitUtf8(item.title, MAX_TEXT) }));
    const s = value.schedule;
    const fixed =
      1 + 1 + (1 + utf8Length(value.source)) + (1 + utf8Length(value.externalId)) + (1 + utf8Length(title)) + (1 + utf8Length(handle)) +
      1 + 2 + (avatar?.bytes.length ?? 0) + SCHEDULE_SIZE + 2 + 2;
    // The rule when everything doesn't fit: the oldest items go first.
    let room = slotCodec.size - fixed;
    let kept = 0;

    for (const item of items) {
      const size = itemSize(item);

      if (size > room) {
        break;
      }

      room -= size;
      kept++;
    }

    const thumbnails = items.slice(0, kept).flatMap((item, index) => (item.thumbnail === null ? [] : [{ index, position: item.thumbnail }]));

    out.u8(1).text(value.source).text(value.externalId).text(title).text(handle);
    out.u8(avatar === null ? 0 : IMAGE_TYPES.indexOf(avatar.type) + 1).blob(avatar?.bytes ?? new Uint8Array());
    out
      .u32(seconds(s.nextPollAt))
      .u8(Math.min(s.consecutiveFailures, 0xff))
      .u8(STATUSES.indexOf(s.websubStatus))
      .u32(seconds(s.websubExpiresAt ?? 0))
      .u32(seconds(s.websubRequestedAt ?? 0))
      .u8((s.websubSecret === null ? 0 : HAS_SECRET) | (s.callbackToken === null ? 0 : HAS_TOKEN))
      .raw(s.websubSecret ?? new Uint8Array(SECRET))
      .raw(s.callbackToken ?? new Uint8Array(TOKEN))
      .u8(Math.min(s.notFoundDays, 0xff))
      .u16(s.notFoundDay);

    out.u16(kept);

    for (const item of items.slice(0, kept)) {
      out
        .text(item.id)
        .text(item.title)
        .u32(seconds(item.published))
        .u32(seconds(item.ingestedAt))
        .u8(ITEM_TYPES.indexOf(item.type))
        .u8((item.deleted ? DELETED : 0) | (item.upcoming ? UPCOMING : 0));
    }

    // Each thumbnail costs 6 bytes; their room was counted with their items'.
    out.u16(thumbnails.length);
    thumbnails.forEach((thumbnail) => out.u16(thumbnail.index).u32(thumbnail.position));

    return out.finish();
  },

  decode(bytes) {
    const read = reader(slotCodec, bytes);
    const tag = read.u8();

    if (tag === 0) {
      read.end();

      return { kind: 'empty' };
    }

    if (tag !== 1) {
      throw new CodecError('Unknown slot kind');
    }

    const source = read.text(MAX_ID);
    const externalId = read.text(MAX_ID);
    const title = read.text(MAX_TEXT);
    const handle = read.text(MAX_TEXT);
    const avatarType = read.upTo(read.u8(), IMAGE_TYPES.length);
    const avatarBytes = read.blob(SLOT_MAX_AVATAR);

    if ((avatarType === 0) !== (avatarBytes.length === 0)) {
      throw new CodecError('Inconsistent avatar');
    }

    const nextPollAt = read.u32() * 1000;
    const consecutiveFailures = read.u8();
    const websubStatus = STATUSES[read.upTo(read.u8(), STATUSES.length - 1)]!;
    const websubExpiresAt = orNull(read.u32());
    const websubRequestedAt = orNull(read.u32());
    const present = flags(read.u8(), HAS_SECRET | HAS_TOKEN);
    const secret = read.raw(SECRET);
    const token = read.raw(TOKEN);
    const notFoundDays = read.u8();
    const notFoundDay = read.u16();
    const count = read.upTo(read.u16(), SLOT_MAX_ITEMS);
    const items: SlotItem[] = [];

    for (let i = 0; i < count; i++) {
      const id = read.text(MAX_ID);
      const itemTitle = read.text(MAX_TEXT);
      const published = read.u32() * 1000;
      const ingestedAt = read.u32() * 1000;
      const type = ITEM_TYPES[read.upTo(read.u8(), ITEM_TYPES.length - 1)]!;
      const itemFlags = flags(read.u8(), DELETED | UPCOMING);

      items.push({ id, title: itemTitle, published, ingestedAt, type, deleted: (itemFlags & DELETED) !== 0, upcoming: (itemFlags & UPCOMING) !== 0, thumbnail: null });
    }

    const thumbnails = read.upTo(read.u16(), count);

    for (let i = 0; i < thumbnails; i++) {
      const item = items[read.upTo(read.u16(), count - 1)]!;

      if (item.thumbnail !== null) {
        throw new CodecError('Duplicate thumbnail');
      }

      item.thumbnail = read.u32();
    }

    read.end();

    return {
      kind: 'channel',
      source,
      externalId,
      title,
      handle: handle === '' ? null : handle,
      avatar: avatarType === 0 ? null : { type: IMAGE_TYPES[avatarType - 1]!, bytes: avatarBytes },
      schedule: {
        nextPollAt,
        consecutiveFailures,
        websubStatus,
        websubExpiresAt,
        websubRequestedAt,
        websubSecret: (present & HAS_SECRET) !== 0 ? secret : nonZero(secret),
        callbackToken: (present & HAS_TOKEN) !== 0 ? token : nonZero(token),
        notFoundDays,
        notFoundDay,
      },
      items,
    };
  },
};

/** nextPollAt, failures, status, expiry, requested, presence, secret, token, not-found days and day. */
const SCHEDULE_SIZE = 4 + 1 + 1 + 4 + 4 + 1 + SECRET + TOKEN + 1 + 2;

function itemSize(item: SlotItem): number {
  return 1 + utf8Length(item.id) + 1 + utf8Length(item.title) + 4 + 4 + 1 + 1 + (item.thumbnail === null ? 0 : 6);
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function orNull(value: number): number | null {
  return value === 0 ? null : value * 1000;
}

/** An absent secret or token is written as zeros: anything else there is a malformed payload. */
function nonZero(bytes: Uint8Array): null {
  if (bytes.some((byte) => byte !== 0)) {
    throw new CodecError('Trailing bytes');
  }

  return null;
}
