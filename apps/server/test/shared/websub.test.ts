import { createHarness, type Harness } from '#harness';
import type { SlotChannel } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { DAY, MINUTE } from '../../src/catalog/schedule';
import { slotIdOf } from '../../src/catalog/slot-id';
import { hex, LEASE_SECONDS } from '../../src/catalog/tend';
import { readSlot, readState } from '../../src/catalog/vault';
import { sources as youtubeOnly } from '../../src/sources';
import { fixtures, NASA } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';
import { newEntry, withEntry } from '../support/feed-entries';

const HUB = 'https://pubsubhubbub.appspot.com/subscribe';
const TOPIC = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${NASA}`;
const PUBLIC = 'https://subify.example';
const SMALL: PassOptions = { firstTableSize: 8, ring: { perPass: 2, cases: 6 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };

interface Setup {
  harness: Harness;
  fake: FakeFetch;
  /** The token the server put in the callback URL, and the secret it gave the hub. */
  token: string;
  secret: string;
  pass(at: number): Promise<void>;
  slot(): Promise<SlotChannel | undefined>;
  /** The updates waiting in the coordinator: thumbnails the small ring had no room for, then what the hub's requests queued. */
  queued(): Promise<number>;
}

/** NASA in the catalog, its subscription requested from the hub and pending. */
async function nasa(): Promise<Setup> {
  const fake = withRecordedChannels(new FakeFetch()).on(HUB, { status: 202 });
  const harness = await createHarness({ fake, config: { publicBaseUrl: PUBLIC } });
  const keys = await harness.platform.keys;
  const pass = async (at: number) => {
    harness.setNow(at);
    await runPass(harness.platform, keys, await readState(harness.db, keys), SMALL, youtubeOnly);
  };
  await runPass(harness.platform, keys, undefined, SMALL);
  await harness.add(NASA);
  await pass(START + 10 * MINUTE);
  await pass(START + 20 * MINUTE);
  const form = new URLSearchParams(fake.calls.find((call) => call.url === HUB)?.body ?? '');
  fake.calls.length = 0;

  return {
    harness,
    fake,
    token: new URL(form.get('hub.callback')!).searchParams.get('c')!,
    secret: form.get('hub.secret')!,
    pass,
    slot: async () => {
      const slot = await readSlot(harness.db, keys, await slotIdOf(keys, 'youtube', NASA));

      return slot?.payload.kind === 'channel' ? slot.payload : undefined;
    },
    queued: async () => (await harness.platform.coordinator.pending(1_000)).length,
  };
}

function verify(harness: Harness, token: string, params: Record<string, string>): Promise<Response> {
  return harness.request(`/api/websub/callback?${new URLSearchParams({ c: token, ...params })}`);
}

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);

  return `sha1=${hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))))}`;
}

function notify(harness: Harness, token: string, body: string, signature?: string): Promise<Response> {
  return harness.request(`/api/websub/callback?c=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/atom+xml', ...(signature === undefined ? {} : { 'X-Hub-Signature': signature }) },
    body,
  });
}

/** What YouTube's hub pushes for a new or updated upload (format from YouTube's documentation). */
function uploadNotification(videoId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
 <link rel="self" href="${TOPIC}"/>
 <title>YouTube video feed</title>
 <updated>2026-10-20T11:00:00+00:00</updated>
 <entry>
  <id>yt:video:${videoId}</id>
  <yt:videoId>${videoId}</yt:videoId>
  <yt:channelId>${NASA}</yt:channelId>
  <title>A new video</title>
  <link rel="alternate" href="http://www.youtube.com/watch?v=${videoId}"/>
  <author><name>NASA</name><uri>http://www.youtube.com/channel/${NASA}</uri></author>
  <published>2026-10-20T10:00:00+00:00</published>
  <updated>2026-10-20T11:00:00+00:00</updated>
 </entry>
</feed>`;
}

/** What YouTube's hub pushes when an upload is deleted. */
function deletionNotification(videoId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
 <at:deleted-entry ref="yt:video:${videoId}" when="2026-10-20T11:00:00+00:00">
  <link href="http://www.youtube.com/watch?v=${videoId}"/>
  <at:by><name>NASA</name><uri>http://www.youtube.com/channel/${NASA}</uri></at:by>
 </at:deleted-entry>
</feed>`;
}

// The dev server and some self-hosted ones cannot be reached by the hub: they must run on polling alone, without errors.
describe('subscribing to the hub', () => {
  it.each([null, 'http://localhost:8787', 'https://192.168.1.20', 'http://subify.example'])('stays off with the public URL %s', async (url) => {
    const fake = withRecordedChannels(new FakeFetch()).on(HUB, { status: 202 });
    const harness = await createHarness({ fake, config: { publicBaseUrl: url } });
    const keys = await harness.platform.keys;
    await runPass(harness.platform, keys, undefined, SMALL);
    await harness.add(NASA);

    for (const minutes of [10, 20]) {
      harness.setNow(START + minutes * MINUTE);
      await runPass(harness.platform, keys, await readState(harness.db, keys), SMALL, youtubeOnly);
    }

    expect(fake.urls).not.toContain(HUB);
    expect((await harness.request('/api/health')).status).toBe(200);
  });
});

