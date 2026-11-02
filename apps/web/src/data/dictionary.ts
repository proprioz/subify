import { fromBase64Url } from '@subify/shared/codec';
import type { Api } from './api';
import { type DictionarySlice, getMeta, setMeta, type SubifyDb } from './db';
import type { OnStep } from './subscriptions';

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
  /** Found despite a typo or two: a suggestion rather than the name typed. */
  similar?: true;
}

interface Entry extends NamedChannel {
  /** The names and the handle, as `normalize` makes them. */
  keys: string[];
  /** The same keys' words, and each key with its words run together, for the search of typos. */
  words: string[];
  compacts: string[];
}

/** The parsed dictionary of each database, kept while the app runs: parsing takes a moment. */
const parsed = new WeakMap<SubifyDb, Promise<Entry[]>>();

/**
 * Makes sure the device has the server's latest dictionary, downloading every slice if not.
 * False when neither the server nor the device has one.
 */
export async function ensureDictionary(db: SubifyDb, api: Api, onStep: OnStep = () => {}): Promise<boolean> {
  onStep({ kind: 'dictionary' });
  const latest = await api.dictionary();

  if (latest === null) {
    return (await db.dictionary.count()) > 0;
  }

  if ((await getMeta<number>(db, 'dictionaryVersion')) === latest.version) {
    return true;
  }

  const slices: DictionarySlice[] = [];

  for (let slice = 0; slice < latest.slices; slice++) {
    onStep({ kind: 'download', slice: slice + 1, slices: latest.slices });
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
 * start, then every word starting a word of the name, and last names that differ by a typo or two
 * (`similar`), as a search engine suggests them. Nothing leaves the device.
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

    // Only names nothing exact found are compared letter by letter: it costs far more.
    if (score === 0) {
      const typos = similarity(words, compact, entry);

      if (typos !== null) {
        score = 1 - (typos + 1) / 10;
      }
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length)
    .slice(0, limit)
    .map(({ entry: { id, handle, name }, score }) => ({ id, handle, name, ...(score < 1 ? { similar: true } : {}) }));
}

/**
 * The fewest typos that make one of the entry's names start with these words, all of them run
 * together (“lenasituation” for “léna situations”), or each matching a word of its names, or null
 * when it takes more than the words allow. Each word keeps its first letter, as people rarely
 * mistype that one.
 */
function similarity(words: readonly string[], compact: string, entry: Entry): number | null {
  let best = Infinity;

  for (const key of entry.compacts) {
    best = Math.min(best, prefixTypos(compact, key));
  }

  let apart = 0;

  for (const word of words) {
    let typos = Infinity;

    for (const key of entry.words) {
      typos = Math.min(typos, prefixTypos(word, key));
    }

    apart += typos;
  }

  best = Math.min(best, apart);

  return best === Infinity ? null : best;
}

/** Typos a word of this length may hold: none under 4 letters, where one would match too much. */
function allowedTypos(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2;
}

/** Two rows of the edit distance, kept between calls: the search compares hundreds of thousands of words. */
let previous = new Uint8Array(64);
let current = new Uint8Array(64);

/**
 * The edit distance between `word` and the start of `key` closest to it, or Infinity past the
 * typos `word` allows. Only the cells within that many of the diagonal can stay under it.
 */
function prefixTypos(word: string, key: string): number {
  const allowed = allowedTypos(word.length);
  const width = Math.min(key.length, word.length + allowed);

  if (key[0] !== word[0] || width < word.length - allowed) {
    return Infinity;
  }

  if (width + 1 > previous.length) {
    previous = new Uint8Array(width + 1);
    current = new Uint8Array(width + 1);
  }

  const over = allowed + 1;

  for (let j = 0; j <= width; j++) {
    previous[j] = Math.min(j, over);
  }

  for (let i = 1; i <= word.length; i++) {
    const from = Math.max(1, i - allowed);
    const to = Math.min(width, i + allowed);
    let lowest = over;
    current[from - 1] = from === 1 ? Math.min(i, over) : over;

    for (let j = from; j <= to; j++) {
      const cost = word.charCodeAt(i - 1) === key.charCodeAt(j - 1) ? 0 : 1;
      const above = j <= i - 1 + allowed ? previous[j]! : over;
      const cell = Math.min(above + 1, current[j - 1]! + 1, previous[j - 1]! + cost, over);
      current[j] = cell;
      lowest = Math.min(lowest, cell);
    }

    if (to < width) {
      current[to + 1] = over;
    }

    if (lowest > allowed) {
      return Infinity;
    }

    [previous, current] = [current, previous];
  }

  // Any start of the key: the word may be only the beginning of the name.
  let best: number = over;

  for (let j = Math.max(0, word.length - allowed); j <= width; j++) {
    best = Math.min(best, previous[j]!);
  }

  return best <= allowed ? best : Infinity;
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

      const keys = [...new Set([...all, ...(handle === '' ? [] : [handle])].map(normalize))];

      return {
        id,
        handle: handle === '' ? null : handle,
        name: all[0] ?? `@${handle}`,
        keys,
        words: [...new Set(keys.flatMap((key) => key.split(' ')))],
        compacts: [...new Set(keys.map((key) => key.replaceAll(' ', '')))],
      };
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
