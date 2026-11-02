import { DurableObject } from 'cloudflare:workers';
import { type Coordinator, Counters, type PendingUpdate, type SearchState, updateKey } from '../catalog/coordinator';

/** Durable Object storage deletes at most this many keys per call. */
const DELETE_CHUNK = 128;

/**
 * The encrypted catalog's coordinator on Workers (src/catalog/coordinator.ts): one instance for
 * the whole server. Sealed updates wait in its storage, so that a restart between two passes
 * loses none; the pass deletes them once applied. Budgets stay in its memory only.
 */
export class CoordinatorObject extends DurableObject {
  private readonly counters = new Counters();
  private search: SearchState | undefined;

  async enqueue(message: Uint8Array): Promise<void> {
    await this.ctx.storage.put(updateKey(Date.now(), crypto.getRandomValues(new Uint8Array(8))), message);
  }

  async pending(limit: number): Promise<PendingUpdate[]> {
    const stored = await this.ctx.storage.list<Uint8Array>({ limit });

    return [...stored].map(([key, message]) => ({ key, message: new Uint8Array(message) }));
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      await this.ctx.storage.delete(keys.slice(i, i + DELETE_CHUNK));
    }
  }

  async take(name: string, windowStart: number, limit: number | null): Promise<boolean> {
    return this.counters.take(name, windowStart, limit);
  }

  async spent(name: string, windowStart: number): Promise<number> {
    return this.counters.spent(name, windowStart);
  }

  /** The search instances' scores: memory only, like the budgets. */
  async searchState(): Promise<SearchState | undefined> {
    return this.search;
  }

  async saveSearchState(state: SearchState): Promise<void> {
    this.search = state;
  }
}

/** The one instance, through its binding. */
export function coordinatorOf(namespace: DurableObjectNamespace<CoordinatorObject>): Coordinator {
  const stub = namespace.get(namespace.idFromName('catalog'));

  return {
    enqueue: (message) => stub.enqueue(message),
    pending: (limit) => stub.pending(limit),
    remove: (keys) => stub.remove([...keys]),
    take: (name, windowStart, limit) => stub.take(name, windowStart, limit),
    spent: (name, windowStart) => stub.spent(name, windowStart),
    searchState: () => stub.searchState(),
    saveSearchState: (state) => stub.saveSearchState(state),
  };
}
