import type { AppType } from '@subify/server/app';
import type { ApiError, ContactRequest } from '@subify/shared';
import { type ClientResponse, hc } from 'hono/client';

/** A request the server refused or could not answer, with a sentence the app can show. */
export class ServerError extends Error {
  override readonly name = 'ServerError';

  constructor(
    message: string,
    readonly code: ApiError['error'] | 'network' | 'unexpected' | 'outdated' | 'cancelled' | 'busy',
    readonly status = 0,
    /** For 'busy': how long the server asked to wait before trying again, in milliseconds, when it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * Retry-After in milliseconds, from a number of seconds or an HTTP date, or undefined. The rate
 * limiting in front of the server answers 429 with its own page, never in the API's format.
 */
function retryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') {
    return undefined;
  }

  const ms = /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : Date.parse(header) - now;

  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

type Client = ReturnType<typeof hc<AppType>>;

/** The answer formats this app reads: 2, and 3 for the encrypted catalog's routes. */
const KNOWN_VERSIONS: readonly number[] = [2, 3];

/** The body a route declares for its 200 answer. */
type Answer<R> = R extends ClientResponse<infer T, 200, 'json'> ? T : never;

/**
 * The only way the app talks to the server: the one that served it, on the same origin, so the
 * app and the server always come from the same deploy, and the routes and answers' types come
 * from the server's own code. Requests carry no cookie, no credentials and no referrer: nothing
 * tells the server who asks.
 */
export class Api {
  private readonly client: Client;
  private catalogKey: ReturnType<Api['oprfKey']> | undefined;

  constructor(
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    /** Called before every request but the connection check, and throws to stop it (see ConnectionGate). */
    private readonly guard: () => Promise<void> = async () => {},
    /**
     * Called when the server answers in a version this app does not know: it was deployed after
     * this page loaded, and the app should load the new version (see updateApp).
     */
    private readonly onOutdated: () => void = () => {},
  ) {
    this.client = hc<AppType>('/', { fetch: fetcher, init: { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'same-origin' } });
  }

  health() {
    return this.read(this.call(() => this.client.api.health.$get()));
  }

  /** The country the server places this connection in: the connection check, sent before anything else. */
  connection() {
    return this.read(this.call(() => this.client.api.connection.$get({ query: {} }, { init: { cache: 'no-store' } }), false));
  }

  /** The encrypted catalog's VOPRF public key (docs/FEATURES.md, D16). */
  oprfKey() {
    return this.read(this.call(() => this.client.api.oprf.$get({ query: {} })));
  }

  /**
   * The encrypted catalog's key, asked once per launch. A failure is not remembered: the next
   * online action asks again.
   */
  catalog() {
    this.catalogKey ??= this.oprfKey();
    this.catalogKey.catch(() => (this.catalogKey = undefined));

    return this.catalogKey;
  }

  /** Evaluates blinded elements, padded by the caller to an allowed batch size. */
  evaluate(blinded: readonly string[]) {
    return this.read(this.call(() => this.client.api.oprf.evaluate.$post({ query: {}, json: { blinded: [...blinded] } })));
  }

  /** A whole group's entries in the stream's batches after `since`. */
  stream(since: number, group: number) {
    return this.read(this.call(() => this.client.api.stream.$get({ query: { since: String(since), group: String(group) } })));
  }

  /** Every slot of a snapshot group, with its thumbnails of the last 7 days when asked. */
  snapshot(group: number, thumbnails: boolean) {
    return this.read(this.call(() => this.client.api.snapshot.$get({ query: { group: String(group), thumbnails: thumbnails ? '1' : '0' } })));
  }

  /** Where each chunk of the handle index starts. */
  handleBounds() {
    return this.read(this.call(() => this.client.api.handles.$get({ query: {} })));
  }

  handleChunk(chunk: number) {
    return this.read(this.call(() => this.client.api.handles[':chunk'].$get({ param: { chunk: String(chunk) }, query: {} })));
  }

