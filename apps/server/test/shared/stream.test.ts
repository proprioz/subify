import { createHarness, type Harness } from '#harness';
import type { StreamResponse } from '@subify/shared';
import { fromBase64Url, openEntries, type SlotChannel, STREAM_ENTRY_SIZE, type StreamDelta } from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, groupOf } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { HOUR, MINUTE } from '../../src/catalog/schedule';
import { deltasOf } from '../../src/catalog/stream';
import { enqueueUpdate } from '../../src/catalog/updates';
import { readState, stateWrite } from '../../src/catalog/vault';
import type { ServerKeys } from '../../src/crypto/keys';
import { item as slotItem, channel as slotChannel } from '../fixtures/payloads/golden';
import { START } from '../harness/types';
import { FakeSource, item } from '../support/fake-source';

interface Setup {
  harness: Harness;
  keys: ServerKeys;
  source: FakeSource;
  pass(at: number): Promise<void>;
}

async function setup(perGroup = 4): Promise<Setup> {
  const source = new FakeSource();
  const harness = await createHarness({ sources: [source] });
  const keys = await harness.platform.keys;
  const options: PassOptions = { firstTableSize: 8, ring: { perPass: 2, cases: 6 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup } };
  await runPass(harness.platform, keys, undefined, options);

  return {
    harness,
    keys,
    source,
    pass: async (at) => {
      harness.setNow(at);
      await runPass(harness.platform, keys, await readState(harness.db, keys), options, [source]);
    },
  };
}

/** A channel entering at the next pass, polled at `pollAt`. */
async function add(s: Setup, externalId: string, pollAt: number): Promise<void> {
  const base = slotChannel([]);
  const channel: SlotChannel = {
    ...base,
    source: 'fake',
    externalId,
    // As the platform names it: a poll then changes nothing about the channel itself.
    title: `Channel ${externalId}`,
    avatar: null,
    items: [],
    schedule: { ...base.schedule, nextPollAt: pollAt, websubStatus: 'off', websubExpiresAt: null, websubRequestedAt: null, websubSecret: null, callbackToken: null },
  };
  s.source.channel(externalId);
  await enqueueUpdate(s.harness.platform.coordinator, s.keys, { kind: 'channel', channel });
}

/** What a device following these channels learns from the stream since `since`. */
async function follow(s: Setup, externalIds: readonly string[], since: number): Promise<{ answer: StreamResponse; deltas: Record<string, StreamDelta[]> }> {
  const secrets = await Promise.all(externalIds.map(async (id) => channelSecrets(evaluate(s.keys.voprf, channelInput('fake', id)))));
  const first = (await (await s.harness.request(`/api/stream?since=${since}&group=0`)).json()) as StreamResponse;
  const deltas: Record<string, StreamDelta[]> = {};

  for (const [i, id] of externalIds.entries()) {
    const group = groupOf(secrets[i]!.slotId, first.groups);
    const answer = (await (await s.harness.request(`/api/stream?since=${since}&group=${group}`)).json()) as StreamResponse;

    for (const batch of answer.batches) {
      deltas[id] = [...(deltas[id] ?? []), ...(await openEntries(secrets[i]!.transitKey, batch.pass, fromBase64Url(batch.entries)))];
    }
  }

  return { answer: first, deltas };
}

