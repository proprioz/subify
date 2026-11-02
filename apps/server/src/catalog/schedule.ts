import type { Platform } from '../platform';

/** When to poll a channel next, and how long items are kept. Pure functions: the pass applies them. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Items published before this are not kept (RETENTION_DAYS). */
export function retentionCutoff(platform: Pick<Platform, 'clock' | 'config'>): number {
  return platform.clock.now() - platform.config.retentionDays * DAY;
}

const MOST_ACTIVE = HOUR;
const LEAST_ACTIVE = 12 * HOUR;
const INACTIVE = 7 * DAY;
/** A channel silent this long is polled weekly. */
const INACTIVE_AFTER = 60 * DAY;
/** With WebSub, polling is only a safety net. */
const WEBSUB_FACTOR = 4;
const WEBSUB_MAX = 24 * HOUR;

/**
 * The delay before the next poll, from how often the channel publishes: half its typical gap
 * between uploads, between 1 hour (very active) and 12 hours, a week once it went quiet, and
 * spaced further while WebSub pushes its uploads. Polling no more than needed is what keeps
 * YouTube from blocking the server.
 *
 * @param published Publication times of the channel's latest uploads, any order.
 */
export function nextPollDelay(published: readonly number[], now: number, websubActive: boolean): number {
  const recent = [...published].sort((a, b) => b - a).slice(0, 10);
  const latest = recent[0];

  if (latest !== undefined && now - latest > INACTIVE_AFTER) {
    return INACTIVE;
  }

  const gaps = recent.slice(1).map((time, i) => recent[i]! - time);
  const base = gaps.length === 0 ? LEAST_ACTIVE : clamp(median(gaps) / 2, MOST_ACTIVE, LEAST_ACTIVE);

  return websubActive ? Math.min(base * WEBSUB_FACTOR, WEBSUB_MAX) : base;
}

/**
 * After a failure: 30 minutes, then twice as long each time, up to a day. YouTube often answers
 * 404 or 500 for a while; a channel is never given up, only polled less often.
 */
export function failureDelay(consecutiveFailures: number): number {
  return Math.min(30 * MINUTE * 2 ** Math.max(0, consecutiveFailures - 1), DAY);
}

/** ±10 %, so channels added together drift apart instead of being polled in bursts. */
export function withJitter(delay: number, random: number): number {
  return Math.round(delay * (0.9 + 0.2 * random));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
