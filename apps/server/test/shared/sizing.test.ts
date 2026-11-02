import { describe, expect, it } from 'vitest';
import { MINUTE } from '../../src/catalog/schedule';
import { FIRST_TABLE_SIZE, groupPlan, grownSize, needsGrowth, passPeriod, ringPlan, streamPlan } from '../../src/catalog/sizing';

const KB = 1024;

// Each size class must reveal only that the catalog crossed a documented threshold, and fit the $5 plan.
describe('the encrypted catalog’s sizes', () => {
  it('grow the table by ×1.5 from 2,500 slots, once half of it is occupied', () => {
    const steps = [FIRST_TABLE_SIZE];

    while (steps.length < 5) {
      steps.push(grownSize(steps.at(-1)!));
    }

    expect(steps).toEqual([2_500, 3_750, 5_625, 8_438, 12_657]);
    expect(needsGrowth(1_249, 2_500)).toBe(false);
    expect(needsGrowth(1_250, 2_500)).toBe(true);
  });

  // Past 45 M rows a month, the pass must slow down rather than cost more than the plan includes.
  it('pass every 10 minutes until that would write more than 45 M rows a month', () => {
    expect(passPeriod({ rowsPerPass: 2_500 })).toBe(10 * MINUTE);
    expect(passPeriod({ rowsPerPass: 10_416 })).toBe(10 * MINUTE);
    // 10,417 rows need 10.0003 minutes: rounded up to the next whole minute.
    expect(passPeriod({ rowsPerPass: 10_417 })).toBe(11 * MINUTE);
    // 12,657 slots: 12.66 minutes.
    expect(passPeriod({ rowsPerPass: 12_657 })).toBe(13 * MINUTE);
  });

  // The group size is the privacy a sync gives: 1/k is the best guess of which channel a device follows.
  it('make groups of the documented sizes, never fewer than 8 channels', () => {
    const plan = (catalogSize: number) => groupPlan({ catalogSize, bytesPerChannelPerDay: 5 * KB });

    expect(plan(236)).toEqual({ groups: 1, k: 236 });
    expect(plan(5_000)).toEqual({ groups: 256, k: 19 });
    expect(plan(50_000)).toEqual({ groups: 4_096, k: 12 });
    // A budget too small for any grouping stops at kMin rather than leaving devices alone in their group.
    expect(groupPlan({ catalogSize: 1_000, bytesPerChannelPerDay: 5 * KB, budgetBytesPerDay: 1 })).toEqual({ groups: 64, k: 15 });
  });

  it('size the thumbnail ring from the table alone, so that it never shows how many videos arrived', () => {
    // 5,000 channels: 2,200 videos a day, with a 1.5 margin, over 144 passes.
    expect(ringPlan({ slots: 10_000, period: 10 * MINUTE })).toEqual({ perPass: 23, cases: 23 * 144 * 30 });
    expect(ringPlan({ slots: 2_500, period: 10 * MINUTE }).perPass).toBe(6);
  });

  // The stream's batch must depend on the table's size alone, and stay within a device's 3 MB a day.
  it('size the sync stream from the table alone, within the device budget', () => {
    // 2,500 slots: 1,250 channels × 0.88 changes × 3, over 144 passes: 23 entries, one group.
    const start = streamPlan({ slots: 2_500, period: 10 * MINUTE });
    expect(start).toEqual({ groups: 1, k: 1_250, perGroup: 23 });
    expect(start.perGroup * start.groups * 512 * 144).toBeLessThan(3 * KB * KB);
    // 12,657 slots, 6,328 channels: with 64 groups a device following 50 would fetch about 4.6 MB a day, with 128 about 2.8 MB.
    const later = streamPlan({ slots: 12_657, period: 10 * MINUTE });
    const fetched = later.groups * (1 - Math.exp(-50 / later.groups));
    expect(later).toEqual({ groups: 128, k: 49, perGroup: 1 });
    expect(fetched * later.perGroup * 512 * 144).toBeLessThan(3 * KB * KB);
  });
});
