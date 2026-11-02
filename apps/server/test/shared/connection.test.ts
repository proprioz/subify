import { describe, expect, it } from 'vitest';
import { createHarness } from '#harness';
import { FakeSource, item } from '../support/fake-source';

describe('GET /api/connection', () => {
  // The whole point of the check: the user sees the country the host places them in, to catch a VPN that is off.
  it('answers the country the host gives', async () => {
    const response = await (await createHarness({ country: 'CH' })).request('/api/connection');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ v: 2, country: 'CH' });
  });

  // A self-hosted Node server has no country, and Cloudflare says 'XX' (unknown) or 'T1' (Tor): the app must then say it can’t tell, not show a wrong place.
  it('answers null when the host gives no country it can name', async () => {
    for (const country of [undefined, 'XX', 'T1', '']) {
      const response = await (await createHarness(country === undefined ? {} : { country })).request('/api/connection');

      expect(await response.json()).toEqual({ v: 2, country: null });
    }
  });

  // Unknown parameters are refused everywhere, so a client can’t smuggle anything in.
  it('refuses parameters', async () => {
    const response = await (await createHarness({ country: 'CH' })).request('/api/connection?x=1');

    expect(response.status).toBe(400);
  });
});

// The owner’s promise: the server looks at where a request comes from for the connection check only, never otherwise, and keeps nothing of it.
describe('the connection country', () => {
  it('is read by the connection check alone, which writes nothing', async () => {
    const harness = await createHarness({ country: 'CH', sources: [new FakeSource().channel('a', [item('v1', Date.UTC(2026, 9, 1))])] });

    await harness.add('fake:a');
    await harness.request('/api/oprf');
    await harness.request('/api/stream?since=0&group=0');
    await harness.request('/api/snapshot?group=0&thumbnails=0');
    await harness.request('/api/health');
    await harness.request('/api/missing');
    expect(harness.countryReads()).toBe(0);

    const before = await harness.dump();
    await harness.request('/api/connection');

    expect(harness.countryReads()).toBe(1);
    expect(await harness.dump()).toBe(before);
  });
});
