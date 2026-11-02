import { describe, expect, it } from 'vitest';
import { DEFAULT_TYPE_FILTER, loadFeed, toggleType } from '../src/data/feed';
import { ageLabel, periodLabel, shortAgeLabel } from '../src/data/format';
import { syncUpdates } from '../src/data/sync';
import { channel, FakeServer, freshDb, item, NOW, subscribe } from './fake-server';

const A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const query = { types: { video: true, short: true, live: true }, showUpcoming: true, showSecret: false, channel: null, search: '', limit: 50 };

// Arrival order differs from publication order (late WebSub, catch-ups): the feed must follow publication.
describe('feed order', () => {
  it('sorts by publication date, not by arrival', async () => {
    const server = new FakeServer().publish(channel(A), item(A, 'mid', 5));
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, A, NOW);
    server.publish(null, item(A, 'oldest-arrived-last', 30), item(A, 'newest', 0));
    await syncUpdates(db, api, NOW);

    const feed = await loadFeed(db, query);

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:newest', 'youtube:mid', 'youtube:oldest-arrived-last']);
  });
});

// Types drive what the user sees; a wrong rule hides uploads or shows a type the user turned off.
describe('feed filters', () => {
  async function followed() {
    const server = new FakeServer().publish(channel(A), item(A, 'v', 1), item(A, 's', 2, 'short'), item(A, 'l', 3, 'live'), item(A, 'u', 4, 'unknown'));
    const db = freshDb();
    await subscribe(db, server.api(), A, NOW);

    return db;
  }

  it('shows every type by default, uploads not typed yet included', async () => {
    const feed = await loadFeed(await followed(), { ...query, types: DEFAULT_TYPE_FILTER });

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:v', 'youtube:s', 'youtube:l', 'youtube:u']);
  });

  it('shows uploads not typed yet with videos', async () => {
    const feed = await loadFeed(await followed(), { ...query, types: { video: true, short: false, live: false } });

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:v', 'youtube:u']);
  });

  it('applies the channel’s own types on top of the feed filter', async () => {
    const db = await followed();
    await db.subscriptions.update(`youtube:${A}`, { types: ['short'] });

    const feed = await loadFeed(db, query);

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:s']);
  });

  it('never turns every type off', () => {
    const onlyVideos = { video: true, short: false, live: false };

    expect(toggleType(onlyVideos, 'video')).toEqual(onlyVideos);
  });
});

// Upcoming lives are scheduled days ahead: sorted by that date they would sink, and the user would miss them.
describe('upcoming items', () => {
  async function withUpcoming() {
    const server = new FakeServer().publish(channel(A), item(A, 'new', 0), item(A, 'old', 10), { ...item(A, 'soon', 20, 'live'), upcoming: true });
    const db = freshDb();
    const api = server.api();
    await subscribe(db, api, A, NOW);

    return { server, db, api };
  }

  it('come first, then the rest from the newest', async () => {
    const { db } = await withUpcoming();

    const feed = await loadFeed(db, query);

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:soon', 'youtube:new', 'youtube:old']);
  });

  it('are left out when the user hides them', async () => {
    const { db } = await withUpcoming();

    const feed = await loadFeed(db, { ...query, showUpcoming: false });

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:new', 'youtube:old']);
  });

  it('still follow the type filters', async () => {
    const { db } = await withUpcoming();

    const feed = await loadFeed(db, { ...query, types: { video: true, short: true, live: false } });

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:new', 'youtube:old']);
  });

  // The server sends the aired item without the flag: a stale copy would keep it on top for good.
  it('join the timeline once the server says they aired', async () => {
    const { server, db, api } = await withUpcoming();
    server.publish(null, { ...item(A, 'soon', 0, 'live'), published: NOW + 1 });
    await syncUpdates(db, api, NOW);

    const feed = await loadFeed(db, query);

    expect(feed.entries.map((entry) => entry.item.key)).toEqual(['youtube:soon', 'youtube:new', 'youtube:old']);
    expect(feed.entries[0]!.item.upcoming).toBeUndefined();
  });
});

// Section headings must not shift a day around midnight, or videos land under the wrong heading.
describe('date labels', () => {
  const now = new Date(2026, 9, 20, 0, 30).getTime();

  it.each([
    [new Date(2026, 9, 20, 0, 5), 'Today', 'today', 'today'],
    [new Date(2026, 9, 19, 23, 50), 'Yesterday', '1 day ago', '1d'],
    [new Date(2026, 9, 14, 12), 'This week', '6 days ago', '6d'],
    [new Date(2026, 9, 2, 12), 'Earlier this month', '2 weeks ago', '2w'],
    [new Date(2026, 6, 4, 12), 'July', '3 months ago', '3mo'],
    [new Date(2025, 2, 1, 12), 'March 2025', '1 year ago', '1y'],
  ])('labels %s', (date, period, age, shortAge) => {
    expect(periodLabel(date.getTime(), now)).toBe(period);
    expect(ageLabel(date.getTime(), now)).toBe(age);
    expect(shortAgeLabel(date.getTime(), now)).toBe(shortAge);
  });
});
