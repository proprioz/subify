import { createHarness, type Harness } from '#harness';
import type { AddResponse, ApiError } from '@subify/shared';
import { fromBase64Url, type SnapshotChannel, snapshotChannelCodec, thumbnailCodec } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { MIN_LATENCY } from '../../src/catalog/add';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import { ADD_THUMBNAILS } from '../../src/catalog/submit';
import { slotIdOf } from '../../src/catalog/slot-id';
import { readSlot, readState } from '../../src/catalog/vault';
import { sources as youtubeOnly } from '../../src/sources';
import { fixtures, KURZGESAGT, NASA, NASA_AVATAR, NASA_VIDEO } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';
import { registerRecorded } from '../support/recorded';
import { FakeSource, item } from '../support/fake-source';

const SMALL: PassOptions = { firstTableSize: 8, ring: { perPass: 2, cases: 6 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };

const NASA_FETCHES = [
  youtubeUrls.page(`channel/${NASA}`),
  youtubeUrls.channel(NASA),
  youtubeUrls.lives(NASA),
  youtubeUrls.shorts(NASA),
  youtubeUrls.videos(NASA),
  NASA_AVATAR,
  // The @handle, which a /channel/ link does not give: oEmbed names it for the latest video.
  youtubeUrls.oembed(NASA_VIDEO),
];

async function setup(): Promise<{ harness: Harness; source: FakeSource; waits: number[] }> {
  const source = new FakeSource();
  source.channel('a', [item('a1', START - HOUR), item('a2', START - 2 * HOUR)]);
  source.images.set('https://fake.test/small/a1', { type: 'image/jpeg', bytes: new Uint8Array(2_000).fill(1) });
  source.images.set('https://fake.test/small/a2', null);
  const harness = await createHarness({ sources: [source] });
  const waits: number[] = [];
  // The clock doesn't move during a request in tests: each wait is the whole minimum latency.
  harness.platform.sleep = async (ms) => void waits.push(ms);

  return { harness, source, waits };
}

/** A YouTube server with the recorded channels, its catalog laid out by a first pass. */
async function youtube(fake = withRecordedChannels(new FakeFetch())): Promise<{ harness: Harness; pass(at: number): Promise<void> }> {
  const harness = await createHarness({ fake });
  const keys = await harness.platform.keys;
  await runPass(harness.platform, keys, undefined, SMALL);

  return {
    harness,
    pass: async (at) => {
      harness.setNow(at);
      await runPass(harness.platform, keys, await readState(harness.db, keys), SMALL, youtubeOnly);
    },
  };
}

async function channelOf(response: Response): Promise<SnapshotChannel> {
  expect(response.status).toBe(200);

  return snapshotChannelCodec.decode(fromBase64Url(((await response.json()) as AddResponse).channel));
}

/** The item ids whose thumbnail the answer carries. */
async function thumbnailsOf(response: Response): Promise<string[]> {
  const cases = fromBase64Url(((await response.json()) as AddResponse).thumbnails);

  return Array.from({ length: ADD_THUMBNAILS }, (_, i) => thumbnailCodec.decode(cases.subarray(i * thumbnailCodec.size, (i + 1) * thumbnailCodec.size))).flatMap((payload) =>
    payload.kind === 'thumbnail' ? [payload.itemId] : [],
  );
}

// The clear way to add a channel must not tell an observer whether the catalog had it: by its size, its timing, or a quick failure.
describe('adding a channel by link', () => {
  it('answers the channel, its items and its thumbnails, at the same size whether the catalog knew it or not', async () => {
    const { harness } = await setup();
    const first = await harness.add('fake:a');
    const body = (await first.json()) as AddResponse;
    const channel = snapshotChannelCodec.decode(fromBase64Url(body.channel));
    const cases = fromBase64Url(body.thumbnails);

    expect(channel).toMatchObject({ source: 'fake', externalId: 'a', items: [{ id: 'a1' }, { id: 'a2' }] });
    expect(cases.length).toBe(ADD_THUMBNAILS * thumbnailCodec.size);
    expect(thumbnailCodec.decode(cases.subarray(0, thumbnailCodec.size))).toMatchObject({ kind: 'thumbnail', itemId: 'a1' });
    expect(thumbnailCodec.decode(cases.subarray(thumbnailCodec.size, 2 * thumbnailCodec.size))).toEqual({ kind: 'empty' });

    const again = await (await harness.add('fake:a')).text();
    expect(again.length).toBe(JSON.stringify(body).length);
  });

  it('waits the minimum latency on every answer, failures included', async () => {
    const { harness, waits } = await setup();

    expect((await harness.add('fake:a')).status).toBe(200);
    expect((await harness.add('fake:a')).status).toBe(200);
    expect((await harness.add('fake:nobody')).status).toBe(404);
    expect(waits).toEqual([MIN_LATENCY, MIN_LATENCY, MIN_LATENCY]);
  });

  // Scheduled weeks ahead, an upcoming video ranks below the latest 15: a new follower would never see it.
  it('gives the latest 15 items of each type, and every upcoming one', async () => {
    const recent = Array.from({ length: 16 }, (_, i) => item(`v${i}`, START - i * HOUR));
    const source = new FakeSource().channel('a', [...recent, { ...item('later', START - 30 * DAY), upcoming: true }]);
    const harness = await createHarness({ sources: [source] });
    const channel = await channelOf(await harness.add('fake:a'));

    expect(channel.items.map((kept) => kept.id)).toEqual([...recent.slice(0, 15).map((kept) => kept.externalId), 'later']);
    expect(channel.items.at(-1)).toMatchObject({ upcoming: true });
  });
});

// Rejecting bad input before any request is what keeps the Worker from being an open proxy.
describe('POST /api/add refuses', () => {
  it.each([
    ['a host that is not YouTube', 'https://example.com/channel/' + NASA],
    ['a look-alike host', 'https://www.youtube.com.example.com/channel/' + NASA],
    ['plain http', 'http://www.youtube.com/channel/' + NASA],
    ['credentials in the link', 'https://me:pw@www.youtube.com/channel/' + NASA],
    ['a port', 'https://www.youtube.com:444/channel/' + NASA],
    ['a malformed channel id', 'https://www.youtube.com/channel/UC123'],
    ['two links in one string', `https://www.youtube.com/channel/${NASA} https://www.youtube.com/channel/${KURZGESAGT}`],
  ])('%s, without any request', async (_, url) => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const response = await harness.add(url);

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toBe('invalid_link');
    expect(harness.fake.calls).toEqual([]);
  });

  // One link per request keeps a request within its subrequest budget: several new channels at once could not be read in one.
  it.each([
    ['a list of links', { url: [`https://www.youtube.com/channel/${NASA}`, `https://www.youtube.com/channel/${KURZGESAGT}`] }],
    ['an extra field', { url: `https://www.youtube.com/channel/${NASA}`, also: KURZGESAGT }],
    ['a list of objects', [{ url: `https://www.youtube.com/channel/${NASA}` }]],
    ['no url', {}],
  ])('a body with %s', async (_, body) => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const response = await harness.post('/api/add', body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toBe('invalid_request');
    expect(harness.fake.calls).toEqual([]);
  });

  // The validators throw their own errors for a body that is not JSON: the answer must still be in the API's format, which the app shows.
  it.each([
    ['text', 'text/plain', `{"url":"${NASA}"}`],
    ['malformed JSON', 'application/json', '{"url":'],
    ['no body', undefined, undefined],
  ])('%s, in the API’s error format', async (_, type, body) => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const response = await harness.request('/api/add', { method: 'POST', ...(type === undefined ? {} : { headers: { 'Content-Type': type } }), ...(body === undefined ? {} : { body }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(harness.fake.calls).toEqual([]);
  });

  it('a body that is too large', async () => {
    const harness = await createHarness();
    const response = await harness.add(`https://www.youtube.com/channel/${NASA}?pad=${'x'.repeat(5_000)}`);

    expect(response.status).toBe(413);
  });
});

// The server only calls URLs it built from a validated id: nothing the user typed is fetched as is.
describe('URLs the server fetches', () => {
  it('are rebuilt from the channel id, whatever the link looked like', async () => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const response = await harness.add(`https://m.youtube.com/channel/${NASA}/videos?view=57&evil=https://example.com#x`);
    const thumbnails = await thumbnailsOf(response);

    expect(response.status).toBe(200);
    expect(thumbnails.length).toBeGreaterThan(0);
    expect(harness.fake.urls.sort()).toEqual([...NASA_FETCHES, ...thumbnails.map(youtubeUrls.smallThumbnail)].sort());
    expect(harness.fake.unexpected).toEqual([]);
  });

  // Anonymity: the requests must name no person, no instance and no project.
  it('carry a generic User-Agent, and the consent cookie only on the channel page', async () => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    await harness.add(NASA);

    expect(harness.fake.calls.length).toBeGreaterThan(NASA_FETCHES.length);

    for (const call of harness.fake.calls) {
      expect(call.headers.get('User-Agent')).toBe('Mozilla/5.0 (compatible; feed reader)');
      expect(call.headers.has('Cookie')).toBe(call.url === youtubeUrls.page(`channel/${NASA}`));
    }
  });

  // Following a redirect blindly would let YouTube, or whoever answers, send the server anywhere.
  it('never follow a redirect off YouTube', async () => {
    const fake = withRecordedChannels(new FakeFetch()).on(youtubeUrls.page('@NASA'), {
      status: 302,
      headers: { Location: 'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F%40NASA' },
    });
    const harness = await createHarness({ fake });
    const response = await harness.add('@NASA');

    expect(response.status).toBe(404);
    expect(harness.fake.urls).toEqual([youtubeUrls.page('@NASA')]);
  });
});

