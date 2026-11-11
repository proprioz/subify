import { createHarness, type Harness } from '#harness';
import { describe, expect, it } from 'vitest';
import { runPass } from '../../src/catalog/pass';
import { addSeededChannel } from '../../src/catalog/seeding';
import { countHours, drawCandidate, emptyHours, harvest, hourShare, SEED_DELAY_DAYS } from '../../src/catalog/seed-pool';
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

async function setup(config: Partial<Config> = {}, name = 'fake'): Promise<{ harness: Harness; source: FakeSource }> {
  const source = new FakeSource(name);
  ['a', 'b', 'c', 'z'].forEach((id) => source.channel(id, [item(`${id}1`, START - HOUR)]));
  // On, as an instance turns it on (SEEDED_CHANNELS_PER_DAY).
  const harness = await createHarness({ sources: [source], config: { seededChannelsPerDay: 24, ...config } });
  // Every draw takes its first choice: seeding is due, at an hour users add at, and the first
  // candidate goes.
  harness.platform.random = () => 0;

  return { harness, source };
}

const OPTIONS = { firstTableSize: 8, poolRows: 2 };
const CITED_AT = START - 20 * DAY;

/**
 * Makes channel `id` cite `cited` in its oldest video, followed by `newer` videos and 5 Shorts:
 * the Shorts don't push a video out of its typed playlist.
 */
function citing(source: FakeSource, id: string, cited: readonly string[], newer: number): void {
  const videos = Array.from({ length: newer }, (_, i) => item(`${id}v${i}`, CITED_AT + (i + 1) * HOUR));
  const shorts = Array.from({ length: 5 }, (_, i) => item(`${id}s${i}`, CITED_AT + (i + 1) * HOUR, 'short'));
  source.channel(id, [item(`${id}1`, CITED_AT), ...videos, ...shorts]);
  source.citations.set(
    id,
    cited.map((externalId) => ({ input: { kind: 'channel', externalId }, video: `${id}1`, published: CITED_AT })),
  );
}

interface Ripe {
  harness: Harness;
  source: FakeSource;
  keys: ServerKeys;
  /** What the user's addition of 'fake:a' left in the coordinator. */
  userUpdates: Update[];
  queued(): Promise<Update[]>;
}

/**
 * A user added 'fake:a' at noon, whose oldest video links to 'fake:b', followed by `newer` videos
 * of its type; the pass harvested 'b', the next one read 'a' again, and the clock is still in the
 * hour users add at: with 15 newer, the citing video has left the public feeds, and seeding may draw 'b'.
 */
async function ripe(config: Partial<Config> = {}, newer = 15, name = 'fake'): Promise<Ripe> {
  const { harness, source } = await setup(config, name);
  const keys = await harness.platform.keys;
  const queued = async () => (await openUpdates(keys, await harness.platform.coordinator.pending(100))).opened.map(({ update }) => update);
  const pass = async () => {
    await runPass(harness.platform, keys, await readState(harness.db, keys), OPTIONS, [source]);
  };
  await runPass(harness.platform, keys, undefined, OPTIONS);
  citing(source, 'a', ['b'], newer);
  await harness.add('fake:a');
  const userUpdates = await queued();
  source.citations.clear();
  harness.setNow(START + 10 * MINUTE);
  await pass();
  harness.setNow(START + 20 * MINUTE);
  await pass();
  harness.setNow(START + 30 * MINUTE);

  return { harness, source, keys, userUpdates, queued };
}

/** A dictionary whose every slice holds these channels alone, as the server stores it. */
async function fillDictionary(harness: Harness, ids: readonly string[]): Promise<void> {
  const text = ids.map((id) => `${id}\t\tChannel ${id}\t5\n`).join('');
  const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

  for (let slice = 0; slice < 64; slice++) {
    await harness.db.run('INSERT INTO dictionary (slice, data) VALUES (?, ?)', [slice, gz]);
  }
}

