import { addingHoursCodec, CodecError, catalogStateCodec, HANDLE_ENTRY_SIZE, lotCodec, lotFragmentCodec, splitThumbnail, openHandleEntry, seedPoolCodec, snapshotChannelCodec, streamDeltaCodec, SLOT_MAX_ITEMS, SLOT_SIZE, type SlotChannel, slotCodec, THUMBNAIL_MAX_BYTES, thumbnailCodec, utf8Length } from '@subify/shared/codec';
import { blind, channelInput, channelSecrets, evaluate, evaluateBlinded, finalize, groupOf } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { open, SealError, seal, sealedSize } from '../../src/crypto/aead';
import { deriveKeys } from '../../src/crypto/keys';
import { channel, GOLDEN, item } from '../fixtures/payloads/golden';
import slotV1 from '../fixtures/payloads/slot-v1.hex?raw';
import stateV1 from '../fixtures/payloads/state-v1.hex?raw';
import thumbnailV1 from '../fixtures/payloads/thumbnail-v1.hex?raw';
import poolV1 from '../fixtures/payloads/pool-v1.hex?raw';
import hoursV1 from '../fixtures/payloads/hours-v1.hex?raw';
import deltaV1 from '../fixtures/payloads/delta-v1.hex?raw';
import deltaV2 from '../fixtures/payloads/delta-v2.hex?raw';
import deltaV3 from '../fixtures/payloads/delta-v3.hex?raw';
import snapshotV1 from '../fixtures/payloads/snapshot-v1.hex?raw';
import snapshotV2 from '../fixtures/payloads/snapshot-v2.hex?raw';
import handleV1 from '../fixtures/payloads/handle-v1.hex?raw';
import lotFragmentV1 from '../fixtures/payloads/lot-fragment-v1.hex?raw';
import lotV1 from '../fixtures/payloads/lot-v1.hex?raw';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const digits = text.trim();

  for (let i = 0; i < digits.length; i += 2) {
    bytes[i / 2] = Number.parseInt(digits.slice(i, i + 2), 16);
  }

  return bytes;
}

