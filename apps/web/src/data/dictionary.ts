import { fromBase64Url } from '@subify/shared/codec';
import type { Api } from './api';
import { type DictionarySlice, getMeta, setMeta, type SubifyDb } from './db';

/**
 * The Wikidata dictionary (docs/FEATURES.md, D16): the YouTube channels Wikidata names, with
 * their @handles and names. The app downloads all of it, never part of it, the first time the
 * user looks a name up, and again only when the server has a newer one; it then searches it on
 * the device, so the server never sees a name the dictionary knows. It is public data, rebuilt
 * from the server at will, and stays out of backups.
 */

export interface NamedChannel {
  /** The channel id, `UC…`. */
  id: string;
  handle: string | null;
  name: string;
  /** What a search service says of it; the dictionary has none. */
  description?: string;
}

interface Entry extends NamedChannel {
  /** The names and the handle, as `normalize` makes them. */
  keys: string[];
}

/** The parsed dictionary of each database, kept while the app runs: parsing takes a moment. */
const parsed = new WeakMap<SubifyDb, Promise<Entry[]>>();

/**
 * Makes sure the device has the server's latest dictionary, downloading every slice if not.
 * False when neither the server nor the device has one.
 */
export async function ensureDictionary(db: SubifyDb, api: Api): Promise<boolean> {
  const latest = await api.dictionary();

  if (latest === null) {
    return (await db.dictionary.count()) > 0;
  }

  if ((await getMeta<number>(db, 'dictionaryVersion')) === latest.version) {
    return true;
  }

  const slices: DictionarySlice[] = [];

  for (let slice = 0; slice < latest.slices; slice++) {
    const { data } = await api.dictionarySlice(slice);
    slices.push({ slice, text: await gunzip(fromBase64Url(data)) });
  }

  // All of it or nothing: an interrupted download leaves the previous copy.
  await db.transaction('rw', db.dictionary, db.meta, async () => {
    await db.dictionary.clear();
    await db.dictionary.bulkPut(slices);
    await setMeta(db, 'dictionaryVersion', latest.version);
  });
  parsed.delete(db);

  return true;
}

/** Whether the device has a dictionary: the search while typing works offline once it does. */
export async function hasDictionary(db: SubifyDb): Promise<boolean> {
  return (await getMeta<number>(db, 'dictionaryVersion')) !== undefined;
}

/**
 * The channels whose name or @handle match these words, best first: the whole name, then its
 * start, then every word starting a word of the name. Nothing leaves the device.
 */
export async function searchDictionary(db: SubifyDb, text: string, limit = 10): Promise<NamedChannel[]> {
  const query = normalize(text);

  if (query.length < 3) {
    return [];
  }

  const words = query.split(' ');
  const compact = query.replaceAll(' ', '');
  const scored: { entry: Entry; score: number }[] = [];

  for (const entry of await entries(db)) {
    let score = 0;

    for (const key of entry.keys) {
      score = Math.max(
        score,
        key === query || key === compact ? 3 : key.startsWith(query) ? 2 : words.every((word) => key.startsWith(word) || key.includes(` ${word}`)) ? 1 : 0,
      );
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length)
    .slice(0, limit)
    .map(({ entry: { id, handle, name } }) => ({ id, handle, name }));
}

function entries(db: SubifyDb): Promise<Entry[]> {
  let found = parsed.get(db);

  if (found === undefined) {
    found = db.dictionary.toArray().then((slices) => slices.flatMap((slice) => parse(new TextDecoder().decode(slice.text))));
    parsed.set(db, found);
    found.catch(() => parsed.delete(db));
  }

  return found;
}

/** The server's lines: `id`, tab, `handle` or nothing, tab, the names separated by U+001F. */
function parse(text: string): Entry[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [id = '', handle = '', names = ''] = line.split('\t');
      const all = names === '' ? [] : names.split('\u001f');

      return { id, handle: handle === '' ? null : handle, name: all[0] ?? `@${handle}`, keys: [...all, ...(handle === '' ? [] : [handle])].map(normalize) };
    });
}

/** Lower case, without accents, words separated by single spaces. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}
