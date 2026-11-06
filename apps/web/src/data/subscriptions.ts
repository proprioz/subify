import { type ApiChannel, type ApiItem, guessHandles, MAX_SYNC_CHANNELS } from '@subify/shared';
import type { Api } from './api';
import { localChannelKey, localHandle } from './channel-link';
import type { NamedChannel } from './dictionary';
import { addByLink, findInCatalog, type NewChannel } from './encrypted';
import { ALL_TYPES, putItems, setMeta, setRetryAt, type Subscription, type SubifyDb } from './db';

export class AlreadyFollowing extends Error {
  override readonly name = 'AlreadyFollowing';

  constructor(readonly subscription: Subscription) {
    super(`You already follow ${subscription.title}.`);
  }
}

/** The app follows at most MAX_SYNC_CHANNELS channels. Following stops there, before any request. */
export class TooManyChannels extends Error {
  override readonly name = 'TooManyChannels';

  constructor() {
    super(`The app can follow up to ${MAX_SYNC_CHANNELS.toLocaleString('en')} channels.`);
  }
}

/** Throws TooManyChannels when following `adding` more channels would pass the limit. */
export async function checkRoom(db: SubifyDb, adding: number): Promise<void> {
  if ((await db.subscriptions.count()) + adding > MAX_SYNC_CHANNELS) {
    throw new TooManyChannels();
  }
}

/**
 * What a link names: a channel already followed, or the server's answer for a new one, kept in
 * memory until the user decides to follow it.
 */
export type FoundChannel = { following: Subscription } | { submitted: NewChannel };

/** What looking text up gives: a channel, or, for a name, the channels a search service found, to choose from. */
export type LookUpResult = FoundChannel | { matches: NamedChannel[] };

/**
 * Each step a lookup goes through, as it starts, so the user can see where it is and why it takes
 * time. A step of the same kind as the previous one (another slice, another chunk) continues it.
 */
export type LookUpStep =
  /** Asking the server for the dictionary's version. */
  | { kind: 'dictionary' }
  | { kind: 'download'; slice: number; slices: number }
  /** Searching the dictionary on the device. */
  | { kind: 'local' }
  /** Reading the catalog's public key. */
  | { kind: 'catalog' }
  /** A blind evaluation: the server answers for sealed inputs, padded with random ones. */
  | { kind: 'blind'; inputs: number }
  | { kind: 'handles'; chunk: number; chunks: number }
  /** Reading a whole group's snapshot. */
  | { kind: 'group' }
  /** Invidious and Piped, through the server. */
  | { kind: 'search' }
  /** `POST /add`: the server reads the channel online, and answers after at least 8 seconds. */
  | { kind: 'add' };

export type OnStep = (step: LookUpStep) => void;

/**
 * Looks a link up before the user follows it: the server finds the channel in its catalog, or reads it online, and answers with its latest items. Nothing is stored yet, so
 * closing the results leaves the device as it was. A link that names a channel already followed
 * is answered without asking.
 */
export async function findChannel(db: SubifyDb, api: Api, input: string, { search = true, onStep = () => {} }: { search?: boolean; onStep?: OnStep } = {}): Promise<LookUpResult> {
  const key = localChannelKey(input);
  const known = key === null ? undefined : await db.subscriptions.get(key);

  if (known !== undefined) {
    return { following: known };
  }

  const submitted = await lookUp(api, input, key, search, onStep);

  if (Array.isArray(submitted)) {
    return { matches: submitted };
  }

  const existing = await db.subscriptions.get(submitted.channel.key);

  return existing === undefined ? { submitted } : { following: existing };
}

/**
 * The channel a link names, from the server. A channel id, a @handle or the handles a name likely
 * gives are first looked for in the encrypted catalog without naming them;
 * then a name goes to the server's search services, when it has any and `search` allows; anything
 * else, or a channel none of them finds, is sent in clear.
 */