  /** This server's name and who runs it. */
  instance() {
    return this.read(this.call(() => this.client.api.instance.$get({ query: {} })));
  }

  /** The Wikidata dictionary's version and slices, or null when this server has none. */
  async dictionary() {
    const response = await this.call(() => this.client.api.dictionary.$get({ query: {} }));

    return response.status === 404 ? null : this.read(Promise.resolve(response));
  }

  dictionarySlice(slice: number) {
    return this.read(this.call(() => this.client.api.dictionary[':slice'].$get({ param: { slice: String(slice) }, query: {} })));
  }

  /**
   * Searches a name on the search services the server's admin turned on (Invidious, Piped), or
   * null when there are none. Each result was checked against the channel's own feed.
   */
  async search(q: string) {
    const response = await this.call(() => this.client.api.search.$post({ query: {}, json: { q } }));

    return response.status === 404 ? null : this.read(Promise.resolve(response));
  }

  /** A robot check for the contact form, or null when this server takes no messages. */
  async contactChallenge() {
    const response = await this.call(() => this.client.api.contact.$get({ query: {} }, { init: { cache: 'no-store' } }));

    return response.status === 404 ? null : this.read(Promise.resolve(response));
  }

  /** Sends a message to whoever runs this server, through the contact form. */
  sendMessage(message: ContactRequest) {
    return this.read(this.call(() => this.client.api.contact.$post({ query: {}, json: message })));
  }

  /** Adds a channel by link the clear way, on a server with the encrypted catalog. Answers after at least 8 seconds. */
  add(url: string) {
    return this.read(this.call(() => this.client.api.add.$post({ query: {}, json: { url } })));
  }

  private async call<R>(request: () => Promise<R>, guarded = true): Promise<R> {
    if (guarded) {
      await this.guard();
    }

    try {
      return await request();
    } catch {
      throw new ServerError('Can’t reach the server. Check your connection and try again.', 'network');
    }
  }

  /**
   * The route's 200 answer, typed as the server declares it. The answer itself is not validated:
   * the app and the server come from the same deploy, and the version says when they do not.
   */
  private async read<R extends ClientResponse<unknown>>(request: Promise<R>): Promise<Answer<R>> {
    const response = await request;
    let body: unknown;

    if (response.status === 429 || response.status === 503) {
      // The server's own refusals (budgets for new channels) say why; the rate limiting in front of it does not.
      const refusal = (await response.json().catch(() => null)) as Partial<ApiError> | null;
      const own = refusal?.v === 2 && typeof refusal.message === 'string' && refusal.error !== undefined;

      throw new ServerError(
        own ? refusal.message! : 'The server is busy. Try again in a moment.',
        own ? refusal.error! : 'busy',
        response.status,
        retryAfter(response.headers.get('Retry-After')),
      );
    }

    try {
      body = await response.json();
    } catch {
      throw new ServerError('The server answered something unexpected.', 'unexpected', response.status);
    }

    // Errors carry the version too: a newer server may refuse what this app sends.
    this.checkVersion((body as { v?: unknown } | null)?.v, response.status);

    if (!response.ok) {
      const error = body as Partial<ApiError>;
      throw new ServerError(error.message ?? 'The server couldn’t handle this request.', error.error ?? 'unexpected', response.status);
    }

    if (!KNOWN_VERSIONS.includes((body as { v?: unknown }).v as number)) {
      throw new ServerError('The server answered something unexpected.', 'unexpected', response.status);
    }

    return body as Answer<R>;
  }

  /** Refuses an answer in another version than this app's, and asks for the server's version of the app. */
  private checkVersion(version: unknown, status: number): void {
    if (typeof version === 'number' && !KNOWN_VERSIONS.includes(version)) {
      this.onOutdated();
      throw new ServerError('This app is out of date. Close it and open it again to update it.', 'outdated', status);
    }
  }
}
