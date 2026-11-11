import type { ItemType } from '@subify/shared';
import { type Http, UpstreamError } from '../../http';
import {
  type ChannelSnapshot,
  type Citation,
  type IncomingItem,
  InputError,
  type ParsedInput,
  type PollContext,
  type PollResult,
  type ResolvedChannel,
  type SourceAdapter,
  type Validators,
} from '../source';
import { type Feed, type FeedEntry, FeedFormatError, parseFeed } from './feed';
import { type Image, readImage } from '../image';
import { avatarUrl, channelFeedUrl, channelOfTopic, smallThumbnailUrl, THUMBNAIL_HOST, thumbnailUrl, type TypedFeed, typedFeedUrl, videoUrl, websubTopic } from './ids';
import { parseNotification } from './notification';
import { guessHandles, parseYoutubeInput } from './input';
import { channelMentions } from './mentions';
import { AVATAR_HOSTS, ChannelPageScanner, CONSENT_COOKIE, MAX_PAGE_BYTES } from './page';

const MAX_FEED_BYTES = 512 * 1024;
/** An 88 px avatar weighs about 3 KB, a 320×180 thumbnail about 15 KB. */
const MAX_AVATAR_BYTES = 64 * 1024;
const MAX_THUMBNAIL_BYTES = 128 * 1024;
const AVATAR_SIZE = 88;
const MAX_OEMBED_BYTES = 16 * 1024;
/** Channels a snapshot names as linked to from its new items: each may cost a page read later. */
const MAX_MENTIONS = 3;

const HANDLE_NOT_FOUND = 'Couldn’t find this channel from its @handle. Paste its /channel/UC… link instead.';

/** When the same video shows up in several typed feeds, the first type here wins. */
const TYPE_PRIORITY: readonly TypedFeed[] = ['live', 'short', 'video'];

/**
 * A video published this recently with no views is taken for a fresh upload whose count YouTube
 * has not updated yet, not for an upcoming one: a WebSub notification brings it within a minute.
 */
const UPCOMING_GRACE = 60 * 60 * 1000;

/** 'unchanged': the playlist answered 304, so it says nothing about what it lists. */
type TypedFeedResult = { status: 'ok'; feed: Feed } | { status: 'empty' } | { status: 'unchanged' } | { status: 'failed' };

