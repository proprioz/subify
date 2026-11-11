import { DICTIONARY_SLICES, dictionarySlicePrefix } from '@subify/shared';
import type { Db } from '../db/db';
import { compile, query } from '../db/query';
import { Http } from '../http';
import { logError } from '../log';
import type { Platform } from '../platform';
import { DAY, MINUTE } from '../catalog/schedule';

/**
 * The Wikidata dictionary (docs/FEATURES.md, D16): every YouTube channel Wikidata names, with its
 * @handle and its names in a few languages. Public data, so it is stored in clear; devices
 * download all of it and search it themselves, so the server never sees a name the dictionary
 * knows.
 *
 * An organisation's item often lists several channels (Apple Inc.: Apple, Apple Support): its
 * labels and @handle belong to one of them at most. Each channel takes the name and handle its own
 * statement gives (qualifiers P1810 and P11245), and the item's only when the item has no other
 * channel or its handle statement names this one (qualifier P2397). A channel of such an item
 * left with nothing of its own is left out: listed under its organisation's name, it would show as
 * a twin of the channel that name belongs to.
 *
 * Each channel also takes a rough audience, so that devices rank the famous channels a few letters
 * bring up before the thousands of obscure ones they match too: its subscriber count as Wikidata
 * gives it (P8687 qualified by the channel id), or else, more roughly, its item's Wikipedia
 * articles (sitelinks). Both are public and the same for everyone; nothing comes from the catalog,
 * which must not tell which channels users follow (D16).
 *
 * A refresh reads one slice a minute (the channels whose id has the same third character, in two queries), each
 * well under the query service's 60-second limit and the Free plan's CPU per run, and starts again
 * every WIKIDATA_REFRESH_DAYS. Nothing is read without WIKIDATA_USER_AGENT: Wikimedia asks every
 * automated client to name itself and give a contact.
 */

export const WIKIDATA_HOST = 'query.wikidata.org';
/**
 * The languages whose labels the dictionary keeps: `mul` is a label for every language. Users
 * mostly speak English and French; labels in other languages made names nobody types, which the
 * typo search then suggested.
 */
const LANGUAGES = ['mul', 'en', 'fr'];
/** A failed slice is asked again after this long. */
const RETRY = 10 * MINUTE;
/** The query service gives up after 60 s; its answer may come late, never larger than this. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 65_000;

const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const MAX_LABEL = 200;

export function sliceQuery(slice: number): string {
  return `SELECT DISTINCT ?id ?shared ?named ?channelHandle ?handle ?handleFor ?label WHERE {
  ?item wdt:P2397 ?id .
  FILTER(STRSTARTS(?id, "${dictionarySlicePrefix(slice)}"))
  ?item p:P2397 ?statement .
  ?statement ps:P2397 ?id .
  OPTIONAL { ?item wdt:P2397 ?other . FILTER(?other != ?id) }
  BIND(BOUND(?other) AS ?shared)
  OPTIONAL { ?statement pq:P1810 ?named }
  OPTIONAL { ?statement pq:P11245 ?channelHandle }
  OPTIONAL { ?item p:P11245 ?handleStatement . ?handleStatement ps:P11245 ?handle . OPTIONAL { ?handleStatement pq:P2397 ?handleFor } }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) IN (${LANGUAGES.map((language) => `"${language}"`).join(', ')})) }
}`;
}

/**
 * The audience of every channel of a slice: its largest subscriber count, and its item's number
 * of sitelinks. A query of its own: joined to the names', it would multiply their rows.
 */
export function popularityQuery(slice: number): string {
  return `SELECT ?id (MAX(?followers) AS ?subscribers) (MAX(?links) AS ?sitelinks) WHERE {
  ?item wdt:P2397 ?id .
  FILTER(STRSTARTS(?id, "${dictionarySlicePrefix(slice)}"))
  OPTIONAL { ?item p:P8687 ?count . ?count ps:P8687 ?followers ; pq:P2397 ?id . }
  OPTIONAL { ?item wikibase:sitelinks ?links }
} GROUP BY ?id`;
}

