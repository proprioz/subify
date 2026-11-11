import { catalogCapacity } from '../config';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { DAY, HOUR, MINUTE } from './schedule';
import { readState } from './vault';

/**
 * A new channel refused for now, for everyone: the server answers 503 with Retry-After. Channels
 * the catalog already has are never refused.
 */
export class BudgetError extends Error {
  override readonly name = 'BudgetError';

  constructor(
    readonly code: 'busy' | 'catalog_full',
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

const BUSY = 'The server takes few new channels at a time, and it has had many lately. Try this one again later.';
const FULL = 'This server can’t take new channels any more. Channels it already knows can still be followed.';

interface Budget {
  name: string;
  size: number;
}

const LOOKUPS: Budget = { name: 'online_lookups', size: MINUTE };
const PER_HOUR: Budget = { name: 'new_channels_hour', size: HOUR };
const PER_DAY: Budget = { name: 'new_channels_day', size: DAY };

export interface Budgets {
  /**
   * Called once by a submission before it reads the platform. Throws BudgetError when the catalog
   * is full, when the hour's or the day's new channels are spent, or when this minute's reads are:
   * a read is reserved only once the others have room, so a refused submission costs nothing.
   */
  beforeGoingOnline(): Promise<void>;
  /** Called once a channel entered the catalog. */
  channelAdded(): Promise<void>;
}

/**
 * Budgets shared by every user of the server: a name, the start of the current window and a
 * count, nothing about who asked or for which channel, kept in the coordinator's memory
 * (docs/FEATURES.md, D16): the database takes no write between two passes. The catalog's size
 * comes from its state, as of the last pass.
 */
export function budgets(platform: Pick<Platform, 'db' | 'config' | 'clock' | 'coordinator'>, keys: ServerKeys): Budgets {
  const { db, config, coordinator } = platform;
  const take = (budget: Budget, at: number, limit: number | null) => coordinator.take(budget.name, windowStart(budget, at), limit);

  return {
    async beforeGoingOnline() {
      const at = platform.clock.now();
      const [hour, day, state] = await Promise.all([
        coordinator.spent(PER_HOUR.name, windowStart(PER_HOUR, at)),
        coordinator.spent(PER_DAY.name, windowStart(PER_DAY, at)),
        readState(db, keys),
      ]);

      if ((state?.channels ?? 0) >= catalogCapacity(config)) {
        throw new BudgetError('catalog_full', FULL, DAY / 1000);
      }

      for (const [budget, spent, limit] of [
        [PER_HOUR, hour, config.newChannelsPerHour],
        [PER_DAY, day, config.newChannelsPerDay],
      ] as const) {
        if (spent >= limit) {
          throw new BudgetError('busy', BUSY, secondsLeft(budget, at));
        }
      }

      if (!(await take(LOOKUPS, at, config.onlineLookupsPerMinute))) {
        throw new BudgetError('busy', BUSY, secondsLeft(LOOKUPS, at));
      }
    },

    async channelAdded() {
      const at = platform.clock.now();

      await Promise.all([take(PER_HOUR, at, null), take(PER_DAY, at, null)]);
    },
  };
}

function windowStart(budget: Budget, at: number): number {
  return Math.floor(at / budget.size) * budget.size;
}

function secondsLeft(budget: Budget, at: number): number {
  return Math.ceil((windowStart(budget, at) + budget.size - at) / 1000);
}