// Devices learn new videos from the stream alone: if what they open differs from what the pass applied, followed channels would miss videos or show wrong ones.
describe('the sync stream', () => {
  it('carries a channel’s changes to a device that knows its key, and nothing to one that doesn’t', async () => {
    const s = await setup();
    await add(s, 'a', START + 20 * MINUTE);
    await s.pass(START + 10 * MINUTE);
    const since = (await readState(s.harness.db, s.keys))!.passes;

    s.source.publish('a', item('a1', START + 15 * MINUTE));
    await s.pass(START + 20 * MINUTE);
    const { answer, deltas } = await follow(s, ['a', 'b'], since);

    expect(answer).toMatchObject({ v: 4, latest: since + 1, groups: 2, expired: false, more: false });
    expect(deltas.a).toEqual([{ kind: 'item', id: 'a1', title: 'Video a1', published: START + 15 * MINUTE, type: 'video', deleted: false, upcoming: false }]);
    expect(deltas.b).toEqual([]);
  });

  // A batch that grew with the changes, or kept its real entries in front, would tell an observer when channels publish.
  it('publishes batches of the same size whatever changed, with tags that differ from pass to pass', async () => {
    const s = await setup();
    await add(s, 'a', START + 20 * MINUTE);
    await s.pass(START + 10 * MINUTE);
    const since = (await readState(s.harness.db, s.keys))!.passes;
    s.source.publish('a', item('a1', START + 15 * MINUTE), item('a2', START + 15 * MINUTE));
    await s.pass(START + 20 * MINUTE);
    await s.pass(START + 30 * MINUTE);

    const blobs = await s.harness.db.all<{ blob: Uint8Array }>('SELECT blob FROM stream');
    expect(new Set(blobs.map((row) => row.blob.length)).size).toBe(1);
    const answers = await Promise.all([0, 1].map(async (group) => (await (await s.harness.request(`/api/stream?since=${since}&group=${group}`)).json()) as StreamResponse));
    const sizes = answers.flatMap((answer) => answer.batches.map((batch) => fromBase64Url(batch.entries).length));
    expect(new Set(sizes)).toEqual(new Set([4 * STREAM_ENTRY_SIZE]));

    const tags = (entries: string) => {
      const bytes = fromBase64Url(entries);

      return Array.from({ length: bytes.length / STREAM_ENTRY_SIZE }, (_, i) => [...bytes.subarray(i * STREAM_ENTRY_SIZE, i * STREAM_ENTRY_SIZE + 16)].join());
    };
    const [changed, quiet] = answers.map((answer) => answer.batches.map((batch) => new Set(tags(batch.entries))));
    expect([...changed![0]!, ...quiet![0]!].filter((tag) => changed![1]!.has(tag) || quiet![1]!.has(tag))).toEqual([]);
  });

  it('keeps the changes a batch has no room for, and sends them first, in order, at the next pass', async () => {
    const s = await setup(1);
    await add(s, 'a', START + 20 * MINUTE);
    await s.pass(START + 10 * MINUTE);
    const since = (await readState(s.harness.db, s.keys))!.passes;
    s.source.publish('a', item('a1', START + HOUR / 4), item('a2', START + HOUR / 4 + MINUTE), item('a3', START + HOUR / 4 + 2 * MINUTE));

    for (const at of [20, 30, 40]) {
      await s.pass(START + at * MINUTE);
    }

    const { deltas } = await follow(s, ['a'], since);
    expect(deltas.a?.map((delta) => (delta.kind === 'item' ? delta.id : delta.kind))).toEqual(['a1', 'a2', 'a3']);
  });

  // A device away for longer than the ring keeps must know it, or it would believe nothing changed.
  it('tells a device too far behind that it expired, and refuses a group that doesn’t exist', async () => {
    const s = await setup();
    await s.pass(START + 10 * MINUTE);
    const state = (await readState(s.harness.db, s.keys))!;

    expect((await s.harness.request(`/api/stream?since=0&group=2`)).status).toBe(404);
    expect((await s.harness.request(`/api/stream?since=0&group=x`)).status).toBe(400);

    await s.harness.db.run(await stateWrite(s.keys, { ...state, passes: state.passes + 30 * 144 }, false));
    await s.pass(START + 20 * MINUTE);
    const answer = (await (await s.harness.request(`/api/stream?since=${state.passes}&group=0`)).json()) as StreamResponse;
    expect(answer).toMatchObject({ expired: true, batches: [] });

    // Last: on workerd, a new harness starts the shared database over.
    expect((await (await createHarness()).request('/api/stream?since=0&group=0')).status).toBe(404);
  });

  // The app must mark a channel the platform no longer has as gone, and learn a renamed one.
  it('turns a removal and a rename into deltas', () => {
    const before = { ...slotChannel([]), title: 'Old', handle: 'old' };

    expect(deltasOf(before, null)).toEqual([{ kind: 'gone' }]);
    expect(deltasOf(before, { ...before, title: 'New' })).toEqual([{ kind: 'channel', title: 'New', handle: 'old' }]);
    expect(deltasOf(before, before)).toEqual([]);
  });

  // A device shows when a channel it has no videos of is read again: it must learn each new time, and that it is over.
  it('turns the retry time of a channel without items into deltas', () => {
    const failing = { ...slotChannel([]), schedule: { ...slotChannel([]).schedule, consecutiveFailures: 2, nextPollAt: START + HOUR } };
    const read = { ...failing, items: [slotItem(1, 'Video')], schedule: { ...failing.schedule, consecutiveFailures: 0, nextPollAt: START + 12 * HOUR } };

    expect(deltasOf(slotChannel([]), failing)).toEqual([{ kind: 'retry', retryAt: START + HOUR }]);
    expect(deltasOf(failing, { ...failing, schedule: { ...failing.schedule, consecutiveFailures: 3, nextPollAt: START + 2 * HOUR } })).toEqual([{ kind: 'retry', retryAt: START + 2 * HOUR }]);
    expect(deltasOf(failing, read)).toEqual([{ kind: 'retry', retryAt: null }, expect.objectContaining({ kind: 'item', id: slotItem(1, 'Video').id })]);
    // A channel with items keeps showing them: its failures say nothing to devices.
    expect(deltasOf(read, { ...read, schedule: { ...read.schedule, consecutiveFailures: 1, nextPollAt: START + HOUR } })).toEqual([]);
  });
});
