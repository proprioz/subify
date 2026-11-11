import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { toBase64Url } from '@subify/shared/codec';
import { type ApiErrorCode, BLIND_BATCH_SIZES, DICTIONARY_SLICES } from '@subify/shared';
import {
  AddResponse,
  ApiError,
  ConnectionResponse,
  ContactChallengeResponse,
  ContactRequest,
  ContactResponse,
  DictionaryResponse,
  DictionarySliceParams,
  DictionarySliceResponse,
  EvaluateRequest,
  EvaluateResponse,
  HandleBoundsResponse,
  HandleChunkParams,
  HandleChunkResponse,
  HealthResponse,
  InstanceResponse,
  NoQuery,
  SubmitRequest,
  OprfKeyResponse,
  SnapshotQuery,
  SnapshotResponse,
  SnapshotThumbnailsResponse,
  StreamQuery,
  StreamResponse,
  LotsQuery,
  LotsResponse,
} from '@subify/shared/schemas';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { addByLink, atMinimumLatency } from './catalog/add';
import { evaluateForDevice, oprfKey } from './catalog/blind';
import { BudgetError } from './catalog/budgets';
import { readSnapshot, readSnapshotThumbnails } from './catalog/snapshot';
import { readStream } from './catalog/stream';
import { readLotPage } from './catalog/lots';
import { readHandleBounds, readHandleChunk } from './catalog/vault';
import { receiveNotification, verifySubscription } from './catalog/websub';
import { createChallenge, messagesOn, sendMessage } from './contact';
import { UpstreamError } from './http';
import { ICON_FILES, iconPath, manifest } from './instance';
import { logError } from './log';
import { dictionaryVersion, readDictionarySlice } from './search/dictionary';
import type { Platform } from './platform';
import { InputError, type SourceAdapter } from './sources/source';

/**
 * The entry points pass the platform with each request, so the app itself is built once and
 * never touches a runtime API. It never reads the request's IP headers either.
 */
export interface AppEnv {
  Bindings: {
    platform: Platform;
    /**
     * The country Cloudflare derives from this request's IP address, or null. Only GET
     * /connection may call it, and only to answer: it is never stored, logged or used for
     * anything else. The Node entry has no such source and leaves it out.
     */
    connectionCountry?: () => string | null;
  };
}

export interface AppOptions {
  /** The video platforms the catalog accepts. The entry points pass YouTube's adapter. */
  sources: readonly SourceAdapter[];
}

/** The API's routes and answers, as the PWA's client sees them (`hc<AppType>`). */
export type AppType = ReturnType<typeof createApp>;

/** Every route declares the errors it may answer, in the API's error format. */
function errors<S extends 400 | 404 | 413 | 502 | 503>(...statuses: S[]) {
  return Object.fromEntries(statuses.map((status) => [status, { description: 'Refused or failed', content: { 'application/json': { schema: ApiError } } }])) as Record<
    S,
    { description: string; content: { 'application/json': { schema: typeof ApiError } } }
  >;
}

function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } };
}

// The contact form (src/contact.ts): a robot check to solve, then the message. 404 when the server takes none.
const contactChallengeRoute = createRoute({
  method: 'get',
  path: '/contact',
  request: { query: NoQuery },
  responses: { 200: json(ContactChallengeResponse, 'A robot check to solve before sending'), ...errors(400, 404) },
});

const contactRoute = createRoute({
  method: 'post',
  path: '/contact',
  middleware: [bodyLimit({ maxSize: 16 * 1024, onError: (c) => fail(c, 'invalid_request', 'This message is too long.', 413) })],
  request: { query: NoQuery, body: jsonBody(ContactRequest) },
  responses: { 200: json(ContactResponse, 'The message was sent'), ...errors(400, 404, 413, 502, 503) },
});

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: { 200: json(HealthResponse, 'The API version') },
});

const connectionRoute = createRoute({
  method: 'get',
  path: '/connection',
  request: { query: NoQuery },
  responses: { 200: json(ConnectionResponse, 'Where the host places this connection'), ...errors(400) },
});

// The encrypted catalog's routes (docs/FEATURES.md, D16).
const oprfKeyRoute = createRoute({
  method: 'get',
  path: '/oprf',
  request: { query: NoQuery },
  responses: { 200: json(OprfKeyResponse, 'The VOPRF public key'), ...errors(400, 404) },
});

// Like /sync, the batch is answered, then forgotten. Its elements tell nothing about the channels they hide.
const evaluateRoute = createRoute({
  method: 'post',
  path: '/oprf/evaluate',
  middleware: [bodyLimit({ maxSize: 8 * 1024, onError: (c) => fail(c, 'invalid_request', 'Too many elements at once.', 413) })],
  request: { query: NoQuery, body: jsonBody(EvaluateRequest) },
  responses: { 200: json(EvaluateResponse, 'The evaluated elements and their proof'), ...errors(400, 404, 413, 503) },
});