// The hub only activates a subscription once we echo its challenge; echoing it for anyone would let anyone subscribe or unsubscribe us.
describe('confirming a subscription', () => {
  it('echoes the challenge of a subscription we asked for, and records its lease, capped at 10 days, at the next pass', async () => {
    const s = await nasa();
    expect(s.token).toMatch(/^[0-9a-f]{32}$/);

    const response = await verify(s.harness, s.token, { 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'xyz123', 'hub.lease_seconds': String(100 * 24 * 3600) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('xyz123');

    await s.pass(START + 30 * MINUTE);
    expect((await s.slot())?.schedule).toMatchObject({ websubStatus: 'active', websubExpiresAt: START + 20 * MINUTE + LEASE_SECONDS * 1000 });
  });

  it.each([
    ['an unknown token', { c: 'f'.repeat(32) }],
    ['a token that isn’t 32 hex characters', { c: 'ab'.repeat(32) }],
    ['another topic', { 'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx` }],
    ['an unsubscribe we never asked for', { 'hub.mode': 'unsubscribe' }],
  ])('refuses %s, and queues nothing', async (_, override) => {
    const s = await nasa();
    const before = await s.harness.dump();
    const queued = await s.queued();

    const response = await verify(s.harness, s.token, { 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'xyz123', ...override });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('xyz123');
    expect(await s.queued()).toBe(queued);
    expect(await s.harness.dump()).toBe(before);
  });

  it('refuses a subscription we are not waiting for', async () => {
    const s = await nasa();
    await verify(s.harness, s.token, { 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'first' });
    await s.pass(START + 30 * MINUTE);
    const queued = await s.queued();

    expect((await verify(s.harness, s.token, { 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'again' })).status).toBe(404);
    expect(await s.queued()).toBe(queued);
  });

  it('turns a subscription off when the hub denies it, and only one that is pending or active', async () => {
    const s = await nasa();

    expect((await verify(s.harness, s.token, { 'hub.mode': 'denied', 'hub.topic': TOPIC })).status).toBe(200);
    await s.pass(START + 30 * MINUTE);
    expect((await s.slot())?.schedule.websubStatus).toBe('off');
    const queued = await s.queued();

    expect((await verify(s.harness, s.token, { 'hub.mode': 'denied', 'hub.topic': TOPIC })).status).toBe(404);
    expect(await s.queued()).toBe(queued);
  });
});

// Only the hub knows the token and the secret: a forged notification could inject fake videos into the catalog, or make the server read feeds on anyone's say.
describe('notifications', () => {
  it.each([
    ['no signature', undefined, undefined],
    ['a wrong signature', 'sha1=0123456789abcdef0123456789abcdef01234567', undefined],
    ['a signature made with another secret', 'other', undefined],
    ['a token that isn’t 32 hex characters', 'right', 'ab'.repeat(32)],
    ['a wrong token', 'right', 'f'.repeat(32)],
  ])('ignores one with %s, writes and reads nothing, and still acknowledges it', async (_, signature, token) => {
    const s = await nasa();
    const before = await s.harness.dump();
    const queued = await s.queued();
    const body = uploadNotification('NewVideo001');
    const header = signature === 'other' ? await sign(body, 'not the secret') : signature === 'right' ? await sign(body, s.secret) : signature;

    const response = await notify(s.harness, token ?? s.token, body, header);

    expect(response.status).toBe(204);
    expect(await s.queued()).toBe(queued);
    expect(await s.harness.dump()).toBe(before);
    expect(s.fake.calls).toEqual([]);
  });

  it('types a new upload from its playlist once the signature matches, at the next pass', async () => {
    const s = await nasa();
    const entry = newEntry('NewVideo001', 'A new video', START - 30 * MINUTE);
    s.fake.on(youtubeUrls.channel(NASA), { body: withEntry(fixtures.nasaChannel, entry) }).on(youtubeUrls.shorts(NASA), { body: withEntry(fixtures.nasaShorts, entry) });
    const body = uploadNotification('NewVideo001');

    expect((await notify(s.harness, s.token, body, await sign(body, s.secret))).status).toBe(204);
    await s.pass(START + 30 * MINUTE);

    expect((await s.slot())?.items.find((kept) => kept.id === 'NewVideo001')).toMatchObject({ type: 'short', deleted: false });
  });

  // Otherwise deleted videos stay in everyone's feed: the slot keeps a tombstone, which the stream hands out and snapshots leave out.
  it('turns a deleted upload into a tombstone at the next pass, without reading the feeds', async () => {
    const s = await nasa();
    const deleted = (await s.slot())!.items.find((kept) => !kept.upcoming)!.id;
    const body = deletionNotification(deleted);

    await notify(s.harness, s.token, body, await sign(body, s.secret));
    expect(s.fake.calls).toEqual([]);
    await s.pass(START + 30 * MINUTE);

    expect((await s.slot())?.items.find((kept) => kept.id === deleted)).toMatchObject({ deleted: true });
  });
});

// Without renewing before the lease ends, a channel silently falls back to the slower polling.
describe('renewing a subscription', () => {
  it('asks the hub again two days before the lease ends, with the same callback token', async () => {
    const s = await nasa();
    await verify(s.harness, s.token, { 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'x', 'hub.lease_seconds': String(3 * 24 * 3600) });
    await s.pass(START + 30 * MINUTE);
    s.fake.calls.length = 0;

    await s.pass(START + 20 * MINUTE + DAY + 10 * MINUTE);
    const form = new URLSearchParams(s.fake.calls.find((call) => call.url === HUB)?.body ?? '');

    expect(new URL(form.get('hub.callback')!).searchParams.get('c')).toBe(s.token);
    expect((await s.slot())?.schedule.websubStatus).toBe('pending');
  });
});
