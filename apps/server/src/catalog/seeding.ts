import { catalogCapacity } from '../config';
import { UpstreamError } from '../http';
import type { Platform } from '../platform';
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
 * Seeded channels only come from the links in the descriptions of the catalog's videos, kept in
 * the encrypted pool: the code ships no list of channels, so a new catalog's first channels are its users'.
 */

/** Seeding slows down as the catalog fills, and stops at this share of its capacity: the rest is for users. */
const SEEDED_SHARE = 0.5;
/** The task runs every minute; seeding adds at the hours users do (src/catalog/seed-pool.ts), an hour's window at a time. */
const RUNS_PER_DAY = DAY / MINUTE;
const WINDOWS_PER_DAY = 24;
/** Candidates drawn per run when the first ones are in the catalog already: those cost no request. */
const ATTEMPTS = 3;

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
    const drawn = drawCandidate(pool, Math.floor(now / DAY), () => platform.random());
    const source = sources.find((candidate) => candidate.source === drawn?.source);
    const input = drawn === undefined ? null : parseCandidateInput(drawn.input);

    if (drawn === undefined || source === undefined || input === null) {
      return false;
    }

    pool = pool.filter((candidate) => candidate !== drawn);

    if ((await knownChannel(context, source.source, input)) !== undefined) {
      await forget(source.source, input);
      continue;
    }

    return plant(source, input, context, forget);
  }

  return false;
}

/** Adds the channel as a user's submission would; a candidate that leads to no channel is forgotten. */
async function plant(
  source: SourceAdapter,
  input: ParsedInput,
  context: SubmitContext,
  forget: (source: string, input: ParsedInput) => Promise<unknown>,
): Promise<boolean> {
  try {
    await submitInput(source, input, context);

    return true;
  } catch (error) {
    if (error instanceof InputError) {
      await forget(source.source, input);
    }

    if (error instanceof BudgetError || error instanceof InputError || error instanceof UpstreamError) {
      return false;
    }

    throw error;
  }
}
