import { createHarness, thumbnailModules } from '#harness';
import type { LotsResponse, StreamResponse } from '@subify/shared';
import { fromBase64Url, LOT_FRAGMENT_SIZE, openEntries, openLot, type SlotChannel, type SlotImage } from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, groupOf } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { HOUR, MINUTE } from '../../src/catalog/schedule';
import { thumbnailEncoder } from '../../src/catalog/thumbnails';
import { enqueueUpdate } from '../../src/catalog/updates';
import { readState } from '../../src/catalog/vault';
import { channel as slotChannel } from '../fixtures/payloads/golden';
import jpegBase64 from '../fixtures/thumbnail-320x180.jpg.b64?raw';
import { START } from '../harness/types';
import { FakeSource, item } from '../support/fake-source';

const image = (fill: number): SlotImage => ({ type: 'image/webp', bytes: new Uint8Array(2_000).fill(fill) });

async function setup(perGroup: number, encode = false) {
  const source = new FakeSource();
  const harness = await createHarness({ sources: [source], ...(encode ? { thumbnails: thumbnailEncoder(thumbnailModules) } : {}) });
  const keys = await harness.platform.keys;
  const options: PassOptions = { firstTableSize: 8, ring: { perPass: 4, cases: 40 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 }, lots: { groups: 2, perGroup, page: 168 } };
  await runPass(harness.platform, keys, undefined, options);
  const pass = async (at: number) => {
    harness.setNow(at);
    await runPass(harness.platform, keys, await readState(harness.db, keys), options, [source]);
  };

  for (const externalId of ['a', 'b']) {
    const base = slotChannel([]);
    const channel: SlotChannel = { ...base, source: 'fake', externalId, title: `Channel ${externalId}`, avatar: null, items: [], schedule: { ...base.schedule, nextPollAt: START + 20 * MINUTE, websubStatus: 'off', websubExpiresAt: null, websubRequestedAt: null, websubSecret: null, callbackToken: null } };
    source.channel(externalId);
    await enqueueUpdate(harness.platform.coordinator, keys, { kind: 'channel', channel });
  }

  await pass(START + 10 * MINUTE);

  /** What a device following `externalId` finds in its group's lots, by hour. */
  const lots = async (externalId: string, until?: number) => {
    const secrets = await channelSecrets(evaluate(keys.voprf, channelInput('fake', externalId)));
    const group = groupOf(secrets.slotId, 2);
    const answer = (await (await harness.request(`/api/lots?group=${group}${until === undefined ? '' : `&until=${until}`}`)).json()) as LotsResponse;
    const found: Record<number, Record<string, SlotImage>> = {};

    for (const lot of answer.lots) {
      found[lot.hour] = Object.fromEntries(await openLot(secrets.transitKey, lot.hour, fromBase64Url(lot.fragments)));
    }

    return { answer, found };
  };

  /** The deltas a device following `externalId` opens in the stream's batches after `since`. */
  const stream = async (externalId: string, since: number) => {
    const secrets = await channelSecrets(evaluate(keys.voprf, channelInput('fake', externalId)));
    const answer = (await (await harness.request(`/api/stream?since=${since}&group=${groupOf(secrets.slotId, 2)}`)).json()) as StreamResponse;

    return (await Promise.all(answer.batches.map((batch) => openEntries(secrets.transitKey, batch.pass, fromBase64Url(batch.entries))))).flat();
  };

  return { harness, source, pass, lots, stream };
}

const hour = (at: number) => Math.floor(at / HOUR);

