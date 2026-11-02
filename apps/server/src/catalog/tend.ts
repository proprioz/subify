import { type SlotChannel, type SlotImage, THUMBNAIL_MAX_BYTES } from '@subify/shared/codec';
import { userAgent, websubBase } from '../config';
import { Http, UpstreamError } from '../http';
import { logError } from '../log';
import type { Platform } from '../platform';
import type { SourceAdapter } from '../sources/source';
import type { PassRing } from './ring';
import type { Mention } from './seed-pool';
import { DAY, failureDelay, HOUR, nextPollDelay, withJitter } from './schedule';
import { mergeItems } from './slot-items';
import type { Update } from './updates';

/**
 * What the pass does to one channel's slot (docs/FEATURES.md, D16): it applies the updates that
 * waited for it, polls it when its turn has come, keeps its WebSub subscription alive and applies
 * retention. All of it is the same for every channel, seeded or not.
 */

/** A channel whose feed said "not found" on this many days, and never answered between, is removed if its page agrees. */
export const DEAD_AFTER_DAYS = 30;
/** The lease asked of the hub: 10 days, the longest YouTube's hub grants. */
export const LEASE_SECONDS = 10 * 24 * 60 * 60;
/** Renewed this long before it expires, so a missed renewal still has time to be retried. */
const RENEW_BEFORE = 2 * DAY;
/** A subscribe request the hub has not verified after this long is sent again. */
const RETRY_AFTER = 6 * HOUR;
/** The longest pause between two polls of one pass: requests are spread, never sent in a burst. */
const SPREAD = 2_000;
/** A channel entering the catalog brings the thumbnails of its items of this long. */
export const THUMBNAILS_ON_ADD = 7 * DAY;

/** What one pass may still spend, shared by all its slots. */
export interface PassBudget {
  polls: number;
  renewals: number;
  /** Polls that succeeded so far: a "not found" counts only once others answered (an outage answers 404 for all). */
  succeeded: number;
  attempted: number;
  /** Whether a feed answered during the last pass that read any: polling order must not decide. */
  answeredBefore: boolean;
}

export interface TendContext {
  platform: Platform;
  sources: readonly SourceAdapter[];
  now: number;
  cutoff: number;
  budget: PassBudget;
  ring: PassRing;
  /** Links to channels in the descriptions read during the pass: seed candidates. */
  mentions: Mention[];
}

/**
 * The slot after this pass, or null when the channel is gone for good. `entering` is for a
 * channel taking a decoy's place: its recent items are all new to the catalog.
 */
export async function tend(
  channel: SlotChannel,
  updates: readonly Update[],
  context: TendContext,
  entering = false,
  read: ReadonlyMap<string, SlotImage | null> = new Map(),
): Promise<SlotChannel | null> {
  const known = new Set(entering ? [] : channel.items.map((item) => item.id));
  const since = entering ? context.now - THUMBNAILS_ON_ADD : -Infinity;
  let slot = updates.reduce((current, update) => applyUpdate(current, update, context), keepThumbnails(channel, context.ring));
  const source = context.sources.find((candidate) => candidate.source === slot.source);

  if (source === undefined) {
    return slot;
  }

  if (slot.schedule.nextPollAt <= context.now && context.budget.polls > 0) {
    context.budget.polls--;
    slot = await poll(slot, source, context);

    if (slot.schedule.notFoundDays >= DEAD_AFTER_DAYS) {
      const exists = await source.exists?.(slot.externalId, http(context, source));

      if (exists === false) {
        return null;
      }

      if (exists === true) {
        slot = { ...slot, schedule: { ...slot.schedule, notFoundDays: 0, notFoundDay: 0 } };
      }
    }
  }

  slot = await renew(slot, source, context);
  slot = { ...slot, items: mergeItems(slot.items, {}, context.cutoff, context.now) };

  return readThumbnails(slot, source, context, (item) => !known.has(item.id) && item.published >= since, read);
}

/**
 * Thumbnails whose case the ring overwrites at this pass: an upcoming item's goes into a new case,
 * since it will still be shown; any other is gone, after the 30 days the ring keeps them.
 */
