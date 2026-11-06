/** Payload values for the codec tests, and the value each golden fixture holds. */
import type { SlotChannel, SlotItem } from '@subify/shared/codec';

const SECOND = 1000;
const START = 1_793_000_000 * SECOND;

export function item(i: number, title: string): SlotItem {
  return { id: `v${String(i).padStart(10, '0')}`, title, published: START - i * 3600 * SECOND, ingestedAt: START - i * 3600 * SECOND + 60 * SECOND, type: 'video', deleted: false, upcoming: false, thumbnail: null, preview: null };
}

export function channel(items: SlotItem[], avatarBytes = 7 * 1024): SlotChannel {
  return {
    kind: 'channel',
    source: 'fake',
    externalId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
    title: 'A channel',
    handle: 'achannel',
    avatar: { type: 'image/jpeg', bytes: new Uint8Array(avatarBytes).fill(7) },
    schedule: {
      nextPollAt: START + 3600 * SECOND,
      consecutiveFailures: 0,
      websubStatus: 'active',
      websubExpiresAt: START + 10 * 86400 * SECOND,
      websubRequestedAt: START - 86400 * SECOND,
      websubSecret: new Uint8Array(32).fill(1),
      callbackToken: new Uint8Array(16).fill(2),
      notFoundDays: 0,
      notFoundDay: 0,
    },
    items,
  };
}

/** The value slot-v1.hex holds. Never change either: the fixture proves version 1 keeps decoding. */
export const GOLDEN: SlotChannel = {
  ...channel([{ ...item(1, 'Première vidéo 🚀'), thumbnail: 42 }, { ...item(2, '日本語のタイトル'), type: 'short', upcoming: true }, { ...item(3, 'Gone'), type: 'live', deleted: true }], 4),
  handle: null,
  schedule: { ...channel([]).schedule, websubStatus: 'pending', websubExpiresAt: null, callbackToken: null, notFoundDays: 3, notFoundDay: 20_750 },
};

/** The value slot-v2.hex holds, with a preview. Never change either: the fixture proves version 2 keeps decoding. */
export const GOLDEN_V2: SlotChannel = {
  ...GOLDEN,
  items: GOLDEN.items.map((one, i) => (i === 0 ? { ...one, preview: Uint8Array.from({ length: 19 }, (_, j) => 0xa0 + j) } : one)),
};