export const youtube: SourceAdapter = {
  source: 'youtube',
  hosts: new Set(['www.youtube.com', ...AVATAR_HOSTS, THUMBNAIL_HOST]),

  websub: {
    hub: 'https://pubsubhubbub.appspot.com/subscribe',
    topic: websubTopic,
    channelOfTopic,
    parseNotification,
  },

  parseInput: parseYoutubeInput,

  guessHandles,

  readAvatar(iconUrl: string, http: Http): Promise<Image | null> {
    return readImage(http, avatarUrl(iconUrl, AVATAR_SIZE), MAX_AVATAR_BYTES);
  },

  readThumbnail(thumbnailUrl: string, http: Http): Promise<Image | null> {
    return readImage(http, thumbnailUrl, MAX_THUMBNAIL_BYTES);
  },

  smallThumbnailUrl,

  /** oEmbed names a video's channel by its @handle link, when it has one. */
  async readHandle(videoId: string, http: Http): Promise<string | null> {
    try {
      const channel = await channelOfVideo(http, videoId);

      return channel.kind === 'handle' ? channel.handle : null;
    } catch (error) {
      if (error instanceof InputError) {
        return null;
      }

      throw error;
    }
  },

  async resolve(input: ParsedInput, http: Http): Promise<ParsedInput | ResolvedChannel> {
    switch (input.kind) {
      case 'channel':
        return readChannelPage(http, `https://www.youtube.com/channel/${input.externalId}`, null, input.externalId);
      case 'handle':
        return readChannelPage(http, `https://www.youtube.com/@${encodeURIComponent(input.handle)}`, input.handle, null);
      case 'other': {
        const [kind, value = ''] = input.value.split(':', 2) as [string, string?];

        if (kind === 'video') {
          return channelOfVideo(http, value);
        }

        return readChannelPage(http, `https://www.youtube.com/${kind}/${encodeURIComponent(value)}`, null, null);
      }
    }
  },

  /**
   * A channel YouTube removed or never had answers 404, or a page without the channel's canonical
   * link (it shows an alert instead). Anything else, an outage included, says nothing.
   */
  async exists(channelId: string, http: Http): Promise<boolean | null> {
    const scanner = new ChannelPageScanner();

    try {
      const response = await http.get(`https://www.youtube.com/channel/${channelId}`, {
        maxBytes: MAX_PAGE_BYTES,
        headers: { Cookie: CONSENT_COOKIE, 'Accept-Language': 'en' },
        until: (text) => scanner.scan(text),
      });

      if (response.status === 404) {
        return false;
      }

      if (response.status !== 200) {
        return null;
      }

      scanner.scan(response.body);

      return scanner.page.channelId === channelId;
    } catch (error) {
      if (error instanceof UpstreamError) {
        return null;
      }

      throw error;
    }
  },

  async verify(channelId: string, http: Http): Promise<string | null> {
    try {
      return (await readChannelFeed(http, channelId)).title;
    } catch (error) {
      if (error instanceof InputError) {
        return null;
      }

      throw error;
    }
  },

  async fetchLatest(channelId: string, http: Http, now: number): Promise<ChannelSnapshot> {
    const [channel, live, short, video] = await Promise.all([
      readChannelFeed(http, channelId),
      readTypedFeed(http, channelId, 'live'),
      readTypedFeed(http, channelId, 'short'),
      readTypedFeed(http, channelId, 'video'),
    ]);

    return {
      title: channel.title,
      items: classify(channel, { live: live.result, short: short.result, video: video.result }, now),
      citations: citationsOf([channel, ...[live, short, video].map(({ result }) => feedOfResult(result))], channelId, () => true),
    };
  },

  /**
   * Reads only the channel feed. The typed playlists, three more requests, are read only when
   * the channel feed lists an upload the catalog does not have, or one it could not type yet, and
   * while the catalog holds an upcoming video the channel feed does not show as aired: upcoming
   * videos are listed in the typed playlists only.
   */
  async poll(channelId: string, http: Http, context: PollContext): Promise<PollResult> {
    const validators = new Map<string, Validators>();
    const answer = await conditionalGet(http, channelFeedUrl(channelId), context.validators.get('channel'));

    if (answer.status === 304 && !context.force) {
      return { snapshot: null, validators };
    }

    if (answer.status !== 200 && answer.status !== 304) {
      throw new UpstreamError('status', answer.status);
    }

    const channel = answer.status === 304 ? null : feedOf(answer.body, channelId);
    validators.set('channel', answer.validators);

    const aired = new Set(channel?.entries.filter((entry) => !isUpcoming(entry, context.now)).map((entry) => entry.videoId));
    const needsTypes =
      context.force ||
      channel === null ||
      [...context.upcoming].some((id) => !aired.has(id)) ||
      channel.entries.some((entry) => {
        const known = context.knownTypes.get(entry.videoId);

        return known === undefined || known === 'unknown';
      });

    if (!needsTypes) {
      return {
        snapshot: { title: channel.title, items: classify(channel, { live: FAILED, short: FAILED, video: FAILED }, context.now) },
        validators,
      };
    }

    const typed = await Promise.all(
      TYPE_PRIORITY.map(async (type): Promise<[TypedFeed, TypedFeedResult]> => {
        const result = await readTypedFeed(http, channelId, type, context.validators.get(type));
        validators.set(type, result.validators);

        return [type, result.result];
      }),
    );
    const byType = Object.fromEntries(typed) as Record<TypedFeed, TypedFeedResult>;
    const items = classify(channel ?? { channelId, title: '', entries: [] }, byType, context.now);
    // Only feeds read in full can tell a video is gone: a failed or unchanged one may still list it.
    const complete = channel !== null && TYPE_PRIORITY.every((type) => byType[type].status === 'ok' || byType[type].status === 'empty');
    const listed = new Set(items.map((item) => item.externalId));

    const isNew = (videoId: string) => !context.knownTypes.has(videoId);

    return {
      snapshot: {
        title: channel?.title ?? '',
        items,
        citations: citationsOf([channel, ...typed.map(([, result]) => feedOfResult(result))], channelId, isNew),
      },
      validators,
      droppedUpcoming: complete ? [...context.upcoming].filter((id) => !listed.has(id)) : [],
    };
  },
};

const FAILED: TypedFeedResult = { status: 'failed' };

function feedOfResult(result: TypedFeedResult): Feed | null {
  return result.status === 'ok' ? result.feed : null;
}

