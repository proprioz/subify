import { describe, expect, it } from 'vitest';
import { FeedFormatError, parseFeed } from '../../src/sources/youtube/feed';
import { fixtures, KURZGESAGT, NASA } from '../fixtures';

// YouTube changes its feed format now and then: parsing the recorded feeds catches it at once.
describe('parsing recorded feeds', () => {
  it.each([
    ['channel feed', fixtures.nasaChannel, NASA],
    ['videos playlist', fixtures.nasaVideos, NASA],
    ['Shorts playlist', fixtures.nasaShorts, NASA],
    ['lives playlist', fixtures.nasaLives, NASA],
    ['channel feed of another channel', fixtures.kurzgesagtChannel, KURZGESAGT],
  ])('reads the %s', (_, body, channelId) => {
    const feed = parseFeed(body);

    expect(feed.channelId).toBe(channelId);
    expect(feed.title).not.toBe('');
    expect(feed.entries).toHaveLength(15);

    for (const entry of feed.entries) {
      expect(entry.videoId).toMatch(/^[0-9A-Za-z_-]{11}$/);
      expect(entry.title).not.toBe('');
      expect(entry.published).toBeGreaterThan(Date.UTC(2005, 0, 1));
    }
  });

  it('tells Shorts apart by their link in the channel feed', () => {
    const shorts = parseFeed(fixtures.kurzgesagtChannel).entries.filter((entry) => entry.isShortLink);

    expect(shorts).toHaveLength(10);
  });

  it('decodes entities in titles', () => {
    const feed = parseFeed(fixtures.nasaChannel.replace(/<title>[^<]*<\/title>/, '<title>Q&amp;A &lt;live&gt; &#8211; 1984</title>'));

    expect(feed.title).toBe('Q&A <live> – 1984');
  });
});

// YouTube sometimes answers 200 with an error page: the server must neither crash nor treat it as an empty channel.
describe('answers that are not a feed', () => {
  it.each([
    ['an HTML error page', fixtures.channelFeed404],
    ['truncated XML', fixtures.nasaChannel.slice(0, 5_000)],
    ['an empty body', ''],
    ['XML that is not a feed', '<?xml version="1.0"?><rss><channel></channel></rss>'],
    ['a document with a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "x">]><feed></feed>'],
  ])('refuses %s', (_, body) => {
    expect(() => parseFeed(body)).toThrow(FeedFormatError);
  });

  it('reads a feed without entries as an empty list', () => {
    const empty = fixtures.nasaChannel.replace(/<entry>[\s\S]*<\/entry>/, '');

    expect(parseFeed(empty).entries).toEqual([]);
  });
});
