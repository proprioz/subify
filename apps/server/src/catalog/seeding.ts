import { catalogCapacity } from '../config';
import { UpstreamError } from '../http';
import type { Platform } from '../platform';
import { randomDictionaryEntry } from '../search/dictionary';
import { InputError, type ParsedInput, type SourceAdapter } from '../sources/source';
import { BudgetError } from './budgets';
import { parseCandidateInput } from './candidates';
import { drawCandidate, hourShare } from './seed-pool';
import { DAY, MINUTE } from './schedule';
import { knownChannel, type SubmitContext, submitContext, submitInput } from './submit';
import { enqueueUpdate } from './updates';
import { readHours, readPool, readState } from './vault';

/**
 * Seeding (docs/FEATURES.md, D15): channels the server adds to the catalog on its own, so that a
 * channel in the catalog doesn't prove that someone follows it, nor tells when someone added
 * it. They enter through the same code as a user's channel, count against the same budgets, and
 * nothing in the database, nor in the logs, tells them apart.
 *
 * Seeded channels come from two public sources, never from a list in the code: the links in the
 * descriptions of the catalog's videos, kept in the encrypted pool until the citing video has left
 * the public feeds, and channels drawn at random from the Wikidata dictionary. Those make seeded
 * channels that nothing in the catalog cites, as users' often are, and need no wait: they cover a
 * new catalog from its first users on.
 */

/** Seeding slows down as the catalog fills, and stops at this share of its capacity: the rest is for users. */
const SEEDED_SHARE = 0.5;
/** The task runs every minute; seeding adds at the hours users do (src/catalog/seed-pool.ts), an hour's window at a time. */
const RUNS_PER_DAY = DAY / MINUTE;
const WINDOWS_PER_DAY = 24;
/** Candidates drawn per run when the first ones are in the catalog already: those cost no request. */
const ATTEMPTS = 3;
/**
 * The share of seeded channels drawn from the dictionary while cited ones are ripe; all of them
 * while none is. More would leave the uncited channels outside the dictionary, often small ones,
 * more exposed: seeded channels taken from citations are mostly cited.
 */
const DICTIONARY_SHARE = 0.25;
/** The source the dictionary's channels belong to. */
const DICTIONARY_SOURCE = 'youtube';

interface Seed {
  source: SourceAdapter;
  input: ParsedInput;
  /** Leaves its candidate out of the pool; nothing for a channel of the dictionary. */
  forget(): Promise<unknown>;
}

/**
 * A scheduled task, every minute. Now and then, adds a channel that the descriptions of the
 * catalog's videos link to: about `seededChannelsPerDay` a day while the catalog is nearly empty,
 * fewer as it fills.
 */
export async function addSeededChannel(platform: Platform, sources: readonly SourceAdapter[]): Promise<boolean> {
  const { db, config } = platform;

  if (config.seededChannelsPerDay === 0) {
    return false;
  }

  const keys = await platform.keys;
  const channels = (await readState(db, keys))?.channels ?? 0;
  const room = 1 - channels / (catalogCapacity(config) * SEEDED_SHARE);

  if (channels === 0 || platform.random() >= ((config.seededChannelsPerDay * WINDOWS_PER_DAY) / RUNS_PER_DAY) * room) {
    return false;
  }

  const now = platform.clock.now();
  const hours = await readHours(db, keys);

  // The base rate counts one window per hour of day; this keeps the hour's share of them.
  if (hours === undefined || platform.random() >= hourShare(hours, now)) {
    return false;
  }

  const context = await submitContext(platform, sources);
  // Nothing is written here: a candidate to forget waits in the coordinator for the pass, like the channel itself.
  const forget = (source: string, input: ParsedInput) => enqueueUpdate(platform.coordinator, keys, { kind: 'forget', source, input });
  let pool = await readPool(db, keys);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const drawn = platform.random() < 1 - DICTIONARY_SHARE ? drawCandidate(pool, Math.floor(now / DAY), () => platform.random()) : undefined;
    let seed: Seed | undefined;

    if (drawn === undefined) {
      seed = await fromDictionary(platform, sources);
    } else {
      pool = pool.filter((candidate) => candidate !== drawn);
      const source = sources.find((candidate) => candidate.source === drawn.source);
      const input = parseCandidateInput(drawn.input);
      seed = source === undefined || input === null ? undefined : { source, input, forget: () => forget(source.source, input) };
    }

    if (seed === undefined) {
      return false;
    }

    if ((await knownChannel(context, seed.source.source, seed.input)) !== undefined) {
      await seed.forget();
      continue;
    }

    return plant(seed, context);
  }

  return false;
}

/** A channel of the dictionary, drawn alike among all of them: none without a dictionary. */
async function fromDictionary(platform: Platform, sources: readonly SourceAdapter[]): Promise<Seed | undefined> {
  const source = sources.find((candidate) => candidate.source === DICTIONARY_SOURCE);
  const id = (await randomDictionaryEntry(platform.db, () => platform.random()))?.[0];

  return source === undefined || id === undefined ? undefined : { source, input: { kind: 'channel', externalId: id }, forget: async () => {} };
}

/** Adds the channel as a user's submission would; a candidate that leads to no channel is forgotten. */
async function plant(seed: Seed, context: SubmitContext): Promise<boolean> {
  try {
    await submitInput(seed.source, seed.input, context);

    return true;
  } catch (error) {
    if (error instanceof InputError) {
      await seed.forget();
    }

    if (error instanceof BudgetError || error instanceof InputError || error instanceof UpstreamError) {
      return false;
    }

    throw error;
  }
}
