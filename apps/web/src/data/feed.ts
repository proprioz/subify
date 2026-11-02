import { ALL_TYPES, getMeta, type ShownType, shownType, type StoredItem, type StoredThumbnail, type Subscription, type SubifyDb } from './db';

export type TypeFilter = Record<ShownType, boolean>;

/** Every type shows until the user turns one off. */
export const DEFAULT_TYPE_FILTER: TypeFilter = { video: true, short: true, live: true };

/** Premieres and lives not aired yet show unless the user hides them. */
export const DEFAULT_SHOW_UPCOMING = true;

export interface FeedQuery {
  types: TypeFilter;
  /** Whether upcoming items show, above the others. */
  showUpcoming: boolean;
  /** Whether secret channels are shown right now. */
  showSecret: boolean;
  /** Only this channel, or every followed one. */
  channel: string | null;
  search: string;
  limit: number;
}

export interface FeedEntry {
  item: StoredItem;
  channel: Subscription;
  /** Kept on the device for recent videos (see thumbnails.ts). */
  thumbnail: StoredThumbnail | undefined;
}

export interface FeedPage {
  entries: FeedEntry[];
  hasMore: boolean;
}

/**
 * The feed: items of followed channels, newest publication first. It is sorted by `published`,
 * never by arrival: WebSub and catch-ups bring items out of order. An item shows when both the
 * feed filter and its channel's own setting allow its type.
 *
 * Upcoming items come first. With no start time to sort them by, they follow
 * the same order; their `published` is when they were scheduled.
 */
export async function loadFeed(db: SubifyDb, query: FeedQuery): Promise<FeedPage> {
  const channels = new Map((await db.subscriptions.toArray()).map((channel) => [channel.key, channel]));
  const search = query.search.trim().toLocaleLowerCase();

  const matches = (item: StoredItem): boolean => {
    const channel = channels.get(item.channel);
    const type = shownType(item.type);

    return (
      channel !== undefined &&
      (query.showSecret || !channel.secret) &&
      query.types[type] &&
      channel.types.includes(type) &&
      (query.channel === null || item.channel === query.channel) &&
      (search === '' || item.title.toLocaleLowerCase().includes(search) || channel.title.toLocaleLowerCase().includes(search))
    );
  };

  const upcoming = query.showUpcoming ? await db.items.where('upcoming').equals(1).filter(matches).toArray() : [];
  const others = await db.items
    .orderBy('published')
    .reverse()
    .filter((item) => item.upcoming === undefined && matches(item))
    .limit(query.limit + 1)
    .toArray();
  const items = [...upcoming.sort((a, b) => b.published - a.published), ...others];
  const shown = items.slice(0, query.limit);
  const thumbnails = await db.thumbnails.bulkGet(shown.map((item) => item.key));

  return {
    entries: shown.map((item, i) => ({ item, channel: channels.get(item.channel)!, thumbnail: thumbnails[i] })),
    hasMore: items.length > query.limit,
  };
}

export async function loadTypeFilter(db: SubifyDb): Promise<TypeFilter> {
  return { ...DEFAULT_TYPE_FILTER, ...(await getMeta<Partial<TypeFilter>>(db, 'typeFilter')) };
}

export async function loadShowUpcoming(db: SubifyDb): Promise<boolean> {
  return (await getMeta<boolean>(db, 'showUpcoming')) ?? DEFAULT_SHOW_UPCOMING;
}

/** At least one type stays on: an empty filter would only ever show an empty feed. */
export function toggleType(filter: TypeFilter, type: ShownType): TypeFilter {
  const next = { ...filter, [type]: !filter[type] };

  return ALL_TYPES.some((candidate) => next[candidate]) ? next : filter;
}

export type ChannelSort = 'recent' | 'oldest' | 'name' | 'name-desc';

export function sortChannels(channels: readonly Subscription[], sort: ChannelSort): Subscription[] {
  const byName = (a: Subscription, b: Subscription) => a.title.localeCompare(b.title);

  return [...channels].sort((a, b) => {
    switch (sort) {
      case 'name':
        return byName(a, b);
      case 'name-desc':
        return byName(b, a);
      case 'oldest':
        return a.addedAt - b.addedAt;
      case 'recent':
        return b.addedAt - a.addedAt;
    }
  });
}
