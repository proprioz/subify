// Runs on Node and in workerd alike: if the shared app stops working on one runtime, this fails there.
import { describe, expect, it } from 'vitest';
import { createHarness } from '#harness';
import { loadConfig } from '../../src/config';

describe('GET /api/health', () => {
  it('answers with the API version', async () => {
    const response = await (await createHarness()).request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ v: 2, ok: true, commit: null });
  });

  // Anyone can compare the commit subify.tv says it runs with the public repository; a value that isn't a commit id must not pass for one.
  it('reports the commit it was built from, and only a commit id', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const built = await (await createHarness({ config: { commit: sha } })).request('/api/health');

    expect(await built.json()).toMatchObject({ commit: sha });
    expect(loadConfig({ COMMIT: sha }).commit).toBe(sha);
    expect(loadConfig({ COMMIT: '<script>' }).commit).toBeNull();
  });

  // The PWA only calls the server that served it: another website must not use an instance from its visitors' browsers.
  it('lets no other origin call the API', async () => {
    const harness = await createHarness();
    const preflight = await harness.request('/api/add', {
      method: 'OPTIONS',
      headers: { Origin: 'https://other.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });

    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await harness.request('/api/health', { headers: { Origin: 'https://other.example' } })).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // Privacy: a shared cache (proxy, CDN) must never keep an answer meant for one client.
  it('marks the answer as private', async () => {
    const response = await (await createHarness()).request('/api/health');

    expect(response.headers.get('Cache-Control')).toBe('private');
  });
});