// Devices get the thumbnails of videos that arrive after they added a channel from these lots alone (D3): one that went missing, or reached the wrong device, would break that promise.
describe('the thumbnail lots', () => {
  it('carry a new video’s thumbnail, at the first pass of the next hour, to a device that knows its channel’s key only', async () => {
    const s = await setup(10);
    s.source.images.set(s.source.smallThumbnailUrl('a1'), image(1));
    s.source.publish('a', item('a1', START + 15 * MINUTE));
    await s.pass(START + 20 * MINUTE);

    // The video arrived during the hour: its thumbnail waits for the hour's end.
    expect((await s.lots('a')).found).toEqual({});

    await s.pass(START + HOUR);
    const a = await s.lots('a');

    expect(a.answer).toMatchObject({ v: 3, latest: hour(START + HOUR), groups: 2 });
    expect(a.found).toEqual({ [hour(START + HOUR)]: { a1: image(1) } });
    expect(Object.values((await s.lots('b')).found).flatMap(Object.keys)).toEqual([]);
  });

  // A lot whose size followed the videos would tell an observer when the channels of a group publish.
  it('have the same size in every group and every hour, whatever arrived', async () => {
    const s = await setup(10);
    s.source.images.set(s.source.smallThumbnailUrl('a1'), image(1));
    s.source.publish('a', item('a1', START + 15 * MINUTE));
    await s.pass(START + 20 * MINUTE);
    await s.pass(START + HOUR);

    const answers = await Promise.all([0, 1].map(async (group) => (await (await s.harness.request(`/api/lots?group=${group}`)).json()) as LotsResponse));
    const sizes = answers.flatMap((answer) => answer.lots.map((lot) => fromBase64Url(lot.fragments).length));

    expect(sizes).toHaveLength(2);
    expect(new Set(sizes)).toEqual(new Set([10 * LOT_FRAGMENT_SIZE]));
    expect(new Set((await s.harness.db.all<{ blob: Uint8Array }>('SELECT blob FROM lots')).map((row) => row.blob.length)).size).toBe(1);
  });

  it('keep a thumbnail a lot has no room for whole, for the next hour’s lot', async () => {
    // Room for one thumbnail of 3 fragments only.
    const s = await setup(5);
    s.source.images.set(s.source.smallThumbnailUrl('a1'), image(1));
    s.source.images.set(s.source.smallThumbnailUrl('a2'), image(2));
    s.source.publish('a', item('a1', START + 15 * MINUTE), item('a2', START + 16 * MINUTE));
    await s.pass(START + 20 * MINUTE);
    await s.pass(START + HOUR);
    await s.pass(START + 2 * HOUR);

    const { found } = await s.lots('a');
    expect(Object.keys(found[hour(START + HOUR)]!)).toHaveLength(1);
    expect(Object.keys({ ...found[hour(START + HOUR)], ...found[hour(START + 2 * HOUR)] }).sort()).toEqual(['a1', 'a2']);
  });

  // The blurred preview shows only if the stream entry carries the ThumbHash the server computed; the lot must carry the lighter WebP.
  it('carry the WebP the server made of a new video’s JPEG, whose stream entry carries its preview', async () => {
    const s = await setup(40, true);
    const jpeg = Uint8Array.from(atob(jpegBase64.trim()), (char) => char.charCodeAt(0));
    s.source.images.set(s.source.smallThumbnailUrl('a1'), { type: 'image/jpeg', bytes: jpeg });
    s.source.publish('a', item('a1', START + 15 * MINUTE));
    const since = (await readState(s.harness.db, await s.harness.platform.keys))!.passes;
    await s.pass(START + 20 * MINUTE);
    await s.pass(START + HOUR);

    const [delta] = await s.stream('a', since);
    expect(delta).toMatchObject({ kind: 'item', id: 'a1' });
    expect(delta!.kind === 'item' && delta!.preview!.length).toBeGreaterThan(10);
    const thumbnail = (await s.lots('a')).found[hour(START + HOUR)]!.a1!;
    expect(thumbnail.type).toBe('image/webp');
    expect(thumbnail.bytes.length).toBeLessThan(jpeg.length / 2);
  });

  // A device reads back page by page: an answer past the week kept, or for a group that doesn't exist, must say so.
  it('read back from `until`, keep a week, and refuse a group that doesn’t exist', async () => {
    const s = await setup(10);
    await s.pass(START + HOUR);
    await s.pass(START + 2 * HOUR);

    expect((await s.lots('a', hour(START + HOUR))).answer.lots.map((lot) => lot.hour)).toEqual([hour(START + HOUR)]);
    // A week after the first lot, it is still there; an hour later, it is gone.
    s.harness.setNow(START + HOUR + 167 * HOUR);
    expect((await s.lots('a')).answer.lots.map((lot) => lot.hour)).toEqual([hour(START + 2 * HOUR), hour(START + HOUR)]);
    s.harness.setNow(START + HOUR + 168 * HOUR);
    expect((await s.lots('a')).answer.lots.map((lot) => lot.hour)).toEqual([hour(START + 2 * HOUR)]);
    expect((await s.harness.request('/api/lots?group=2')).status).toBe(404);
    expect((await s.harness.request('/api/lots?group=0&since=1')).status).toBe(400);
  });
});