/**
 * The channels that the descriptions of these feeds' new entries link to, as seed candidates
 * (docs/FEATURES.md, D15), each with the newest entry citing it. Only new entries: the others were
 * read when they were new. Those whose newest citation is the oldest come first: their video
 * leaves the public feeds first, and only then may they be seeded.
 */
function citationsOf(feeds: readonly (Feed | null)[], channelId: string, isNew: (videoId: string) => boolean): Citation[] {
  const entries = new Map<string, FeedEntry>();

  for (const entry of feeds.flatMap((feed) => feed?.entries ?? [])) {
    if (!entries.has(entry.videoId) && isNew(entry.videoId)) {
      entries.set(entry.videoId, entry);
    }
  }

  const newest = new Map<string, Citation>();

  for (const entry of [...entries.values()].sort((a, b) => b.published - a.published)) {
    for (const input of channelMentions(entry.group, channelId, Infinity)) {
      const key = input.kind === 'channel' ? input.externalId : input.kind === 'handle' ? `@${input.handle.toLowerCase()}` : input.value;

      if (!newest.has(key)) {
        newest.set(key, { input, video: entry.videoId, published: entry.published });
      }
    }
  }

  return [...newest.values()].sort((a, b) => a.published - b.published).slice(0, MAX_MENTIONS);
}

interface ConditionalAnswer {
  status: number;
  body: string;
  validators: Validators;
}

/** A GET with the validators of the last answer. YouTube ignores them today; other platforms may not. */
async function conditionalGet(http: Http, url: string, previous: Validators | undefined): Promise<ConditionalAnswer> {
  const headers: Record<string, string> = {};

  if (previous?.etag) {
    headers['If-None-Match'] = previous.etag;
  }

  if (previous?.lastModified) {
    headers['If-Modified-Since'] = previous.lastModified;
  }

  const response = await http.get(url, { maxBytes: MAX_FEED_BYTES, headers });

  return {
    status: response.status,
    body: response.body,
    validators:
      response.status === 304 && previous !== undefined
        ? previous
        : { etag: response.headers.get('ETag'), lastModified: response.headers.get('Last-Modified') },
  };
}

function feedOf(body: string, channelId: string): Feed {
  let feed: Feed;

  try {
    feed = parseFeed(body);
  } catch (error) {
    throw error instanceof FeedFormatError ? new UpstreamError('invalid') : error;
  }

  if (feed.channelId !== channelId) {
    throw new UpstreamError('invalid');
  }

  return feed;
}

/**
 * Types every upload from the typed playlists, and keeps every entry of every feed once.
 *
 * A typed playlist that answers 404 is empty: YouTube has none for a kind the channel never
 * uploaded. When none of them could be read, they may be gone for good (their names are not
 * documented), and the channel feed alone types its entries: Shorts by their /shorts/ link,
 * the rest 'unknown'. The next pass that reads them reclassifies those.
 */
export function classify(channel: Feed, typed: Record<TypedFeed, TypedFeedResult>, now: number): IncomingItem[] {
  const items = new Map<string, IncomingItem>();
  const typeOf = new Map<string, ItemType>();

  for (const type of TYPE_PRIORITY) {
    const result = typed[type];

    if (result.status !== 'ok') {
      continue;
    }

    for (const entry of result.feed.entries) {
      if (!typeOf.has(entry.videoId)) {
        typeOf.set(entry.videoId, type);
        items.set(entry.videoId, toItem(entry, type, now));
      }
    }
  }

  for (const entry of channel.entries) {
    if (!items.has(entry.videoId)) {
      items.set(entry.videoId, toItem(entry, entry.isShortLink ? 'short' : 'unknown', now));
    }
  }

  return [...items.values()];
}

function toItem(entry: FeedEntry, type: ItemType, now: number): IncomingItem {
  const item: IncomingItem = {
    externalId: entry.videoId,
    title: entry.title,
    url: videoUrl(entry.videoId, type),
    thumbnailUrl: thumbnailUrl(entry.videoId),
    published: entry.published,
    type,
  };

  if (isUpcoming(entry, now)) {
    item.upcoming = true;
  }

  return item;
}

/**
 * The feeds give no start time, but a premiere or a live not aired yet has no views. Its
 * `published` is when it was scheduled, often days earlier.
 */
function isUpcoming(entry: FeedEntry, now: number): boolean {
  return entry.views === 0 && now - entry.published > UPCOMING_GRACE;
}

