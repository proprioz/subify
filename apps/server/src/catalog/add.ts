import type { AddResponse } from '@subify/shared';
import { type SlotChannel, type SlotImage, snapshotChannelCodec, type ThumbnailPayload, thumbnailCodec, toBase64Url } from '@subify/shared/codec';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import type { SourceAdapter } from '../sources/source';
import { snapshotChannel } from './snapshot';
import { ADD_THUMBNAILS, submitChannel, submitContext } from './submit';
import { THUMBNAILS_ON_ADD } from './tend';
import { readCases } from './vault';

/**
 * Adding a channel by link, the clear way (docs/FEATURES.md, D16): for a channel the device found
 * in no snapshot, a video link, or a handle the index doesn't know yet. The answer has a fixed
 * size, and comes after at least MIN_LATENCY whether the catalog knew the channel or read it
 * online: neither tells an observer which it was.
 */

export const MIN_LATENCY = 8_000;

/** Waits until `MIN_LATENCY` after `started`, whatever the work did, failures included. */
export async function atMinimumLatency<T>(platform: Platform, work: () => Promise<T>): Promise<T> {
  const started = platform.clock.now();

  try {
    return await work();
  } finally {
    await platform.sleep(Math.max(0, started + MIN_LATENCY - platform.clock.now()));
  }
}

export async function addByLink(platform: Platform, keys: ServerKeys, sources: readonly SourceAdapter[], url: string): Promise<AddResponse> {
  const submitted = await submitChannel(url, { ...(await submitContext(platform, sources)), byUser: true });
  const channel = snapshotChannel(submitted.channel);
  // A channel new to the catalog brought its thumbnails; one it had takes them from its slot.
  const images = submitted.thumbnails ?? (await fromRing(platform, keys, submitted.channel));
  const thumbnails: ThumbnailPayload[] = channel.items.flatMap((item) => {
    const image = images.get(item.id);

    return image === undefined ? [] : [{ kind: 'thumbnail' as const, itemId: item.id, image }];
  });
  const padded = [...thumbnails.slice(0, ADD_THUMBNAILS), ...Array.from({ length: Math.max(0, ADD_THUMBNAILS - thumbnails.length) }, () => ({ kind: 'empty' as const }))];

  return {
    v: 5,
    channel: toBase64Url(snapshotChannelCodec.encode(channel)),
    thumbnails: toBase64Url(concat(padded.map((payload) => thumbnailCodec.encode(payload)))),
  };
}

/** The thumbnails of the channel's last 7 days, from the ring. */
async function fromRing(platform: Platform, keys: ServerKeys, slot: SlotChannel): Promise<Map<string, SlotImage>> {
  const since = platform.clock.now() - THUMBNAILS_ON_ADD;
  const wanted = slot.items.filter((item) => item.thumbnail !== null && !item.deleted && (item.published >= since || item.upcoming));
  const cases = await readCases(platform.db, keys, wanted.map((item) => item.thumbnail!));
  const found = new Map<string, SlotImage>();

  for (const item of wanted) {
    const held = cases.get(item.thumbnail!);

    if (held?.kind === 'thumbnail' && held.itemId === item.id) {
      found.set(item.id, held.image);
    }
  }

  return found;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  parts.forEach((part) => {
    all.set(part, at);
    at += part.length;
  });

  return all;
}
