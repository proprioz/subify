import type { ItemType } from '@subify/shared';

export const CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;
export const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;

/**
 * YouTube keeps an automatic playlist per kind of upload, named by a prefix plus the channel id
 * without its "UC". These prefixes are not documented: when they stop working, the channel feed
 * alone still brings every upload, typed 'unknown'.
 */
export const TYPE_PLAYLIST_PREFIXES = {
  video: 'UULF',
  short: 'UUSH',
  live: 'UULV',
} as const satisfies Partial<Record<ItemType, string>>;

export type TypedFeed = keyof typeof TYPE_PLAYLIST_PREFIXES;

export function typedPlaylistId(channelId: string, type: TypedFeed): string {
  return TYPE_PLAYLIST_PREFIXES[type] + channelId.slice(2);
}

/** The topic YouTube's hub publishes a channel's uploads under. */
export function websubTopic(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

/** The channel a hub topic names: only a topic exactly as {@link websubTopic} writes it. */
export function channelOfTopic(topic: string): string | null {
  const prefix = websubTopic('');
  const channelId = topic.startsWith(prefix) ? topic.slice(prefix.length) : '';

  return CHANNEL_ID.test(channelId) ? channelId : null;
}

export function channelFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

export function typedFeedUrl(channelId: string, type: TypedFeed): string {
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=${typedPlaylistId(channelId, type)}`;
}

export function videoUrl(videoId: string, type: ItemType): string {
  return type === 'short' ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
}

export const THUMBNAIL_HOST = 'i.ytimg.com';

export function thumbnailUrl(videoId: string): string {
  return `https://${THUMBNAIL_HOST}/vi/${videoId}/mqdefault.jpg`;
}

/**
 * 320×180, about 10 KB: the thumbnail the encrypted catalog keeps in its ring (D16). Not
 * `default.jpg`, 120×90 with black bars, which the app had to blow up about five times.
 */
export function smallThumbnailUrl(videoId: string): string {
  return `https://${THUMBNAIL_HOST}/vi/${videoId}/mqdefault.jpg`;
}

/**
 * The avatar at `size` pixels. The page gives it at 900 px; the size sits after the last "=",
 * as in "…=s900-c-k-c0x00ffffff-no-rj". A URL in another form is read as it is, within the
 * avatar size limit.
 */
export function avatarUrl(iconUrl: string, size: number): string {
  return iconUrl.replace(/=s\d+((?:-[^=/]*)?)$/, (_, rest: string) => `=s${size}${rest}`);
}
