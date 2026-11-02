import { logError } from '../log';

/**
 * Work that goes on after a response on Node, the counterpart of `ctx.waitUntil` on Workers.
 * The promises are kept so that a shutdown waits for them instead of cutting work short.
 */
export class DetachedWork {
  private readonly pending = new Set<Promise<unknown>>();

  track(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch((error: unknown) => logError('Work after response failed', error))
      .finally(() => this.pending.delete(tracked));

    this.pending.add(tracked);
  }

  /** Resolves once every tracked promise settled, including those added meanwhile. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }
}
