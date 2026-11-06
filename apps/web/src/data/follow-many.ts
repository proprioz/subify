import type { Api } from './api';
import { ServerError } from './api';
import { ALL_TYPES, getMeta, setMeta, type ShownType, type SubifyDb } from './db';
import { addByLink, catchUp } from './encrypted';
import { checkRoom, fillSubscription } from './subscriptions';

/** A channel to follow from a backup or an import, before the server is asked anything. */
export interface ChannelToFollow {
  key: string;
  title: string;
  handle: string | null;
  secret?: boolean;
  types?: ShownType[];
}

export interface FollowManyResult {
  /** Filled at once from the catalog. */
  known: number;
  /** Waiting in the queue, to be submitted one at a time. */
  queued: number;
  /** Already followed. */
  skipped: number;
}

/** After a failure the server or the network may recover from. */
const QUEUE_RETRY = 5 * 60_000;

/**
 * Follows many channels at once, from a restored backup. The channels the catalog knows are
 * filled at once from the snapshots of their groups. The others go into a queue persisted with
 * them and are submitted one at a time (see runImportQueue): each costs the server several reads
 * online. A restore asks for the `thumbnails` of the last 7 days too, of every group it reads
 * (see catchUp).
 */
export async function followMany(
  db: SubifyDb,
  api: Api,
  channels: readonly ChannelToFollow[],
  now = Date.now(),
  { thumbnails = false }: { thumbnails?: boolean } = {},
): Promise<FollowManyResult> {
  const existing = new Set(await db.subscriptions.toCollection().primaryKeys());
  const fresh = [...new Map(channels.filter((channel) => !existing.has(channel.key)).map((channel) => [channel.key, channel])).values()];

  if (fresh.length === 0) {
    return { known: 0, queued: 0, skipped: channels.length };
  }

  await checkRoom(db, fresh.length);
  // The channels wait in the queue, then the snapshots of their groups fill those the catalog has,
  // without naming any; the others stay in the queue.
  await db.subscriptions.bulkPut(
    fresh.map((channel, i) => ({
      key: channel.key,
      source: channel.key.slice(0, channel.key.indexOf(':')),
      title: channel.title,
      handle: channel.handle,
      icon: null,
      avatar: null,
      types: channel.types?.length ? channel.types : [...ALL_TYPES],
      // Keeps the list's order for "Recently added" and for the queue.
      addedAt: now + i,
      status: 'pending_submit' as const,
      secret: channel.secret ?? false,
    })),
  );
  await catchUp(db, api, await api.catalog(), now, thumbnails);
  const queued = (await db.subscriptions.bulkGet(fresh.map((channel) => channel.key))).filter((subscription) => subscription?.status === 'pending_submit').length;

  return { known: fresh.length - queued, queued, skipped: channels.length - fresh.length };
}

export type QueueStep = 'idle' | 'waiting' | 'done';

/**
 * Submits the next channel of the queue. Called again and again while the app is open, one
 * channel per call; the queue lives in the database, so it resumes on the next launch.
 */
export async function runImportQueue(db: SubifyDb, api: Api, now = Date.now()): Promise<QueueStep> {
  const next = (await db.subscriptions.where('status').equals('pending_submit').sortBy('addedAt'))[0];

  if (next === undefined) {
    return 'idle';
  }

  if (now < ((await getMeta<number>(db, 'queueNextAt')) ?? 0)) {
    return 'waiting';
  }

  try {
    // Its slot appears at the next pass; the next refresh computes it.
    const added = await addByLink(api, next.key.slice(next.key.indexOf(':') + 1));

    await db.transaction('rw', db.subscriptions, db.items, db.thumbnails, async () => {
      // A backup's icon stays: the encrypted catalog doesn't keep it.
      await fillSubscription(db, { ...added.channel, icon: next.icon }, added.items, added.retryAt);
      await db.subscriptions.update(next.key, { submittedAt: now });
      await db.thumbnails.bulkPut(added.thumbnails.map((thumbnail) => ({ ...thumbnail, channel: next.key })));
    });
  } catch (error) {
    if (error instanceof ServerError && (error.code === 'channel_not_found' || error.code === 'invalid_link')) {
      await db.subscriptions.update(next.key, { status: 'failed' });
    } else {
      // A busy server may ask for a longer pause than the usual one: the queue waits that long.
      const asked = error instanceof ServerError ? (error.retryAfter ?? 0) : 0;
      await setMeta(db, 'queueNextAt', now + Math.max(QUEUE_RETRY, asked));
    }
  }

  return 'done';
}
