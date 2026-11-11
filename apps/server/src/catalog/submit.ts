import { type SlotChannel, THUMBNAIL_MAX_BYTES } from '@subify/shared/codec';
import { userAgent } from '../config';
import type { ServerKeys } from '../crypto/keys';
import type { Db } from '../db/db';
import { Http, UpstreamError } from '../http';
import type { Platform } from '../platform';
import type { Image } from '../sources/image';
import { type ChannelSnapshot, type IncomingItem, InputError, type ParsedInput, type ResolvedChannel, type SourceAdapter } from '../sources/source';
import { avatarOrNothing } from './avatars';
import { type Budgets, budgets } from './budgets';
import type { Coordinator } from './coordinator';
import { findHandle } from './handles';
import { nextPollDelay, retentionCutoff, withJitter } from './schedule';
import { slotIdOf } from './slot-id';
import { mergeItems } from './slot-items';
import { THUMBNAILS_ON_ADD } from './tend';
import type { ThumbnailEncoder } from './thumbnails';
import { enqueueUpdate } from './updates';
import { readSlot } from './vault';

export interface SubmitContext {
  db: Db;
  keys: ServerKeys;
  /** Where a channel entering the catalog waits for the next pass. */
  coordinator: Coordinator;
  sources: readonly SourceAdapter[];
  http: (source: SourceAdapter) => Http;
  thumbnails: ThumbnailEncoder | null;
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Items published before this are not kept (retention). */
  cutoff: () => number;
  /** What a channel new to the catalog may cost, shared by every user (see budgets.ts). */
  budgets: Budgets;
  /** A user's addition, as opposed to seeding: only those set the hours seeding adds at. */
  byUser?: boolean;
}

/** A channel a submission found: in its slot, or read online just now with the thumbnails of its last 7 days. */
export interface Submitted {
  channel: SlotChannel;
  /** By item id; null for a channel the catalog had, which reads nothing online. */
  thumbnails: Map<string, Image> | null;
}

/** What a submission needs, from the platform the request or the scheduled run came with. */
export async function submitContext(platform: Platform, sources: readonly SourceAdapter[]): Promise<SubmitContext> {
  const keys = await platform.keys;

  return {
    db: platform.db,
    keys,
    coordinator: platform.coordinator,
    sources,
    http: (source) => new Http(platform.fetch, userAgent(platform.config), source.hosts),
    thumbnails: platform.thumbnails,
    now: () => platform.clock.now(),
    random: () => platform.random(),
    sleep: (ms) => platform.sleep(ms),
    cutoff: () => retentionCutoff(platform),
    budgets: budgets(platform, keys),
  };
}

/** Each step narrows the input (a video gives its channel's handle, a handle its channel). */
const MAX_RESOLVE_STEPS = 4;

/**
 * Adds one channel to the catalog and returns it with its latest items. A channel the catalog
 * already has, by id or by handle, comes from its slot without contacting the platform: the
 * server only reads a channel when it is new to the catalog. A video link is always read
 * online: the server keeps no list of videos to tell their channel from.
 */
export function submitChannel(raw: string, context: SubmitContext): Promise<Submitted> {
  for (const source of context.sources) {
    const parsed = source.parseInput(raw);

    if (parsed !== null) {
      return submitInput(source, parsed, context);
    }
  }

  for (const source of context.sources) {
    const handles = source.guessHandles?.(raw) ?? [];

    if (handles.length > 0) {
      return submitGuesses(source, handles, context);
    }
  }

  throw new InputError('invalid_link', 'This link isn’t supported. Paste a link to a YouTube channel, its @handle, or one of its videos.');
}

/** Each guess the catalog lacks costs a page read, counted in the budgets like any other. */
const MAX_ONLINE_GUESSES = 3;

/**
 * A channel typed by its name: the first of the handles it may have that the catalog knows,
 * without any request, or else the first of the likeliest ones the platform knows.
 */
async function submitGuesses(source: SourceAdapter, handles: readonly string[], context: SubmitContext): Promise<Submitted> {
  for (const handle of handles) {
    const known = await knownChannel(context, source.source, { kind: 'handle', handle });

    if (known !== undefined) {
      return { channel: known, thumbnails: null };
    }
  }

  for (const handle of handles.slice(0, MAX_ONLINE_GUESSES)) {
    try {
      return await submitInput(source, { kind: 'handle', handle }, context);
    } catch (error) {
      if (!(error instanceof InputError && error.code === 'channel_not_found')) {
        throw error;
      }
    }
  }

  throw new InputError('channel_not_found', 'No channel has a @handle like this name. Paste its link or @handle instead.');
}

