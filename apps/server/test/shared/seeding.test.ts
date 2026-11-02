import { createHarness, type Harness } from '#harness';
import { describe, expect, it } from 'vitest';
import { runPass } from '../../src/catalog/pass';
import { addSeededChannel } from '../../src/catalog/seeding';
import { countHours, emptyHours, hourShare, SEED_DELAY_DAYS } from '../../src/catalog/seed-pool';
import { openUpdates, type Update } from '../../src/catalog/updates';
import { readPool, readState, stateWrite } from '../../src/catalog/vault';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import type { Config } from '../../src/config';
import type { ServerKeys } from '../../src/crypto/keys';
import { Http } from '../../src/http';
import { youtube } from '../../src/sources/youtube/adapter';
import { channelMentions } from '../../src/sources/youtube/mentions';
import { KURZGESAGT } from '../fixtures';
import { START } from '../harness/types';
import { FakeFetch, withRecordedChannels } from '../support/fake-fetch';
import { FakeSource, item } from '../support/fake-source';

async function setup(config: Partial<Config> = {}): Promise<{ harness: Harness; source: FakeSource }> {
  const source = new FakeSource();
  ['a', 'b', 'c', 'z'].forEach((id) => source.channel(id, [item(`${id}1`, START - HOUR)]));
  // On, as an instance turns it on (SEEDED_CHANNELS_PER_DAY).
  const harness = await createHarness({ sources: [source], config: { seededChannelsPerDay: 24, ...config } });
  // Every draw takes its first choice: seeding is due, at an hour users add at, and the first
  // candidate goes.
  harness.platform.random = () => 0;

  return { harness, source };
}

const OPTIONS = { firstTableSize: 8, poolRows: 2 };

interface Ripe {
  harness: Harness;
  source: FakeSource;
  keys: ServerKeys;
  /** What the user's addition of 'fake:a' left in the coordinator. */
  userUpdates: Update[];
  queued(): Promise<Update[]>;
}

/**
 * A user added 'fake:a' at noon, whose new video links to 'fake:b'; the pass harvested 'b', and
 * the clock is now past the delay a candidate waits, at noon: seeding may draw 'b'.
 */
async function ripe(config: Partial<Config> = {}): Promise<Ripe> {
  const { harness, source } = await setup(config);
  const keys = await harness.platform.keys;
  const queued = async () => (await openUpdates(keys, await harness.platform.coordinator.pending(100))).opened.map(({ update }) => update);
  await runPass(harness.platform, keys, undefined, OPTIONS);
  source.mentions.set('a', [{ kind: 'channel', externalId: 'b' }]);
  await harness.add('fake:a');
  const userUpdates = await queued();
  source.mentions.clear();
  harness.setNow(START + 10 * MINUTE);
  await runPass(harness.platform, keys, await readState(harness.db, keys), OPTIONS, [source]);
  harness.setNow(START + SEED_DELAY_DAYS * DAY + 20 * MINUTE);

  return { harness, source, keys, userUpdates, queued };
}

/** An update's fields and the types of their values, down to the channel's: what would tell two apart without reading them. */
function shape(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) {
    return value === null ? null : value instanceof Uint8Array ? 'bytes' : typeof value;
  }

  return Array.isArray(value) ? value.map(shape) : Object.fromEntries(Object.entries(value).map(([key, field]) => [key, shape(field)]));
}

// Seeding only protects users if nothing can tell a seeded channel from one a user added
// (docs/FEATURES.md, D15): with the encrypted catalog, what a seeded addition leaves for the pass.
describe('seeded channels', () => {
  it('leave the same kind of update as a user’s channel, only without the hour users add at', async () => {
    const { harness, source, userUpdates, queued } = await ripe();
    const kinds = (updates: readonly Update[]) => updates.map((update) => update.kind).sort();
    const before = await queued();
    // As 'a' had when its user added it: one video of the last hour.
    source.channel('b', [item('b1', harness.platform.clock.now() - HOUR)]);

    expect(await addSeededChannel(harness.platform, [source])).toBe(true);
    const after = await queued();
    const seeded = after.find((update) => update.kind === 'channel' && update.channel.externalId === 'b');
    const user = userUpdates.find((update) => update.kind === 'channel');

    expect(kinds(userUpdates)).toEqual(['added', 'channel']);
    expect(kinds(after)).toEqual(kinds([...before, seeded!]));
    expect(shape({ ...seeded, mentions: [] })).toEqual(shape({ ...user, mentions: [] }));
  });

  // A seeded channel costs reads and polling like any channel: the shared budgets must hold it back too.
  it('count against the budgets users’ channels do', async () => {
    const { harness, source, queued } = await ripe({ newChannelsPerDay: 1 });
    await harness.add('fake:z');
    const before = (await queued()).length;

    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await queued()).toHaveLength(before);
  });

  // Channels never leave the catalog: unchecked, seeding would fill the room polling has for users.
  it('stop at half the catalog’s capacity, as the last pass counted its channels', async () => {
    // One channel per run: 360 channels at most, seeded ones up to 180.
    const { harness, source, keys } = await ripe({ pollBatchSize: 1 });
    const state = (await readState(harness.db, keys))!;

    await harness.db.run(await stateWrite(keys, { ...state, channels: 180 }, false));
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);

    await harness.db.run(await stateWrite(keys, { ...state, channels: 179 }, false));
    expect(await addSeededChannel(harness.platform, [source])).toBe(true);
  });

  it('are never added when turned off', async () => {
    const { harness, source, queued } = await ripe({ seededChannelsPerDay: 0 });
    const before = (await queued()).length;

    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await queued()).toHaveLength(before);
  });
});

