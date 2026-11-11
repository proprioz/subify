import type { ApiItem, ItemType } from '@subify/shared';
import Dexie, { type EntityTable } from 'dexie';
import { type Keyring, LocalCipher, sealing } from './vault';

/** The types a channel can show. 'unknown' follows 'video': it is an upload YouTube did not type yet. */
export type ShownType = 'video' | 'short' | 'live';

/**
 * Whether a subscription is filled from the server ('ready'), waits in the import queue to be
 * submitted ('pending_submit'), the server found no such channel ('failed'), or the platform
 * doesn't have it ('gone': its history stays, nothing is asked for it).
 */
export type SubmissionStatus = 'ready' | 'pending_submit' | 'failed' | 'gone';

export interface Subscription {
  /** The channel key, '<source>:<id on the platform>'. */
  key: string;
  source: string;
  title: string;
  handle: string | null;
  /** The avatar's URL on the platform, for backups only: the app never loads it. */
  icon: string | null;
  /** The avatar itself, as a data: URL from the server, shown without going online. */
  avatar: string | null;
  types: ShownType[];
  addedAt: number;
  status: SubmissionStatus;
  /** Kept out of sight until the secret code (or biometrics) shows it. */
  secret: boolean;
  /**
   * With the encrypted catalog (docs/FEATURES.md, D16): where the channel's slot is and the key its
   * entries are sealed with, from a blind evaluation under the server's key `keyId`. Absent until
   * the first online action computes it; computed again when the server's key changes.
   */
  slot?: Slot;
  /**
   * When it was last added the clear way (POST /api/add), until the catalog shows it: it enters at
   * the next pass, and a refresh an hour later checks that it did.
   */
  submittedAt?: number;
  /**
   * When the server reads the channel again, while it has no videos of it because its last read
   * failed (YouTube didn't answer). Absent otherwise.
   */
  retryAt?: number;
  /** The stream's pass that last renamed it: a rename from an earlier pass, read later, is older. */
  renamedAt?: number;
  /** The stream's pass that last set `retryAt`: one from an earlier pass, read later, is older. */
  retryPass?: number;
}

/** Sets or removes a subscription's retry time, in a Dexie update callback. */
export function setRetryAt(stored: Subscription, retryAt: number | null): void {
  if (retryAt === null) {
    delete stored.retryAt;
  } else {
    stored.retryAt = retryAt;
  }
}

export interface Slot {
  keyId: number;
  /** 16 bytes. */
  id: Uint8Array;
  /** 32 bytes. */
  key: Uint8Array;
}

/**
 * A copy of a catalog item of a followed channel. `upcoming` is kept as 1 rather than true:
 * IndexedDB cannot index a boolean, and the feed finds upcoming items through their index.
 */
export type StoredItem = Omit<ApiItem, 'upcoming'> & {
  upcoming?: 1;
  /** The stream's pass that last changed it: a change from an earlier pass, read later, is older. */
  pass?: number;
  /** Its thumbnail's ThumbHash, from the stream: a blurred preview until the thumbnail comes (docs/FEATURES.md, D3). */
  preview?: Uint8Array;
};

/**
 * Writes items from the server, replacing the copies already there; `pass` is the stream's pass
 * they come from. An item's preview stays when the new copy has none: only its first entry carries it.
 */
export async function putItems(db: SubifyDb, items: readonly (ApiItem & { preview?: Uint8Array })[], pass?: number): Promise<void> {
  const kept = await db.items.bulkGet(items.map((item) => item.key));

  await db.items.bulkPut(
    items.map(({ upcoming, ...item }, i): StoredItem => {
      const preview = item.preview ?? kept[i]?.preview;

      return { ...item, ...(upcoming === true ? { upcoming: 1 as const } : {}), ...(pass === undefined ? {} : { pass }), ...(preview === undefined ? {} : { preview }) };
    }),
  );
}