// A slot that doesn't round-trip, or changes size with its content, would lose a channel's videos or tell busy channels from quiet ones and decoys.
describe('the slot codec', () => {
  it('keeps the documented 400 items of a busy channel with Latin titles', () => {
    const value = channel(Array.from({ length: SLOT_MAX_ITEMS }, (_, i) => item(i, 'A typical video title of about fifty characters ok')));
    const bytes = slotCodec.encode(value);

    expect(bytes.length).toBe(SLOT_SIZE);
    expect(slotCodec.decode(bytes)).toEqual(value);
  });

  it('fits the worst case, emoji titles at the limit and the largest avatar, by dropping the oldest items and cutting titles at a character', () => {
    const emoji = '😀'.repeat(100);
    const value = channel(Array.from({ length: SLOT_MAX_ITEMS }, (_, i) => item(i, emoji)), 12 * 1024);
    const bytes = slotCodec.encode(value);
    const decoded = slotCodec.decode(bytes) as SlotChannel;

    expect(bytes.length).toBe(SLOT_SIZE);
    expect(decoded.items.length).toBeGreaterThan(60);
    expect(decoded.items.length).toBeLessThan(SLOT_MAX_ITEMS);
    // The newest are kept, in order.
    expect(decoded.items.map((kept) => kept.id)).toEqual(value.items.slice(0, decoded.items.length).map((kept) => kept.id));
    // 63 whole emoji: 252 bytes, never half of one.
    expect(decoded.items[0]!.title).toBe('😀'.repeat(63));
    expect(utf8Length(decoded.items[0]!.title)).toBe(252);
  });

  it('gives an empty decoy the same size as a full slot', () => {
    const bytes = slotCodec.encode({ kind: 'empty' });

    expect(bytes.length).toBe(SLOT_SIZE);
    expect(slotCodec.decode(bytes)).toEqual({ kind: 'empty' });
  });

  // Like backup-v1.json: a format change shows in a diff, and stored slots of version 1 keep decoding.
  it('keeps decoding the version 1 fixture, and encodes it the same way', () => {
    const fixture = fromHex(slotV1, SLOT_SIZE);

    expect(slotCodec.decode(fixture)).toEqual(GOLDEN);
    expect(hex(slotCodec.encode(GOLDEN)).replace(/(00)+$/, '')).toBe(slotV1.trim());
  });

  // The catalog's state outlives every deploy: a format change would show in this diff, and a state written before a field existed must still read as its zero ("no feed answered", the ring at its start, no channel counted).
  it('keeps decoding the version 1 state fixture, and a state from before feedsAnswered', () => {
    const golden = { tableSize: 3750, passes: 1234, growthDueAt: 1_793_000_000_000, feedsAnswered: true, ringNext: 0, channels: 0 };

    expect(catalogStateCodec.decode(fromHex(stateV1, catalogStateCodec.size))).toEqual(golden);
    expect(hex(catalogStateCodec.encode(golden)).replace(/(00)+$/, '')).toBe(stateV1.trim());
    expect(catalogStateCodec.decode(fromHex(stateV1.trim().slice(0, -2), catalogStateCodec.size)).feedsAnswered).toBe(false);
  });

  // Cases live in the ring for 30 days across deploys: a format change shows in this diff, and an image too large for a case is refused rather than cut into a broken picture.
  it('keeps decoding the version 1 thumbnail fixture, gives a decoy the same size, and refuses an image too large for a case', () => {
    const golden = { kind: 'thumbnail' as const, itemId: 'videoidabcd', image: { type: 'image/jpeg' as const, bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0) } };

    expect(thumbnailCodec.decode(fromHex(thumbnailV1, thumbnailCodec.size))).toEqual(golden);
    expect(hex(thumbnailCodec.encode(golden)).replace(/(00)+$/, '')).toBe(thumbnailV1.trim());
    expect(thumbnailCodec.encode({ kind: 'empty' }).length).toBe(thumbnailCodec.size);
    const largest = { ...golden, itemId: 'x'.repeat(64), image: { type: 'image/webp' as const, bytes: new Uint8Array(THUMBNAIL_MAX_BYTES).fill(1) } };
    expect(thumbnailCodec.decode(thumbnailCodec.encode(largest))).toEqual(largest);
    expect(() => thumbnailCodec.encode({ ...golden, image: { type: 'image/jpeg', bytes: new Uint8Array(THUMBNAIL_MAX_BYTES + 1) } })).toThrow(CodecError);
  });

  // A pass reads seeding's rows before it rewrites them: a format change would show in this diff, and rows of version 1 must keep decoding.
  it('keeps decoding the version 1 seed pool and hours fixtures, and encodes them the same way', () => {
    const pool = [
      { source: 'fake', input: 'channel:b', cites: 2, day: 20_750 },
      { source: 'youtube', input: 'handle:lenasitu', cites: 1, day: 20_760 },
    ];
    const hours = { counts: Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 5 : hour === 18 ? 1 : 0)), halvedDay: 20_755 };

    expect(seedPoolCodec.decode(fromHex(poolV1, seedPoolCodec.size))).toEqual(pool);
    expect(hex(seedPoolCodec.encode(pool)).replace(/(00)+$/, '')).toBe(poolV1.trim());
    expect(addingHoursCodec.decode(fromHex(hoursV1, addingHoursCodec.size))).toEqual(hours);
    expect(hex(addingHoursCodec.encode(hours))).toBe(hoursV1.trim() + '00'.repeat(addingHoursCodec.size - hoursV1.trim().length / 2));
  });

  // Devices decode stream entries with this codec: a format change would show in this diff, and an app must keep reading every version.
  it('keeps decoding the stream delta fixtures of every version, and refuses an unknown kind', () => {
    const golden = { kind: 'item' as const, id: 'videoidabcd', title: 'Titre', published: 1_793_000_000_000, type: 'short' as const, deleted: false, upcoming: true, preview: null };
    const withPreview = { ...golden, preview: Uint8Array.from({ length: 19 }, (_, i) => 0xa0 + i) };
    const fixture = fromHex(deltaV1, streamDeltaCodec.size);
    const retry = { kind: 'retry' as const, retryAt: 1_793_000_600_000 };

    expect(streamDeltaCodec.decode(fixture)).toEqual(golden);
    expect(streamDeltaCodec.decode(fromHex(deltaV2, streamDeltaCodec.size))).toEqual(retry);
    expect(streamDeltaCodec.decode(fromHex(deltaV3, streamDeltaCodec.size))).toEqual(withPreview);
    expect(hex(streamDeltaCodec.encode(withPreview)).replace(/(00)+$/, '')).toBe(deltaV3.trim());
    expect(streamDeltaCodec.decode(streamDeltaCodec.encode({ kind: 'gone' }))).toEqual({ kind: 'gone' });
    expect(streamDeltaCodec.decode(streamDeltaCodec.encode({ kind: 'retry', retryAt: null }))).toEqual({ kind: 'retry', retryAt: null });
    // Version 1 had no 'retry' kind; 5 is no kind at all.
    expect(() => streamDeltaCodec.decode(fixture.map((byte, i) => (i === 1 ? 4 : byte)))).toThrow(CodecError);
    expect(() => streamDeltaCodec.decode(fromHex(deltaV2, streamDeltaCodec.size).map((byte, i) => (i === 1 ? 5 : byte)))).toThrow(CodecError);
  });

  // Devices decode snapshot entries with this codec when they add a channel: a format change would show in this diff, and an app must keep reading every version.
  it('keeps decoding the snapshot entry fixtures of every version', () => {
    const golden = {
      source: 'youtube',
      externalId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
      title: 'Une chaîne 🚀',
      handle: 'unechaine',
      avatar: { type: 'image/png' as const, bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) },
      items: [
        { id: 'videoidabcd', title: 'Première vidéo', published: 1_793_000_000_000, type: 'video' as const, upcoming: false },
        { id: 'videoidefgh', title: '日本語', published: 1_792_990_000_000, type: 'live' as const, upcoming: true },
      ],
    };

    // Version 1 has no retry time.
    expect(snapshotChannelCodec.decode(fromHex(snapshotV1, snapshotChannelCodec.size))).toEqual({ ...golden, retryAt: null });
    expect(snapshotChannelCodec.decode(fromHex(snapshotV2, snapshotChannelCodec.size))).toEqual({ ...golden, retryAt: 1_793_000_600_000 });
    expect(hex(snapshotChannelCodec.encode({ ...golden, retryAt: 1_793_000_600_000 })).replace(/(00)+$/, '')).toBe(snapshotV2.trim());
    expect(snapshotChannelCodec.decode(snapshotChannelCodec.encode({ ...golden, retryAt: null })).retryAt).toBeNull();
  });

  // Devices decode lot fragments with this codec, and the server reads back a week of lots across deploys: a format change would show in this diff.
  it('keeps decoding the version 1 lot fragment and lot fixtures, and cuts a thumbnail in parts that join back', () => {
    const fragment = { itemId: 'videoidabcd', type: 'image/webp' as const, part: 1, parts: 3, bytes: Uint8Array.of(0x52, 0x49, 0x46, 0x46) };
    const lot = { hour: 498_000, groups: 32, fragments: new Uint8Array(1024).fill(0xab) };

    expect(lotFragmentCodec.decode(fromHex(lotFragmentV1, lotFragmentCodec.size))).toEqual(fragment);
    expect(hex(lotFragmentCodec.encode(fragment)).replace(/(00)+$/, '')).toBe(lotFragmentV1.trim());
    expect(lotCodec(1).decode(fromHex(lotV1, lotCodec(1).size))).toEqual(lot);
    expect(() => lotFragmentCodec.decode(fromHex(lotFragmentV1, lotFragmentCodec.size).map((byte, i) => (i === 13 ? 3 : byte)))).toThrow(CodecError);

    // 7,000 bytes, the size of a typical WebP, in 8 parts.
    const image = { type: 'image/webp' as const, bytes: Uint8Array.from({ length: 7_000 }, (_, i) => i % 251) };
    const parts = splitThumbnail('videoidabcd', image);
    expect(parts.map((part) => [part.part, part.parts])).toEqual(Array.from({ length: 8 }, (_, i) => [i, 8]));
    expect(parts.map((part) => lotFragmentCodec.decode(lotFragmentCodec.encode(part)).bytes).reduce((all, bytes) => Uint8Array.from([...all, ...bytes]))).toEqual(image.bytes);
  });

  // Devices open handle entries with this layout and key: a change to the sealed value or its associated data would leave every device unable to find a channel by its @handle.
  it('keeps opening the version 1 handle entry fixture', async () => {
    const entryId = new Uint8Array(16).fill(0x11);
    const fixture = fromHex(handleV1, HANDLE_ENTRY_SIZE);

    expect(await openHandleEntry(entryId, new Uint8Array(32).fill(0x22), fixture)).toEqual({ source: 'youtube', externalId: 'UCxxxxxxxxxxxxxxxxxxxxxx' });
    await expect(openHandleEntry(entryId, new Uint8Array(32).fill(0x23), fixture)).rejects.toThrow();
  });

  // A lenient decoder would accept a format it doesn't know and read garbage as a channel.
  it('refuses truncated input, trailing bytes, unknown flags, versions and out-of-range counts', () => {
    const good = slotCodec.encode(GOLDEN);
    const changed = (at: number, value: number) => good.map((byte, i) => (i === at ? value : byte));
    // Version, kind, source, id, title, empty handle, avatar (type, length, 4 bytes), then the schedule.
    const countAt = 1 + 1 + 5 + 25 + 10 + 1 + (1 + 2 + 4) + (4 + 1 + 1 + 4 + 4 + 1 + 32 + 16 + 1 + 2);
    // The first item's flags: after the count, its id, title, published, ingested and type.
    const firstFlags = countAt + 2 + 12 + 1 + utf8Length(GOLDEN.items[0]!.title) + 4 + 4 + 1;

    expect(() => slotCodec.decode(good.slice(0, -1))).toThrow(CodecError);
    expect(() => slotCodec.decode(changed(good.length - 1, 1))).toThrow(CodecError);
    expect(() => slotCodec.decode(changed(0, 2))).toThrow(CodecError);
    expect(() => slotCodec.decode(changed(firstFlags, 0x80))).toThrow(CodecError);
    expect(() => slotCodec.decode(changed(countAt, 0xff))).toThrow(CodecError);
    // The offsets above are right: a known flag there decodes.
    expect((slotCodec.decode(changed(firstFlags, 2)) as SlotChannel).items[0]!.upcoming).toBe(true);
  });
});