async function readChannelFeed(http: Http, channelId: string): Promise<Feed> {
  const response = await http.get(channelFeedUrl(channelId), { maxBytes: MAX_FEED_BYTES });

  if (response.status === 404) {
    throw new InputError('channel_not_found', 'No channel was found for this link.');
  }

  if (response.status !== 200) {
    throw new UpstreamError('status', response.status);
  }

  let feed: Feed;

  try {
    feed = parseFeed(response.body);
  } catch (error) {
    throw error instanceof FeedFormatError ? new UpstreamError('invalid') : error;
  }

  if (feed.channelId !== channelId) {
    throw new UpstreamError('invalid');
  }

  return feed;
}

/**
 * A typed playlist that answers 304 has nothing new: it lists nothing for this pass, which leaves
 * the new upload 'unknown' until the next pass reads it in full.
 */
async function readTypedFeed(
  http: Http,
  channelId: string,
  type: TypedFeed,
  previous?: Validators,
): Promise<{ result: TypedFeedResult; validators: Validators }> {
  const none = { etag: null, lastModified: null };

  try {
    const answer = await conditionalGet(http, typedFeedUrl(channelId, type), previous);

    if (answer.status === 304) {
      return { result: { status: 'unchanged' }, validators: answer.validators };
    }

    if (answer.status === 404) {
      return { result: { status: 'empty' }, validators: none };
    }

    if (answer.status !== 200) {
      return { result: { status: 'failed' }, validators: previous ?? none };
    }

    const feed = parseFeed(answer.body);

    return { result: feed.channelId === channelId ? { status: 'ok', feed } : { status: 'failed' }, validators: answer.validators };
  } catch (error) {
    if (error instanceof UpstreamError || error instanceof FeedFormatError) {
      return { result: { status: 'failed' }, validators: previous ?? none };
    }

    throw error;
  }
}

/**
 * The one page read the server allows itself: when a channel enters the catalog, for its id
 * (needed for a @handle), title and avatar. A failure is fatal only when the id is unknown.
 */
async function readChannelPage(http: Http, url: string, handle: string | null, knownId: string | null): Promise<ResolvedChannel> {
  const scanner = new ChannelPageScanner();

  try {
    const response = await http.get(url, {
      maxBytes: MAX_PAGE_BYTES,
      headers: { Cookie: CONSENT_COOKIE, 'Accept-Language': 'en' },
      until: (text) => scanner.scan(text),
    });

    if (response.status === 200) {
      scanner.scan(response.body);
    } else if (response.status === 404 && knownId === null) {
      throw new InputError('channel_not_found', HANDLE_NOT_FOUND);
    }
  } catch (error) {
    if (!(error instanceof UpstreamError) || knownId === null) {
      throw error instanceof UpstreamError ? new InputError('channel_not_found', HANDLE_NOT_FOUND) : error;
    }
  }

  const { channelId, title, iconUrl } = scanner.page;

  if (knownId !== null) {
    // The page may belong to another channel only if YouTube redirected: keep what the user gave.
    const samePage = channelId === knownId;

    return { kind: 'resolved', externalId: knownId, confirmed: samePage, title: samePage ? title : null, handle, iconUrl: samePage ? iconUrl : null };
  }

  if (channelId === null) {
    throw new InputError('channel_not_found', HANDLE_NOT_FOUND);
  }

  return { kind: 'resolved', externalId: channelId, confirmed: true, title, handle, iconUrl };
}

/** A link to a video: oEmbed names its channel by a link, which is parsed like user input. */
async function channelOfVideo(http: Http, videoId: string): Promise<ParsedInput> {
  const videoLink = `https://www.youtube.com/watch?v=${videoId}`;
  const notFound = new InputError('channel_not_found', 'Couldn’t find the channel of this video. Paste a link to the channel instead.');
  let response;

  try {
    response = await http.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoLink)}&format=json`, { maxBytes: MAX_OEMBED_BYTES });
  } catch (error) {
    throw error instanceof UpstreamError ? notFound : error;
  }

  if (response.status !== 200) {
    throw notFound;
  }

  let authorUrl: unknown;

  try {
    authorUrl = (JSON.parse(response.body) as { author_url?: unknown }).author_url;
  } catch {
    throw notFound;
  }

  if (typeof authorUrl !== 'string') {
    throw notFound;
  }

  try {
    const channel = parseYoutubeInput(authorUrl);

    if (channel?.kind === 'channel' || channel?.kind === 'handle') {
      return channel;
    }
  } catch {
    // An author link the parser refuses is handled like a missing one.
  }

  throw notFound;
}
