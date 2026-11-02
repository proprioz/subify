import type { Fetcher } from './platform';

/** `invalid`: the answer came, but is not what the platform normally sends (an HTML error page instead of a feed). */
export type UpstreamFailure = 'timeout' | 'too_large' | 'network' | 'redirect' | 'status' | 'invalid';

/** Why a request to a platform did not give a usable answer. */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly failure: UpstreamFailure,
    readonly status?: number,
  ) {
    super(failure);
  }
}

export interface GetOptions {
  /** The body is never read past this many bytes. */
  maxBytes: number;
  headers?: Record<string, string>;
  /** Gives up after this long instead of 8 seconds: for a query service that may take a minute. */
  timeoutMs?: number;
  /** Stops reading early once this returns true for the text read so far (it may be called often: keep it incremental). */
  until?: (text: string) => boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

export interface BinaryResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

/**
 * The only way the server reaches a platform. It only calls https URLs on the hosts it was
 * given, follows redirects only to those hosts, gives up after 8 seconds (unless told otherwise) and never reads more
 * than `maxBytes`. Callers build every URL themselves: no URL a user typed is ever fetched.
 */
export class Http {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly userAgent: string,
    private readonly allowedHosts: ReadonlySet<string>,
  ) {}

  /** Any status is returned, except redirects, which are followed. Throws UpstreamError otherwise. */
  async get(url: string, options: GetOptions): Promise<HttpResponse> {
    const response = await this.send(url, 'GET', null, options);

    return { status: response.status, headers: response.headers, body: await readBody(response, options) };
  }

  /** A GET for an image: the body as bytes, never read past `maxBytes`. */
  async getBytes(url: string, options: Omit<GetOptions, 'until'>): Promise<BinaryResponse> {
    const response = await this.send(url, 'GET', null, options);

    return { status: response.status, headers: response.headers, bytes: await readBytes(response, options.maxBytes) };
  }

  /** Posts a form, as a WebSub hub expects. Redirects are not followed. */
  async postForm(url: string, form: Record<string, string>, options: GetOptions): Promise<HttpResponse> {
    const response = await this.send(url, 'POST', new URLSearchParams(form).toString(), options);

    return { status: response.status, headers: response.headers, body: await readBody(response, options) };
  }

  private async send(url: string, method: 'GET' | 'POST', body: string | null, options: Omit<GetOptions, 'until'>): Promise<Response> {
    let current = this.checked(url);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;

      try {
        response = await this.fetcher(current.href, {
          method,
          redirect: 'manual',
          headers: {
            'User-Agent': this.userAgent,
            ...(body === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
            ...options.headers,
          },
          ...(body === null ? {} : { body }),
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (error) {
        throw new UpstreamError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
      }

      if (response.status >= 300 && response.status < 400 && response.status !== 304 && method === 'GET') {
        await response.body?.cancel();
        const location = response.headers.get('Location');

        if (location === null) {
          throw new UpstreamError('redirect', response.status);
        }

        current = this.checked(new URL(location, current).href);
        continue;
      }

      return response;
    }

    throw new UpstreamError('redirect');
  }

  private checked(url: string): URL {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:' || !this.allowedHosts.has(parsed.hostname) || parsed.username !== '' || parsed.port !== '') {
      throw new UpstreamError('redirect');
    }

    return parsed;
  }
}

async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      bytes += value.byteLength;

      if (bytes > maxBytes) {
        throw new UpstreamError('too_large');
      }

      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally {
    reader.cancel().catch(() => {});
  }

  const result = new Uint8Array(bytes);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function readBody(response: Response, options: GetOptions): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        return text + decoder.decode();
      }

      bytes += value.byteLength;

      if (bytes > options.maxBytes) {
        throw new UpstreamError('too_large');
      }

      text += decoder.decode(value, { stream: true });

      if (options.until?.(text)) {
        return text;
      }
    }
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally {
    reader.cancel().catch(() => {});
  }
}