// Anyone may download it: without the channels' keys it is noise. A device asks for whole groups only.
const streamRoute = createRoute({
  method: 'get',
  path: '/stream',
  request: { query: StreamQuery },
  responses: { 200: json(StreamResponse, 'The group’s entries in the batches after `since`'), ...errors(400, 404) },
});

// The thumbnail lots (D3): like the stream, whole groups only, and noise without the channels' keys.
const lotsRoute = createRoute({
  method: 'get',
  path: '/lots',
  request: { query: LotsQuery },
  responses: { 200: json(LotsResponse, 'The group’s thumbnail lots of the hours up to `until`'), ...errors(400, 404) },
});

// The handle index, in two steps: where each chunk starts, then one whole chunk. The server learns
// which chunk a device reads, a few thousand handles at least, never which handle.
const handleBoundsRoute = createRoute({
  method: 'get',
  path: '/handles',
  request: { query: NoQuery },
  responses: { 200: json(HandleBoundsResponse, 'The first entry id of each chunk'), ...errors(400, 404) },
});

const handleChunkRoute = createRoute({
  method: 'get',
  path: '/handles/{chunk}',
  request: { params: HandleChunkParams, query: NoQuery },
  responses: { 200: json(HandleChunkResponse, 'One chunk of the handle index'), ...errors(400, 404) },
});

// A whole group, so that what a device reads says nothing finer about which channel it wants.
const snapshotRoute = createRoute({
  method: 'get',
  path: '/snapshot',
  request: { query: SnapshotQuery },
  responses: { 200: json(SnapshotResponse, 'Every slot of the group, sealed'), ...errors(400, 404, 503) },
});

// A whole group's thumbnails, read after its snapshot: asking for a channel's would name it.
const snapshotThumbnailsRoute = createRoute({
  method: 'get',
  path: '/snapshot/thumbnails',
  request: { query: SnapshotQuery },
  responses: { 200: json(SnapshotThumbnailsResponse, 'The thumbnails of the last 7 days of every slot of the group, sealed'), ...errors(400, 404, 503) },
});

// The clear way to add a channel with the encrypted catalog: alone in its request, and answered
// after the same minimum time whether the catalog knew the channel or not.
const addRoute = createRoute({
  method: 'post',
  path: '/add',
  middleware: [bodyLimit({ maxSize: 4 * 1024, onError: (c) => fail(c, 'invalid_request', 'Send one link at a time.', 413) })],
  request: { query: NoQuery, body: jsonBody(SubmitRequest) },
  responses: { 200: json(AddResponse, 'The channel, its latest items and its thumbnails'), ...errors(400, 404, 413, 502, 503) },
});

// The Wikidata dictionary: public data, the same for every device, always downloaded whole.
const dictionaryRoute = createRoute({
  method: 'get',
  path: '/dictionary',
  request: { query: NoQuery },
  responses: { 200: json(DictionaryResponse, 'The dictionary’s version and its slices'), ...errors(400, 404) },
});

const dictionarySliceRoute = createRoute({
  method: 'get',
  path: '/dictionary/{slice}',
  request: { params: DictionarySliceParams, query: NoQuery },
  responses: { 200: json(DictionarySliceResponse, 'One slice of the dictionary'), ...errors(400, 404) },
});

// Who runs this server, for the Privacy page: the app asks only when the user taps for it.
const instanceRoute = createRoute({
  method: 'get',
  path: '/instance',
  request: { query: NoQuery },
  responses: { 200: json(InstanceResponse, 'The server’s name and its operator'), ...errors(400) },
});

