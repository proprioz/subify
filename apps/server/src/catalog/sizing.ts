/**
 * How big the encrypted catalog's parts are and how often the pass runs (docs/FEATURES.md, D16).
 * Pure functions: every size here depends on the table's size class and fixed constants only,
 * never on how many channels changed, so that nothing the database or the sync stream shows
 * varies with activity.
 */
import { DAY, MINUTE } from './schedule';

const MONTH = 30 * DAY;
const KB = 1024;

/** The table's first size, in slots. */
export const FIRST_TABLE_SIZE = 2_500;
/** Each growth step multiplies the table by this. */
const GROWTH = 1.5;
/** A growth step is due once occupied slots reach this share of the table: fixed, never another criterion. */
const GROWTH_THRESHOLD = 0.5;
/** It happens at a pass drawn at random within this long after the threshold was crossed. */
export const GROWTH_WINDOW = 3 * DAY;

/** The size after one growth step: 2,500, 3,750, 5,625, 8,438… */
export function grownSize(slots: number): number {
  return Math.ceil(slots * GROWTH);
}

/** Whether the table has reached its growth threshold. */
export function needsGrowth(occupied: number, slots: number): boolean {
  return occupied >= slots * GROWTH_THRESHOLD;
}

export interface PeriodOptions {
  /** Rows the pass writes each time: every slot, plus the other rows it rewrites. */
  rowsPerPass: number;
  minPeriod?: number;
  /** D1 rows written a month, kept under the 50 M the Workers Paid plan includes. */
  monthlyRows?: number;
}

/**
 * Time between two passes: 10 minutes, or longer when that would write more than about 45 M rows
 * a month. Rounded up to whole minutes, the pace of the scheduled trigger. 2,500 slots write about
 * 10.8 M rows a month, 5,625 about 24 M; the period first exceeds 10 minutes past 10,416 rows a pass.
 */
export function passPeriod({ rowsPerPass, minPeriod = 10 * MINUTE, monthlyRows = 45_000_000 }: PeriodOptions): number {
  const needed = (rowsPerPass * MONTH) / monthlyRows;

  return Math.max(minPeriod, Math.ceil(needed / MINUTE) * MINUTE);
}

export interface GroupOptions {
  /** Channels in the catalog's size class. */
  catalogSize: number;
  /** What one channel's changes weigh in the sync stream per day. */
  bytesPerChannelPerDay: number;
  budgetBytesPerDay?: number;
  /** The device the budget is for: one following this many channels. */
  referenceFollowed?: number;
  /** The fewest channels a group may hold. */
  kMin?: number;
}

export interface GroupPlan {
  /** A power of two; 1 means the whole catalog is one group. */
  groups: number;
  /** Channels per group, rounded down: 1/k is the best chance of guessing which one a device follows. */
  k: number;
}

/**
 * The fewest groups (a power of two) for which a device following `referenceFollowed` channels
 * downloads, on average, no more than the budget a day, without a group falling under `kMin`
 * channels. A device downloads every group holding one of its channels: with `groups` groups it
 * expects `catalogSize × (1 − e^(−referenceFollowed / groups))` channels' worth of changes.
 *
 * At 5 KB per channel a day: k = 236 for today's catalog of 236, 19 at 5,000 channels, 12 at 50,000.
 */
export function groupPlan({ catalogSize, bytesPerChannelPerDay, budgetBytesPerDay = 5 * KB * KB, referenceFollowed = 50, kMin = 8 }: GroupOptions): GroupPlan {
  let groups = 1;

  const download = (count: number) => catalogSize * (1 - Math.exp(-referenceFollowed / count)) * bytesPerChannelPerDay;

  while (download(groups) > budgetBytesPerDay && catalogSize / (groups * 2) >= kMin) {
    groups *= 2;
  }

  return { groups, k: Math.floor(catalogSize / groups) };
}

export interface RingOptions {
  slots: number;
  period: number;
  /** Measured on the catalog in November 2026: about 0.44 videos per channel per day. */
  videosPerChannelPerDay?: number;
  margin?: number;
  /** How long a thumbnail stays before the ring wraps over it. */
  keepDays?: number;
}

export interface RingPlan {
  /** Cases the pass overwrites each time, the oldest first. */
  perPass: number;
  /** Cases in the ring: a case is overwritten after `keepDays`. */
  cases: number;
}

/**
 * The thumbnail ring's size, from the table's size alone: its channels are counted as half the
 * slots, the growth threshold. About 23 cases a pass for 5,000 channels at 10-minute passes.
 */
export function ringPlan({ slots, period, videosPerChannelPerDay = 0.44, margin = 1.5, keepDays = 30 }: RingOptions): RingPlan {
  const passesPerDay = DAY / period;
  const perPass = Math.ceil((slots * GROWTH_THRESHOLD * videosPerChannelPerDay * margin) / passesPerDay);

  return { perPass, cases: Math.ceil(perPass * passesPerDay * keepDays) };
}

export interface StreamOptions {
  slots: number;
  period: number;
  /** Changes per channel a day: about 0.44 new videos, each changing once more later (estimate). */
  changesPerChannelPerDay?: number;
  margin?: number;
  budgetBytesPerDay?: number;
}

export interface StreamPlan extends GroupPlan {
  /** Entries of each group in every batch, real and decoys. */
  perGroup: number;
}

/** Bytes of one stream entry (packages/shared, codec/stream.ts). */
const STREAM_ENTRY = 512;
/** A device's stream budget: about 3 MB a day. */
const STREAM_BUDGET = 3 * KB * KB;

/**
 * The sync stream's shape, from the table's size alone, like the ring: its channels counted as
 * half the slots, three times the changes expected, so that a busy evening rarely makes a change
 * wait a pass. 2,500 slots: one group of 23 entries a pass, about 1.7 MB a day.
 */
export function streamPlan({ slots, period, changesPerChannelPerDay = 0.88, margin = 3, budgetBytesPerDay = STREAM_BUDGET }: StreamOptions): StreamPlan {
  const channels = Math.floor(slots * GROWTH_THRESHOLD);
  const passesPerDay = DAY / period;
  const plan = groupPlan({ catalogSize: channels, bytesPerChannelPerDay: changesPerChannelPerDay * margin * STREAM_ENTRY, budgetBytesPerDay });
  const perPass = (channels * changesPerChannelPerDay * margin) / passesPerDay;

  return { ...plan, perGroup: Math.max(1, Math.ceil(perPass / plan.groups)) };
}

/** Rows of the stream's ring: 30 days of 10-minute passes. With longer passes, it keeps more. */
export const STREAM_ROWS = 30 * 144;
