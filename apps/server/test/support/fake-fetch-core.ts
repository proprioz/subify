import type { Fetcher } from '../../src/platform';

export interface FakeAnswer {
  status?: number;
  body?: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null;
  headers?: Record<string, string>;
}

/**
 * Stands in for the network: answers only the URLs a test registered, and records every call.
 * A call to any other URL fails the request and is kept in `unexpected`.
 */
export class FakeFetch {
  readonly calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  readonly unexpected: string[] = [];
  private readonly routes = new Map<string, () => FakeAnswer>();

  on(url: string, answer: FakeAnswer | (() => FakeAnswer)): this {
    this.routes.set(url, typeof answer === 'function' ? answer : () => answer);

    return this;
  }

  get urls(): string[] {
    return this.calls.map((call) => call.url);
  }

  readonly fetch: Fetcher = async (url, init) => {
    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = this.routes.get(url);

    if (route === undefined) {
      this.unexpected.push(url);
      throw new TypeError(`No fake answer for ${url}`);
    }

    const { status = 200, body = '', headers = {} } = route();

    return new Response(status === 304 ? null : body, { status, headers });
  };
}
