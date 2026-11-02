import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { createHarness } from '#harness';
import { runPass } from '../../src/catalog/pass';
import worker from '../../src/entry/worker';
import { START } from '../harness/types';

// The Worker entry is what Cloudflare runs: this catches a broken `main` or a routing rule that stops sending /api to it.
it('routes /api requests through the Worker entry point', async () => {
  const response = await exports.default.fetch('http://localhost/api/health');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ v: 2, ok: true, commit: null });
});

// The connection check depends on the Worker entry handing Cloudflare's country to the app: without it, every user would read “can’t tell”.
it('answers the connection check with the country Cloudflare gives the request', async () => {
  const ctx = createExecutionContext();
  const request = new Request('http://localhost/api/connection', { cf: { country: 'CH' } });
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);

  expect(await response.json()).toEqual({ v: 2, country: 'CH' });
});

// The Cron Trigger calls this handler every minute: it must run the shared schedule, the pass included, without throwing.
it('runs the scheduled tasks from the Cron Trigger handler', async () => {
  // A small catalog laid out beforehand: a first pass would lay out the real 2,500 slots, far too slow
  // for a test. The Worker reads the real clock, so whether the pass is due depends on the minute.
  const harness = await createHarness();
  await runPass(harness.platform, await harness.platform.keys, undefined, { firstTableSize: 8 });
  const ctx = createExecutionContext();

  worker.scheduled(createScheduledController({ scheduledTime: START, cron: '* * * * *' }), env, ctx);

  await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
});

// A Worker deployed without its instance's name must not serve an app that passes for another server.
it('refuses to serve without INSTANCE_NAME', async () => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost/api/health') as Request<unknown, IncomingRequestCfProperties>, { ...env, INSTANCE_NAME: '' }, ctx);
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(503);
  expect(await response.text()).toContain('INSTANCE_NAME');
});

// Without its secret, the Worker would write a catalog it could never read back: it must refuse to serve.
it('refuses to serve without MASTER_SECRET', async () => {
  const ctx = createExecutionContext();
  const { MASTER_SECRET: _, ...withoutSecret } = env;
  const response = await worker.fetch(new Request('http://localhost/api/health') as Request<unknown, IncomingRequestCfProperties>, withoutSecret, ctx);
  await waitOnExecutionContext(ctx);

  expect(response.status).toBe(503);
  expect(await response.text()).toContain('MASTER_SECRET');
});
