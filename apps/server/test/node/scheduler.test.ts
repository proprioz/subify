import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../../src/node/scheduler';

// Two overlapping ticks would run two passes at once, polling the same channels twice, which raises the risk of being blocked by YouTube.
describe('Node scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips a tick while the previous one still runs', async () => {
    let running = 0;
    let maxRunning = 0;
    let started = 0;
    const tick = async () => {
      started++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 150_000));
      running--;
    };

    const scheduler = startScheduler({ intervalMs: 60_000, tick });
    await vi.advanceTimersByTimeAsync(360_000);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(150_000);
    await stopping;

    expect(maxRunning).toBe(1);
    expect(started).toBe(2);
  });

  // A shutdown that leaves a pass half done would lose what it was about to write.
  it('waits for the running tick when stopped', async () => {
    let finished = false;
    const tick = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      finished = true;
    };

    const scheduler = startScheduler({ intervalMs: 60_000, tick });
    await vi.advanceTimersByTimeAsync(60_000);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;

    expect(finished).toBe(true);
  });
});
