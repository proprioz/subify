import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { VIDEO_ID } from './ids';

export interface FeedEntry {
  videoId: string;
  title: string;
  /** The link YouTube gives: a /shorts/ link tells a Short apart in the channel feed. */
  isShortLink: boolean;
  published: number;
  /** The view count YouTube gives, null when it gives none. A premiere or live not aired yet has 0. */
  views: number | null;
  /** The entry's media:group as raw text, its description escaped in it: read only for new entries. */
  group: string;
}

export interface Feed {
  /** The channel the feed belongs to, always with its "UC" (playlist and channel feeds differ). */
  channelId: string;
  title: string;
  entries: FeedEntry[];
}

/** The answer is not a YouTube feed: an HTML error page, broken XML, another document. */
export class FeedFormatError extends Error {
  override readonly name = 'FeedFormatError';
}

const MAX_TITLE_LENGTH = 500;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Ids and titles stay strings: "1984" is a title, not a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Decodes numeric character references (&#8211;) as well as the XML ones.
  htmlEntities: true,
  isArray: (name) => name === 'entry' || name === 'link',
  // Each entry's media:group (full description, statistics) is left unparsed: it takes a third off
  // the CPU a feed costs, which counts with 10 ms per Workers Free invocation. Only the view count
  // is read from it, as text (see readViews).
  stopNodes: ['feed.entry.media:group'],
});

/**
 * Parses a channel feed or an uploads playlist feed. YouTube sometimes answers 200 with an HTML
 * page: anything that is not well-formed Atom with a channel id throws FeedFormatError, so the
 * caller keeps what it already has. Entries with a missing or malformed field are skipped.
 */
export function parseFeed(body: string): Feed {
  const text = body.replace(/^﻿/, '').trimStart();

  if (!(text.startsWith('<?xml') || text.startsWith('<feed')) || /<!DOCTYPE/i.test(text)) {
    throw new FeedFormatError('Not an Atom feed');
  }

  if (XMLValidator.validate(text) !== true) {
    throw new FeedFormatError('Malformed XML');
  }

  const feed = (parser.parse(text) as { feed?: Record<string, unknown> }).feed;

  if (feed === undefined || typeof feed !== 'object') {
    throw new FeedFormatError('No feed element');
  }

  const channelId = normalizeChannelId(feed['yt:channelId']);

  if (channelId === null) {
    throw new FeedFormatError('No channel id');
  }

  const entries = Array.isArray(feed.entry) ? feed.entry : [];

  return {
    channelId,
    title: clean(textOf(feed.title)) ?? '',
    entries: entries.map(readEntry).filter((entry) => entry !== null),
  };
}

function readEntry(raw: unknown): FeedEntry | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }

  const entry = raw as Record<string, unknown>;
  const videoId = textOf(entry['yt:videoId']);
  const title = clean(textOf(entry.title));
  const published = Date.parse(textOf(entry.published) ?? '');

  if (videoId === null || !VIDEO_ID.test(videoId) || title === null || Number.isNaN(published)) {
    return null;
  }

  const links = Array.isArray(entry.link) ? (entry.link as Record<string, unknown>[]) : [];
  const href = links.find((link) => link.rel === 'alternate')?.href;

  return {
    videoId,
    title,
    isShortLink: typeof href === 'string' && href.startsWith('https://www.youtube.com/shorts/'),
    published,
    views: readViews(entry['media:group']),
    group: typeof entry['media:group'] === 'string' ? entry['media:group'] : '',
  };
}

/**
 * The view count in the entry's raw media:group. The description is escaped XML in there, so a
 * tag can only be the real one.
 */
function readViews(group: unknown): number | null {
  const match = typeof group === 'string' ? /<media:statistics views="(\d+)"/.exec(group) : null;

  return match?.[1] === undefined ? null : Number(match[1]);
}

/** The channel feed writes the id without "UC", playlist feeds with it. */
function normalizeChannelId(value: unknown): string | null {
  const id = textOf(value);

  if (id === null) {
    return null;
  }

  const withPrefix = id.startsWith('UC') && id.length === 24 ? id : `UC${id}`;

  return /^UC[0-9A-Za-z_-]{22}$/.test(withPrefix) ? withPrefix : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)['#text'] === 'string') {
    return (value as Record<string, string>)['#text'] ?? null;
  }

  return null;
}

function clean(value: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();

  return text === undefined || text === '' ? null : text.slice(0, MAX_TITLE_LENGTH);
}
