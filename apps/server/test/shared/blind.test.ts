import { createHarness, type Harness } from '#harness';
import type { ApiError, EvaluateResponse, OprfKeyResponse } from '@subify/shared';
import { fromBase64Url, toBase64Url } from '@subify/shared/codec';
import { blind, channelInput, channelSecrets, finalize } from '@subify/shared/oprf';
import { describe, expect, it } from 'vitest';
import { MINUTE } from '../../src/catalog/schedule';
import { slotIdOf } from '../../src/catalog/slot-id';
import { hex } from '../../src/catalog/tend';
import type { Config } from '../../src/config';
import { START } from '../harness/types';

function evaluate(harness: Harness, blinded: readonly Uint8Array[] | readonly string[]): Promise<Response> {
  return harness.request('/api/oprf/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blinded: blinded.map((element) => (typeof element === 'string' ? element : toBase64Url(element))) }),
  });
}

/** A device's batch: its channels, padded with random inputs to `size`. */
function batch(channels: readonly string[], size = 10) {
  const random = Array.from({ length: size - channels.length }, () => crypto.getRandomValues(new Uint8Array(32)));

  return blind([...channels.map((externalId) => channelInput('fake', externalId)), ...random]);
}

async function setup(config: Partial<Config> = {}): Promise<Harness> {
  return createHarness({ config: { ...config } });
}

// A device finds a channel's slot without naming it: if the blind route and the pass disagreed on O, every lookup would miss.
describe('blind evaluation', () => {
  it('gives a device the slot the pass uses for a channel, proved under the published key', async () => {
    const harness = await setup();
    const key = (await (await harness.request('/api/oprf')).json()) as OprfKeyResponse;
    const request = batch(['a', 'b']);
    const answer = (await (await evaluate(harness, request.blinded)).json()) as EvaluateResponse;
    const outputs = finalize(request, { evaluated: answer.evaluated.map(fromBase64Url), proof: fromBase64Url(answer.proof) }, fromBase64Url(key.publicKey));
    const keys = await harness.platform.keys;

    expect(answer.v).toBe(3);
    expect(hex((await channelSecrets(outputs[0]!)).slotId)).toBe(hex(await slotIdOf(keys, 'fake', 'a')));
    expect(hex((await channelSecrets(outputs[1]!)).slotId)).toBe(hex(await slotIdOf(keys, 'fake', 'b')));
  });

  // The answer's size must say nothing about the channels asked for: only the batch size the device chose.
  it('answers every batch of a size with the same number of bytes', async () => {
    const harness = await setup();
    const sizes = await Promise.all([batch(['a']), batch(['b', 'c', 'd']), batch([])].map(async (request) => (await (await evaluate(harness, request.blinded)).text()).length));

    expect(new Set(sizes).size).toBe(1);
  });

  // A batch of any size would tell how many channels a device follows; a malformed element must not crash the route.
  it('refuses other batch sizes and elements that aren’t blinded elements', async () => {
    const harness = await setup();
    const status = async (response: Promise<Response>) => (await response).status;

    expect(await status(evaluate(harness, batch(['a'], 10).blinded.slice(0, 9)))).toBe(400);
    expect(await status(evaluate(harness, Array.from({ length: 10 }, () => toBase64Url(new Uint8Array(32).fill(0xff)))))).toBe(400);
    expect(await status(evaluate(harness, batch([], 50).blinded))).toBe(200);
  });

  // Each batch is a membership test of up to 50 channels: without a limit shared by all, anyone could probe the catalog against long lists.
  it('answers only so many batches a minute, all devices together', async () => {
    const harness = await setup({ blindBatchesPerMinute: 2 });

    expect((await evaluate(harness, batch([]).blinded)).status).toBe(200);
    expect((await evaluate(harness, batch([]).blinded)).status).toBe(200);
    const refused = await evaluate(harness, batch([]).blinded);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as ApiError).error).toBe('busy');
    expect(refused.headers.get('Retry-After')).toBe('60');

    harness.setNow(START + MINUTE);
    expect((await evaluate(harness, batch([]).blinded)).status).toBe(200);
  });
});
