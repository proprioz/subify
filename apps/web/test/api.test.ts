import { describe, expect, it } from 'vitest';
import { Api, ServerError } from '../src/data/api';

function answering(status: number, body: unknown, onOutdated: () => void): Api {
  return new Api(async () => Response.json(body, { status }), undefined, onOutdated);
}

// Rate limiting in front of the server answers 429 with the host's own page: the app must say the
// server is busy rather than "something unexpected", and know how long it was asked to wait.
describe('a busy server', () => {
  it.each([
    ['429 with a delay in seconds', 429, '10', 10_000],
    ['503 with an HTTP date', 503, new Date(Date.now() + 3_600_000).toUTCString(), 3_600_000],
    ['429 without a delay', 429, null, undefined],
  ])('reads %s', async (_, status, header, expected) => {
    const api = new Api(async () => new Response('<html>Too many requests</html>', { status, headers: header === null ? {} : { 'Retry-After': header } }));

    const failure = (await api.stream(0, 0).catch((error: unknown) => error)) as ServerError;

    expect(failure).toMatchObject({ code: 'busy', message: 'The server is busy. Try again in a moment.' });

    if (expected === undefined) {
      expect(failure.retryAfter).toBeUndefined();
    } else {
      expect(failure.retryAfter).toBeGreaterThan(expected - 2_000);
      expect(failure.retryAfter).toBeLessThanOrEqual(expected);
    }
  });

  it('shows the server’s own reason when it refuses a new channel', async () => {
    const message = 'This server can’t take new channels any more. Channels it already knows can still be followed.';
    const api = new Api(async () => Response.json({ v: 2, error: 'catalog_full', message }, { status: 503, headers: { 'Retry-After': '86400' } }));

    const failure = (await api.add('@someone').catch((error: unknown) => error)) as ServerError;

    expect(failure).toMatchObject({ code: 'catalog_full', message, retryAfter: 86_400_000 });
  });
});

// A server deployed after the page loaded answers in a version the page does not know: the app must load the new version, not fail on every request.
describe('a server newer than the app', () => {
  it('asks for the new version on an answer', async () => {
    let outdated = 0;
    const failure = await answering(200, { v: 6, ok: true }, () => outdated++).health().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServerError);
    expect((failure as ServerError).code).toBe('outdated');
    expect(outdated).toBe(1);
  });

  it('asks for the new version on an error, which may come from a request the new server refuses', async () => {
    let outdated = 0;
    const failure = await answering(400, { v: 6, error: 'invalid_request', message: 'No.' }, () => outdated++).stream(0, 0).catch((error: unknown) => error);

    expect((failure as ServerError).code).toBe('outdated');
    expect(outdated).toBe(1);
  });

  it('does not for an error without a version, such as a proxy’s', async () => {
    let outdated = 0;
    const failure = await answering(502, { error: 'bad_gateway' }, () => outdated++).stream(0, 0).catch((error: unknown) => error);

    expect((failure as ServerError).code).not.toBe('outdated');
    expect(outdated).toBe(0);
  });
});