/**
 * {@link submitChannel} once the link is read. Seeded channels (src/catalog/seeding.ts) enter the catalog
 * through here too, so that nothing tells them from a user's channels.
 */
export async function submitInput(source: SourceAdapter, parsed: ParsedInput, context: SubmitContext): Promise<Submitted> {
  let input: ParsedInput = parsed;
  let online = false;

  for (let step = 0; step < MAX_RESOLVE_STEPS; step++) {
    const known = await knownChannel(context, source.source, input);

    if (known !== undefined) {
      return { channel: known, thumbnails: null };
    }

    if (!online) {
      await context.budgets.beforeGoingOnline();
      online = true;
    }

    const resolved = await source.resolve(input, context.http(source));

    if (resolved.kind !== 'resolved') {
      input = resolved;
      continue;
    }

    const existing = await knownChannel(context, source.source, { kind: 'channel', externalId: resolved.externalId });

    if (existing !== undefined) {
      return { channel: existing, thumbnails: null };
    }

    // The avatar is read with the feeds: the app shows it as soon as the channel is followed.
    const [{ snapshot, failed }, avatar] = await Promise.all([latestOrNothing(source, resolved, context), avatarOrNothing(source, resolved.iconUrl, context.http(source))]);
    const handle = await handleOf(source, resolved, snapshot.items, context.http(source));
    const title = resolved.title ?? (snapshot.title || resolved.externalId);
    const thumbnails = await recentThumbnails(source, snapshot.items, context);
    const channel = enteringSlot(source.source, resolved.externalId, title, handle, avatar, snapshot.items, failed, context);
    // Until the next pass gives it its slot, the coordinator holds it: a second addition meanwhile reads it again.
    await enqueueUpdate(context.coordinator, context.keys, { kind: 'channel', channel, citations: snapshot.citations ?? [], thumbnails });

    if (context.byUser === true) {
      await enqueueUpdate(context.coordinator, context.keys, { kind: 'added', at: context.now() });
    }

    await context.budgets.channelAdded();

    return { channel, thumbnails: new Map(thumbnails.flatMap(({ itemId, image }) => (image === null ? [] : [[itemId, image] as const]))) };
  }

  throw new InputError('channel_not_found', 'No channel was found for this link.');
}

/**
 * Thumbnails read per channel entering: those of its last 7 days, the newest first. They come with
 * the channel because asking for them by item would name the videos a device shows.
 */
export const ADD_THUMBNAILS = 12;

/**
 * The thumbnails of a channel's last 7 days, read once, when it enters: the add answer gives them,
 * and the pass keeps them in its ring. One that is missing, too large or failed is null.
 */
async function recentThumbnails(source: SourceAdapter, items: readonly IncomingItem[], context: SubmitContext): Promise<{ itemId: string; image: Image | null; preview: Uint8Array | null }[]> {
  const smallUrl = source.smallThumbnailUrl;

  if (smallUrl === undefined) {
    return [];
  }

  const recent = [...items]
    .filter((item) => item.published >= context.now() - THUMBNAILS_ON_ADD || item.upcoming === true)
    .sort((a, b) => b.published - a.published)
    .slice(0, ADD_THUMBNAILS);

  return Promise.all(
    recent.map(async (item) => {
      try {
        const read = await source.readThumbnail(smallUrl(item.externalId), context.http(source));
        const encoded = read === null || context.thumbnails === null ? { image: read, preview: null } : await context.thumbnails(read);
        const kept = encoded.image !== null && encoded.image.bytes.length <= THUMBNAIL_MAX_BYTES;

        return { itemId: item.externalId, image: kept ? encoded.image : null, preview: kept ? encoded.preview : null };
      } catch {
        return { itemId: item.externalId, image: null, preview: null };
      }
    }),
  );
}

