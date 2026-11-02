import type { SearchResult } from '@subify/shared';
import { DICTIONARY_SLICES } from '@subify/shared';
import { budgets } from '../catalog/budgets';
import type { InstanceKind, InstanceState, SearchState } from '../catalog/coordinator';
import { DAY } from '../catalog/schedule';
import { userAgent } from '../config';
import { Http, UpstreamError } from '../http';
import { logError, logMeasure } from '../log';
import type { Platform } from '../platform';
import type { SourceAdapter } from '../sources/source';
import { readDictionarySlice } from './dictionary';

/**
 * Searching a channel by name on Invidious and Piped instances (docs/FEATURES.md, D16), when
 * nothing on the device found it. Off unless the admin lists them in SEARCH_SOURCES. The server
 * queries them, never the device: one instance drawn among the most reliable, plus decoy searches
 * sent to others with each real one and at a steady rate, drawn from the Wikidata dictionary and
 * common words, never from the catalog. Every result is checked against the channel's own feed
 * before it is shown. The instances' scores live in the coordinator's memory only, never in the database.
 */

export const INVIDIOUS_LIST = 'https://api.invidious.io/instances.json?sort_by=type,health';
export const PIPED_LIST = 'https://piped-instances.kavin.rocks/';
/** Results checked and shown per search: each costs a read of the channel's feed. */
export const MAX_RESULTS = 5;
/** Decoys sent to other instances with each real search, to hide it among them. */
export const DECOYS_PER_SEARCH = 2;
/** Real searches try this many instances before giving up: the app then tries the name's likely handles. */
const TRIES = 2;
/** A real search is drawn among this many of the best instances, weighted by their scores. */
const BEST = 3;
/** An instance that refused automated requests is left alone this long. */
const BLOCKED_FOR = DAY;
/** A slower answer counts as half a success. */
const SLOW_MS = 4_000;
/** Each outcome's share in the score; scores drift back to 0.5 over about a week without news. */
const LEARNING = 0.2;
const DRIFT_MS = 7 * DAY;
const MAX_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 300;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Words for decoys besides the dictionary's names, in the dictionary's languages. */
const WORDS = [
  'music', 'cooking', 'gaming', 'news', 'science', 'history', 'travel', 'football', 'guitar', 'piano', 'comedy', 'cars', 'cats', 'dogs',
  'gardening', 'fitness', 'yoga', 'chess', 'math', 'physics', 'space', 'movies', 'trailers', 'podcast', 'tutorial', 'recipes', 'baking',
  'cuisine', 'musique', 'histoire', 'voyage', 'jeux', 'actualités', 'humour', 'dessin', 'peinture', 'vélo', 'montagne', 'nature',
  'kochen', 'reisen', 'geschichte', 'nachrichten', 'spiele', 'wissenschaft', 'musik', 'fahrrad', 'cocina', 'viajes', 'noticias',
  'historia', 'juegos', 'ciencia', 'música', 'cucina', 'viaggi', 'notizie', 'storia', 'giochi', 'scienza', 'calcio', 'motori',
];

type Outcome = { kind: 'ok'; results: Candidate[]; ms: number } | { kind: 'failed' } | { kind: 'refused' };

interface Candidate {
  id: string;
  handle: string | null;
  description: string;
}

/** The kinds of instances SEARCH_SOURCES turns on. */
export function searchKinds(platform: Platform): InstanceKind[] {
  return (['invidious', 'piped'] as const).filter((kind) => platform.config.searchSources.has(kind));
}

/**
 * Searches a name and returns the channels it found that the platform confirms, at most
 * MAX_RESULTS. Empty when no instance answered. The name is kept nowhere.
 */
export async function searchByName(platform: Platform, sources: readonly SourceAdapter[], name: string): Promise<SearchResult[]> {
  const youtube = sources.find((source) => source.source === 'youtube');

  if (youtube?.verify === undefined) {
    return [];
  }

  await budgets(platform, await platform.keys).beforeSearching();
  const state = await currentState(platform);
  const tried = new Set<string>();
  let results: SearchResult[] = [];

  for (let attempt = 0; attempt < TRIES; attempt++) {
    const instance = drawBest(state, platform, tried);

    if (instance === undefined) {
      break;
    }

    tried.add(instance.host);
    const outcome = await query(platform, instance, name);
    state.real++;

    if (outcome.kind !== 'ok') {
      score(instance, outcome, platform.clock.now(), 0);
      continue;
    }

    results = await verified(platform, youtube, outcome.results.slice(0, MAX_RESULTS));
    score(instance, outcome, platform.clock.now(), outcome.results.length === 0 ? 1 : results.length / Math.min(MAX_RESULTS, outcome.results.length));
    break;
  }

  // Decoys to other instances, after the answer: they make this search one among several each sees.
  const others = shuffled(available(state, platform).filter((instance) => !tried.has(instance.host)), platform).slice(0, DECOYS_PER_SEARCH);
  await platform.coordinator.saveSearchState(state);
  platform.afterResponse(Promise.all(others.map((instance) => sendDecoy(platform, instance))).catch((error) => logError('Decoy search failed', error)));

  return results;
}

