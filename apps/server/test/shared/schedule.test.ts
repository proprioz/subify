import { describe, expect, it } from 'vitest';
import { DAY, failureDelay, HOUR, MINUTE, nextPollDelay } from '../../src/catalog/schedule';
import { START } from '../harness/types';

// The polling frequency is what keeps YouTube from blocking the server: too often is risky, too rarely delays the feed.
describe('when to poll next', () => {
  const hours = (count: number) => Array.from({ length: count }, (_, i) => START - i * HOUR);
  const days = (count: number, every = 1) => Array.from({ length: count }, (_, i) => START - i * every * DAY);

  it('polls a very active channel every hour', () => {
    expect(nextPollDelay(hours(10), START, false)).toBe(HOUR);
  });

  it('polls a daily channel every 12 hours', () => {
    expect(nextPollDelay(days(10), START, false)).toBe(12 * HOUR);
  });

  it('polls a channel silent for months once a week', () => {
    expect(nextPollDelay(days(10).map((t) => t - 90 * DAY), START, false)).toBe(7 * DAY);
  });

  it('spaces polling out while WebSub pushes the uploads', () => {
    expect(nextPollDelay(hours(10), START, true)).toBe(4 * HOUR);
    expect(nextPollDelay(days(10), START, true)).toBe(24 * HOUR);
  });

  it('backs off after failures, up to a day', () => {
    expect([1, 2, 3, 4, 10].map(failureDelay)).toEqual([30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, DAY]);
  });
});