function keepThumbnails(slot: SlotChannel, ring: PassRing): SlotChannel {
  const items = slot.items.map((item) => {
    const held = item.thumbnail === null ? 'kept' : ring.expiring(item.thumbnail, item.id);

    if (held === 'kept') {
      return item;
    }

    const thumbnail = held !== null && item.upcoming ? ring.place({ source: slot.source, externalId: slot.externalId, itemId: item.id, image: held }, false) : null;

    return { ...item, thumbnail };
  });

  return { ...slot, items };
}

/**
 * Reads the thumbnails of the items new to the catalog, once each, when they arrive: one that
 * isn't there, too large or that failed is not read again.
 */
async function readThumbnails(
  slot: SlotChannel,
  source: SourceAdapter,
  context: TendContext,
  isNew: (item: SlotChannel['items'][number]) => boolean,
  read: ReadonlyMap<string, SlotImage | null>,
): Promise<SlotChannel> {
  if (source.smallThumbnailUrl === undefined) {
    return slot;
  }

  const items = [];

  for (const item of slot.items) {
    if (item.thumbnail !== null || item.deleted || !isNew(item)) {
      items.push(item);
      continue;
    }

    let image = read.get(item.id) ?? null;

    try {
      if (!read.has(item.id)) {
        image = await source.readThumbnail(source.smallThumbnailUrl(item.id), http(context, source));
      }
    } catch (error) {
      if (!(error instanceof UpstreamError)) {
        logError('Reading a thumbnail failed', error);
      }
    }

    items.push(
      image !== null && image.bytes.length <= THUMBNAIL_MAX_BYTES
        ? { ...item, thumbnail: context.ring.place({ source: slot.source, externalId: slot.externalId, itemId: item.id, image }, false) }
        : item,
    );
  }

  return { ...slot, items };
}

export function applyUpdate(slot: SlotChannel, update: Update, context: Pick<TendContext, 'now' | 'cutoff' | 'ring' | 'mentions'>): SlotChannel {
  if ((update.kind === 'channel' || update.kind === 'feed') && update.mentions !== undefined) {
    context.mentions.push(...update.mentions.map((input) => ({ source: slot.source, input })));
  }

  switch (update.kind) {
    case 'channel': {
      const fresh = update.channel;

      return {
        ...slot,
        title: fresh.title,
        handle: fresh.handle ?? slot.handle,
        avatar: fresh.avatar ?? slot.avatar,
        items: mergeItems(
          slot.items,
          { incoming: fresh.items.map((item) => ({ externalId: item.id, title: item.title, url: '', thumbnailUrl: null, published: item.published, type: item.type, upcoming: item.upcoming })) },
          context.cutoff,
          context.now,
        ),
      };
    }
    case 'feed':
      return {
        ...slot,
        title: update.title === '' ? slot.title : update.title,
        items: mergeItems(slot.items, { incoming: update.items, dropped: update.dropped, deleted: update.deleted }, context.cutoff, context.now),
      };
    case 'websub':
      return { ...slot, schedule: { ...slot.schedule, websubStatus: update.status, websubExpiresAt: update.expiresAt } };
    case 'thumbnail':
      return {
        ...slot,
        // Placed only while its item is still there and has none: a later pass may have read another.
        items: slot.items.map((item) => (item.id === update.itemId && item.thumbnail === null && !item.deleted ? { ...item, thumbnail: context.ring.place(update, true) } : item)),
      };
    case 'forget':
    case 'added':
    case 'delta':
      // Seeding's and the stream's own: the pass takes them before slots.
      return slot;
  }
}