/** A channel read online as the encrypted catalog keeps it: polled again when its activity says, subscribed to WebSub by the pass. */
function enteringSlot(
  source: string,
  externalId: string,
  title: string,
  handle: string | null,
  avatar: Image | null,
  items: readonly IncomingItem[],
  failed: boolean,
  context: SubmitContext,
): SlotChannel {
  const now = context.now();

  return {
    kind: 'channel',
    source,
    externalId,
    title,
    handle,
    avatar,
    schedule: {
      // Without items (its feeds were down when it was read), it is polled at the first pass that can.
      nextPollAt: items.length === 0 ? now : now + withJitter(nextPollDelay(items.map((item) => item.published), now, false), context.random()),
      // A failed read counts as the first failure: devices then say when the next one comes (retryAtOf).
      consecutiveFailures: failed ? 1 : 0,
      websubStatus: 'off',
      websubExpiresAt: null,
      websubRequestedAt: null,
      websubSecret: null,
      callbackToken: null,
      notFoundDays: 0,
      notFoundDay: 0,
    },
    items: mergeItems([], { incoming: items }, context.cutoff(), now),
  };
}

/** Reads of a channel's feeds when it enters, the first included: a failure is often over a second later. */
const RETRY_PAUSE = 1_000;
/** No second attempt starts this long after the first one did: the user waits for the answer (add.ts, MIN_LATENCY). */
const RETRY_WITHIN = 4_000;

/**
 * YouTube's feeds have outages where every channel answers 404 or 500 for a while, or for a single
 * request, and sometimes answer an empty list for a channel with uploads. A channel its page
 * confirmed is then read a second time, a second later, through its channel feed alone (`poll`
 * reads the typed playlists only when that feed lists something), and if that fails too it is
 * added as failed, with what the reads gave: the next passes read it again (EMPTY_READS). Only a
 * channel nothing confirmed is reported as not found, at once.
 */
async function latestOrNothing(source: SourceAdapter, resolved: ResolvedChannel, context: SubmitContext): Promise<{ snapshot: ChannelSnapshot; failed: boolean }> {
  const started = context.now();
  const feedsDown = (error: unknown) => error instanceof UpstreamError || (error instanceof InputError && error.code === 'channel_not_found');
  let last: ChannelSnapshot = { title: '', items: [] };

  try {
    const snapshot = await source.fetchLatest(resolved.externalId, context.http(source), context.now());

    if (snapshot.items.length > 0 || !resolved.confirmed) {
      return { snapshot, failed: false };
    }

    last = snapshot;
  } catch (error) {
    // A channel nothing confirmed may not exist: its first "not found" is the answer.
    if (!feedsDown(error) || !resolved.confirmed) {
      throw error;
    }
  }

  if (context.now() + RETRY_PAUSE - started >= RETRY_WITHIN) {
    return { snapshot: last, failed: true };
  }

  await context.sleep(RETRY_PAUSE);

  try {
    const { snapshot } = await source.poll(resolved.externalId, context.http(source), {
      validators: new Map(),
      knownTypes: new Map(),
      upcoming: new Set(),
      force: false,
      now: context.now(),
    });

    return snapshot !== null && snapshot.items.length > 0 ? { snapshot, failed: false } : { snapshot: snapshot ?? last, failed: true };
  } catch (error) {
    if (!feedsDown(error)) {
      throw error;
    }

    return { snapshot: last, failed: true };
  }
}

/**
 * The @handle of a channel entering the catalog: the one that led to it, or else the one its
 * platform names for its latest aired item (one request), so that it can be found by it later.
 */
async function handleOf(source: SourceAdapter, resolved: ResolvedChannel, items: readonly IncomingItem[], http: Http): Promise<string | null> {
  if (resolved.handle !== null || source.readHandle === undefined) {
    return resolved.handle;
  }

  const latest = items.filter((item) => !item.upcoming).reduce<IncomingItem | undefined>((last, item) => (last === undefined || item.published > last.published ? item : last), undefined);

  return latest === undefined ? null : source.readHandle(latest.externalId, http);
}

/** The channel's slot, when the catalog has it: by its id, or by its handle in the handle index. */
export async function knownChannel(context: Pick<SubmitContext, 'db' | 'keys'>, source: string, input: ParsedInput): Promise<SlotChannel | undefined> {
  const { db, keys } = context;
  const target = input.kind === 'channel' ? { source, externalId: input.externalId } : input.kind === 'handle' ? await findHandle(db, keys, source, input.handle) : null;

  if (target === null) {
    return undefined;
  }

  const slot = await readSlot(db, keys, await slotIdOf(keys, target.source, target.externalId));

  return slot?.payload.kind === 'channel' ? slot.payload : undefined;
}
