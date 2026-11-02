import { describe, expect, it } from 'vitest';
import { advance, finishMs, OVERDUE_CAP, WAITING_CAP } from '../src/ui/refresh-progress';

/** Runs the bar frame by frame, at 60 frames a second, and returns every width it showed. */
function simulate({ estimateMs, syncMs, totalMs }: { estimateMs: number; syncMs: number; totalMs: number }): number[] {
  const frameMs = 1000 / 60;
  const widths: number[] = [];
  let shown = 0;
  let speed = 0;
  let finishBy: number | null = null;

  for (let at = frameMs; at <= totalMs; at += frameMs) {
    if (finishBy === null && at >= syncMs) {
      finishBy = at + finishMs(shown);
    }

    [shown, speed] = advance(shown, speed, (finishBy ?? estimateMs) - at, frameMs, finishBy !== null);
    widths.push(shown);
  }

  return widths;
}

// A bar that went back, filled up before the sync ended, or never filled after it would misreport the refresh.
describe('the refresh bar', () => {
  it('never goes back', () => {
    const widths = simulate({ estimateMs: 1_000, syncMs: 3_000, totalMs: 4_000 });

    expect(widths.every((width, index) => index === 0 || width >= widths[index - 1]!)).toBe(true);
  });

  it('stays short of the waiting cap on time, and never shows full while the sync runs, however late', () => {
    const widths = simulate({ estimateMs: 1_000, syncMs: 120_000, totalMs: 110_000 });

    expect(widths[599]).toBeLessThan(WAITING_CAP);
    expect(Math.max(...widths)).toBeLessThanOrEqual(OVERDUE_CAP);
  });

  it('fills up within its finishing time once the sync is over, even when it ends early', () => {
    const widths = simulate({ estimateMs: 5_000, syncMs: 200, totalMs: 200 + finishMs(0) + 50 });

    expect(widths.at(-1)).toBe(100);
  });
});