/** Called every minute: reads the instance lists once a day, and sends a decoy SEARCH_DECOYS_PER_HOUR times an hour on average. */
export async function searchInBackground(platform: Platform): Promise<void> {
  if (searchKinds(platform).length === 0) {
    return;
  }

  const state = await currentState(platform);
  await platform.coordinator.saveSearchState(state);

  if (platform.random() < platform.config.searchDecoysPerHour / 60) {
    // Uniform, not by score: every instance sees decoys, the unreliable ones too.
    const instance = shuffled(available(state, platform), platform)[0];

    if (instance !== undefined) {
      await sendDecoy(platform, instance);
    }
  }
}

/** P(a search an instance sees is real), the measure of the blurring: the real share, spread over the instances. */
export function blurring(state: SearchState): number {
  const total = state.real + state.decoys;

  return total === 0 ? 0 : state.real / total / Math.max(1, state.instances.length);
}

async function sendDecoy(platform: Platform, instance: InstanceState): Promise<void> {
  const term = await decoyTerm(platform);
  const outcome = await query(platform, instance, term);
  const state = await currentState(platform);
  const stored = state.instances.find((candidate) => candidate.host === instance.host);
  state.decoys++;

  if (stored !== undefined) {
    score(stored, outcome, platform.clock.now(), 1);
  }

  await platform.coordinator.saveSearchState(state);
}

/** A name from a random slice of the dictionary, or a common word: never anything from the catalog. */
export async function decoyTerm(platform: Platform): Promise<string> {
  if (platform.random() < 0.5) {
    const data = await readDictionarySlice(platform.db, Math.floor(platform.random() * DICTIONARY_SLICES));

    if (data !== undefined) {
      const lines = (await gunzip(data)).split('\n').filter((line) => line !== '');
      const line = lines[Math.floor(platform.random() * lines.length)];
      const names = (line?.split('\t')[2] ?? '').split('\u001f').filter((name) => name.length >= 3);
      const name = names[Math.floor(platform.random() * names.length)];

      if (name !== undefined) {
        return name;
      }
    }
  }

  return WORDS[Math.floor(platform.random() * WORDS.length)]!;
}

/** The state, with the instance lists read again once a day (or after a restart lost them). */
async function currentState(platform: Platform): Promise<SearchState> {
  const now = platform.clock.now();
  const state = (await platform.coordinator.searchState()) ?? { listedAt: 0, instances: [], real: 0, decoys: 0 };

  if (now - state.listedAt < DAY) {
    return state;
  }

  if (state.listedAt > 0) {
    logMeasure('Search blurring', blurring(state));
  }

  const listed: { kind: InstanceKind; host: string }[] = [];

  for (const kind of searchKinds(platform)) {
    const configured = kind === 'invidious' ? platform.config.invidiousInstances : platform.config.pipedInstances;
    const hosts = configured ?? (await officialList(platform, kind));
    hosts.forEach((host) => listed.push({ kind, host }));
  }

  const known = new Map(state.instances.map((instance) => [`${instance.kind}:${instance.host}`, instance]));

  return {
    listedAt: now,
    instances: listed.map(({ kind, host }) => known.get(`${kind}:${host}`) ?? { kind, host, score: 0.5, scoredAt: now, blockedUntil: 0 }),
    real: 0,
    decoys: 0,
  };
}

/**
 * The instances an official list shows with an open API, which their operators offer for others to use: Invidious's with `api`,
 * Piped's up to date and up 90 % of the last week. Empty when the list can't be read.
 */
async function officialList(platform: Platform, kind: InstanceKind): Promise<string[]> {
  const url = kind === 'invidious' ? INVIDIOUS_LIST : PIPED_LIST;
  const http = new Http(platform.fetch, userAgent(platform.config), new Set([new URL(url).hostname]));

  try {
    const response = await http.get(url, { maxBytes: MAX_BYTES, headers: { Accept: 'application/json' } });

    if (response.status !== 200) {
      return [];
    }

    const list: unknown = JSON.parse(response.body);

    return kind === 'invidious' ? invidiousHosts(list) : pipedHosts(list);
  } catch (error) {
    logError('An instance list could not be read', error);

    return [];
  }
}

export function invidiousHosts(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'object' || entry[1] === null) {
      return [];
    }

    const info = entry[1] as { type?: unknown; api?: unknown; monitor?: { down?: unknown } | null };

    return info.type === 'https' && info.api === true && info.monitor?.down !== true && HOST.test(entry[0]) ? [entry[0]] : [];
  });
}

export function pipedHosts(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((entry: unknown) => {
    const info = (typeof entry === 'object' && entry !== null ? entry : {}) as { api_url?: unknown; up_to_date?: unknown; uptime_7d?: unknown };

    if (typeof info.api_url !== 'string' || info.up_to_date === false || typeof info.uptime_7d !== 'number' || info.uptime_7d < 90) {
      return [];
    }

    try {
      const url = new URL(info.api_url);

      return url.protocol === 'https:' && url.port === '' && HOST.test(url.hostname) ? [url.hostname] : [];
    } catch {
      return [];
    }
  });
}

