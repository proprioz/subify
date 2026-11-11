/**
 * What the encrypted catalog keeps outside the database (docs/FEATURES.md, D16): the sealed
 * updates waiting for the next pass, since nothing writes to the database between passes, and the
 * budgets shared by every user. On Workers, one Durable Object (src/workers/coordinator.ts); on
 * Node, this process's memory.
 */
export interface Coordinator {
  /** Keeps a sealed update until a pass takes it, not before `at` when given. */
  enqueue(message: Uint8Array, at?: number): Promise<void>;
  /**
   * Up to `limit` waiting updates, oldest first, with the keys that remove them once applied:
   * with `until`, those due by then only.
   */
  pending(limit: number, until?: number): Promise<PendingUpdate[]>;
  remove(keys: readonly string[]): Promise<void>;
  /**
   * Counts one more in a budget's window, and says whether it did: once `limit` is reached,
   * nothing is counted. Kept in memory only: a restart starts every budget over.
   */
  take(name: string, windowStart: number, limit: number | null): Promise<boolean>;
  /** What a budget counted in this window so far. */
  spent(name: string, windowStart: number): Promise<number>;
}

export interface PendingUpdate {
  key: string;
  message: Uint8Array;
}

/** Counters by budget, for the window they count in. Shared by both implementations. */
export class Counters {
  private readonly windows = new Map<string, { start: number; count: number }>();

  take(name: string, windowStart: number, limit: number | null): boolean {
    const current = this.windows.get(name);
    const count = current?.start === windowStart ? current.count : 0;

    if (limit !== null && count >= limit) {
      return false;
    }

    this.windows.set(name, { start: windowStart, count: count + 1 });

    return true;
  }

  spent(name: string, windowStart: number): number {
    const current = this.windows.get(name);

    return current?.start === windowStart ? current.count : 0;
  }
}

/**
 * A key that sorts in arrival order: a pass applies a channel's updates in the order they came.
 * The random part keeps two updates of the same millisecond apart.
 */
export function updateKey(now: number, random: Uint8Array): string {
  return `${now.toString(36).padStart(10, '0')}-${[...random].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The first key past those due by `until`: keys sort by their time, then their random part. */
export function keysAfter(until: number): string {
  return updateKey(until + 1, new Uint8Array());
}

/** Node's coordinator, and the tests': this process's memory. Updates waiting are lost with it. */
export class MemoryCoordinator implements Coordinator {
  private readonly updates = new Map<string, Uint8Array>();
  private readonly counters = new Counters();

  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(message: Uint8Array, at?: number): Promise<void> {
    this.updates.set(updateKey(at ?? this.now(), crypto.getRandomValues(new Uint8Array(8))), message);
  }

  async pending(limit: number, until?: number): Promise<PendingUpdate[]> {
    return [...this.updates]
      .filter(([key]) => until === undefined || key < keysAfter(until))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([key, message]) => ({ key, message }));
  }

  async remove(keys: readonly string[]): Promise<void> {
    keys.forEach((key) => this.updates.delete(key));
  }

  async take(name: string, windowStart: number, limit: number | null): Promise<boolean> {
    return this.counters.take(name, windowStart, limit);
  }

  async spent(name: string, windowStart: number): Promise<number> {
    return this.counters.spent(name, windowStart);
  }
}