// Without the server key, a blob must say nothing; with it, it must only open where it was written.
describe('sealed payloads', () => {
  const secret = new Uint8Array(32).fill(9);
  const rowA = new Uint8Array(16).fill(0xa);
  const rowB = new Uint8Array(16).fill(0xb);

  it('have the same size whatever they hold, and open only for their row and kind, with their key', async () => {
    const keys = await deriveKeys(secret);
    const full = await seal(keys, slotCodec, rowA, GOLDEN);
    const empty = await seal(keys, slotCodec, rowA, { kind: 'empty' });

    expect(full.length).toBe(40 * 1024);
    expect(empty.length).toBe(sealedSize(slotCodec));
    expect(await open(keys, slotCodec, rowA, full)).toEqual(GOLDEN);

    await expect(open(keys, slotCodec, rowB, full)).rejects.toThrow(SealError);
    await expect(open(keys, { ...slotCodec, kind: 99 }, rowA, full)).rejects.toThrow(SealError);
    await expect(open(await deriveKeys(new Uint8Array(32).fill(8)), slotCodec, rowA, full)).rejects.toThrow(SealError);
    const tampered = full.slice();
    tampered[100] = tampered[100]! ^ 1;
    await expect(open(keys, slotCodec, rowA, tampered)).rejects.toThrow(SealError);
  });

  it('look unrelated when the same payload is written twice', async () => {
    const keys = await deriveKeys(secret);
    const first = await seal(keys, slotCodec, rowA, { kind: 'empty' });
    const second = await seal(keys, slotCodec, rowA, { kind: 'empty' });

    expect(hex(first.slice(2))).not.toBe(hex(second.slice(2)));
  });
});

