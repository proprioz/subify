import type { ApiError, DictionaryResponse, DictionarySliceResponse } from '@subify/shared';
import { DICTIONARY_SLICES } from '@subify/shared';
import { fromBase64Url } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '#harness';
import { DAY, MINUTE } from '../../src/catalog/schedule';
import { parsePopularity, parseSlice, popularityQuery, refreshDictionary, sliceQuery, WIKIDATA_HOST } from '../../src/search/dictionary';
import { NASA } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';

const AGENT = 'SubifyBot/1.0 (https://subify.test) feed-reader';
const A = 'UCAaaaaaaaaaaaaaaaaaaaaa';
const B = 'UCAbbbbbbbbbbbbbbbbbbbbb';
const HEADER = '?id\t?shared\t?named\t?channelHandle\t?handle\t?handleFor\t?label';

type Cells = Partial<Record<'named' | 'channelHandle' | 'handle' | 'handleFor' | 'label', string>> & { shared?: boolean };

/** One row of the query's answer: a channel `id`, whether its item lists others, and its other cells as Wikidata writes them. */
function row(id: string, { shared = false, named = '', channelHandle = '', handle = '', handleFor = '', label = '' }: Cells = {}): string {
  return [id, `"${shared}"^^<http://www.w3.org/2001/XMLSchema#boolean>`, named, channelHandle, handle, handleFor, label].join('\t');
}

const POPULARITY_HEADER = '?id\t?subscribers\t?sitelinks';

function sliceUrl(slice: number): string {
  return `https://${WIKIDATA_HOST}/sparql?query=${encodeURIComponent(sliceQuery(slice))}`;
}

function popularityUrl(slice: number): string {
  return `https://${WIKIDATA_HOST}/sparql?query=${encodeURIComponent(popularityQuery(slice))}`;
}

