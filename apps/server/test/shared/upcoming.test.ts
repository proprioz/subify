import type { SlotItem } from '@subify/shared/codec';
import { describe, expect, it } from 'vitest';
import { mergeItems } from '../../src/catalog/slot-items';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import { Http } from '../../src/http';
import type { PollContext } from '../../src/sources/source';
import { youtube } from '../../src/sources/youtube/adapter';
import { fixtures, NASA } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels, youtubeUrls } from '../support/fake-fetch';
import { aired, newEntry, UPCOMING_LIVE, withEntry } from '../support/feed-entries';
import { item } from '../support/fake-source';

function http(fake: FakeFetch): Http {
  return new Http(fake.fetch, 'test', youtube.hosts);
}

/** NASA as its slot holds it once added at START, and the fake that answers for it. */
async function nasa(): Promise<{ fake: FakeFetch; slot: SlotItem[] }> {
  const fake = withRecordedChannels(new FakeFetch());

  return { fake, slot: mergeItems([], { incoming: (await youtube.fetchLatest(NASA, http(fake), START)).items }, 0, START) };
}

/** What a poll at `now` gives, as the pass does it, merged into the slot. */
async function pollLater(fake: FakeFetch, slot: SlotItem[], now: number): Promise<SlotItem[]> {
  const context: PollContext = {
    validators: new Map(),
    knownTypes: new Map(slot.map((kept) => [kept.id, kept.type])),
    upcoming: new Set(slot.filter((kept) => kept.upcoming).map((kept) => kept.id)),
    force: false,
    now,
  };
  fake.calls.length = 0;
  const result = await youtube.poll(NASA, http(fake), context);

  return mergeItems(slot, { incoming: result.snapshot?.items ?? [], dropped: result.droppedUpcoming ?? [] }, 0, now);
}

const live = (slot: SlotItem[]) => slot.find((kept) => kept.id === UPCOMING_LIVE);

// The feeds give no start time: a live not aired yet is told apart by its 0 views, and the app shows it apart.
describe('an upcoming video', () => {
  it('is marked upcoming when the channel is added, and only that one', async () => {
    const { slot } = await nasa();

    expect(slot.filter((kept) => kept.upcoming).map((kept) => kept.id)).toEqual([UPCOMING_LIVE]);
  });

  // Upcoming lives are listed in the lives playlist only: reading the channel feed alone would never see one air.
  it('keeps the typed playlists read while it is upcoming', async () => {
    const { fake, slot } = await nasa();

    const later = await pollLater(fake, slot, START + HOUR);

    expect(fake.urls).toContain(youtubeUrls.lives(NASA));
    expect(live(later)).toMatchObject({ upcoming: true });
  });

  // Its feed date is the day it was scheduled: keeping it would bury a live that just aired weeks deep in the feed.
  it('takes the time it was seen aired as its publication', async () => {
    const { fake, slot } = await nasa();
    fake.on(youtubeUrls.lives(NASA), { body: aired(fixtures.nasaLives) });

    const later = await pollLater(fake, slot, START + 3 * DAY);

    expect(live(later)).toMatchObject({ published: START + 3 * DAY, upcoming: false });
  });

  // A cancelled live, or one pushed out of the 15 latest, would otherwise sit on top of every feed for six months.
  it('stops being upcoming once no feed lists it, and keeps its date', async () => {
    const { fake, slot } = await nasa();
    fake.on(youtubeUrls.lives(NASA), { body: fixtures.nasaLives.replace(/<entry>(?:(?!<entry>)[\s\S])*pAKqJxuxDgk[\s\S]*?<\/entry>/, '') });

    const later = await pollLater(fake, slot, START + HOUR);

    expect(live(later)).toMatchObject({ published: live(slot)!.published, upcoming: false });
  });

  // YouTube's feeds have outages: a playlist that failed to answer says nothing about what it lists.
  it('stays upcoming when a playlist could not be read', async () => {
    const { fake, slot } = await nasa();
    fake.on(youtubeUrls.lives(NASA), { status: 500, body: '' });

    expect(live(await pollLater(fake, slot, START + HOUR))).toMatchObject({ upcoming: true });
  });
});

// Every upload has 0 views for a moment: a regular video must not show as upcoming, nor jump in the feed later.
describe('a regular upload with no views', () => {
  it('is not upcoming while it is fresh', async () => {
    const { fake, slot } = await nasa();
    const entry = newEntry('FreshVideo1', 'Just published', START + HOUR - 5 * MINUTE, 0);
    fake.on(youtubeUrls.channel(NASA), { body: withEntry(fixtures.nasaChannel, entry) }).on(youtubeUrls.videos(NASA), { body: withEntry(fixtures.nasaVideos, entry) });

    const later = await pollLater(fake, slot, START + HOUR);

    expect(later.find((kept) => kept.id === 'FreshVideo1')).toMatchObject({ published: START + HOUR - 5 * MINUTE, upcoming: false });
  });

  it('never turns upcoming once the catalog has it', () => {
    const slot = mergeItems([], { incoming: [item('v', START - DAY)] }, 0, START);

    expect(mergeItems(slot, { incoming: [{ ...item('v', START - DAY), upcoming: true }] }, 0, START + HOUR)).toMatchObject([{ id: 'v', published: START - DAY, upcoming: false }]);
  });
});
