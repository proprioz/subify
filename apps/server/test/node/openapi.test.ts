import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

// The PWA's types follow the server's code, so a change to a route's request or answer would go unnoticed: openapi.json makes it show in the diff, where it is decided whether `v` must change.
describe('the API contract', () => {
  it('matches openapi.json (run `pnpm --filter @subify/server exec vitest run --project node -u` after a deliberate change)', async () => {
    const document = createApp({ sources: [] }).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Subify API', version: '2' } });

    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../../openapi.json');
  });
});
