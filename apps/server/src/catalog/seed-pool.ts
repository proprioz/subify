import { type AddingHours, candidateSize, SEED_POOL_ROW_ROOM, type SeedCandidate, type SlotChannel, type SlotItem, utf8Length } from '@subify/shared/codec';
import type { Citation, ParsedInput } from '../sources/source';
import { candidateInput } from './candidates';
import { DAY, HOUR } from './schedule';

/**
 * Seeding's state in the encrypted catalog (docs/FEATURES.md, D15 and D16): the candidates the
 * pass harvests from the catalog's descriptions, and the hours of day users add channels at.
 */

/** Rows of candidates, rewritten whole at every pass: about 30,000 candidates. */
export const POOL_ROWS = 64;
/**
 * A channel's public feeds list its latest 15 videos, and each typed playlist (videos, Shorts,
 * lives) its latest 15 of that type: a video has left them all once 15 newer of its type came.
 */
export const FEED_LENGTH = 15;
/**
 * A candidate of version 1 knows no citing video: it is drawn this long after it was first cited,
 * about a month at the catalog's 0.44 videos a day.
 */
export const SEED_DELAY_DAYS = 30;
/** Hour counts are halved this often: they follow users' habits of the last weeks. */
const HALVING_DAYS = 7;
const MAX_TEXT = 255;

export interface Mention {
  source: string;
  input: ParsedInput;
}

/** A mention read in a description: the channel and video citing it, and that video's day. */
export interface CitedMention extends Mention {
  citer: string;
  video: string;
  cited: number;
}

/** A channel's citations as mentions, its own id as their citer. */
export function citedBy(channel: Pick<SlotChannel, 'source' | 'externalId'>, citations: readonly Citation[] = []): CitedMention[] {
  return citations.map(({ input, video, published }) => ({ source: channel.source, input, citer: channel.externalId, video, cited: Math.floor(published / DAY) }));
}

/**
 * Whether a video has left its channel's public feeds, from the channel's slot: 15 newer of its
 * type came, or it was deleted. One the slot no longer holds is past RETENTION_DAYS, or behind
 * 400 newer ones. One whose type is still unknown waits until a read tells it.
 */
export function leftFeeds(items: readonly SlotItem[], video: string): boolean {
  const cited = items.find((item) => item.id === video);

  if (cited === undefined || cited.deleted) {
    return true;
  }

  return cited.type !== 'unknown' && items.filter((item) => !item.deleted && item.type === cited.type && item.published > cited.published).length >= FEED_LENGTH;
}

/**
 * The pool after a pass: forgotten candidates out (their channel entered the catalog, or they
 * lead to none), new mentions in, a known one counted once more. A known one cited again by a
 * video as recent or more follows that video, and waits for it to leave the feeds too.
 */
export function harvest(pool: readonly SeedCandidate[], mentions: readonly CitedMention[], forgotten: readonly Mention[], today: number): SeedCandidate[] {
  const gone = new Set(forgotten.map((mention) => keyOf(mention.source, candidateInput(mention.input))));
  const kept = pool.filter((candidate) => !gone.has(keyOf(candidate.source, candidate.input))).map((candidate) => ({ ...candidate }));
  const byKey = new Map(kept.map((candidate) => [keyOf(candidate.source, candidate.input), candidate]));

  for (const { source, input, citer, video, cited } of mentions) {
    const stored = candidateInput(input);
    const key = keyOf(source, stored);
    const known = byKey.get(key);

    if (gone.has(key) || [source, stored, citer, video].some((text) => utf8Length(text) > MAX_TEXT)) {
      continue;
    }

    if (known === undefined) {
      const candidate = { source, input: stored, cites: 1, day: today, citer, video, cited, ripe: false };
      kept.push(candidate);
      byKey.set(key, candidate);
      continue;
    }

    known.cites = Math.min(known.cites + 1, 0xff);

    if (known.citer === '' || cited >= known.cited) {
      Object.assign(known, { citer, video, cited, ripe: false });
    }
  }

  return kept;
}

/** The pool in its rows, in order. When it is full, the newest candidates are dropped. */
export function packPool(pool: readonly SeedCandidate[], count = POOL_ROWS): SeedCandidate[][] {
  const rows: SeedCandidate[][] = Array.from({ length: count }, () => []);
  let row = 0;
  let room = SEED_POOL_ROW_ROOM;

  for (const candidate of pool) {
    const size = candidateSize(candidate);

    if (size > room) {
      row++;
      room = SEED_POOL_ROW_ROOM;
    }

    if (row >= count) {
      break;
    }

    rows[row]!.push(candidate);
    room -= size;
  }

  return rows;
}

/**
 * A candidate to seed: one whose citing video has left the public feeds (SEED_DELAY_DAYS after it
 * was first cited for one of version 1), and cited once if any such is left, as a channel many
 * videos cite is easy to tell as cited.
 */
export function drawCandidate(pool: readonly SeedCandidate[], today: number, random: () => number): SeedCandidate | undefined {
  const ripe = pool.filter((candidate) => candidate.ripe || (candidate.citer === '' && candidate.day + SEED_DELAY_DAYS <= today));
  const once = ripe.filter((candidate) => candidate.cites === 1);
  const from = once.length > 0 ? once : ripe;

  return from[Math.floor(random() * from.length)];
}

export function emptyHours(today: number): AddingHours {
  return { counts: Array.from({ length: 24 }, () => 0), halvedDay: today };
}

/** The counts after a pass: halved when a week went by, then this pass's additions by users counted. */
export function countHours(hours: AddingHours, additions: readonly number[], today: number): AddingHours {
  const halve = today - hours.halvedDay >= HALVING_DAYS;
  const counts = hours.counts.map((count) => (halve ? Math.floor(count / 2) : count));

  for (const at of additions) {
    const hour = hourOf(at);
    counts[hour] = Math.min((counts[hour] ?? 0) + 1, 0xffffffff);
  }

  return { counts, halvedDay: halve ? today : hours.halvedDay };
}

/** The share of users' additions made in this hour of day; every hour alike before any. */
export function hourShare(hours: AddingHours, at: number): number {
  const total = hours.counts.reduce((sum, count) => sum + count, 0);

  return total === 0 ? 1 / 24 : hours.counts[hourOf(at)]! / total;
}

function hourOf(at: number): number {
  return Math.floor((((at % DAY) + DAY) % DAY) / HOUR);
}

function keyOf(source: string, input: string): string {
  return `${source}\n${input}`;
}
