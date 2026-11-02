import type { InstanceResponse } from '@subify/shared';
import { describe, expect, it } from 'vitest';
import { createHarness } from '#harness';

describe('the instance', () => {
  // A self-hosted app must not pass for the official one on a home screen: its name is the admin's, and its icon blue.
  it('names the installed app after INSTANCE_NAME, with the blue icon off subify.tv', async () => {
    const harness = await createHarness({ config: { instanceName: 'Videos at home' } });

    const response = await harness.request('/api/manifest.webmanifest');
    const manifest = (await response.json()) as { name: string; short_name: string; start_url: string; icons: { src: string }[] };
    const icon = await harness.request('/api/icons/apple-touch-icon.png', { redirect: 'manual' });

    expect(response.headers.get('Content-Type')).toBe('application/manifest+json');
    expect(manifest).toMatchObject({ name: 'Videos at home', short_name: 'Videos at home', start_url: '/feed' });
    expect(manifest.icons.map((i) => i.src)).toEqual(['/icons/blue/pwa-192.png', '/icons/blue/pwa-512.png', '/icons/blue/pwa-512.png']);
    expect(icon.status).toBe(302);
    expect(icon.headers.get('Location')).toBe('/icons/blue/apple-touch-icon.png');
  });

  // The official server is recognized by the host the request came to: there, and only there, the icon stays red.
  it('keeps the red icon for subify.tv only', async () => {
    const harness = await createHarness();

    const official = (await (await harness.request('https://subify.tv/api/manifest.webmanifest')).json()) as { icons: { src: string }[] };
    const lookalike = await harness.request('https://notsubify.tv/api/icons/favicon.svg', { redirect: 'manual' });
    const officialIcon = await harness.request('https://subify.tv/api/icons/favicon.svg', { redirect: 'manual' });

    expect(official.icons[0]!.src).toBe('/icons/red/pwa-192.png');
    expect(officialIcon.headers.get('Location')).toBe('/icons/red/favicon.svg');
    expect(lookalike.headers.get('Location')).toBe('/icons/blue/favicon.svg');
  });

  // The redirect builds a path from the request: only the five known files may lead anywhere.
  it('answers only the known icon files', async () => {
    const harness = await createHarness();

    expect((await harness.request('/api/icons/..%2F..%2Findex.html', { redirect: 'manual' })).status).toBe(404);
    expect((await harness.request('/api/icons/other.png', { redirect: 'manual' })).status).toBe(404);
  });

  // The Privacy page shows who to write to about one's data: the operator as the admin set it, or nothing invented.
  it('tells who runs the server, when its admin said so', async () => {
    const named = await createHarness({ config: { instanceName: 'Subify', operatorName: 'Subify', operatorContact: 'hello@subify.tv' } });
    const answer = (await (await named.request('/api/instance')).json()) as InstanceResponse;
    const unnamed = await createHarness({ config: { instanceName: 'Home' } });
    const silent = (await (await unnamed.request('/api/instance')).json()) as InstanceResponse;

    expect(answer).toEqual({ v: 3, name: 'Subify', operator: { name: 'Subify', contact: 'hello@subify.tv' }, messages: false });
    expect(silent).toEqual({ v: 3, name: 'Home', operator: null, messages: false });
  });
});