// With the encrypted catalog, seeding must not rely on what it can't keep: a date of entry per channel, a readable list of candidates, a write outside the pass.
describe('seeding from the encrypted pool', () => {
  it('draws from the pool the pass harvests, once ripe, cited once first, at the hours users add at, and forgets what it used', async () => {
    const { harness, source } = await setup();
    const keys = await harness.platform.keys;
    const pass = async () => {
      await runPass(harness.platform, keys, await readState(harness.db, keys), { firstTableSize: 8, poolRows: 2 }, [source]);
    };
    const pool = async () => (await readPool(harness.db, keys)).map((candidate) => `${candidate.input}×${candidate.cites}`).sort();
    await pass();
    source.mentions.set('a', [{ kind: 'channel', externalId: 'b' }, { kind: 'channel', externalId: 'nobody' }, { kind: 'channel', externalId: 'c' }]);
    source.mentions.set('z', [{ kind: 'channel', externalId: 'b' }]);
    // Two users' additions at noon UTC (START): seeding then adds at noon only.
    await harness.add('fake:a');
    await harness.add('fake:z');
    // YouTube names links from new videos only: later reads of these channels cite nothing more.
    source.mentions.clear();
    harness.setNow(START + 10 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2', 'channel:c×1', 'channel:nobody×1']);

    // Not ripe yet: the citing videos may still be in their channels' public feeds. Then not at
    // an hour users add at. Nothing is drawn: a draw would leave an update for the pass.
    const waiting = async () => (await harness.platform.coordinator.pending(100)).length;
    const queued = await waiting();
    harness.setNow(START + 20 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    const ripe = START + SEED_DELAY_DAYS * DAY;
    harness.setNow(ripe + 6 * HOUR);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await waiting()).toBe(queued);

    // Cited once first: 'nobody' leads to no channel, and is forgotten at the next pass.
    harness.setNow(ripe + 20 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    harness.setNow(ripe + 30 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2', 'channel:c×1']);

    const before = (await harness.platform.coordinator.pending(10)).length;
    harness.setNow(ripe + 40 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(true);
    // Only the channel waits for the pass: a seeded addition doesn't count in users' hours.
    expect(await harness.platform.coordinator.pending(10)).toHaveLength(before + 1);

    harness.setNow(ripe + 50 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2']);
  });

  // Seeded channels must follow users' current habits: hours counted for good would keep last year's.
  it('follow the hours of users’ additions, halved once a week', () => {
    const day = 20_000;
    const noon = day * DAY + 12 * HOUR;
    let hours = countHours(emptyHours(day), [noon, noon, noon, noon], day);
    expect(hourShare(emptyHours(day), noon)).toBe(1 / 24);
    expect(hourShare(hours, noon)).toBe(1);

    // A week later: the old ones count for half, every week once.
    hours = countHours(hours, [noon + 7 * DAY + 6 * HOUR], day + 7);
    hours = countHours(hours, [], day + 8);
    expect(hours.counts[12]).toBe(2);
    expect(hourShare(hours, noon + 6 * HOUR)).toBe(1 / 3);
  });
});

// A wrong link read from a description would add the channel itself, or spend a page read on nothing.
describe('links to channels in YouTube descriptions', () => {
  it('finds the channel a real description links to', async () => {
    const fake = withRecordedChannels(new FakeFetch());
    const snapshot = await youtube.fetchLatest(KURZGESAGT, new Http(fake.fetch, 'test', youtube.hosts), START);

    expect(snapshot.mentions).toEqual([{ kind: 'handle', handle: 'nightshift_kurzgesagt' }]);
  });

  it('keeps links to other channels only, each once, up to the limit', () => {
    const other = `UC${'x'.repeat(22)}`;
    const text = [
      'Our second channel: https://www.youtube.com/@Second.',
      'Also youtube.com/@second and https://m.youtube.com/channel/' + other,
      'Not ours: https://notyoutube.com/@fake https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      `Ourselves: https://www.youtube.com/channel/${KURZGESAGT}`,
      'Old: https://youtube.com/c/OldName',
    ].join('\n');

    expect(channelMentions(text, KURZGESAGT, 5)).toEqual([
      { kind: 'handle', handle: 'Second' },
      { kind: 'channel', externalId: other },
      { kind: 'other', value: 'c:OldName' },
    ]);
    expect(channelMentions(text, KURZGESAGT, 1)).toEqual([{ kind: 'handle', handle: 'Second' }]);
  });
});
