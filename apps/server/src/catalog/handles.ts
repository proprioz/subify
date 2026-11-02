import { chunkOf, compareEntries, decoyHandleEntry, HANDLE_CHUNK_ENTRIES, HANDLE_ENTRY_SIZE, type HandleTarget, handleChunks, openHandleEntry, sealHandleEntry } from '@subify/shared/codec';
import { channelSecrets, evaluate, handleInput } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Db } from '../db/db';
import { readHandleBounds, readHandleChunk } from './vault';

/**
 * The handle index (docs/FEATURES.md, D16), rebuilt by the pass once an hour from the handles of
 * the slots it read: one entry per channel with a handle, random entries up to one per slot,
 * sorted, cut into chunks of a fixed size. About 1.7 ms of CPU per handle (its VOPRF).
 */

export interface Handle {
  source: string;
  externalId: string;
  handle: string;
}

export async function buildHandleIndex(keys: ServerKeys, handles: readonly Handle[], slots: number): Promise<{ chunks: Uint8Array[]; bounds: Uint8Array[] }> {
  const total = handleChunks(slots) * HANDLE_CHUNK_ENTRIES;
  const entries = await Promise.all(
    handles.slice(0, total).map(async ({ source, externalId, handle }) => {
      const secrets = await channelSecrets(evaluate(keys.voprf, handleInput(source, handle)));

      return sealHandleEntry(secrets.slotId, secrets.transitKey, { source, externalId });
    }),
  );

  while (entries.length < total) {
    entries.push(decoyHandleEntry());
  }

  entries.sort(compareEntries);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < entries.length; i += HANDLE_CHUNK_ENTRIES) {
    const chunk = new Uint8Array(HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE);
    entries.slice(i, i + HANDLE_CHUNK_ENTRIES).forEach((entry, j) => chunk.set(entry, j * HANDLE_ENTRY_SIZE));
    chunks.push(chunk);
  }

  return { chunks, bounds: chunks.map((chunk) => chunk.slice(0, 16)) };
}

/**
 * Server side: the channel a handle leads to in the index, as a device would find it, or null.
 * A channel entered since the last hourly rebuild isn't there yet.
 */
export async function findHandle(db: Db, keys: ServerKeys, source: string, handle: string): Promise<HandleTarget | null> {
  const bounds = await readHandleBounds(db, keys);

  if (bounds === undefined) {
    return null;
  }

  const { slotId, transitKey } = await channelSecrets(evaluate(keys.voprf, handleInput(source, handle)));
  const chunk = await readHandleChunk(db, keys, chunkOf(bounds, slotId));

  return chunk === undefined ? null : openHandleEntry(slotId, transitKey, chunk);
}
