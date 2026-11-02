import type { SearchResponse } from '@subify/shared';
import { describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '#harness';
import { runPass } from '../../src/catalog/pass';
import { DAY, MINUTE } from '../../src/catalog/schedule';
import { enqueueUpdate } from '../../src/catalog/updates';
import { readState } from '../../src/catalog/vault';
import type { Config } from '../../src/config';
import { blurring, decoyTerm, INVIDIOUS_LIST, invidiousHosts, PIPED_LIST, pipedHosts, searchInBackground } from '../../src/search/search';
import { fixtures, NASA } from '../fixtures';
import { channel as slotChannel } from '../fixtures/payloads/golden';
import { START } from '../harness/types';
import { FakeFetch, youtubeUrls } from '../support/fake-fetch';

const NAME = 'nasa space';
const KURZ_FAN = 'UCkkkkkkkkkkkkkkkkkkkkkk';

function invidiousUrl(host: string, term: string): string {
  return `https://${host}/api/v1/search?q=${encodeURIComponent(term)}&type=channel`;
}

const INVIDIOUS_ANSWER = JSON.stringify([
  { type: 'video', videoId: 'abcdefghijk', authorId: KURZ_FAN },
  { type: 'channel', authorId: NASA, author: 'Nasa (instance’s name)', channelHandle: '@NASA', description: 'Explore\nthe universe' },
  { type: 'channel', authorId: KURZ_FAN, author: 'Gone', channelHandle: null, description: '' },
  { type: 'channel', authorId: 'not-an-id', author: 'X' },
]);

/** A fake network: YouTube's feeds for NASA (exists) and KURZ_FAN (404), every instance answering any term with `answer`. */
function network(answers: Record<string, () => { status?: number; body?: string }> = {}): FakeFetch {
  const fake = new FakeFetch().on(youtubeUrls.channel(NASA), { body: fixtures.nasaChannel }).on(youtubeUrls.channel(KURZ_FAN), { status: 404, body: fixtures.channelFeed404 });
  const route = fake.fetch;
  // Instances answer whatever is searched: decoys are drawn at random.
  const answered: typeof fake.fetch = async (url, init) => {
    const host = new URL(url).hostname;
    const answer = answers[host];

    if (answer !== undefined && !fake.urls.includes(url)) {
      fake.on(url, answer);
    }

    return route(url, init);
  };

  return Object.assign(fake, { fetch: answered });
}

async function harnessWith(fake: FakeFetch, config: Partial<Config>): Promise<Harness> {
  return createHarness({ fake, config: { searchSources: new Set(['invidious', 'piped']), invidiousInstances: [], pipedInstances: [], ...config } });
}

async function search(harness: Harness, q: string): Promise<SearchResponse> {
  const response = await harness.post('/api/search', { q });
  expect(response.status).toBe(200);

  return (await response.json()) as SearchResponse;
}

function instanceCalls(harness: Harness, host: string): string[] {
  return harness.fake.calls.map((call) => call.url).filter((url) => new URL(url).hostname === host);
}

describe('searching a channel by name on Invidious and Piped', () => {
  // Third parties are the admin's choice: a server that didn't turn them on must not contact any, not even for decoys.
  it('is off unless SEARCH_SOURCES names them, and SEARCH_SOURCES=none stays silent', async () => {
    const fake = network({ 'inv.test': () => ({ body: INVIDIOUS_ANSWER }) });
    const byDefault = await createHarness({ fake, config: { invidiousInstances: ['inv.test'] } });
    byDefault.platform.random = () => 0;
    await searchInBackground(byDefault.platform);
    const none = await createHarness({ fake, config: { searchSources: new Set(), invidiousInstances: ['inv.test'] } });
    none.platform.random = () => 0;
    await searchInBackground(none.platform);

    expect((await byDefault.post('/api/search', { q: NAME })).status).toBe(404);
    expect((await none.post('/api/search', { q: NAME })).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  // A result is shown only if the platform itself confirms the channel, named as its own feed names it: an instance may lie or be stale.
  it('answers only the results the channel feed confirms', async () => {
    const harness = await harnessWith(network({ 'inv.test': () => ({ body: INVIDIOUS_ANSWER }) }), { invidiousInstances: ['inv.test'] });

    const { results } = await search(harness, NAME);

    expect(results).toEqual([{ id: NASA, name: 'NASA', handle: 'NASA', description: 'Explore the universe' }]);
    expect(harness.fake.urls).toContain(youtubeUrls.channel(KURZ_FAN));
  });

  // Each result costs a read of YouTube: no more than five per search.
  it('checks five results at most', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ type: 'channel', authorId: `UC${String(i).repeat(22)}`, description: '' }));
    const harness = await harnessWith(network({ 'inv.test': () => ({ body: JSON.stringify(many) }) }), { invidiousInstances: ['inv.test'] });

    await search(harness, NAME);

    expect(harness.fake.unexpected.filter((url) => url.startsWith('https://www.youtube.com/'))).toHaveLength(5);
  });

  // Decoys hide the real search: with it go two searches to other instances, never the same term.
  it('sends two decoys to other instances with each real search', async () => {
    const answer = () => ({ body: INVIDIOUS_ANSWER });
    const harness = await harnessWith(network({ 'a.test': answer, 'b.test': answer, 'c.test': answer, 'p.test': () => ({ body: '{"items":[]}' }) }), {
      invidiousInstances: ['a.test', 'b.test', 'c.test'],
      pipedInstances: ['p.test'],
    });

    await search(harness, NAME);
    const searched = harness.fake.calls.map((call) => new URL(call.url)).filter((url) => url.hostname !== 'www.youtube.com');
    const real = searched.filter((url) => url.searchParams.get('q') === NAME);

    expect(real).toHaveLength(1);
    expect(searched).toHaveLength(3);
    expect(new Set(searched.map((url) => url.hostname)).size).toBe(3);
  });

  // An instance that refuses automated requests (a challenge page, 429) must be left alone, and the search must still be tried elsewhere.
  it('tries another instance when one refuses, then leaves it alone for a day', async () => {
    const harness = await harnessWith(
      network({ 'busy.test': () => ({ body: '<html>Checking your browser…</html>' }), 'ok.test': () => ({ body: INVIDIOUS_ANSWER }) }),
      { invidiousInstances: ['busy.test', 'ok.test'] },
    );
    // The first draw falls on busy.test.
    harness.platform.random = () => 0;

    const first = await search(harness, NAME);
    const refused = instanceCalls(harness, 'busy.test').length;
    harness.setNow(START + 12 * 60 * MINUTE);
    await search(harness, 'another name');

    expect(first.results.map((result) => result.id)).toEqual([NASA]);
    expect(refused).toBe(1);
    expect(instanceCalls(harness, 'busy.test')).toHaveLength(1);
  });

  // Instances are drawn by reliability: one that just failed must not be the first choice.
  it('prefers the instances that answered well', async () => {
    let failing = true;
    const harness = await harnessWith(
      network({ 'a.test': () => (failing ? { status: 500, body: '' } : { body: INVIDIOUS_ANSWER }), 'b.test': () => ({ body: INVIDIOUS_ANSWER }) }),
      { invidiousInstances: ['a.test', 'b.test'], searchDecoysPerHour: 0 },
    );
    harness.platform.random = () => 0;
    await search(harness, 'first name');
    failing = false;
    const before = instanceCalls(harness, 'a.test').length;

    // The draw takes the best first: b.test now, since a.test failed.
    await search(harness, 'second name');

    expect(harness.fake.calls.filter((call) => call.url === invidiousUrl('b.test', 'second name'))).toHaveLength(1);
    expect(instanceCalls(harness, 'a.test').filter((url) => url.includes('second'))).toHaveLength(0);
    expect(before).toBeGreaterThan(0);
  });

  // The name is the user's words: answered, then forgotten, in the database as anywhere else.
  it('keeps the name nowhere', async () => {
    const harness = await harnessWith(network({ 'inv.test': () => ({ body: INVIDIOUS_ANSWER }) }), { invidiousInstances: ['inv.test'] });

    await search(harness, 'Very Private Name');

    expect(await harness.dump()).not.toMatch(/private/i);
    expect(JSON.stringify(await harness.platform.coordinator.searchState())).not.toMatch(/private/i);
  });

  // Decoys at a steady rate keep a quiet hour from showing that a search is real.
  it('sends background decoys at SEARCH_DECOYS_PER_HOUR on average', async () => {
    const harness = await harnessWith(network({ 'inv.test': () => ({ body: '[]' }) }), { invidiousInstances: ['inv.test'], searchDecoysPerHour: 2 });

    harness.platform.random = () => 2 / 60 + 0.001;
    await searchInBackground(harness.platform);
    const above = harness.fake.calls.length;
    harness.platform.random = () => 2 / 60 - 0.001;
    await searchInBackground(harness.platform);

    expect(above).toBe(0);
    expect(instanceCalls(harness, 'inv.test')).toHaveLength(1);
    expect(blurring((await harness.platform.coordinator.searchState())!)).toBe(0);
  });
});

