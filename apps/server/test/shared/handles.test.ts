import { createHarness, type Harness } from '#harness';
import type { EvaluateResponse, HandleBoundsResponse, HandleChunkResponse, OprfKeyResponse } from '@subify/shared';
import { chunkOf, fromBase64Url, HANDLE_CHUNK_ENTRIES, HANDLE_ENTRY_SIZE, type SlotChannel, toBase64Url, openHandleEntry } from '@subify/shared/codec';
import { blind, channelSecrets, finalize, handleInput } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { type PassOptions, runPass } from '../../src/catalog/pass';
import { MINUTE } from '../../src/catalog/schedule';
import { enqueueUpdate } from '../../src/catalog/updates';
import { readState } from '../../src/catalog/vault';
import type { ServerKeys } from '../../src/crypto/keys';
import { channel as slotChannel } from '../fixtures/payloads/golden';
import { START } from '../harness/types';
import { FakeSource } from '../support/fake-source';

const OPTIONS: PassOptions = { firstTableSize: 8, ring: { perPass: 2, cases: 6 }, poolRows: 2, stream: { groups: 2, k: 2, perGroup: 4 } };

async function setup(): Promise<{ harness: Harness; keys: ServerKeys; pass(minutes: number): Promise<void> }> {
  const source = new FakeSource();
  const harness = await createHarness({ sources: [source] });
  const keys = await harness.platform.keys;
  await runPass(harness.platform, keys, undefined, OPTIONS);

  return {
    harness,
    keys,
    pass: async (minutes) => {
      harness.setNow(START + minutes * MINUTE);
      await runPass(harness.platform, keys, await readState(harness.db, keys), OPTIONS, [source]);
    },
  };
}

async function add(harness: Harness, keys: ServerKeys, externalId: string, handle: string): Promise<void> {
  const base = slotChannel([]);
  const channel: SlotChannel = { ...base, source: 'fake', externalId, handle, title: `Channel ${externalId}`, avatar: null, items: [], schedule: { ...base.schedule, nextPollAt: START + 30 * 24 * 60 * MINUTE } };
  await enqueueUpdate(harness.platform.coordinator, keys, { kind: 'channel', channel });
}

/** What a device does to find a channel by its @handle: blind evaluation, then one chunk of the index. */
async function find(harness: Harness, handle: string): Promise<{ target: unknown; chunkBytes: number }> {
  const key = (await (await harness.request('/api/oprf')).json()) as OprfKeyResponse;
  const request = blind([handleInput('fake', handle), ...Array.from({ length: 9 }, () => crypto.getRandomValues(new Uint8Array(32)))]);
  const response = await harness.request('/api/oprf/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blinded: request.blinded.map(toBase64Url) }) });
  const answer = (await response.json()) as EvaluateResponse;
  const [output] = finalize(request, { evaluated: answer.evaluated.map(fromBase64Url), proof: fromBase64Url(answer.proof) }, fromBase64Url(key.publicKey));
  const secrets = await channelSecrets(output!);
  const bounds = (await (await harness.request('/api/handles')).json()) as HandleBoundsResponse;
  const chunk = (await (await harness.request(`/api/handles/${chunkOf(bounds.chunks.map(fromBase64Url), secrets.slotId)}`)).json()) as HandleChunkResponse;
  const bytes = fromBase64Url(chunk.entries);

  return { target: await openHandleEntry(secrets.slotId, secrets.transitKey, bytes), chunkBytes: bytes.length };
}

// Adding by @handle must find a channel the catalog has without naming it: an index the device can't read, or that names the handle, would send every such addition the clear way.
describe('the handle index', () => {
  it('leads a device from a handle to its channel, ignoring case, and to nothing for a handle the catalog lacks', async () => {
    const s = await setup();
    await add(s.harness, s.keys, 'a', 'ChannelA');
    await s.pass(10);

    expect(await find(s.harness, 'channela')).toEqual({ target: { source: 'fake', externalId: 'a' }, chunkBytes: HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE });
    expect((await find(s.harness, 'nobody')).target).toBeNull();
  });

  // Rebuilt at every pass, its write would tell when someone added a channel; with its size following the handles, how many there are.
  it('is rebuilt once an hour only, always at the same size', async () => {
    const s = await setup();
    await s.pass(10);
    const blobs = async () => (await s.harness.db.all<{ blob: Uint8Array }>('SELECT blob FROM handles')).map((row) => [...row.blob.subarray(0, 32)].join());
    const first = await blobs();

    await add(s.harness, s.keys, 'b', 'later');
    await s.pass(20);
    expect(await blobs()).toEqual(first);
    expect((await find(s.harness, 'later')).target).toBeNull();

    for (let minutes = 30; minutes <= 60; minutes += 10) {
      await s.pass(minutes);
    }

    expect(await blobs()).not.toEqual(first);
    expect((await find(s.harness, 'later')).target).toEqual({ source: 'fake', externalId: 'b' });
  });

  // A device can only read what the pass built: before the first rebuild the server must say so, not answer an empty index.
  it('is absent until the pass first builds it', async () => {
    const fresh = await createHarness();

    expect((await fresh.request('/api/handles')).status).toBe(404);
    expect((await fresh.request('/api/handles/0')).status).toBe(404);
  });
});
