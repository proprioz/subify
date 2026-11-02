import { logError } from '../log';

export interface Scheduler {
  /** Stops ticking, then waits for the tick in progress, if any. */
  stop(): Promise<void>;
}

/**
 * Stands in for the Cron Trigger on Node: it calls the same tick once a minute. Unlike a bare
 * setInterval, it never starts a tick while the previous one still runs, so a slow batch of
 * channels is never polled twice at once.
 */
export function startScheduler(options: { intervalMs: number; tick: () => Promise<void> }): Scheduler {
  let running: Promise<void> | undefined;
  let stopped = false;

  const timer = setInterval(() => {
    if (running !== undefined || stopped) {
      return;
    }

    running = options
      .tick()
      .catch((error: unknown) => logError('Scheduled tick failed', error))
      .finally(() => {
        running = undefined;
      });
  }, options.intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