async function lookUp(api: Api, input: string, key: string | null, search: boolean, onStep: OnStep): Promise<NewChannel | NamedChannel[]> {
  onStep({ kind: 'catalog' });
  const catalog = await api.catalog();

  // A @handle, or else the handles a name likely gives: guessed on the device, looked up blindly.
  const handle = localHandle(input);
  const guesses = handle !== null ? [handle] : guessHandles(input);
  const known = await findInCatalog(api, catalog, key !== null ? { key } : { handles: guesses }, onStep);

  if (known !== null) {
    return known;
  }

  // A name: Invidious or Piped, through the server, before the server reads guessed handles online.
  if (search && key === null && handle === null && guesses.length > 0) {
    onStep({ kind: 'search' });
    const results = (await api.search(input.trim()))?.results ?? [];

    if (results.length > 0) {
      return results;
    }
  }

  onStep({ kind: 'add' });

  return addByLink(api, input);
}

/**
 * Follows a channel the server just answered for, without going online again.
 *
 * The first items come from that answer, never from the stream: its cursor is usually past them
 * already.
 */
export async function follow(db: SubifyDb, submitted: NewChannel, now = Date.now()): Promise<Subscription> {
  const subscription: Subscription = {
    key: submitted.channel.key,
    source: submitted.channel.source,
    title: submitted.channel.title,
    handle: submitted.channel.handle,
    icon: submitted.channel.icon,
    avatar: submitted.channel.avatar,
    types: [...ALL_TYPES],
    addedAt: now,
    status: 'ready',
    secret: false,
    ...(submitted.slot === undefined ? {} : { slot: submitted.slot }),
    ...(submitted.start === null ? { submittedAt: now } : {}),
    ...(submitted.retryAt === null ? {} : { retryAt: submitted.retryAt }),
  };

  return db.transaction('rw', db.subscriptions, db.items, db.thumbnails, db.meta, async () => {
    // The results may have stayed open while an import or another tab added the same channel.
    const existing = await db.subscriptions.get(subscription.key);

    if (existing !== undefined) {
      throw new AlreadyFollowing(existing);
    }

    await checkRoom(db, 1);
    await db.subscriptions.put(subscription);
    await putItems(db, submitted.items);
    await db.thumbnails.bulkPut(submitted.thumbnails.map((thumbnail) => ({ ...thumbnail, channel: subscription.key })));
    const { start } = submitted;

    if (start !== null && (await db.subscriptions.count()) === 1) {
      // The only channel: the stream starts at its snapshot. With others, the cursor they share
      // stays where it is, and a channel added the clear way waits for the next refresh.
      await setMeta(db, 'streamPass', start.pass);
    }

    return subscription;
  });
}

/** Stops following a channel and forgets its items and their thumbnails. */
export async function unsubscribe(db: SubifyDb, key: string): Promise<void> {
  await db.transaction('rw', db.subscriptions, db.items, db.thumbnails, db.meta, async () => {
    await db.items.where('channel').equals(key).delete();
    await db.thumbnails.where('channel').equals(key).delete();
    await db.subscriptions.delete(key);

    // With nothing left to follow, the next subscription starts the cursor afresh instead of
    // catching up on the new channel's changes since an old one.
    if ((await db.subscriptions.count()) === 0) {
      await db.meta.delete('streamPass');
    }
  });
}

/** Fills a subscription with a channel's first items and its catalog details, in one transaction. */
export async function fillSubscription(db: SubifyDb, channel: ApiChannel, items: readonly ApiItem[], retryAt: number | null): Promise<void> {
  await db.transaction('rw', db.subscriptions, db.items, async () => {
    await db.subscriptions.update(channel.key, (stored) => {
      Object.assign(stored, { title: channel.title, handle: channel.handle, icon: channel.icon, avatar: channel.avatar, status: 'ready' });
      setRetryAt(stored, retryAt);
    });
    await putItems(db, items);
  });
}