const entering = (updates: readonly Update[]) => updates.flatMap((update) => (update.kind === 'channel' ? [update.channel.externalId] : []));

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
    // As 'a' had when its user added it, without its link.
    citing(source, 'b', [], 15);

    expect(await addSeededChannel(harness.platform, [source])).toBe(true);
    const after = await queued();
    const seeded = after.find((update) => update.kind === 'channel' && update.channel.externalId === 'b');
    const user = userUpdates.find((update) => update.kind === 'channel');

    expect(kinds(userUpdates)).toEqual(['added', 'channel']);
    expect(kinds(after)).toEqual(kinds([...before, seeded!]));
    expect(shape({ ...seeded, citations: [] })).toEqual(shape({ ...user, citations: [] }));
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
  // Drawn while the citing video is still in its channel's feeds, a seeded channel would point to it, and users' channels would stand out as uncited.
  it('wait until the video citing them has left its channel’s public feeds: 15 newer of its type', async () => {
    for (const [newer, drawn] of [
      [14, false],
      [15, true],
    ] as const) {
      const { harness, source } = await ripe({}, newer);
      source.channel('b', [item('b1', harness.platform.clock.now() - HOUR)]);

      expect(await addSeededChannel(harness.platform, [source])).toBe(drawn);
    }
  });

  it('draws from the pool the pass harvests, once ripe, cited once first, at the hours users add at, and forgets what it used', async () => {
    const { harness, source } = await setup();
    const keys = await harness.platform.keys;
    const pass = async () => {
      await runPass(harness.platform, keys, await readState(harness.db, keys), { firstTableSize: 8, poolRows: 2 }, [source]);
    };
    const pool = async () => (await readPool(harness.db, keys)).map((candidate) => `${candidate.input}×${candidate.cites}`).sort();
    await pass();
    citing(source, 'a', ['b', 'nobody', 'c'], 15);
    citing(source, 'z', ['b'], 15);
    // Two users' additions at noon UTC (START): seeding then adds at noon only.
    await harness.add('fake:a');
    await harness.add('fake:z');
    // YouTube names links from new videos only: later reads of these channels cite nothing more.
    source.citations.clear();
    harness.setNow(START + 10 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2', 'channel:c×1', 'channel:nobody×1']);

    // Not ripe yet: no pass has read the citing channels since. Then ripe, but not at an hour
    // users add at. Nothing is drawn: a draw would leave an update for the pass.
    const waiting = async () => (await harness.platform.coordinator.pending(100)).length;
    let queued = await waiting();
    harness.setNow(START + 15 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await waiting()).toBe(queued);
    harness.setNow(START + 20 * MINUTE);
    await pass();
    queued = await waiting();
    harness.setNow(START + 6 * HOUR);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await waiting()).toBe(queued);

    // Cited once first: 'nobody' leads to no channel, and is forgotten at the next pass.
    const noon = START + DAY;
    harness.setNow(noon + 10 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    harness.setNow(noon + 20 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2', 'channel:c×1']);

    const before = (await harness.platform.coordinator.pending(10)).length;
    harness.setNow(noon + 30 * MINUTE);
    expect(await addSeededChannel(harness.platform, [source])).toBe(true);
    // Only the channel waits for the pass: a seeded addition doesn't count in users' hours.
    expect(await harness.platform.coordinator.pending(10)).toHaveLength(before + 1);

    harness.setNow(noon + 40 * MINUTE);
    await pass();
    expect(await pool()).toEqual(['channel:b×2']);
  });

  // Seeded channels all cited would leave users' uncited channels standing out, and a new catalog would wait weeks for its first.
  it('come from the dictionary a quarter of the time, and every time no cited channel is ripe', async () => {
    for (const [newer, draws, expected] of [
      // Ripe 'b': cited when the share's draw falls in the first three quarters, the dictionary's 'd' otherwise.
      [15, [0, 0, 0.7], 'b'],
      [15, [0, 0, 0.8], 'd'],
      // 'b' not ripe yet: the dictionary, whatever the draw.
      [14, [0, 0, 0], 'd'],
    ] as const) {
      const { harness, source, queued } = await ripe({}, newer, 'youtube');
      citing(source, 'b', [], 15);
      citing(source, 'd', [], 15);
      await fillDictionary(harness, ['d']);
      const sequence: number[] = [...draws];
      harness.platform.random = () => sequence.shift() ?? 0;
      const before = entering(await queued());

      expect(await addSeededChannel(harness.platform, [source])).toBe(true);
      expect(entering(await queued()).filter((id) => !before.includes(id))).toEqual([expected]);
    }
  });

  it('draw nothing from the dictionary when there is none, nor from a dictionary channel the catalog has', async () => {
    const { harness, source, queued } = await ripe({}, 14, 'youtube');
    const before = (await queued()).length;

    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    await fillDictionary(harness, ['a']);
    expect(await addSeededChannel(harness.platform, [source])).toBe(false);
    expect(await queued()).toHaveLength(before);
  });

  // A candidate that kept its first citation would ripen while a newer video citing it is still in the feeds.
  it('follow the newest citation, and keep the day rule for candidates from before citing videos were kept', () => {
    const ripeOne = { source: 'fake', input: 'channel:b', cites: 1, day: 100, citer: 'a', video: 'a1', cited: 90, ripe: true };
    const mention = (citer: string, video: string, cited: number) => ({ source: 'fake', input: { kind: 'channel' as const, externalId: 'b' }, citer, video, cited });

    expect(harvest([ripeOne], [mention('z', 'z1', 95)], [], 101)).toEqual([{ ...ripeOne, cites: 2, citer: 'z', video: 'z1', cited: 95, ripe: false }]);
    expect(harvest([ripeOne], [mention('z', 'z0', 80)], [], 101)).toEqual([{ ...ripeOne, cites: 2 }]);

    const older = { ...ripeOne, citer: '', video: '', cited: 0, ripe: false };
    expect(drawCandidate([older], older.day + SEED_DELAY_DAYS - 1, () => 0)).toBeUndefined();
    expect(drawCandidate([older], older.day + SEED_DELAY_DAYS, () => 0)).toEqual(older);
    expect(harvest([older], [mention('z', 'z1', 80)], [], 101)).toEqual([{ ...older, cites: 2, citer: 'z', video: 'z1', cited: 80 }]);
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

    // Two of its videos link to it: the newest one is the one to wait for.
    expect(snapshot.citations).toEqual([{ input: { kind: 'handle', handle: 'nightshift_kurzgesagt' }, video: 'h3DCdWyb0cc', published: Date.parse('2026-03-30T14:00:12Z') }]);
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