// A device finds a channel's slot only if its blind evaluation gives the O the server computes itself.
describe('the VOPRF', () => {
  // A snapshot reads its group as one range of slot ids, and the stream keeps older batches with fewer groups: both need groups to be leading bits that nest.
  it('puts a slot in the group its id starts with, nested across group counts', () => {
    const id = Uint8Array.of(0b1011_0000, 0xff, 0, 0, ...new Array(12).fill(0));

    expect([1, 2, 4, 8, 16].map((groups) => groupOf(id, groups))).toEqual([0, 1, 2, 5, 11]);
    expect(() => groupOf(id, 3)).toThrow(RangeError);
  });

  it('gives a device the same output as the server, without the server seeing the channel', async () => {
    const keys = (await deriveKeys(new Uint8Array(32).fill(3))).voprf;
    const inputs = [channelInput('youtube', 'UCaaaaaaaaaaaaaaaaaaaaaa'), channelInput('youtube', 'UCbbbbbbbbbbbbbbbbbbbbbb')];
    const request = blind(inputs);
    const outputs = finalize(request, evaluateBlinded(keys, request.blinded), keys.publicKey);

    expect(outputs.map(hex)).toEqual(inputs.map((input) => hex(evaluate(keys, input))));

    const [a, b] = await Promise.all(outputs.map(channelSecrets));
    expect(hex(a!.slotId)).not.toBe(hex(b!.slotId));
    expect(a!.slotId.length).toBe(16);
    expect(hex(a!.transitKey)).not.toBe(hex(a!.slotId));
  });

  // An answer made with another key would send the device to wrong slots, or let a server tell devices apart by key.
  it('is refused by the device when the proof doesn’t match the published key', async () => {
    const keys = (await deriveKeys(new Uint8Array(32).fill(3))).voprf;
    const other = (await deriveKeys(new Uint8Array(32).fill(4))).voprf;
    const request = blind([channelInput('youtube', 'UCaaaaaaaaaaaaaaaaaaaaaa')]);

    expect(() => finalize(request, evaluateBlinded(other, request.blinded), keys.publicKey)).toThrow();
  });
});