// Adding a channel must give a usable answer at once, whatever form the link takes.
describe('adding a channel new to the catalog', () => {
  it('answers it with its title, handle, avatar and items, and it enters its slot at the next pass', async () => {
    const { harness, pass } = await youtube();
    const channel = await channelOf(await harness.add(`https://www.youtube.com/channel/${NASA}`));

    expect(channel).toMatchObject({ source: 'youtube', externalId: NASA, title: 'NASA', handle: 'NASA', avatar: { type: 'image/jpeg' } });
    expect(channel.items.length).toBeGreaterThan(0);

    await pass(START + 10 * MINUTE);
    harness.fake.calls.length = 0;

    expect(await channelOf(await harness.add(NASA))).toEqual(channel);
    expect(harness.fake.calls).toEqual([]);
  });

  // The server never reads a channel because a user asked, once the catalog has it: by its id, or by its handle once the hourly index has it.
  it('answers a known channel from its slot, without any request', async () => {
    const { harness, pass } = await youtube();
    await harness.add('@NASA');
    await pass(START + 10 * MINUTE);
    harness.fake.calls.length = 0;

    for (const link of [NASA, '@nasa', `https://www.youtube.com/channel/${NASA}`, 'https://www.youtube.com/@NASA']) {
      expect((await channelOf(await harness.add(link))).externalId).toBe(NASA);
    }

    expect(harness.fake.calls).toEqual([]);
  });

  // Until the next pass, the coordinator holds a new channel and the handle index doesn't name it: a second addition reads it again rather than fail.
  it('reads a channel again when added twice before the pass', async () => {
    const { harness } = await youtube();
    await harness.add('@NASA');
    harness.fake.calls.length = 0;

    expect((await channelOf(await harness.add('@NASA'))).externalId).toBe(NASA);
    expect(harness.fake.urls).toContain(youtubeUrls.page('@NASA'));
  });

  it('resolves a @handle with one read of the channel page', async () => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const channel = await channelOf(await harness.add('https://www.youtube.com/@NASA'));

    expect(channel).toMatchObject({ externalId: NASA, handle: 'NASA', title: 'NASA' });
    expect(harness.fake.urls.filter((url) => url.includes('/@NASA'))).toHaveLength(1);
    expect(harness.fake.urls).not.toContain(youtubeUrls.page(`channel/${NASA}`));
  });

  it('asks for the /channel/ link when a @handle cannot be found', async () => {
    const fake = new FakeFetch().on(youtubeUrls.page('@nobody-here'), { status: 404, body: fixtures.page404 });
    const harness = await createHarness({ fake });
    const response = await harness.add('@nobody-here');
    const body = (await response.json()) as ApiError;

    expect(response.status).toBe(404);
    expect(body.error).toBe('channel_not_found');
    expect(body.message).toContain('/channel/UC…');
  });

  // A channel typed by its name is found through the @handles it likely has, and a name must not cost more than a few page reads.
  describe('typed by its name', () => {
    const pages = (fake: FakeFetch) => fake.urls.filter((url) => url.startsWith(youtubeUrls.page('@')));

    it('reads its likeliest handles in turn until one is a channel', async () => {
      const fake = withRecordedChannels(new FakeFetch())
        .on(youtubeUrls.page('@nasaspace'), { status: 404, body: fixtures.page404 })
        .on(youtubeUrls.page('@nasa.space'), { body: fixtures.nasaPage });
      const harness = await createHarness({ fake });
      const channel = await channelOf(await harness.add('NASA Space'));

      expect(channel).toMatchObject({ externalId: NASA, handle: 'nasa.space' });
      expect(pages(harness.fake)).toEqual([youtubeUrls.page('@nasaspace'), youtubeUrls.page('@nasa.space')]);
    });

    it('answers from the catalog under any of them once the handle index has it, without any request', async () => {
      const { harness, pass } = await youtube(withRecordedChannels(new FakeFetch()).on(youtubeUrls.page('@nasa-space'), { body: fixtures.nasaPage }));
      await harness.add('@nasa-space');
      await pass(START + 10 * MINUTE);
      harness.fake.calls.length = 0;

      expect((await channelOf(await harness.add('Nasa Space'))).externalId).toBe(NASA);
      expect(harness.fake.calls).toEqual([]);
    });

    it('gives up after three page reads', async () => {
      const fake = new FakeFetch();

      for (const handle of ['nasaspace', 'nasa.space', 'nasa_space']) {
        fake.on(youtubeUrls.page(`@${handle}`), { status: 404, body: fixtures.page404 });
      }

      const harness = await createHarness({ fake });
      const response = await harness.add('NASA Space');

      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error).toBe('channel_not_found');
      expect(harness.fake.urls).toHaveLength(3);
    });
  });

  it('finds the channel of a video link through oEmbed', async () => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const channel = await channelOf(await harness.add(`https://youtu.be/${NASA_VIDEO}`));

    expect(channel).toMatchObject({ externalId: NASA, handle: 'NASA' });
    expect(harness.fake.urls[0]).toBe(youtubeUrls.oembed(NASA_VIDEO));
  });

  // The server keeps no list of videos to tell their channel from: a video link costs an oEmbed read, but no more once the catalog has the channel.
  it('reads oEmbed for a video link even when the catalog has its channel, and nothing else', async () => {
    const { harness, pass } = await youtube();
    await harness.add('@NASA');
    await pass(START + 10 * MINUTE);
    harness.fake.calls.length = 0;

    expect((await channelOf(await harness.add(`https://youtu.be/${NASA_VIDEO}`))).externalId).toBe(NASA);
    expect(harness.fake.urls).toEqual([youtubeUrls.oembed(NASA_VIDEO)]);
  });

  it('explains when a video’s channel cannot be found', async () => {
    const fake = new FakeFetch().on(youtubeUrls.oembed('AAAAAAAAAAA'), { status: 404, body: fixtures.oembed404 });
    const harness = await createHarness({ fake });
    const response = await harness.add('https://www.youtube.com/watch?v=AAAAAAAAAAA');

    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).message).toContain('link to the channel');
  });

  it('reports a channel id that does not exist, and queues nothing', async () => {
    const missing = 'UCxxxxxxxxxxxxxxxxxxxxxx';
    const fake = new FakeFetch()
      .on(youtubeUrls.page(`channel/${missing}`), { status: 404, body: fixtures.page404 })
      .on(youtubeUrls.channel(missing), { status: 404, body: fixtures.channelFeed404 })
      .on(youtubeUrls.videos(missing), { status: 404 })
      .on(youtubeUrls.shorts(missing), { status: 404 })
      .on(youtubeUrls.lives(missing), { status: 404 });
    const harness = await createHarness({ fake });
    const response = await harness.add(missing);

    expect(response.status).toBe(404);
    expect(await harness.platform.coordinator.pending(10)).toEqual([]);
  });

  // YouTube's feeds go down for every channel at once now and then: a channel its page confirmed must still be added.
  it('adds a channel its page confirmed while its feeds are down, without items', async () => {
    const down = { status: 404, body: fixtures.channelFeed404 };
    const fake = withRecordedChannels(new FakeFetch())
      .on(youtubeUrls.channel(NASA), down)
      .on(youtubeUrls.videos(NASA), down)
      .on(youtubeUrls.shorts(NASA), down)
      .on(youtubeUrls.lives(NASA), down);
    const { harness, pass } = await youtube(fake);
    const channel = await channelOf(await harness.add('@NASA'));

    expect(channel).toMatchObject({ externalId: NASA, title: 'NASA', items: [] });
    // The channel and the hour a user added one.
    expect(await harness.platform.coordinator.pending(10)).toHaveLength(2);

    // Once the feeds are back, the pass after the one it entered at polls it, not hours later.
    registerRecorded(fake, fixtures);
    await pass(START + 10 * MINUTE);
    await pass(START + 20 * MINUTE);
    const keys = await harness.platform.keys;
    const slot = await readSlot(harness.db, keys, await slotIdOf(keys, 'youtube', NASA));

    expect(slot?.payload.kind === 'channel' ? slot.payload.items.length : 0).toBeGreaterThan(0);
  });

  it('asks to try again when neither the page nor the feeds can be read, and queues nothing', async () => {
    const fake = withRecordedChannels(new FakeFetch())
      .on(youtubeUrls.page(`channel/${NASA}`), { status: 503 })
      .on(youtubeUrls.channel(NASA), { status: 500 });
    const harness = await createHarness({ fake });
    const response = await harness.add(NASA);

    expect(response.status).toBe(502);
    expect(await harness.platform.coordinator.pending(10)).toEqual([]);
  });

  it('still adds a channel whose page cannot be read, with the feed title and no avatar', async () => {
    const harness = await createHarness({ fake: withRecordedChannels(new FakeFetch()) });
    const channel = await channelOf(await harness.add(KURZGESAGT));

    expect(channel.title).toContain('Kurzgesagt');
    expect(channel.avatar).toBeNull();
  });
});

// A channel page weighs 2 MB; the Workers Free plan gives a request 10 ms of CPU, so reading must stop once the id is found.
describe('reading a channel page', () => {
  it('stops once it found the id, title and avatar', async () => {
    let pulledAfterEnd = 0;
    const encoder = new TextEncoder();
    const page = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(fixtures.nasaPage));
        },
        pull(controller) {
          pulledAfterEnd++;
          controller.enqueue(encoder.encode('<div>'.repeat(10_000)));
        },
      });
    const fake = withRecordedChannels(new FakeFetch()).on(youtubeUrls.page('@NASA'), () => ({ body: page() }));
    const harness = await createHarness({ fake });

    const response = await harness.add('@NASA');

    expect(response.status).toBe(200);
    expect(pulledAfterEnd).toBeLessThanOrEqual(1);
  });
});
