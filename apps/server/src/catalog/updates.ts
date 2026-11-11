import type { SlotChannel, SlotImage, StreamDelta, WebSubStatus } from '@subify/shared/codec';
import { openMessage, sealMessage } from '../crypto/aead';
import type { ServerKeys } from '../crypto/keys';
import type { Citation, IncomingItem, ParsedInput } from '../sources/source';
import type { Coordinator, PendingUpdate } from './coordinator';

/**
 * What changes the encrypted catalog between two passes (docs/FEATURES.md, D16). Nothing writes
 * to the database then: each change waits, sealed, in the coordinator, and the next pass applies
 * it to its slot.
 */
export type Update =
  /** A channel read online, entering the catalog; merged into its slot if it is there already. */
  | {
      kind: 'channel';
      channel: SlotChannel;
      citations?: Citation[];
      /**
       * The thumbnails the addition already read, by item, with their previews; null for one it
       * tried and didn't get. The pass doesn't read them again.
       */
      thumbnails?: { itemId: string; image: SlotImage | null; preview?: Uint8Array | null }[];
    }
  /** What a channel's feeds said, read after a WebSub notification. */
  | { kind: 'feed'; source: string; externalId: string; title: string; items: IncomingItem[]; dropped: string[]; deleted: string[]; citations?: Citation[] }
  /** The hub confirmed or denied a subscription. */
  | { kind: 'websub'; source: string; externalId: string; status: WebSubStatus; expiresAt: number | null }
  /** A thumbnail the last pass had no case for in the ring. */
  | { kind: 'thumbnail'; source: string; externalId: string; itemId: string; image: SlotImage }
  /** A thumbnail the ring holds and no lot carried yet: its channel, its item and its case. */
  | { kind: 'lot'; source: string; externalId: string; itemId: string; position: number }
  /** A seed candidate that leads to no channel, or to one the catalog has. */
  | { kind: 'forget'; source: string; input: ParsedInput }
  /** A user added a channel new to the catalog then: counted in the hours seeding follows. Names no channel. */
  | { kind: 'added'; at: number }
  /** A channel's changes the last pass's stream batch had no room for, in order: one update, so their order survives the queue. */
  | { kind: 'delta'; source: string; externalId: string; deltas: StreamDelta[] };

/** Bound into the associated data: a sealed update can't be read as anything else. */
const UPDATE_KIND = 16;

export async function enqueueUpdate(coordinator: Coordinator, keys: ServerKeys, update: Update): Promise<void> {
  await coordinator.enqueue(await sealMessage(keys, UPDATE_KIND, new TextEncoder().encode(JSON.stringify(update, withBytes))));
}

export interface OpenedUpdate {
  key: string;
  update: Update;
}

/** Opens waiting updates. One that doesn't open is a bug or a key change: it is dropped, never applied. */
export async function openUpdates(keys: ServerKeys, pending: readonly PendingUpdate[]): Promise<{ opened: OpenedUpdate[]; broken: string[] }> {
  const opened: OpenedUpdate[] = [];
  const broken: string[] = [];

  for (const { key, message } of pending) {
    try {
      opened.push({ key, update: JSON.parse(new TextDecoder().decode(await openMessage(keys, UPDATE_KIND, message)), toBytes) as Update });
    } catch {
      broken.push(key);
    }
  }

  return { opened, broken };
}

/** JSON has no bytes: an avatar or a secret travels as base64 under `$bytes`. */
function withBytes(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let binary = '';
    value.forEach((byte) => (binary += String.fromCharCode(byte)));

    return { $bytes: btoa(binary) };
  }

  return value;
}

function toBytes(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '$bytes' in value && typeof value.$bytes === 'string') {
    return Uint8Array.from(atob(value.$bytes), (char) => char.charCodeAt(0));
  }

  return value;
}