/** Wikidata answering every slice: `first` and `audience` for slice 0 (ids starting with `UCA`), only the headers for the others. */
function wikidata(first: string, fake = new FakeFetch(), audience = ''): FakeFetch {
  for (let slice = 0; slice < DICTIONARY_SLICES; slice++) {
    fake.on(sliceUrl(slice), { body: `${HEADER}\n${slice === 0 ? first : ''}` });
    fake.on(popularityUrl(slice), { body: `${POPULARITY_HEADER}\n${slice === 0 ? audience : ''}` });
  }

  return fake;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function everyMinute(harness: Harness, runs: number, from = START): Promise<void> {
  for (let i = 0; i < runs; i++) {
    harness.setNow(from + i * MINUTE);
    await refreshDictionary(harness.platform);
  }
}

describe('the Wikidata dictionary', () => {
  // Wikimedia asks every automated client for a contact: without one set by the admin, the server must not query it at all.
  it('reads nothing without WIKIDATA_USER_AGENT', async () => {
    const quiet = await createHarness({ fake: wikidata('') });
    await everyMinute(quiet, 3);

    expect(quiet.fake.calls).toEqual([]);
    expect((await quiet.request('/api/dictionary')).status).toBe(404);
  });

  // Devices download it whole and compare versions: it must appear only once every slice is in, then be served as stored.
  it('reads one slice a minute and publishes the dictionary once all are in', async () => {
    const harness = await createHarness({
      fake: wikidata(`${row(`"${A}"`, { handle: '"@nasa"', label: '"NASA"@en' })}\n${row(`"${A}"`, { handle: '"@nasa"', label: '"Nasa"@fr' })}\n`, undefined, `"${A}"\t12300000.0\t96\n`),
      config: { wikidataUserAgent: AGENT },
    });

    await everyMinute(harness, DICTIONARY_SLICES - 1);
    const early = await harness.request('/api/dictionary');
    harness.setNow(START + (DICTIONARY_SLICES - 1) * MINUTE);
    await refreshDictionary(harness.platform);
    const index = (await (await harness.request('/api/dictionary')).json()) as DictionaryResponse;
    const slice = (await (await harness.request('/api/dictionary/0')).json()) as DictionarySliceResponse;

    expect(early.status).toBe(404);
    expect(harness.fake.urls).toEqual(Array.from({ length: DICTIONARY_SLICES }, (_, i) => [sliceUrl(i), popularityUrl(i)]).flat());
    expect(harness.fake.calls.every((call) => call.headers.get('User-Agent') === AGENT && call.headers.get('Accept') === 'text/tab-separated-values')).toBe(true);
    expect(index).toEqual({ v: 3, version: START + (DICTIONARY_SLICES - 1) * MINUTE, slices: DICTIONARY_SLICES });
    expect(await gunzip(fromBase64Url(slice.data))).toBe(`${A}\tnasa\tNASA\u001fNasa\te\n`);
    expect(((await (await harness.request(`/api/dictionary/${DICTIONARY_SLICES}`)).json()) as ApiError).error).toBe('invalid_request');
  });

  // A refresh that never ends would hammer the query service: it waits WIKIDATA_REFRESH_DAYS, then starts again from the first slice.
  it('starts a new refresh only after WIKIDATA_REFRESH_DAYS', async () => {
    const harness = await createHarness({ fake: wikidata(''), config: { wikidataUserAgent: AGENT, wikidataRefreshDays: 3 } });
    await everyMinute(harness, DICTIONARY_SLICES);
    const done = START + (DICTIONARY_SLICES - 1) * MINUTE;

    await everyMinute(harness, 5, done + 3 * DAY - 5 * MINUTE);
    const waited = harness.fake.calls.length;
    harness.setNow(done + 3 * DAY);
    await refreshDictionary(harness.platform);

    expect(waited).toBe(2 * DICTIONARY_SLICES);
    expect(harness.fake.urls.slice(-2)).toEqual([sliceUrl(0), popularityUrl(0)]);
  });

  // The query service rate-limits and times out: a failed slice must be asked again later, not skipped and not retried at once.
  it('asks a failed slice again ten minutes later', async () => {
    const fake = wikidata('').on(sliceUrl(0), { status: 429, body: 'Too Many Requests' });
    const harness = await createHarness({ fake, config: { wikidataUserAgent: AGENT } });
    await everyMinute(harness, 10);
    fake.on(sliceUrl(0), { body: `${HEADER}\n` });
    harness.setNow(START + 10 * MINUTE);
    await refreshDictionary(harness.platform);
    await everyMinute(harness, 1, START + 11 * MINUTE);

    expect(harness.fake.urls).toEqual([sliceUrl(0), sliceUrl(0), popularityUrl(0), sliceUrl(1), popularityUrl(1)]);
  });

  // Only Wikidata gets the bot's name and contact: YouTube and every other host keep the generic User-Agent.
  it('sends WIKIDATA_USER_AGENT to Wikidata only', async () => {
    const harness = await createHarness({ fake: wikidata('', withRecordedChannels(new FakeFetch())), config: { wikidataUserAgent: AGENT } });
    await refreshDictionary(harness.platform);
    await harness.add(`https://www.youtube.com/channel/${NASA}`);
    const youtube = harness.fake.calls.filter((call) => call.url === youtubeUrls.channel(NASA));

    expect(youtube).toHaveLength(1);
    expect(youtube[0]!.headers.get('User-Agent')).not.toContain('Subify');
    expect(harness.fake.calls.filter((call) => call.headers.get('User-Agent') === AGENT).map((call) => new URL(call.url).hostname)).toEqual([WIKIDATA_HOST, WIKIDATA_HOST]);
  });
});

describe('a slice of Wikidata’s answer', () => {
  // Wikidata is edited by anyone: what isn't a channel id, a handle or a reasonable name must not reach devices.
  it('keeps channel ids, handles and names, and drops the rest', () => {
    const tsv = [
      HEADER,
      row(`"${B}"`, { label: '"Zeta \\"Z\\""@de' }),
      row(`"${A}"`, { handle: '"@nasa"', label: '"NASA"@en' }),
      row(`"${A}"`, { handle: '"other"', label: '"NASA"@mul' }),
      row(`"${A}"`, { handle: '"@nasa"', label: '"Tab\\there"@fr' }),
      row('"not-a-channel"', { handle: '"@x"', label: '"X"@en' }),
      row('"UCAccccccccccccccccccccc"', { handle: '"a b"', label: `"${'x'.repeat(201)}"@en` }),
      row('<http://www.wikidata.org/entity/Q1>', { label: '"Q"@en' }),
      '',
    ].join('\n');

    expect(parseSlice(tsv)).toBe(`${A}\tnasa\tNASA\u001fTab here\t\n${B}\t\tZeta "Z"\t\n`);
  });

  // An organisation's item lists several channels (Apple Inc.: Apple, Apple Support): giving each
  // the item's labels and handle showed twins, “Apple Inc. @Apple” twice, on every device.
  it('gives each channel of an item its own name and handle, and the item’s to the one they belong to', () => {
    const C = 'UCAccccccccccccccccccccc';
    const item = { shared: true, handle: '"Apple"', handleFor: `"${A}"` };
    const tsv = [
      HEADER,
      row(`"${A}"`, { ...item, named: '"Apple"', label: '"Apple Inc."@en' }),
      row(`"${A}"`, { ...item, named: '"Apple"', label: '"Apple"@fr' }),
      row(`"${B}"`, { ...item, named: '"Apple Support"', channelHandle: '"applesupport"', label: '"Apple Inc."@en' }),
      // Nothing of its own: under the item's name, it would be the twin of the first.
      row(`"${C}"`, { ...item, label: '"Apple Inc."@en' }),
      '',
    ].join('\n');

    expect(parseSlice(tsv)).toBe(`${A}\tApple\tApple\u001fApple Inc.\t\n${B}\tapplesupport\tApple Support\t\n`);
  });

  // Without an audience, devices ranked thousands of obscure channels a few letters match before the famous one typed.
  it('gives each channel a rough audience: its subscribers, else its sitelinks', () => {
    const C = 'UCAccccccccccccccccccccc';
    const D = 'UCAddddddddddddddddddddd';
    const audience = parsePopularity(
      [POPULARITY_HEADER, `"${A}"\t523000000.0\t72`, `"${B}"\t\t7`, `"${C}"\t\t2`, `"${D}"\t\t0`, '"not-a-channel"\t1000.0\t3', ''].join('\n'),
    );
    const tsv = [HEADER, row(`"${A}"`, { label: '"MrBeast"@en' }), row(`"${D}"`, { label: '"Nobody"@en' }), ''].join('\n');

    // 523 million subscribers: 2 × 8.7, rounded down, is 17, “h” in base 36; the sitelinks only stand in without a count.
    expect([...audience]).toEqual([
      [A, 17],
      [B, 10],
      [C, 9],
    ]);
    expect(parseSlice(tsv, audience)).toBe(`${A}\t\tMrBeast\th\n${D}\t\tNobody\t\n`);
  });
});