describe('decoy terms', () => {
  // Decoys drawn from the catalog would tell the instances which channels it holds: only the dictionary and common words may give them.
  it('come from the dictionary or common words, never from the catalog', async () => {
    const harness = await harnessWith(network(), {});
    const keys = await harness.platform.keys;
    await runPass(harness.platform, keys, undefined, { firstTableSize: 8, poolRows: 2 });
    await enqueueUpdate(harness.platform.coordinator, keys, { kind: 'channel', channel: { ...slotChannel([]), title: 'Catalog Only Title', schedule: { ...slotChannel([]).schedule, nextPollAt: START + DAY } } });
    await runPass(harness.platform, keys, await readState(harness.db, keys), { firstTableSize: 8, poolRows: 2 });
    expect((await readState(harness.db, keys))?.channels).toBe(1);
    const gz = new Uint8Array(await new Response(new Blob([`${NASA}\tnasa\tNASA Dictionary\u001fNasa Dico\n`]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    for (let slice = 0; slice < 64; slice++) {
      await harness.db.run('INSERT INTO dictionary (slice, data) VALUES (?, ?)', [slice, gz]);
    }

    const terms = new Set<string>();
    for (let i = 0; i < 200; i++) {
      let draw = i;
      harness.platform.random = () => ((draw = (draw * 9301 + 49297) % 233280) / 233280);
      terms.add(await decoyTerm(harness.platform));
    }

    expect(terms.has('NASA Dictionary') || terms.has('Nasa Dico')).toBe(true);
    expect([...terms].some((term) => /catalog/i.test(term))).toBe(false);
    expect(terms.size).toBeGreaterThan(5);
  });
});

describe('the official instance lists', () => {
  // Only instances whose operators open their API are used; a list that changes is read again once a day, not more.
  it('are read once a day, keeping instances with an open API', async () => {
    const fake = network({ 'yt.open.test': () => ({ body: '[]' }), 'pipedapi.test': () => ({ body: '{"items":[]}' }) });
    fake.on(INVIDIOUS_LIST, { body: JSON.stringify([['yt.open.test', { type: 'https', api: true, monitor: { down: false } }], ['closed.test', { type: 'https', api: false }]]) });
    fake.on(PIPED_LIST, { body: JSON.stringify([{ api_url: 'https://pipedapi.test', up_to_date: true, uptime_7d: 99 }]) });
    const harness = await createHarness({ fake, config: { searchSources: new Set(['invidious', 'piped']) } });

    await searchInBackground(harness.platform);
    harness.setNow(START + DAY - MINUTE);
    await searchInBackground(harness.platform);
    harness.setNow(START + DAY);
    await searchInBackground(harness.platform);

    expect(harness.fake.urls.filter((url) => url === INVIDIOUS_LIST)).toHaveLength(2);
    expect((await harness.platform.coordinator.searchState())!.instances.map((instance) => instance.host)).toEqual(['yt.open.test', 'pipedapi.test']);
  });

  // The lists are edited by others: only https instances with their API open, up and up to date may be kept.
  it('keep only reachable instances with an open API', () => {
    expect(
      invidiousHosts([
        ['open.test', { type: 'https', api: true, monitor: { down: false } }],
        ['down.test', { type: 'https', api: true, monitor: { down: true } }],
        ['closed.test', { type: 'https', api: false }],
        ['x.onion', { type: 'onion', api: null }],
        ['bad host', { type: 'https', api: true }],
      ]),
    ).toEqual(['open.test']);
    expect(
      pipedHosts([
        { api_url: 'https://good.test', up_to_date: true, uptime_7d: 95 },
        { api_url: 'https://old.test', up_to_date: false, uptime_7d: 99 },
        { api_url: 'https://flaky.test', up_to_date: true, uptime_7d: 60 },
        { api_url: 'http://plain.test', up_to_date: true, uptime_7d: 99 },
      ]),
    ).toEqual(['good.test']);
  });
});