function available(state: SearchState, platform: Platform): InstanceState[] {
  const now = platform.clock.now();

  return state.instances.filter((instance) => instance.blockedUntil <= now);
}

/** One of the best instances, drawn with a chance in proportion to its score. */
function drawBest(state: SearchState, platform: Platform, tried: ReadonlySet<string>): InstanceState | undefined {
  const now = platform.clock.now();
  const best = available(state, platform)
    .filter((instance) => !tried.has(instance.host))
    .sort((a, b) => current(b, now) - current(a, now))
    .slice(0, BEST);
  const weights = best.map((instance) => Math.max(0.05, current(instance, now)));
  let draw = platform.random() * weights.reduce((sum, weight) => sum + weight, 0);

  return best.find((_, i) => (draw -= weights[i]!) < 0) ?? best.at(-1);
}

/** The score as it stands now: what it learnt, drifting back to 0.5 as it gets older. */
function current(instance: InstanceState, now: number): number {
  return 0.5 + (instance.score - 0.5) * Math.exp(-(now - instance.scoredAt) / DRIFT_MS);
}

/** Learns from an answer: a failure counts 0, a slow one half, and a real search's results count by how many the platform confirmed. */
function score(instance: InstanceState, outcome: Outcome, now: number, confirmed: number): void {
  const value = outcome.kind === 'ok' ? confirmed * (outcome.ms > SLOW_MS ? 0.5 : 1) : 0;
  instance.score = current(instance, now) * (1 - LEARNING) + value * LEARNING;
  instance.scoredAt = now;

  if (outcome.kind === 'refused') {
    instance.blockedUntil = now + BLOCKED_FOR;
  }
}

/** One search on one instance. An answer that isn't the API's JSON (a challenge page, 403, 429) means it refuses us. */
async function query(platform: Platform, instance: InstanceState, term: string): Promise<Outcome> {
  const http = new Http(platform.fetch, userAgent(platform.config), new Set([instance.host]));
  const url =
    instance.kind === 'invidious'
      ? `https://${instance.host}/api/v1/search?q=${encodeURIComponent(term)}&type=channel`
      : `https://${instance.host}/search?q=${encodeURIComponent(term)}&filter=channels`;
  const started = platform.clock.now();

  try {
    const response = await http.get(url, { maxBytes: MAX_BYTES, headers: { Accept: 'application/json' } });

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return { kind: 'refused' };
    }

    if (response.status !== 200) {
      return { kind: 'failed' };
    }

    let body: unknown;

    try {
      body = JSON.parse(response.body);
    } catch {
      return { kind: 'refused' };
    }

    return { kind: 'ok', results: instance.kind === 'invidious' ? invidiousResults(body) : pipedResults(body), ms: platform.clock.now() - started };
  } catch (error) {
    if (error instanceof UpstreamError) {
      return { kind: 'failed' };
    }

    throw error;
  }
}

export function invidiousResults(body: unknown): Candidate[] {
  return unique(
    (Array.isArray(body) ? body : []).flatMap((item: unknown) => {
      const channel = (typeof item === 'object' && item !== null ? item : {}) as { type?: unknown; authorId?: unknown; channelHandle?: unknown; description?: unknown };

      if (channel.type !== 'channel' || typeof channel.authorId !== 'string' || !CHANNEL_ID.test(channel.authorId)) {
        return [];
      }

      const handle = typeof channel.channelHandle === 'string' ? channel.channelHandle.replace(/^@/, '') : '';

      return [{ id: channel.authorId, handle: HANDLE.test(handle) ? handle : null, description: clean(channel.description) }];
    }),
  );
}

export function pipedResults(body: unknown): Candidate[] {
  const items = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];

  return unique(
    items.flatMap((item: unknown) => {
      const channel = (typeof item === 'object' && item !== null ? item : {}) as { type?: unknown; url?: unknown; description?: unknown };
      const id = typeof channel.url === 'string' ? /^\/channel\/(UC[\w-]{22})$/.exec(channel.url)?.[1] : undefined;

      return channel.type === 'channel' && id !== undefined ? [{ id, handle: null, description: clean(channel.description) }] : [];
    }),
  );
}

/** The results whose channel the platform's own feed confirms, named as the feed names them. */
async function verified(platform: Platform, youtube: SourceAdapter, candidates: readonly Candidate[]): Promise<SearchResult[]> {
  const http = new Http(platform.fetch, userAgent(platform.config), youtube.hosts);
  const names = await Promise.all(candidates.map((candidate) => youtube.verify!(candidate.id, http).catch(() => null)));

  return candidates.flatMap((candidate, i) => {
    const name = names[i];

    return name === null || name === undefined || name === '' ? [] : [{ id: candidate.id, name, handle: candidate.handle, description: candidate.description }];
  });
}

function unique(candidates: Candidate[]): Candidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

function clean(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_DESCRIPTION) : '';
}

function shuffled<T>(items: readonly T[], platform: Platform): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(platform.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }

  return copy;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