async function poll(slot: SlotChannel, source: SourceAdapter, context: TendContext): Promise<SlotChannel> {
  const { now, platform } = context;

  await platform.sleep(Math.floor(platform.random() * SPREAD));

  const known = slot.items.filter((item) => !item.deleted);
  context.budget.attempted++;

  try {
    const result = await source.poll(slot.externalId, http(context, source), {
      validators: new Map(),
      knownTypes: new Map(known.map((item) => [item.id, item.type])),
      upcoming: new Set(known.filter((item) => item.upcoming).map((item) => item.id)),
      force: false,
      now,
    });
    context.budget.succeeded++;

    const snapshot = result.snapshot;
    context.mentions.push(...(snapshot?.mentions ?? []).map((input) => ({ source: slot.source, input })));
    const items = snapshot === null ? slot.items : mergeItems(slot.items, { incoming: snapshot.items, dropped: result.droppedUpcoming ?? [] }, context.cutoff, now);
    const websubActive = slot.schedule.websubExpiresAt !== null && slot.schedule.websubExpiresAt > now;
    const delay = nextPollDelay(items.filter((item) => !item.deleted).map((item) => item.published), now, websubActive);

    return {
      ...slot,
      title: snapshot !== null && snapshot.title !== '' ? snapshot.title : slot.title,
      items,
      schedule: { ...slot.schedule, nextPollAt: now + withJitter(delay, platform.random()), consecutiveFailures: 0, notFoundDays: 0, notFoundDay: 0 },
    };
  } catch (error) {
    if (!(error instanceof UpstreamError)) {
      logError('Polling a channel failed', error);
    }

    const failures = slot.schedule.consecutiveFailures + 1;
    const schedule = { ...slot.schedule, consecutiveFailures: failures, nextPollAt: now + withJitter(failureDelay(failures), platform.random()) };
    const today = Math.floor(now / DAY);

    // Days with a "not found" since the feed last answered, each counted once, and only when
    // other channels' feeds answered, in this pass or the last one that read any: YouTube's outages
    // answer 404 for every channel, for hours or days. With the failure backoff, a gone channel is
    // read about once a day.
    const othersAnswered = context.budget.succeeded > 0 || context.budget.answeredBefore;

    if (error instanceof UpstreamError && error.status === 404 && othersAnswered && schedule.notFoundDay !== today) {
      schedule.notFoundDays = Math.min(schedule.notFoundDays + 1, 0xff);
      schedule.notFoundDay = today;
    }

    return { ...slot, schedule };
  }
}

/**
 * Subscribes the channel to its hub, or renews the subscription before it lapses. Only while the
 * server has a public URL the hub can call back.
 */
async function renew(slot: SlotChannel, source: SourceAdapter, context: TendContext): Promise<SlotChannel> {
  const base = websubBase(context.platform.config);
  const websub = source.websub;
  const s = slot.schedule;
  const { now } = context;
  const notRequestedLately = s.websubRequestedAt === null || s.websubRequestedAt < now - RETRY_AFTER;
  const due = notRequestedLately && (s.websubStatus !== 'active' || (s.websubExpiresAt ?? 0) < now + RENEW_BEFORE);

  if (base === null || websub === undefined || !due || context.budget.renewals <= 0) {
    return slot;
  }

  context.budget.renewals--;
  // Random, unlike anything derived from the channel: only the hub learns them.
  const secret = s.websubSecret ?? crypto.getRandomValues(new Uint8Array(32));
  const token = s.callbackToken ?? crypto.getRandomValues(new Uint8Array(16));
  let accepted = false;

  try {
    const hubHttp = new Http(context.platform.fetch, userAgent(context.platform.config), new Set([new URL(websub.hub).hostname]));
    const response = await hubHttp.postForm(
      websub.hub,
      {
        'hub.callback': `${base}/api/websub/callback?c=${hex(token)}`,
        'hub.mode': 'subscribe',
        'hub.topic': websub.topic(slot.externalId),
        'hub.verify': 'async',
        'hub.secret': hex(secret),
        'hub.lease_seconds': String(LEASE_SECONDS),
      },
      { maxBytes: 16 * 1024 },
    );
    accepted = response.status >= 200 && response.status < 300;
  } catch {
    // The hub did not answer: the request is sent again after RETRY_AFTER.
  }

  return {
    ...slot,
    schedule: { ...s, websubSecret: secret, callbackToken: token, websubRequestedAt: now, websubStatus: accepted ? 'pending' : s.websubStatus },
  };
}

function http(context: TendContext, source: SourceAdapter): Http {
  return new Http(context.platform.fetch, userAgent(context.platform.config), source.hosts);
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