/**
 * A thumbnail, downloaded through the server while the app was online for the user (see
 * thumbnails.ts) and kept here, so the feed shows it without going online.
 */
export interface StoredThumbnail {
  /** The item's key. */
  key: string;
  channel: string;
  /** null when the platform has none: it is not asked for again. */
  type: string | null;
  data: ArrayBuffer | null;
}

/** One slice of the Wikidata dictionary, as the server sends it once unzipped (see dictionary.ts). */
export interface DictionarySlice {
  slice: number;
  /** UTF-8 lines, kept as bytes: iOS fails to store a Blob now and then. */
  text: Uint8Array;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

export const ALL_TYPES: readonly ShownType[] = ['video', 'short', 'live'];

export function shownType(type: ItemType): ShownType {
  return type === 'unknown' ? 'video' : type;
}

/**
 * Everything the app keeps lives here, on the device. Each schema change is a new version with
 * its upgrade, and a test that opens data from the previous version (see test/db.test.ts).
 */
export class SubifyDb extends Dexie {
  subscriptions!: EntityTable<Subscription, 'key'>;
  items!: EntityTable<StoredItem, 'key'>;
  thumbnails!: EntityTable<StoredThumbnail, 'key'>;
  meta!: EntityTable<MetaEntry, 'key'>;
  dictionary!: EntityTable<DictionarySlice, 'slice'>;
  keyring!: EntityTable<Keyring, 'id'>;
  /** Whether the tables are sealed, and the key while unlocked (vault.ts). */
  readonly cipher = new LocalCipher();

  constructor(name = 'subify') {
    super(name);

    this.version(1).stores({
      subscriptions: 'key, idHash, addedAt',
      items: 'key, channel, published, [channel+published]',
      meta: 'key',
    });

    // Secret channels, and an index on the status for the import queue.
    this.version(2)
      .stores({ subscriptions: 'key, idHash, addedAt, status' })
      .upgrade((tx) =>
        tx
          .table('subscriptions')
          .toCollection()
          .modify((subscription: Partial<Subscription>) => {
            subscription.secret ??= false;
          }),
      );

    // Drops the hash index and each channel's hash, and makes 'known' and 'submitted' one status,
    // 'ready'.
    this.version(3)
      .stores({ subscriptions: 'key, addedAt, status' })
      .upgrade((tx) =>
        tx
          .table('subscriptions')
          .toCollection()
          .modify((subscription: Omit<Subscription, 'status'> & { idHash?: string; status: string }) => {
            delete subscription.idHash;

            if (subscription.status === 'known' || subscription.status === 'submitted') {
              subscription.status = 'ready';
            }
          }),
      );

    // Upcoming items, shown above the others. Items stored at version 3 lack the field: nothing to
    // convert, the next sync brings the upcoming ones.
    this.version(4).stores({ items: 'key, channel, published, [channel+published], upcoming' });

    // Avatars and thumbnails. Avatars reach the app through /sync as the server reads them.
    this.version(5)
      .stores({ thumbnails: 'key, channel' })
      .upgrade((tx) =>
        tx
          .table('subscriptions')
          .toCollection()
          .modify((subscription: Partial<Subscription>) => {
            subscription.avatar ??= null;
          }),
      );

    // The Wikidata dictionary, to find a channel by its name on the device. Nothing to convert.
    this.version(6).stores({ dictionary: 'slice' });

    // Deletes the 'cursor' meta entry, which the app doesn't read: it syncs from the encrypted
    // catalog. The tables and indexes stay as they are; channels get their slot at the next
    // online action.
    this.version(7).upgrade((tx) => tx.table('meta').delete('cursor'));

    // The keyring: the key that seals the other tables, itself sealed by the password and by
    // Face ID / a fingerprint (vault.ts). Nothing to convert: the tables are sealed once the user
    // chooses a password.
    this.version(8).stores({ keyring: 'id' });

    this.use(sealing(this.cipher));
  }
}

export async function getMeta<T>(db: SubifyDb, key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(db: SubifyDb, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
