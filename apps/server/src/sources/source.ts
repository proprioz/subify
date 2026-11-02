import type { ItemType } from '@subify/shared';
import type { Http } from '../http';
import type { Image } from './image';

/**
 * What the catalog, the sync and the routes know about a video platform. Everything specific to
 * one platform (which links it accepts, which feeds to read, how to classify a video) lives in
 * its adapter, so another platform can be added without touching the rest.
 */
export interface SourceAdapter {
  /** Short name, the prefix of channel and item keys: 'youtube'. */
  readonly source: string;
  /** The only hosts the server may contact for this platform. */
  readonly hosts: ReadonlySet<string>;

  /**
   * Reads what a user pasted, without any request. Returns null when it is not a link to this
   * platform, and throws InputError when it is one that cannot be accepted.
   */
  parseInput(raw: string): ParsedInput | null;

  /**
   * When no platform reads the text as a link, it may be a channel's name: the handles such a
   * channel most likely has, most likely first. Empty when the text cannot be a name.
   */
  guessHandles?(name: string): string[];

  /**
   * Takes one step towards a channel: either the channel itself, or a narrower input the catalog
   * may already know (a link to a video gives its channel's handle, for example).
   */
  resolve(input: ParsedInput, http: Http): Promise<ParsedInput | ResolvedChannel>;

  /**
   * Reads a channel's avatar, small, from the `iconUrl` {@link resolve} gave. Null when there is
   * none. Throws UpstreamError when it failed.
   */
  readAvatar(iconUrl: string, http: Http): Promise<Image | null>;

  /** Reads an item's thumbnail from the `thumbnailUrl` its snapshot gave, as {@link readAvatar}. */
  readThumbnail(thumbnailUrl: string, http: Http): Promise<Image | null>;

  /** The smallest thumbnail of an item, derived from its id: what the encrypted catalog keeps (D16). */
  smallThumbnailUrl?(itemId: string): string;

  /**
   * The @handle of the channel that published this item, for a channel entering the catalog
   * without one. Null when it has none or the platform did not answer.
   */
  readHandle?(itemId: string, http: Http): Promise<string | null>;

  /** Reads the channel's latest items. Throws InputError when the channel does not exist. */
  fetchLatest(externalId: string, http: Http, now: number): Promise<ChannelSnapshot>;

  /**
   * One polling pass over a channel already in the catalog: as few requests as possible, and
   * conditional ones when the platform supports them. Throws UpstreamError when it failed.
   */
  poll(externalId: string, http: Http, context: PollContext): Promise<PollResult>;

  /**
   * Whether the channel still exists, from one read of its page: true or false when the platform
   * said so, null when it didn't answer. Asked only before removing a channel whose feed has said
   * "not found" for 30 days (docs/FEATURES.md, D16).
   */
  exists?(externalId: string, http: Http): Promise<boolean | null>;

  /**
   * The channel's name from one read of its feed, to check a search service's result before it is
   * shown: null when the platform has no such channel. Throws UpstreamError when it didn't answer.
   */
  verify?(externalId: string, http: Http): Promise<string | null>;

  /** Present when the platform pushes new uploads through a WebSub hub. */
  readonly websub?: WebSubSupport;
}

/** Validators a platform sent for one of its feeds, for the next conditional request. */
export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export interface PollContext {
  /** By feed name, as the adapter returned them last time. */
  validators: ReadonlyMap<string, Validators>;
  /** The channel's items the catalog already has, by id on the platform, with their type. */
  knownTypes: ReadonlyMap<string, ItemType>;
  /** The channel's items the catalog holds as upcoming, by id on the platform. */
  upcoming: ReadonlySet<string>;
  /** Read every feed, even when nothing looks new (a WebSub notification announced something). */
  force: boolean;
  now: number;
}

export interface PollResult {
  /** Null when nothing changed since the last pass (every feed answered 304). */
  snapshot: ChannelSnapshot | null;
  /** By feed name; a feed missing here keeps its previous validators. */
  validators: Map<string, Validators>;
  /**
   * Ids among {@link PollContext.upcoming} that the platform no longer lists anywhere: cancelled,
   * or pushed out of its feeds before it aired. They stop being upcoming, with no start time.
   */
  droppedUpcoming?: string[];
}

export interface WebSubSupport {
  /** The hub's subscribe URL, on a host the server may contact. */
  hub: string;
  /** The topic the hub knows the channel by. */
  topic(externalId: string): string;
  /** The channel a topic names, or null when it is not one of this platform's topics. */
  channelOfTopic(topic: string): string | null;
  /** Reads a notification body. Null when it is not one the server understands. */
  parseNotification(body: string): WebSubNotification | null;
}

export interface WebSubNotification {
  /** The channel the notification is about. */
  externalId: string;
  /** Uploads added or updated. */
  videoIds: string[];
  /** Uploads deleted. */
  deletedIds: string[];
}

export type ParsedInput =
  | { kind: 'channel'; externalId: string }
  | { kind: 'handle'; handle: string }
  /** Anything else the adapter understands, such as a link to a video. */
  | { kind: 'other'; value: string };

export interface ResolvedChannel {
  kind: 'resolved';
  externalId: string;
  /** The platform itself showed the channel exists (its page named it), whatever its feeds answer. */
  confirmed: boolean;
  title: string | null;
  handle: string | null;
  iconUrl: string | null;
}

export interface IncomingItem {
  externalId: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  published: number;
  type: ItemType;
  /** Announced but not aired yet: a premiere or a scheduled live. */
  upcoming?: boolean;
}

export interface ChannelSnapshot {
  title: string;
  items: IncomingItem[];
  /**
   * Other channels that the descriptions of new items link to, a few at most: the server may add
   * them as seeded channels (docs/FEATURES.md, D15).
   */
  mentions?: ParsedInput[];
}

export type InputErrorCode = 'invalid_link' | 'channel_not_found';

/** A problem with what the user submitted, with a sentence the app can show. */
export class InputError extends Error {
  override readonly name = 'InputError';

  constructor(
    readonly code: InputErrorCode,
    message: string,
  ) {
    super(message);
  }
}
