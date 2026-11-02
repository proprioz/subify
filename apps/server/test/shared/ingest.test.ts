import type { ItemType } from '@subify/shared';
import type { SlotItem } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { mergeItems } from '../../src/catalog/slot-items';
import { Http, UpstreamError } from '../../src/http';
import type { IncomingItem, PollContext } from '../../src/sources/source';
import { youtube } from '../../src/sources/youtube/adapter';
import { parseFeed } from '../../src/sources/youtube/feed';
import { fixtures, KURZGESAGT, NASA } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';

function idsOf(body: string): string[] {
  return parseFeed(body).entries.map((entry) => entry.videoId);
}

function typesOf(items: readonly { externalId?: string; id?: string; type: ItemType }[]): Map<string, ItemType> {
  return new Map(items.map((item) => [item.externalId ?? item.id!, item.type]));
}

function http(fake: FakeFetch): Http {
  return new Http(fake.fetch, 'test', youtube.hosts);
}

/** The items as a slot keeps them once a channel entered with these. */
function entered(items: readonly IncomingItem[]): SlotItem[] {
  return mergeItems([], { incoming: items }, 0, START);
}

/** What the pass tells the adapter about a slot's items. */
function contextOf(items: readonly SlotItem[]): PollContext {
  return { validators: new Map(), knownTypes: typesOf(items), upcoming: new Set(items.filter((item) => item.upcoming).map((item) => item.id)), force: false, now: START };
}

// Types drive the feed filters in the app: every recorded upload must land in the right one.
describe('classifying uploads', () => {
  it('types each upload from its playlist', async () => {
    const snapshot = await youtube.fetchLatest(NASA, http(withRecordedChannels(new FakeFetch())), START);
    const types = typesOf(snapshot.items);

    expect(types.size).toBe(45);
    idsOf(fixtures.nasaVideos).forEach((id) => expect(types.get(id)).toBe('video'));
    idsOf(fixtures.nasaShorts).forEach((id) => expect(types.get(id)).toBe('short'));
    idsOf(fixtures.nasaLives).forEach((id) => expect(types.get(id)).toBe('live'));
  });

  // A video listed in the channel feed and in its playlist must show once in the feed, not twice.
  it('keeps a video found in several feeds once', async () => {
    const snapshot = await youtube.fetchLatest(NASA, http(withRecordedChannels(new FakeFetch())), START);
    const inBoth = idsOf(fixtures.nasaChannel).filter((id) => idsOf(fixtures.nasaLives).includes(id));

    expect(inBoth.length).toBeGreaterThan(0);
    expect(snapshot.items).toHaveLength(45);
    expect(new Set(snapshot.items.map((item) => item.externalId)).size).toBe(45);
  });

  it('reads a playlist that answers 404 as empty', async () => {
    const types = [...typesOf((await youtube.fetchLatest(KURZGESAGT, http(withRecordedChannels(new FakeFetch())), START)).items).values()];

    expect(types.filter((type) => type === 'video')).toHaveLength(15);
    expect(types.filter((type) => type === 'short')).toHaveLength(15);
    expect(types).not.toContain('unknown');
  });

  // The typed playlists are undocumented: if YouTube drops them, no upload may be lost, and their return fixes the types.
  it('falls back to the channel feed when no playlist answers, then reclassifies at the next poll', async () => {
    const fake = new FakeFetch();
    const playlistsDown = { status: 500, body: 'Internal error' };
    withRecordedChannels(fake)
      .on(youtubeUrls.videos(KURZGESAGT), playlistsDown)
      .on(youtubeUrls.shorts(KURZGESAGT), playlistsDown)
      .on(youtubeUrls.lives(KURZGESAGT), playlistsDown);
    const slot = entered((await youtube.fetchLatest(KURZGESAGT, http(fake), START)).items);
    const fallback = slot.map((item) => item.type);

    expect(fallback).toHaveLength(15);
    expect(fallback.filter((type) => type === 'short')).toHaveLength(10);
    expect(fallback.filter((type) => type === 'unknown')).toHaveLength(5);

    withRecordedChannels(fake);
    const result = await youtube.poll(KURZGESAGT, http(fake), contextOf(slot));
    const types = typesOf(mergeItems(slot, { incoming: result.snapshot!.items }, 0, START));

    expect([...types.values()]).not.toContain('unknown');
    idsOf(fixtures.kurzgesagtVideos).forEach((id) => expect(types.get(id)).toBe('video'));
  });

  // An item already typed must not fall back to 'unknown' because one poll could not read the playlists.
  it('keeps known types when a later poll cannot read the playlists', async () => {
    const fake = withRecordedChannels(new FakeFetch());
    const slot = entered((await youtube.fetchLatest(KURZGESAGT, http(fake), START)).items);
    fake.on(youtubeUrls.videos(KURZGESAGT), { status: 503 }).on(youtubeUrls.shorts(KURZGESAGT), { status: 503 });

    const result = await youtube.poll(KURZGESAGT, http(fake), { ...contextOf(slot), force: true });

    expect(mergeItems(slot, { incoming: result.snapshot!.items }, 0, START)).toEqual(slot);
  });
});

// A bad answer from YouTube must never cost data: the poll fails, and the pass keeps what the slot had (encrypted-ingest.test.ts).
describe('bad answers to a poll', () => {
  it.each([
    ['an HTML page with status 200', { body: fixtures.channelFeed404 }],
    ['broken XML', { body: fixtures.nasaChannel.slice(0, 3_000) }],
    ['a server error', { status: 500, body: '' }],
  ])('fail it after %s', async (_, answer) => {
    const fake = withRecordedChannels(new FakeFetch());
    const slot = entered((await youtube.fetchLatest(NASA, http(fake), START)).items);
    fake.on(youtubeUrls.channel(NASA), answer);

    await expect(youtube.poll(NASA, http(fake), contextOf(slot))).rejects.toThrow(UpstreamError);
  });

  it('take nothing from empty feeds, and remove nothing', async () => {
    const fake = withRecordedChannels(new FakeFetch());
    const slot = entered((await youtube.fetchLatest(NASA, http(fake), START)).items);
    const empty = (body: string) => ({ body: body.replace(/<entry>[\s\S]*<\/entry>/, '') });
    fake
      .on(youtubeUrls.channel(NASA), empty(fixtures.nasaChannel))
      .on(youtubeUrls.videos(NASA), empty(fixtures.nasaVideos))
      .on(youtubeUrls.shorts(NASA), empty(fixtures.nasaShorts))
      .on(youtubeUrls.lives(NASA), empty(fixtures.nasaLives));

    const result = await youtube.poll(NASA, http(fake), contextOf(slot));

    expect(result.snapshot?.items).toEqual([]);
    const kept = mergeItems(slot, { incoming: result.snapshot!.items, dropped: result.droppedUpcoming ?? [] }, 0, START);
    expect(kept.map(({ id, title, published, type, deleted }) => ({ id, title, published, type, deleted }))).toEqual(slot.map(({ id, title, published, type, deleted }) => ({ id, title, published, type, deleted })));
  });
});
