import { createHarness, type Harness } from '#harness';
import type { SnapshotResponse } from '@subify/shared';
import { fromBase64Url, openSnapshotEntry, openSnapshotThumbnails, SNAPSHOT_ENTRY_SIZE, type SlotChannel, type SlotImage, type SlotItem } from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import { snapshotGroups } from '../../src/catalog/snapshot';
import { enqueueUpdate } from '../../src/catalog/updates';
import { readState } from '../../src/catalog/vault';
import type { ServerKeys } from '../../src/crypto/keys';
import { channel as slotChannel } from '../fixtures/payloads/golden';
import { START } from '../harness/types';
import { FakeSource } from '../support/fake-source';

const OPTIONS: PassOptions = { firstTableSize: 8, ring: { perPass: 6, cases: 18 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };

interface Setup {
  harness: Harness;
  keys: ServerKeys;
  source: FakeSource;
  pass(): Promise<void>;
}

async function setup(): Promise<Setup> {
  const source = new FakeSource();
  const harness = await createHarness({ sources: [source] });
  const keys = await harness.platform.keys;
  await runPass(harness.platform, keys, undefined, OPTIONS);
  harness.setNow(START + 10 * MINUTE);

  return { harness, keys, source, pass: async () => void (await runPass(harness.platform, keys, await readState(harness.db, keys), OPTIONS, [source])) };
}

const video = (id: string, published: number, type: SlotItem['type'] = 'video', upcoming = false): SlotItem => ({ id, title: `Title ${id}`, published, ingestedAt: START, type, deleted: false, upcoming, thumbnail: null });
const image = (fill: number): SlotImage => ({ type: 'image/jpeg', bytes: new Uint8Array(3_000).fill(fill) });

async function add(s: Setup, externalId: string, items: SlotItem[]): Promise<void> {
  const base = slotChannel([]);
  const channel: SlotChannel = { ...base, source: 'fake', externalId, title: `Channel ${externalId}`, avatar: image(9), items, schedule: { ...base.schedule, nextPollAt: START + 30 * DAY } };
  s.source.channel(externalId);
  await enqueueUpdate(s.harness.platform.coordinator, s.keys, { kind: 'channel', channel });
}

/** What a device does for a channel it knows the VOPRF output of: download its group's snapshot, keep its own entry. */
async function read(s: Setup, externalId: string, thumbnails: boolean) {
  const secrets = await channelSecrets(evaluate(s.keys.voprf, channelInput('fake', externalId)));
  const response = await s.harness.request(`/api/snapshot?group=0&thumbnails=${thumbnails ? 1 : 0}`);
  const answer = (await response.json()) as SnapshotResponse;
  const entries = fromBase64Url(answer.entries);

  return {
    answer,
    entries,
    channel: await openSnapshotEntry(secrets.slotId, secrets.transitKey, entries),
    thumbnails: await openSnapshotThumbnails(secrets.transitKey, answer.pass, fromBase64Url(answer.thumbnails)),
  };
}

// Adding a channel the catalog has, restoring, or coming back after 30 days all go through the snapshot: a device that can't find its channel there would send it in clear, and a snapshot that shows only one channel would name it.
describe('group snapshots', () => {
  it('give a device its channel as an addition would, the latest 15 of each type, and nothing for a channel the catalog lacks', async () => {
    const s = await setup();
    const videos = Array.from({ length: 20 }, (_, i) => video(`v${String(i).padStart(2, '0')}`, START - (i + 1) * HOUR));
    await add(s, 'a', [video('soon', START + DAY, 'live', true), ...videos, video('s1', START - 2 * DAY, 'short')]);
    await s.pass();

    const { answer, channel } = await read(s, 'a', false);
    expect(answer).toMatchObject({ v: 3, groups: 1, thumbnails: '' });
    expect(channel).toMatchObject({ source: 'fake', externalId: 'a', title: 'Channel a', avatar: image(9) });
    expect(channel?.items.map((item) => item.id)).toEqual(['soon', ...videos.slice(0, 15).map((item) => item.id), 's1']);
    expect((await read(s, 'nobody', false)).channel).toBeNull();
  });

  it('hold one entry of the same size per slot of the group, decoys included, whatever the channels hold', async () => {
    const s = await setup();
    const empty = (await read(s, 'a', false)).entries.length;
    await add(s, 'a', [video('x', START - HOUR)]);
    await add(s, 'b', Array.from({ length: 40 }, (_, i) => video(`b${i}`, START - (i + 1) * HOUR)));
    await s.pass();

    expect(empty).toBe(8 * SNAPSHOT_ENTRY_SIZE);
    expect((await read(s, 'a', false)).entries.length).toBe(empty);
  });

  it('carry the group’s thumbnails of the last 7 days when asked, a fixed number of them, each found only with its channel’s key', async () => {
    const s = await setup();
    s.source.images.set('https://fake.test/small/recent', image(1));
    s.source.images.set('https://fake.test/small/old', image(2));
    const quiet = (await read(s, 'b', true)).answer.thumbnails.length;
    await add(s, 'a', [video('recent', START - DAY), video('old', START - 8 * DAY)]);
    await add(s, 'b', []);
    await s.pass();

    const a = await read(s, 'a', true);
    expect([...a.thumbnails]).toEqual([['recent', image(1)]]);
    expect((await read(s, 'b', true)).thumbnails.size).toBe(0);
    expect(a.answer.thumbnails.length).toBe(quiet);
  });

  // The group's size is the privacy a snapshot gives: about 40 channels, whatever the table's size.
  it('cut the catalog into groups of about 40 channels', () => {
    expect([2_500, 3_750, 5_625, 12_657].map(snapshotGroups)).toEqual([32, 64, 64, 128]);
    expect(snapshotGroups(8)).toBe(1);
  });

  // A device must tell a catalog with no pass yet, or a group past its end, from an empty group.
  it('are absent before the first pass, and refuse a group out of range', async () => {
    const s = await setup();

    expect((await s.harness.request('/api/snapshot?group=1&thumbnails=0')).status).toBe(404);
    expect((await s.harness.request('/api/snapshot?group=0')).status).toBe(400);
    // A second harness starts from an empty database, on both runtimes.
    expect((await (await createHarness()).request('/api/snapshot?group=0&thumbnails=0')).status).toBe(404);
  });
});
