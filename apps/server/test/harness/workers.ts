import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { D1Adapter } from '../../src/workers/d1';
import { buildHarness } from './common';
import type { Harness, HarnessOptions } from './types';

export type { Harness } from './types';

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  let ctx = createExecutionContext();

  return buildHarness(
    new D1Adapter(env.DB),
    options,
    async (app, request, bindings) => {
      const response = await app.fetch(request, bindings, ctx);
      await waitOnExecutionContext(ctx);
      ctx = createExecutionContext();

      return response;
    },
    (work) => ctx.waitUntil(work),
  );
}