/** Reads the next slice when one is due. Called every minute; most minutes it only reads the state. */
export async function refreshDictionary(platform: Platform): Promise<void> {
  const { config, db, clock } = platform;

  if (!config.searchSources.has('wikidata') || config.wikidataUserAgent === null) {
    return;
  }

  const now = clock.now();
  const state = (await db.first(compile(query.selectFrom('dictionary_state').selectAll().where('id', '=', 1)))) ?? { next_slice: 0, next_at: 0, version: null };

  if (now < state.next_at) {
    return;
  }

  const http = new Http(platform.fetch, config.wikidataUserAgent, new Set([WIKIDATA_HOST]));
  const read = async (sparql: string): Promise<string> => {
    const response = await http.get(`https://${WIKIDATA_HOST}/sparql?query=${encodeURIComponent(sparql)}`, {
      maxBytes: MAX_BYTES,
      timeoutMs: TIMEOUT_MS,
      headers: { Accept: 'text/tab-separated-values' },
    });

    if (response.status !== 200 || !response.body.startsWith('?id\t')) {
      throw new Error(`Wikidata answered ${response.status}`);
    }

    return response.body;
  };
  let lines: string;

  try {
    // Without its audiences, a slice would rank its channels worse than the copy devices have: it waits too.
    lines = parseSlice(await read(sliceQuery(state.next_slice)), parsePopularity(await read(popularityQuery(state.next_slice))));
  } catch (error) {
    logError('The dictionary slice could not be read', error);
    await saveState(db, { next_slice: state.next_slice, next_at: now + RETRY, version: state.version });

    return;
  }

  const last = state.next_slice === DICTIONARY_SLICES - 1;
  await db.batch([
    compile(query.replaceInto('dictionary').values({ slice: state.next_slice, data: await gzip(lines) })),
    stateStatement(last ? { next_slice: 0, next_at: now + config.wikidataRefreshDays * DAY, version: now } : { next_slice: state.next_slice + 1, next_at: now, version: state.version }),
  ]);
}

interface State {
  next_slice: number;
  next_at: number;
  version: number | null;
}

function stateStatement(state: State) {
  return compile(query.replaceInto('dictionary_state').values({ id: 1, ...state }));
}

async function saveState(db: Db, state: State): Promise<void> {
  await db.run(stateStatement(state));
}

/** What the rows of one channel say, before it is decided which of its item's names are its own. */
interface SliceChannel {
  /** The item lists other channels too. */
  shared: boolean;
  /** The item's handle statement names this channel. */
  owner: boolean;
  /** From the channel's statement, from the item's for this channel, from the item's for none. */
  handles: { own?: string | undefined; item?: string | undefined; other?: string | undefined };
  /** From the channel's statement (P1810). */
  names: Set<string>;
  /** The item's labels. */
  labels: Set<string>;
}

/**
 * The query's answer as the dictionary's lines, sorted by channel id: `id`, tab, `handle` (or
 * nothing), tab, the names separated by U+001F, tab, the channel's audience (`popularity`) as one
 * base-36 digit, or nothing. Values that aren't what Wikidata should hold are left out.
 */
export function parseSlice(tsv: string, popularity: ReadonlyMap<string, number> = new Map()): string {
  const channels = new Map<string, SliceChannel>();

  for (const line of tsv.split('\n').slice(1)) {
    const cells = line.split('\t');
    const [id, , named, channelHandle, handle, handleFor, label] = cells.map(literal);

    if (id === null || id === undefined || !CHANNEL_ID.test(id)) {
      continue;
    }

    const channel = channels.get(id) ?? { shared: false, handles: {}, names: new Set<string>(), labels: new Set<string>(), owner: false };
    channels.set(id, channel);
    channel.shared ||= (cells[1] ?? '').includes('true');
    channel.owner ||= handleFor === id;
    channel.handles.own ??= cleanHandle(channelHandle);
    // The item's handle: this channel's when its statement says so, nobody's in particular when it
    // names no channel, and another channel's otherwise.
    if (handleFor === id) {
      channel.handles.item ??= cleanHandle(handle);
    } else if (handleFor === null || handleFor === undefined) {
      channel.handles.other ??= cleanHandle(handle);
    }
    addName(channel.names, named);
    addName(channel.labels, label);
  }

  return [...channels]
    .map(([id, channel]) => {
      const own = !channel.shared || channel.owner;
      const handle = channel.handles.own ?? channel.handles.item ?? (own ? channel.handles.other : undefined) ?? '';
      const names = new Set([...channel.names, ...(own ? channel.labels : [])]);

      return [id, handle, names] as const;
    })
    .filter(([, handle, names]) => names.size > 0 || handle !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, handle, names]) => `${id}\t${handle}\t${[...names].join('\u001f')}\t${popularity.get(id)?.toString(36) ?? ''}\n`)
    .join('');
}

