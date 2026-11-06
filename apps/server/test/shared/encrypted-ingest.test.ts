import { createHarness, type Harness } from '#harness';
import type { AddResponse } from '@subify/shared';
import { fromBase64Url, type SlotChannel, type SlotImage, type SlotItem, snapshotChannelCodec, THUMBNAIL_MAX_BYTES } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { periodOf, runPass, type PassOptions } from '../../src/catalog/pass';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import { slotIdOf } from '../../src/catalog/slot-id';
import { snapshotChannel } from '../../src/catalog/snapshot';
import { DEAD_AFTER_DAYS, hex } from '../../src/catalog/tend';
import { enqueueUpdate, openUpdates } from '../../src/catalog/updates';
import { readCases, readSlot, readSlots, readState } from '../../src/catalog/vault';
import type { Config } from '../../src/config';
import type { ServerKeys } from '../../src/crypto/keys';
import { youtube } from '../../src/sources/youtube/adapter';
import { fixtures, NASA } from '../fixtures';
import { channel as slotChannel } from '../fixtures/payloads/golden';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';
import { aired, newEntry, withEntry } from '../support/feed-entries';
import { FakeSource, item } from '../support/fake-source';

// A ring of 6 cases, 2 a pass: it wraps after 3 passes. A stream of 2 groups of 4 entries: room for every change unless a test fills it.
const SMALL: PassOptions = { firstTableSize: 8, ring: { perPass: 2, cases: 6 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };

interface Setup {
  harness: Harness;
  keys: ServerKeys;
  source: FakeSource;
  /** Runs one pass from the stored state, with the FakeSource and YouTube. */
  pass(): Promise<void>;
}

async function setup(config: Partial<Config> = {}, fake?: FakeFetch): Promise<Setup> {
  const source = new FakeSource();
  const harness = await createHarness({ config: { ...config }, sources: [source, youtube], ...(fake === undefined ? {} : { fake }) });
  const keys = await harness.platform.keys;
  await runPass(harness.platform, keys, undefined, SMALL);

  return {
    harness,
    keys,
    source,
    pass: async () => {
      await runPass(harness.platform, keys, await readState(harness.db, keys), SMALL, [source, youtube]);
    },
  };
}

/** A channel as an addition read it online, entering at the next pass. */
function entering(source: string, externalId: string, overrides: Partial<SlotChannel> = {}): SlotChannel {
  const base = slotChannel([]);

  return {
    ...base,
    source,
    externalId,
    avatar: null,
    items: [],
    schedule: { ...base.schedule, nextPollAt: START + HOUR, websubStatus: 'off', websubExpiresAt: null, websubRequestedAt: null, websubSecret: null, callbackToken: null },
    ...overrides,
  };
}

async function add(s: Setup, channel: SlotChannel): Promise<void> {
  await enqueueUpdate(s.harness.platform.coordinator, s.keys, { kind: 'channel', channel });
}

async function slotOf(s: Setup, source: string, externalId: string): Promise<SlotChannel | undefined> {
  const slot = await readSlot(s.harness.db, s.keys, await slotIdOf(s.keys, source, externalId));

  return slot?.payload.kind === 'channel' ? slot.payload : undefined;
}

async function allBlobs(harness: Harness): Promise<Uint8Array[]> {
  return (await harness.db.all<{ blob: Uint8Array }>('SELECT blob FROM slots')).map((row) => row.blob);
}

function contains(haystack: Uint8Array, needle: string): boolean {
  return hex(haystack).includes(hex(new TextEncoder().encode(needle)));
}

// A channel enters the encrypted catalog only through the pass, in place of a decoy: the table must not grow by one, nor show the channel.
describe('channels entering the encrypted catalog', () => {
  it('take a decoy’s place at the next pass, and the table holds nothing readable', async () => {
    const s = await setup();
    const video = { id: 'videoidabcd', title: 'A recognisable video title', published: START - HOUR, ingestedAt: START, type: 'video' as const, deleted: false, upcoming: false, thumbnail: null, preview: null };
    await add(s, entering('fake', 'achannelid', { title: 'A recognisable title', items: [video] }));

    // Nothing is written before the pass.
    expect((await s.harness.db.all('SELECT id FROM slots')).length).toBe(8);
    expect(await slotOf(s, 'fake', 'achannelid')).toBeUndefined();

    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();

    expect((await slotOf(s, 'fake', 'achannelid'))?.items.map((kept) => kept.id)).toEqual(['videoidabcd']);
    expect((await s.harness.db.all('SELECT id FROM slots')).length).toBe(8);
    const blobs = await allBlobs(s.harness);
    expect(blobs.some((blob) => ['A recognisable', 'achannelid', 'videoidabcd'].some((text) => contains(blob, text)))).toBe(false);
    expect(await s.harness.platform.coordinator.pending(10)).toEqual([]);
  });

  it('come from an addition by link, with what it read online', async () => {
    const s = await setup({}, withRecordedChannels(new FakeFetch()));
    const response = (await (await s.harness.add(NASA)).json()) as AddResponse;
    const added = snapshotChannelCodec.decode(fromBase64Url(response.channel));

    // The channel, and the time a user added one, for the hours seeding follows.
    expect(await s.harness.platform.coordinator.pending(10)).toHaveLength(2);
    expect(await slotOf(s, 'youtube', NASA)).toBeUndefined();

    const reads = s.harness.fake.calls.length;
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    const slot = await slotOf(s, 'youtube', NASA);

    expect(slot?.title).toBe(added.title);
    expect(slot?.handle).toBe(added.handle);
    expect(slot?.avatar?.type).toBe('image/jpeg');
    expect(added.items.length).toBeGreaterThan(0);
    expect(snapshotChannel(slot!).items).toEqual(added.items);
    expect(slot?.schedule.nextPollAt).toBeGreaterThan(START + 10 * MINUTE);
    // Read moments ago: the pass doesn't read its feeds again.
    expect(s.harness.fake.calls.slice(reads).filter((call) => call.url.includes('/feeds/'))).toEqual([]);
  });

  it('wait in the coordinator while no decoy is left, and enter once the table grew', async () => {
    const s = await setup();
    s.harness.platform.random = () => 0;

    for (let i = 0; i < 9; i++) {
      await add(s, entering('fake', `c${i}`));
    }

    const channels = async () => (await readSlots(s.harness.db, s.keys, null, 50)).filter((slot) => slot.payload.kind === 'channel').length;

    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    // Full: the ninth waits. The table grew at once (the growth time drawn at 0), by decoys only.
    expect(await channels()).toBe(8);
    expect(await s.harness.platform.coordinator.pending(10)).toHaveLength(1);
    expect((await readState(s.harness.db, s.keys))?.tableSize).toBe(12);

    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();
    expect(await channels()).toBe(9);
    expect(await s.harness.platform.coordinator.pending(10)).toEqual([]);
  });
});

// Polling is the safety net when WebSub misses an upload: in the encrypted catalog, the pass does it.
describe('the pass polling the encrypted catalog', () => {
  it('reads a channel when its turn has come, merges new items, and schedules the next read', async () => {
    const s = await setup();
    s.source.channel('a', [item('a1', START - DAY)]);
    await add(s, entering('fake', 'a', { schedule: { ...entering('fake', 'a').schedule, nextPollAt: START + 20 * MINUTE } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    expect(s.source.polls).toEqual([]);

    s.source.publish('a', item('a2', START + 15 * MINUTE));
    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();

    const slot = await slotOf(s, 'fake', 'a');
    expect(s.source.polls.map((poll) => poll.id)).toEqual(['a']);
    expect(slot?.items.map((kept) => kept.id)).toEqual(['a2', 'a1']);
    expect(slot?.schedule.nextPollAt).toBeGreaterThan(START + 20 * MINUTE + HOUR / 2);
  });

  it('drops items older than the retention window', async () => {
    const s = await setup({ retentionDays: 30 });
    s.source.channel('a', [item('old', START - 40 * DAY), item('new', START - DAY)]);
    await add(s, entering('fake', 'a', { schedule: { ...entering('fake', 'a').schedule, nextPollAt: START } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();

    expect((await slotOf(s, 'fake', 'a'))?.items.map((kept) => kept.id)).toEqual(['new']);
  });

  // An inactive channel's feed keeps listing years-old videos: taking them in would undo retention at every pass.
  it('never takes in items older than the window, from an addition either', async () => {
    const s = await setup({ retentionDays: 183 });
    s.source.channel('a', [item('old', START - 200 * DAY), item('new', START - DAY)]);
    const response = (await (await s.harness.add('fake:a')).json()) as AddResponse;

    expect(snapshotChannelCodec.decode(fromBase64Url(response.channel)).items.map((kept) => kept.id)).toEqual(['new']);
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    expect((await slotOf(s, 'fake', 'a'))?.items.map((kept) => kept.id)).toEqual(['new']);
  });

  // YouTube answers 404 and 500 now and then for channels that exist: one failure must never cost a channel or its videos.
  it('keeps a failing channel’s items, retries it later and later, and recovers', async () => {
    const s = await setup();
    s.source.channel('a', [item('a1', START - DAY)]);
    await add(s, entering('fake', 'a', { items: [{ id: 'a1', title: 'Video a1', published: START - DAY, ingestedAt: START, type: 'video', deleted: false, upcoming: false, thumbnail: null, preview: null }], schedule: { ...entering('fake', 'a').schedule, nextPollAt: START } }));
    s.source.failing.set('a', 2);
    // A channel entering is polled from the pass after.
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();

    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();
    // The harness draws 0.5: the jitter adds nothing.
    expect((await slotOf(s, 'fake', 'a'))?.schedule).toMatchObject({ consecutiveFailures: 1, nextPollAt: START + 50 * MINUTE });
    expect((await slotOf(s, 'fake', 'a'))?.items.map((kept) => kept.id)).toEqual(['a1']);

    s.harness.setNow(START + 50 * MINUTE);
    await s.pass();
    expect((await slotOf(s, 'fake', 'a'))?.schedule).toMatchObject({ consecutiveFailures: 2, nextPollAt: START + 110 * MINUTE });

    s.harness.setNow(START + 110 * MINUTE);
    await s.pass();
    expect((await slotOf(s, 'fake', 'a'))?.schedule.consecutiveFailures).toBe(0);
    expect(s.source.polls).toHaveLength(3);
  });

  // Going past the Workers limits (subrequests per invocation) fails the whole pass: polls are capped at POLL_BATCH_SIZE a minute of its period.
  it('polls at most its budget of due channels in one pass', async () => {
    const source = new FakeSource();
    const harness = await createHarness({ sources: [source], config: { pollBatchSize: 1 } });
    const keys = await harness.platform.keys;
    const options = { ...SMALL, firstTableSize: 16 };
    await runPass(harness.platform, keys, undefined, options);

    for (let i = 0; i < 12; i++) {
      source.channel(`c${i}`, [item(`c${i}v`, START - DAY)]);
      await enqueueUpdate(harness.platform.coordinator, keys, { kind: 'channel', channel: entering('fake', `c${i}`, { schedule: { ...entering('fake', `c${i}`).schedule, nextPollAt: START } }) });
    }

    // They enter at one pass, and are polled from the next.
    for (const minutes of [10, 20]) {
      harness.setNow(START + minutes * MINUTE);
      await runPass(harness.platform, keys, await readState(harness.db, keys), options, [source]);
    }

    expect(source.polls).toHaveLength(periodOf(16) / MINUTE);
    expect(source.polls.length).toBeLessThan(12);
  });
});

// Each poll should cost one request: the three typed playlists are read only when there is something to type.
describe('the pass polling a YouTube channel', () => {
  /** NASA in its slot, due to be polled a day later. The recorded live has aired: while upcoming, every poll reads the playlists (upcoming.test.ts). */
  async function nasa(): Promise<{ s: Setup; fake: FakeFetch }> {
    const fake = withRecordedChannels(new FakeFetch()).on(youtubeUrls.lives(NASA), { body: aired(fixtures.nasaLives) });
    const s = await setup({}, fake);
    await s.harness.add(NASA);
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    fake.calls.length = 0;
    s.harness.setNow(START + DAY);

    return { s, fake };
  }

  it('reads only the channel feed when every upload is known', async () => {
    const { s, fake } = await nasa();

    await s.pass();

    expect(fake.urls).toEqual([youtubeUrls.channel(NASA)]);
  });

  it('reads the typed playlists to type a new upload', async () => {
    const { s, fake } = await nasa();
    const entry = newEntry('NewVideo001', 'A new video', START + DAY - HOUR);
    fake.on(youtubeUrls.channel(NASA), { body: withEntry(fixtures.nasaChannel, entry) }).on(youtubeUrls.videos(NASA), { body: withEntry(fixtures.nasaVideos, entry) });

    await s.pass();

    expect(fake.urls.filter((url) => url.includes('/feeds/')).sort()).toEqual([youtubeUrls.channel(NASA), youtubeUrls.lives(NASA), youtubeUrls.shorts(NASA), youtubeUrls.videos(NASA)].sort());
    expect((await slotOf(s, 'youtube', NASA))?.items.find((kept) => kept.id === 'NewVideo001')?.type).toBe('video');
  });

  // A rename must reach devices, which learn it from the slot.
  it('takes a channel’s new name', async () => {
    const { s, fake } = await nasa();
    fake.on(youtubeUrls.channel(NASA), { body: fixtures.nasaChannel.replace('<title>NASA</title>', '<title>NASA (renamed)</title>') });

    await s.pass();

    expect((await slotOf(s, 'youtube', NASA))?.title).toBe('NASA (renamed)');
  });
});

// The only removal: a channel the platform no longer has. Removing a live channel by mistake, during an outage, would be worse than keeping a dead one.
describe('channels gone from the platform', () => {
  async function dying(): Promise<Setup> {
    const s = await setup({ pollBatchSize: 10 });
    s.source.channel('alive', [item('x1', START - DAY)]).channel('dead', [item('d1', START - DAY)]);
    await add(s, entering('fake', 'alive', { schedule: { ...entering('fake', 'alive').schedule, nextPollAt: START } }));
    await add(s, entering('fake', 'dead', { schedule: { ...entering('fake', 'dead').schedule, nextPollAt: START } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    s.source.remove('dead');

    return s;
  }

  /** One pass a day: both channels are due by then. */
  async function days(s: Setup, from: number, count: number): Promise<void> {
    for (let day = from; day < from + count; day++) {
      const now = START + day * DAY + 10 * MINUTE;
      s.harness.setNow(now);
      await s.pass();
    }
  }

  it('are removed after 30 days of “not found”, once their page agrees, leaving a decoy in their place', async () => {
    const s = await dying();
    const deadId = hex(await slotIdOf(s.keys, 'fake', 'dead'));
    await days(s, 1, DEAD_AFTER_DAYS + 2);

    expect(await slotOf(s, 'fake', 'dead')).toBeUndefined();
    expect(await slotOf(s, 'fake', 'alive')).toBeDefined();
    const ids = (await s.harness.db.all<{ id: Uint8Array }>('SELECT id FROM slots')).map((row) => hex(row.id));
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(deadId);
  });

  it('stay while their page doesn’t answer', async () => {
    const s = await dying();
    s.source.pageDown.add('dead');
    await days(s, 1, DEAD_AFTER_DAYS + 2);
    expect(await slotOf(s, 'fake', 'dead')).toBeDefined();
  });

  it('stay while every feed fails at once', async () => {
    const outage = await dying();
    outage.source.remove('alive');
    // Every feed says 404: an outage, not a removal. 'alive' is back after it.
    await days(outage, 1, DEAD_AFTER_DAYS + 2);
    expect(await slotOf(outage, 'fake', 'dead')).toBeDefined();
  });
});

const HUB = 'https://pubsubhubbub.appspot.com/subscribe';
const TOPIC = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${NASA}`;

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);

  return `sha1=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))))}`;
}

// WebSub brings new videos within minutes; in the encrypted catalog, the hub's requests may only read, and the URL must name no channel.
describe('WebSub for the encrypted catalog', () => {
  it('subscribes at a pass, confirms, and turns a notification into an update the next pass applies', async () => {
    const newVideo = 'newvideo123';
    const fake = withRecordedChannels(new FakeFetch()).on(HUB, { status: 202 });
    const s = await setup({ publicBaseUrl: 'https://subify.example' }, fake);
    await add(s, entering('youtube', NASA, { schedule: { ...entering('youtube', NASA).schedule, nextPollAt: START + DAY } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();
    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();

    const form = new URLSearchParams(fake.calls.find((call) => call.url === HUB)?.body ?? '');
    const callback = new URL(form.get('hub.callback')!);
    const token = callback.searchParams.get('c')!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(form.get('hub.callback')).not.toContain(NASA);
    expect((await slotOf(s, 'youtube', NASA))?.schedule.websubStatus).toBe('pending');

    const writes = JSON.stringify(await allBlobs(s.harness));
    const confirm = await s.harness.request(`/api/websub/callback?${new URLSearchParams({ c: token, 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'xyz', 'hub.lease_seconds': '432000' })}`);
    expect(await confirm.text()).toBe('xyz');
    // The hub's request wrote nothing: the change waits for the pass.
    expect(JSON.stringify(await allBlobs(s.harness))).toBe(writes);

    s.harness.setNow(START + 30 * MINUTE);
    await s.pass();
    expect((await slotOf(s, 'youtube', NASA))?.schedule).toMatchObject({ websubStatus: 'active', websubExpiresAt: START + 20 * MINUTE + 432_000_000 });

    fake.on(`https://www.youtube.com/feeds/videos.xml?channel_id=${NASA}`, { body: withEntry(fixtures.nasaChannel, newEntry(newVideo, 'Fresh', START + 25 * MINUTE)) });
    // What YouTube's hub pushes for a new upload (format from YouTube's documentation).
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="${TOPIC}"/>
 <entry>
  <id>yt:video:${newVideo}</id>
  <yt:videoId>${newVideo}</yt:videoId>
  <yt:channelId>${NASA}</yt:channelId>
  <title>Fresh</title>
  <link rel="alternate" href="http://www.youtube.com/watch?v=${newVideo}"/>
  <published>2026-10-20T12:25:00+00:00</published>
  <updated>2026-10-20T12:25:00+00:00</updated>
 </entry>
</feed>`;
    const post = (signature: string) =>
      s.harness.request(`/api/websub/callback?c=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/atom+xml', 'X-Hub-Signature': signature }, body });

    await post(await sign(body, 'not-the-secret'));
    expect(await s.harness.platform.coordinator.pending(10)).toEqual([]);

    await post(await sign(body, form.get('hub.secret')!));
    expect(await s.harness.platform.coordinator.pending(10)).toHaveLength(1);

    s.harness.setNow(START + 40 * MINUTE);
    await s.pass();
    expect((await slotOf(s, 'youtube', NASA))?.items.map((kept) => kept.id)).toContain(newVideo);
  });
});

// Thumbnails come from the ring: a pass that wrote more cases when more videos arrived would tell when channels publish, and a slot pointing at an overwritten case would show another video's picture.
describe('thumbnails in the encrypted catalog', () => {
  const image = (fill: number, size = 3_000): SlotImage => ({ type: 'image/jpeg', bytes: new Uint8Array(size).fill(fill) });
  const video = (id: string, published: number, upcoming = false): SlotItem => ({ id, title: id, published, ingestedAt: START, type: 'video', deleted: false, upcoming, thumbnail: null, preview: null });
  const small = (id: string) => `https://fake.test/small/${id}`;

  async function thumbnails(s: Setup, externalId: string): Promise<Record<string, number | null>> {
    return Object.fromEntries((await slotOf(s, 'fake', externalId))!.items.map((kept) => [kept.id, kept.thumbnail]));
  }

  async function caseAt(s: Setup, position: number) {
    return (await readCases(s.harness.db, s.keys, [position])).get(position);
  }

  it('are read once, when their item arrives, the same number of cases written at every pass', async () => {
    const s = await setup();
    s.source.channel('a');
    [['recent', image(1)], ['old', image(2)], ['large', image(3, THUMBNAIL_MAX_BYTES + 1)], ['missing', null]].forEach(([id, img]) => s.source.images.set(small(id as string), img as SlotImage | null));
    // Entering, a channel brings the thumbnails of its last 7 days only.
    await add(s, entering('fake', 'a', { items: [video('recent', START - DAY), video('old', START - 8 * DAY)], schedule: { ...entering('fake', 'a').schedule, nextPollAt: START + 20 * MINUTE } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();

    const first = await thumbnails(s, 'a');
    expect(first.old).toBeNull();
    expect(await caseAt(s, first.recent!)).toEqual({ kind: 'thumbnail', itemId: 'recent', image: image(1) });
    expect(await s.harness.db.all('SELECT position FROM thumbnails')).toHaveLength(2);

    // Too large for a case, or not on the platform: kept without, and never read again.
    s.source.publish('a', item('large', START + 15 * MINUTE), item('missing', START + 15 * MINUTE));
    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();
    s.source.publish('a', item('later', START + 25 * MINUTE));
    s.harness.platform.random = () => 0;
    s.harness.setNow(START + 30 * MINUTE);
    await s.pass();

    expect(await thumbnails(s, 'a')).toMatchObject({ large: null, missing: null, recent: first.recent });
    expect(s.source.imageReads.filter((url) => url.includes('/small/') && !url.endsWith('/later'))).toEqual([small('recent'), small('large'), small('missing')]);
    const blobs = await s.harness.db.all<{ blob: Uint8Array }>('SELECT blob FROM thumbnails');
    expect(blobs).toHaveLength(6);
    expect(new Set(blobs.map((row) => row.blob.length)).size).toBe(1);
  });

  // Thumbnails the hour's lots haven't carried yet wait there too: only those without a case count here.
  const waitingThumbnails = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await openUpdates(await s.harness.platform.keys, await s.harness.platform.coordinator.pending(100))).opened.filter(({ update }) => update.kind === 'thumbnail').length;

  it('wait in the coordinator when a pass has no case left, and go before new ones at the next', async () => {
    const s = await setup();
    // 'busy' is read before 'waits' in the table's id order: its new videos would take every case first.
    s.source.channel('waits').channel('busy');
    ['w1', 'w2', 'w3', 'b1', 'b2'].forEach((id, i) => s.source.images.set(small(id), image(i + 1)));
    await add(s, entering('fake', 'waits', { items: [video('w1', START - 3 * HOUR), video('w2', START - 2 * HOUR), video('w3', START - HOUR)] }));
    await add(s, entering('fake', 'busy', { schedule: { ...entering('fake', 'busy').schedule, nextPollAt: START + 20 * MINUTE } }));
    s.harness.setNow(START + 10 * MINUTE);
    await s.pass();

    expect(Object.values(await thumbnails(s, 'waits')).filter((position) => position !== null)).toHaveLength(2);
    expect(await waitingThumbnails(s)).toBe(1);

    // Two new videos arrive with the one that waited: it has a case, one of them waits in turn.
    s.source.publish('busy', item('b1', START + 15 * MINUTE), item('b2', START + 15 * MINUTE));
    s.harness.setNow(START + 20 * MINUTE);
    await s.pass();

    expect(Object.values(await thumbnails(s, 'waits')).every((position) => position !== null)).toBe(true);
    expect(Object.values(await thumbnails(s, 'busy')).filter((position) => position !== null)).toHaveLength(1);
    expect(await waitingThumbnails(s)).toBe(1);
  });

  it('are gone once the ring wraps over them, except an upcoming item’s, which moves to a new case', async () => {
    const s = await setup();
    s.source.channel('a');
    s.source.images.set(small('aired'), image(1));
    s.source.images.set(small('soon'), image(2));
    await add(s, entering('fake', 'a', { items: [video('aired', START - HOUR), video('soon', START + 3 * DAY, true)], schedule: { ...entering('fake', 'a').schedule, nextPollAt: START + DAY } }));

    for (let pass = 1; pass <= 3; pass++) {
      s.harness.setNow(START + pass * 10 * MINUTE);
      await s.pass();
    }

    const before = await thumbnails(s, 'a');
    expect([before.aired, before.soon].sort()).toEqual([0, 1]);

    s.harness.setNow(START + 40 * MINUTE);
    await s.pass();
    const after = await thumbnails(s, 'a');

    expect(after.aired).toBeNull();
    expect(await caseAt(s, after.soon!)).toEqual({ kind: 'thumbnail', itemId: 'soon', image: image(2) });
  });
});
