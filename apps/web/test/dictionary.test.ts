import { describe, expect, it } from 'vitest';
import { DICTIONARY_CHECK, ensureDictionary, hasDictionary, refreshDictionary, searchDictionary } from '../src/data/dictionary';
import { FakeServer, freshDb } from './fake-server';

const LENA = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const LENA_FAN = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const ARTE = 'UCcccccccccccccccccccccc';
const NASA = 'UCdddddddddddddddddddddd';
const COMEDY = 'UCeeeeeeeeeeeeeeeeeeeeee';

/** Three slices, as the server builds them: `id`, tab, handle, tab, names separated by U+001F. */
const SLICES = [
  `${LENA}\tlenasituations\tLéna Situations\u001fLena Situations\n${LENA_FAN}\t\tLéna Situations Fans Club\n`,
  `${ARTE}\tarte\tARTE\u001fArte France\n${COMEDY}\t\tSituations Comedy Network\n`,
  `${NASA}\tNASA\tNASA\u001fNational Aeronautics and Space Administration\n`,
];

function server(version = 1): FakeServer {
  const fake = new FakeServer();
  fake.dictionary = { version, slices: [...SLICES] };

  return fake;
}

describe('the Wikidata dictionary on the device', () => {
  // The point of the dictionary: the server must never see a name it knows, and a download must not tell which names interest the user.
  it('downloads every slice, then finds names with no request at all', async () => {
    const fake = server();
    const db = freshDb();

    expect(await hasDictionary(db)).toBe(false);
    expect(await ensureDictionary(db, fake.api())).toBe(true);
    const downloaded = [...fake.paths];
    const found = await searchDictionary(db, 'lena situations');

    expect(downloaded).toEqual(['GET /api/dictionary', 'GET /api/dictionary/0', 'GET /api/dictionary/1', 'GET /api/dictionary/2']);
    expect(fake.paths).toEqual(downloaded);
    expect(found.map((channel) => channel.id)).toEqual([LENA, LENA_FAN]);
    expect(found[0]).toEqual({ id: LENA, handle: 'lenasituations', name: 'Léna Situations' });
    expect(await hasDictionary(db)).toBe(true);
  });

  // 5 MB on a phone: it must be downloaded again only when the server has a newer one.
  it('downloads it again only for a new version', async () => {
    const fake = server(1);
    const db = freshDb();
    await ensureDictionary(db, fake.api());
    const first = fake.paths.length;

    await ensureDictionary(db, fake.api());
    const same = fake.paths.length;
    // Searched before the new version: what was read then must not stay in use.
    await searchDictionary(db, 'lena situations');
    fake.dictionary = { version: 2, slices: [`${ARTE}\tarte\tARTE\n`] };
    await ensureDictionary(db, fake.api());

    expect(same).toBe(first + 1);
    expect(fake.paths.slice(same)).toEqual(['GET /api/dictionary', 'GET /api/dictionary/0']);
    expect(await searchDictionary(db, 'lena situations')).toEqual([]);
    expect((await searchDictionary(db, 'arte')).map((channel) => channel.id)).toEqual([ARTE]);
  });

  // A phone may lose the network mid-download: half a dictionary would miss channels without saying so.
  it('keeps the previous copy when a download stops halfway', async () => {
    const fake = server(1);
    const db = freshDb();
    await ensureDictionary(db, fake.api());
    fake.dictionary = { version: 2, slices: [`${ARTE}\tarte\tARTE\n`, 'missing'] };
    const failing = new FakeServer();
    failing.dictionary = fake.dictionary;
    let calls = 0;
    const api = failing.api(async () => {
      if (++calls === 3) {
        throw new Error('offline');
      }
    });

    await expect(ensureDictionary(db, api)).rejects.toThrow();

    expect((await searchDictionary(db, 'lena situations')).map((channel) => channel.id)).toEqual([LENA, LENA_FAN]);
  });

  // People type names as they say them: accents, case and punctuation must not matter, and the closest name must come first.
  it('ranks the whole name, then its start, then words, ignoring accents and case', async () => {
    const db = freshDb();
    await ensureDictionary(db, server().api());

    expect((await searchDictionary(db, 'LÉNA')).map((channel) => channel.id)).toEqual([LENA, LENA_FAN]);
    expect((await searchDictionary(db, 'situations fans')).map((channel) => channel.id)).toEqual([LENA_FAN]);
    expect((await searchDictionary(db, 'national space')).map((channel) => channel.id)).toEqual([NASA]);
    expect((await searchDictionary(db, 'nasa'))[0]).toEqual({ id: NASA, handle: 'NASA', name: 'NASA' });
    // A name that starts with the words beats a shorter one that only contains them.
    expect((await searchDictionary(db, 'situations')).map((channel) => channel.id)).toEqual([COMEDY, LENA, LENA_FAN]);
    expect(await searchDictionary(db, 'ar')).toEqual([]);
  });

  // People mistype names, as in a search engine: a typo must still find the channel, marked as a suggestion, while a short word must not match everything a letter away.
  it('suggests names a typo or two away, marked as such', async () => {
    const db = freshDb();
    await ensureDictionary(db, server().api());

    expect(await searchDictionary(db, 'lena sitaution')).toEqual([
      { id: LENA, handle: 'lenasituations', name: 'Léna Situations', similar: true },
      { id: LENA_FAN, handle: null, name: 'Léna Situations Fans Club', similar: true },
    ]);
    // Run together, and one letter short.
    expect((await searchDictionary(db, 'lenasituation')).map((channel) => channel.id)).toEqual([LENA, LENA_FAN]);
    expect((await searchDictionary(db, 'aeronautcs')).map((channel) => channel.id)).toEqual([NASA]);
    expect((await searchDictionary(db, 'lena situations'))[0]).toEqual({ id: LENA, handle: 'lenasituations', name: 'Léna Situations' });
    expect(await searchDictionary(db, 'are')).toEqual([]);
    expect(await searchDictionary(db, 'zrte')).toEqual([]);
  });

  // Refreshing the feed downloads the list without asking: on mobile data, it must not check at every refresh, and a failure must not cost the copy or break the refresh.
  it('downloads it with a refresh, then checks again only after a day', async () => {
    const fake = server(1);
    const db = freshDb();
    const now = Date.UTC(2026, 10, 2);

    await refreshDictionary(db, fake.api(), now);
    const first = [...fake.paths];
    fake.dictionary = { version: 2, slices: [`${ARTE}\tarte\tARTE\n`] };
    await refreshDictionary(db, fake.api(), now + DICTIONARY_CHECK - 1);
    const sameDay = fake.paths.length;
    await expect(refreshDictionary(db, fake.api(async () => { throw new Error('offline'); }), now + DICTIONARY_CHECK + 1)).resolves.toBeUndefined();
    await refreshDictionary(db, fake.api(), now + DICTIONARY_CHECK + 2);

    expect(first).toEqual(['GET /api/dictionary', 'GET /api/dictionary/0', 'GET /api/dictionary/1', 'GET /api/dictionary/2']);
    expect(sameDay).toBe(first.length);
    expect(fake.paths.slice(sameDay)).toEqual(['GET /api/dictionary', 'GET /api/dictionary/0']);
    expect((await searchDictionary(db, 'arte')).map((channel) => channel.id)).toEqual([ARTE]);
  });

  // A server without WIKIDATA_USER_AGENT has no dictionary: the app must say so and fall back, not fail.
  it('reports no dictionary when the server has none', async () => {
    const db = freshDb();

    expect(await ensureDictionary(db, new FakeServer().api())).toBe(false);
  });
});
