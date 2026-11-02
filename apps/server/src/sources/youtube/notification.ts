import { XMLParser } from 'fast-xml-parser';
import type { WebSubNotification } from '../source';
import { CHANNEL_ID, VIDEO_ID } from './ids';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry' || name === 'at:deleted-entry',
});

/**
 * Reads what YouTube's hub pushes: an Atom feed with the added or updated uploads as entries,
 * and the deleted ones as `at:deleted-entry`. Its format follows YouTube's documentation (a
 * real notification cannot be recorded without a public callback).
 */
export function parseNotification(body: string): WebSubNotification | null {
  if (/<!DOCTYPE/i.test(body)) {
    return null;
  }

  let feed: Record<string, unknown> | undefined;

  try {
    feed = (parser.parse(body) as { feed?: Record<string, unknown> }).feed;
  } catch {
    return null;
  }

  if (feed === undefined || typeof feed !== 'object') {
    return null;
  }

  const channels = new Set<string>();
  const videoIds: string[] = [];
  const deletedIds: string[] = [];

  for (const entry of asList(feed.entry)) {
    const videoId = entry['yt:videoId'];
    const channelId = entry['yt:channelId'];

    if (typeof videoId === 'string' && VIDEO_ID.test(videoId) && typeof channelId === 'string' && CHANNEL_ID.test(channelId)) {
      videoIds.push(videoId);
      channels.add(channelId);
    }
  }

  for (const deleted of asList(feed['at:deleted-entry'])) {
    const videoId = typeof deleted.ref === 'string' ? deleted.ref.replace(/^yt:video:/, '') : '';
    const author = (deleted['at:by'] as Record<string, unknown> | undefined)?.uri;
    const channelId = typeof author === 'string' ? /\/channel\/(UC[0-9A-Za-z_-]{22})$/.exec(author)?.[1] : undefined;

    if (VIDEO_ID.test(videoId) && channelId !== undefined) {
      deletedIds.push(videoId);
      channels.add(channelId);
    }
  }

  // A notification is about one channel, the one its topic names.
  const [channelId, ...others] = [...channels];

  return channelId === undefined || others.length > 0 ? null : { externalId: channelId, videoIds, deletedIds };
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object') : [];
}