export function createApp({ sources }: AppOptions) {
  const app = new OpenAPIHono<AppEnv>().basePath('/api');

  // Every answer is for this client only: no shared cache may keep it.
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'private');
  });

  app.onError((error, c) => {
    if (error instanceof InputError) {
      return fail(c, error.code, error.message, error.code === 'channel_not_found' ? 404 : 400);
    }

    // A new channel refused for now: the answer says how long to wait.
    if (error instanceof BudgetError) {
      c.header('Retry-After', String(error.retryAfterSeconds));

      return fail(c, error.code, error.message, 503);
    }

    if (error instanceof UpstreamError) {
      return fail(c, 'upstream_unavailable', 'The platform didn’t answer as expected. Try again in a moment.', 502);
    }

    // A body that is not JSON, or not valid JSON: the validators throw before any route runs.
    if (error instanceof HTTPException && error.status < 500) {
      return fail(c, 'invalid_request', 'Send a JSON object.', 400);
    }

    logError('Request failed', error);

    return c.json({ v: 2, error: 'internal' }, 500);
  });

  const api = app
    .openapi(healthRoute, (c) => c.json({ v: 2 as const, ok: true as const, commit: c.env.platform.config.commit }, 200))

    // The connection check: the one place the server looks at where a request comes from, at
    // the user's request, so they can check their VPN. Cloudflare says 'XX' when it does not know.
    .openapi(
      connectionRoute,
      (c) => {
        const country = c.env.connectionCountry?.() ?? null;

        return c.json({ v: 2, country: country !== null && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null } as const, 200);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      oprfKeyRoute,
      async (c) => {
        return c.json(oprfKey(await c.env.platform.keys), 200);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      evaluateRoute,
      async (c) => {
        const { platform } = c.env;

        const answer = await evaluateForDevice(platform, await platform.keys, c.req.valid('json').blinded);

        return answer === null ? fail(c, 'invalid_request', 'An element isn’t a valid blinded element.', 400) : c.json(answer, 200);
      },
      refuse(`Send a JSON object with a \`blinded\` list of ${BLIND_BATCH_SIZES.join(' or ')} elements.`),
    )

    .openapi(
      streamRoute,
      async (c) => {
        const { platform } = c.env;

        const { since, group } = c.req.valid('query');
        const answer = await readStream(platform, await platform.keys, since, group);

        return answer === null ? fail(c, 'invalid_request', 'No such group, or no batch yet.', 404) : c.json(answer, 200);
      },
      refuse('Send `since`, the `latest` of a previous answer, and `group`, as numbers.'),
    )

    .openapi(
      lotsRoute,
      async (c) => {
        const { platform } = c.env;

        const { group, until } = c.req.valid('query');
        const answer = await readLotPage(platform, await platform.keys, group, until);

        return answer === null ? fail(c, 'invalid_request', 'No such group, or no pass yet.', 404) : c.json(answer, 200);
      },
      refuse('Send `group` and, to read back, `until`, as numbers.'),
    )

    .openapi(
      handleBoundsRoute,
      async (c) => {
        const { platform } = c.env;
        const bounds = await readHandleBounds(platform.db, await platform.keys);

        return bounds === undefined ? fail(c, 'invalid_request', 'No handle index yet.', 404) : c.json({ v: 3 as const, chunks: bounds.map(toBase64Url) }, 200);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      handleChunkRoute,
      async (c) => {
        const { platform } = c.env;
        const chunk = await readHandleChunk(platform.db, await platform.keys, c.req.valid('param').chunk);

        return chunk === undefined ? fail(c, 'invalid_request', 'No such chunk.', 404) : c.json({ v: 3 as const, entries: toBase64Url(chunk) }, 200);
      },
      refuse('Send the chunk’s number, and no parameter.'),
    )

    .openapi(
      snapshotRoute,
      async (c) => {
        const { platform } = c.env;

        const answer = await readSnapshot(platform, await platform.keys, c.req.valid('query').group);

        return answer === null ? fail(c, 'invalid_request', 'No such group, or no pass yet.', 404) : c.json(answer, 200);
      },
      refuse('Send `group`, a number, and no other parameter.'),
    )

    .openapi(
      snapshotThumbnailsRoute,
      async (c) => {
        const { platform } = c.env;
        const answer = await readSnapshotThumbnails(platform, await platform.keys, c.req.valid('query').group);

        return answer === null ? fail(c, 'invalid_request', 'No such group, or no pass yet.', 404) : c.json(answer, 200);
      },
      refuse('Send `group`, a number, and no other parameter.'),
    )

    .openapi(
      dictionaryRoute,
      async (c) => {
        const version = await dictionaryVersion(c.env.platform.db);

        return version === null
          ? fail(c, 'invalid_request', 'This server has no dictionary of channel names.', 404)
          : c.json({ v: 3 as const, version, slices: DICTIONARY_SLICES }, 200);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      dictionarySliceRoute,
      async (c) => {
        const data = await readDictionarySlice(c.env.platform.db, c.req.valid('param').slice);

        return data === undefined ? fail(c, 'invalid_request', 'No such slice.', 404) : c.json({ v: 3 as const, data: toBase64Url(data) }, 200);
      },
      refuse('Send the slice’s number, and no parameter.'),
    )

    .openapi(
      instanceRoute,
      (c) => {
        const { platform } = c.env;
        const { instanceName, operatorName, operatorContact } = platform.config;
        const messages = messagesOn(platform);
        // With the contact form on, the operator's address stays out of sight: the form reaches them.
        const contact = messages ? null : operatorContact;
        const operator = operatorName === null && contact === null ? null : { name: operatorName, contact };

        return c.json({ v: 3 as const, name: instanceName ?? '', operator, messages }, 200);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      contactChallengeRoute,
      async (c) => {
        const { platform } = c.env;

        return messagesOn(platform)
          ? c.json({ v: 3 as const, ...(await createChallenge(platform, await platform.keys)) }, 200)
          : fail(c, 'invalid_request', 'This server doesn’t take messages.', 404);
      },
      refuse('This request takes no parameters.'),
    )

    .openapi(
      contactRoute,
      async (c) => {
        const { platform } = c.env;
        const { result, retryAfter } = await sendMessage(platform, await platform.keys, c.req.valid('json'));

        switch (result) {
          case 'sent':
            return c.json({ v: 3 as const, sent: true as const }, 200);
          case 'off':
            return fail(c, 'invalid_request', 'This server doesn’t take messages.', 404);
          case 'bad_proof':
            return fail(c, 'invalid_request', 'The robot check expired. Close the form and try again.', 400);
          case 'busy':
            c.header('Retry-After', String(retryAfter));

            return fail(c, 'busy', 'Many messages came in lately. Try again later.', 503);
          case 'failed':
            return fail(c, 'upstream_unavailable', 'The message couldn’t be sent. Try again later.', 502);
        }
      },
      refuse('Send your name, your email address, a message of 10 to 2,000 characters, and the solved robot check.'),
    )

    .openapi(
      addRoute,
      async (c) => {
        const { platform } = c.env;
        // Failures wait too: a quick “not found” or “busy” would tell what the catalog holds.
        return c.json(await atMinimumLatency(platform, async () => addByLink(platform, await platform.keys, sources, c.req.valid('json').url)), 200);
      },
      refuse('Send a JSON object with a single `url` field.'),
    );

  // The installed app's manifest and icons, for the host the request came to (src/instance.ts).
  // The browser asks for them, not the app's code: they stay outside the API's contract.
  app.get('/manifest.webmanifest', (c) => {
    const { config } = c.env.platform;

    if (config.instanceName === null) {
      return c.text('INSTANCE_NAME is not set.', 503);
    }

    return c.body(JSON.stringify(manifest(c, { ...config, instanceName: config.instanceName })), 200, { 'Content-Type': 'application/manifest+json' });
  });

  app.get('/icons/:file', (c) => (ICON_FILES.has(c.req.param('file')) ? c.redirect(iconPath(c, c.req.param('file')), 302) : c.text('', 404)));

  // WebSub: the hub confirms a subscription with a GET, and pushes uploads with a POST. These are
  // the hub's requests, not the app's: they stay outside the API's contract.
  app.get('/websub/callback', async (c) => {
    if (!onlyParams(c, ['c', 'hub.mode', 'hub.topic', 'hub.challenge', 'hub.lease_seconds', 'hub.reason'])) {
      return c.text('', 404);
    }

    const answer = await verifySubscription(c.env.platform, sources, {
      channel: c.req.query('c') ?? '',
      mode: c.req.query('hub.mode') ?? '',
      topic: c.req.query('hub.topic') ?? '',
      challenge: c.req.query('hub.challenge') ?? '',
      leaseSeconds: c.req.query('hub.lease_seconds'),
    });

    return answer === null ? c.text('', 404) : c.text(answer, 200);
  });

  app.post('/websub/callback', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const channel = c.req.query('c');

    if (onlyParams(c, ['c']) && channel !== undefined) {
      await receiveNotification(c.env.platform, sources, channel, await c.req.text(), c.req.header('X-Hub-Signature'));
    }

    // WebSub asks subscribers to acknowledge every notification, valid or not, and to ignore the invalid ones.
    return c.body(null, 204);
  });

  return api;
}

function fail<S extends 400 | 404 | 413 | 502 | 503>(c: Context, error: ApiErrorCode, message: string, status: S) {
  return c.json({ v: 2, error, message } satisfies z.infer<typeof ApiError>, status);
}

/**
 * Answers a request the schemas refuse in the API's error format, with what the route expects.
 * Generic over the context: a plain `Context` would widen the route's path in the app's type.
 */
function refuse(message: string) {
  return <C extends Context>(result: { success: boolean }, c: C) => (result.success ? undefined : fail(c, 'invalid_request', message, 400));
}

/** Only these parameters, each given once. */
function onlyParams(c: Context, allowed: readonly string[]): boolean {
  return Object.entries(c.req.queries()).every(([name, values]) => allowed.includes(name) && values.length === 1);
}
