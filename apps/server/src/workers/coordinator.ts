import { DurableObject } from 'cloudflare:workers';
import { type Coordinator, Counters, keysAfter, type PendingUpdate, updateKey } from '../catalog/coordinator';

/** Durable Object storage deletes at most this many keys per call. */
const DELETE_CHUNK = 128;

/**
 * The encrypted catalog's coordinator on Workers (src/catalog/coordinator.ts): one instance for
 * the whole server. Sealed updates wait in its storage, so that a restart between two passes
 * loses none; the pass deletes them once applied. Budgets stay in its memory only.
 */
export class CoordinatorObject extends DurableObject {
  private readonly counters = new Counters();

  async enqueue(message: Uint8Array, at?: number): Promise<void> {
    await this.ctx.storage.put(updateKey(at ?? Date.now(), crypto.getRandomValues(new Uint8Array(8))), message);
  }

  async pending(limit: number, until?: number): Promise<PendingUpdate[]> {
    const stored = await this.ctx.storage.list<Uint8Array>(until === undefined ? { limit } : { limit, end: keysAfter(until) });

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
}

/** The one instance, through its binding. */
export function coordinatorOf(namespace: DurableObjectNamespace<CoordinatorObject>): Coordinator {
  const stub = namespace.get(namespace.idFromName('catalog'));

  return {
    enqueue: (message, at) => stub.enqueue(message, at),
    pending: (limit, until) => stub.pending(limit, until),
    remove: (keys) => stub.remove([...keys]),
    take: (name, windowStart, limit) => stub.take(name, windowStart, limit),
    spent: (name, windowStart) => stub.spent(name, windowStart),
  };
}