/**
 * The audience query's answer, by channel id: twice the subscriber count's order of magnitude
 * (12 for a million, 14 for ten million), or, without a count, 10 for an item with 5 Wikipedia
 * articles or more and 9 for one with fewer, where the subscribers of such channels mostly lie.
 * Coarse on purpose: a device only needs to tell famous channels from obscure ones, and one digit
 * per line keeps the download small.
 */
export function parsePopularity(tsv: string): Map<string, number> {
  const popularity = new Map<string, number>();

  for (const line of tsv.split('\n').slice(1)) {
    const [cell, subscribers, sitelinks] = line.split('\t').map((value, index) => (index === 0 ? literal(value) : number(value)));

    if (typeof cell !== 'string' || !CHANNEL_ID.test(cell)) {
      continue;
    }
    const bucket =
      typeof subscribers === 'number' && subscribers >= 1 ? Math.floor(2 * Math.log10(subscribers)) : typeof sitelinks === 'number' && sitelinks >= 1 ? (sitelinks >= 5 ? 10 : 9) : null;

    if (bucket !== null) {
      popularity.set(cell, Math.min(bucket, 35));
    }
  }

  return popularity;
}

/** A number cell of SPARQL results, bare (`1200`) or typed (`"1.2E7"^^<…#double>`), or null. */
function number(cell: string | undefined): number | null {
  const match = /^"?([\d.eE+-]+)"?(?:\^\^<[^>]*>)?$/.exec((cell ?? '').trim());
  const value = match === null ? NaN : Number(match[1]);

  return Number.isFinite(value) ? value : null;
}

/** A handle as Wikidata gives it, without its @, or undefined when it isn't one. */
function cleanHandle(handle: string | null | undefined): string | undefined {
  const clean = handle?.replace(/^@/, '');

  return clean !== undefined && HANDLE.test(clean) ? clean : undefined;
}

function addName(names: Set<string>, label: string | null | undefined): void {
  // eslint-disable-next-line no-control-regex
  const name = label?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

  if (name !== undefined && name !== '' && name.length <= MAX_LABEL) {
    names.add(name);
  }
}

/** One TSV cell of SPARQL results as text: `"…"`, `"…"@en`, or null for a cell left empty or not a string. */
function literal(cell: string | undefined): string | null {
  const match = /^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]*>)?$/.exec((cell ?? '').trim());

  return match === null ? null : match[1]!.replace(/\\(.)/g, (_, char: string) => ({ t: '\t', n: '\n', r: '\r' })[char] ?? char);
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** When the last full refresh ended, or null before the first one. */
export async function dictionaryVersion(db: Db): Promise<number | null> {
  const state = await db.first(compile(query.selectFrom('dictionary_state').select('version').where('id', '=', 1)));

  return state?.version ?? null;
}

export async function readDictionarySlice(db: Db, slice: number): Promise<Uint8Array | undefined> {
  return (await db.first(compile(query.selectFrom('dictionary').select('data').where('slice', '=', slice))))?.data;
}

/**
 * A channel of the dictionary drawn at random, as its fields: id, handle, names, audience. Slices
 * split the channels by a character of their id, so they hold about as many each. Undefined
 * without a dictionary.
 */
export async function randomDictionaryEntry(db: Db, random: () => number): Promise<string[] | undefined> {
  const data = await readDictionarySlice(db, Math.floor(random() * DICTIONARY_SLICES));

  if (data === undefined) {
    return undefined;
  }

  const lines = (await gunzip(data)).split('\n').filter((line) => line !== '');

  return lines[Math.floor(random() * lines.length)]?.split('\t');
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
