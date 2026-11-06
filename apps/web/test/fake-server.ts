import type { ApiChannel, ApiItem, ItemType } from '@subify/shared';
import { type SlotImage, type SlotImageType, type SnapshotChannel, type StreamDelta, STREAM_MAX_PER_CHANNEL, toBase64Url } from '@subify/shared/codec';
import { Api } from '../src/data/api';
import { type Subscription, SubifyDb } from '../src/data/db';
import { AlreadyFollowing, findChannel, follow } from '../src/data/subscriptions';
import { FakeCatalog } from './fake-catalog';

/** 2026-10-20, noon UTC: every test date counts back from here. */
export const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

let dbCount = 0;

/** A fresh, empty database per test. */
export function freshDb(): SubifyDb {
  return new SubifyDb(`test-${++dbCount}`);
}

/** Looks a link up and follows what it names, as the Follow button does. */
export async function subscribe(db: SubifyDb, api: Api, input: string, now?: number): Promise<Subscription> {
  const found = await findChannel(db, api, input);

  if ('following' in found) {
    throw new AlreadyFollowing(found.following);
  }

  if ('matches' in found) {
    throw new Error('The search found several channels: pick one.');
  }

  return follow(db, found.submitted, now);
}

export function channel(id: string, title = `Channel ${id}`): ApiChannel {
  return { key: `youtube:${id}`, source: 'youtube', title, handle: null, icon: null, avatar: null };
}

export function item(channelId: string, id: string, daysAgo: number, type: ItemType = 'video'): ApiItem {
  return {
    key: `youtube:${id}`,
    channel: `youtube:${channelId}`,
    title: `Video ${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: null,
    published: NOW - daysAgo * DAY,
    type,
  };
}

export function many(channelId: string, prefix: string, count: number, type: ItemType = 'video', fromDaysAgo = 0): ApiItem[] {
  return Array.from({ length: count }, (_, i) => item(channelId, `${prefix}${i}`, fromDaysAgo + i, type));
}

/**
 * A stand-in for the server, with the encrypted catalog (`encrypted`), answering the API like the
 * real one and recording every request the app sends. Channels and items given in the API's own
 * types are put in the catalog as passes would: each change reaches the stream.
 */
export class FakeServer {
  readonly requests: { method: string; url: string; body: string | null }[] = [];
  /** Fail the nth /stream request (1-based), to simulate an app suspended mid-sync. */
  failStreamAt: number | null = null;
  /** Called with each /stream request's number (1-based) as it arrives, to act while it is on its way. */
  onStream: ((call: number) => void) | null = null;
  private streamCalls = 0;
  /** What /connection answers: the country the server places the device in. */
  country: string | null = 'CH';
  /** What /search answers for any name, or null for a server with no search service (404). */
  searchResults: { id: string; name: string; handle: string | null; description: string }[] | null = null;
  /** The Wikidata dictionary the server offers: its version and its slices' lines, or none. */
  dictionary: { version: number; slices: string[] } | null = null;
  /** The encrypted catalog, which answers its routes. */
  encrypted = new FakeCatalog();

  /**
   * Puts a channel and its items in the catalog, as ingestion would: a channel new to it enters
   * its snapshots, and every change after that goes through passes of the stream, at most
   * STREAM_MAX_PER_CHANNEL changes per channel and per pass, as the real server sends them.
   */
  publish(newChannel: ApiChannel | null, ...items: ApiItem[]): this {
    const changes = new Map<string, StreamDelta[]>();
    const change = (key: string, delta: StreamDelta) => changes.set(key, [...(changes.get(key) ?? []), delta]);

    if (newChannel !== null) {
      const known = this.encrypted.channels.get(newChannel.key);

      if (known === undefined) {
        this.encrypted.publish(snapshotOf(newChannel, []));
      } else {
        known.handle = newChannel.handle;
        known.avatar = imageOf(newChannel.avatar);
        change(newChannel.key, { kind: 'channel', title: newChannel.title, handle: newChannel.handle });
      }
    }

    for (const newItem of items) {
      if (!this.encrypted.channels.has(newItem.channel)) {
        this.encrypted.publish(snapshotOf(channel(newItem.channel.slice(newItem.channel.indexOf(':') + 1)), []));
      }

      change(newItem.channel, { kind: 'item', id: idOf(newItem.key), title: newItem.title, published: newItem.published, type: newItem.type, deleted: newItem.deleted === true, upcoming: newItem.upcoming === true, preview: null });
    }

    for (let at = 0; [...changes.values()].some((deltas) => deltas.length > at); at += STREAM_MAX_PER_CHANNEL) {
      const pass = [...changes].flatMap(([key, deltas]) => (deltas.length > at ? [{ key, deltas: deltas.slice(at, at + STREAM_MAX_PER_CHANNEL) }] : []));
      this.encrypted.passWith(...pass);
    }

    for (const key of changes.keys()) {
      const stored = this.encrypted.channels.get(key)!;
      const deleted = new Set(items.filter((i) => i.channel === key && i.deleted === true).map((i) => idOf(i.key)));
      stored.items = stored.items.filter((i) => !deleted.has(i.id)).sort((x, y) => y.published - x.published);
    }

    return this;
  }

  /** What /api/add reads online for this link when the catalog lacks the channel. */
  online(link: string, newChannel: ApiChannel, items: readonly ApiItem[] = []): this {
    this.encrypted.online.set(link, snapshotOf(newChannel, items));

    return this;
  }

  /** A thumbnail the catalog keeps for this item of a published channel, sent with its snapshot and its additions. */
  thumbnail(itemKey: string, channelKey: string, bytes: Uint8Array, type: SlotImageType = 'image/jpeg'): this {
    this.encrypted.thumbnails.get(channelKey)!.set(idOf(itemKey), { type, bytes });

    return this;
  }

  get paths(): string[] {
    return this.requests.map((request) => `${request.method} ${request.url}`);
  }

  /** The bodies the app posted to `url`, parsed. */
  posted<T>(url: string): T[] {
    return this.requests.filter((request) => request.method === 'POST' && request.url === url).map((request) => JSON.parse(request.body ?? 'null') as T);
  }

  /** An Api for this server, which `guard` may stop before each request, as the connection check does. */
  api(guard?: () => Promise<void>): Api {
    return new Api(async (input, init) => this.answer(String(input), init), guard);
  }

  private async answer(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    this.requests.push({ method, url, body });

    if (init?.credentials !== 'omit' || init.referrerPolicy !== 'no-referrer') {
      return json({ v: 2, error: 'invalid_request', message: 'The app must omit credentials and referrer.' }, 400);
    }

    const sent = JSON.parse(body ?? '{}') as { url?: string; blinded?: string[] };

    if (url === '/api/health' && method === 'GET') {
      return json({ v: 2, ok: true });
    }

    if (url === '/api/connection' && method === 'GET') {
      return json({ v: 2, country: this.country });
    }

    if (url.startsWith('/api/stream?') && method === 'GET') {
      this.streamCalls++;
      this.onStream?.(this.streamCalls);

      if (this.streamCalls === this.failStreamAt) {
        throw new TypeError('The app was suspended.');
      }
    }

    if (url === '/api/search' && method === 'POST') {
      return this.searchResults === null ? json({ v: 2, error: 'invalid_request', message: 'No search.' }, 404) : json({ v: 3, results: this.searchResults });
    }

    if (url === '/api/dictionary' && method === 'GET') {
      return this.dictionary === null
        ? json({ v: 2, error: 'invalid_request', message: 'No dictionary.' }, 404)
        : json({ v: 3, version: this.dictionary.version, slices: this.dictionary.slices.length });
    }

    const slice = /^\/api\/dictionary\/(\d+)$/.exec(url);

    if (slice !== null && method === 'GET' && this.dictionary !== null) {
      const lines = this.dictionary.slices[Number(slice[1])];

      return lines === undefined ? json({ v: 2, error: 'invalid_request', message: 'No such slice.' }, 404) : json({ v: 3, data: toBase64Url(await gzip(lines)) });
    }

    const answer = await this.encrypted.answer(new URL(url, 'https://subify.test'), method, sent);

    if (answer === null) {
      return json({ v: 2, error: 'channel_not_found', message: 'Not found.' }, 404);
    }

    if (answer !== undefined) {
      return json(answer);
    }

    return json({ v: 2, error: 'invalid_request', message: 'Unknown route.' }, 404);
  }
}

function idOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/** A channel and its items as the encrypted catalog keeps them. */
export function snapshotOf(newChannel: ApiChannel, items: readonly ApiItem[]): SnapshotChannel {
  return {
    source: newChannel.source,
    externalId: idOf(newChannel.key),
    title: newChannel.title,
    handle: newChannel.handle,
    avatar: imageOf(newChannel.avatar),
    items: items
      .filter((i) => i.deleted !== true)
      .map((i) => ({ id: idOf(i.key), title: i.title, published: i.published, type: i.type, upcoming: i.upcoming === true, preview: null }))
      .sort((x, y) => y.published - x.published),
    retryAt: null,
  };
}

/** A data: URL's image, as the catalog keeps avatars. */
function imageOf(url: string | null): SlotImage | null {
  const match = url === null ? null : /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(url);

  return match === null ? null : { type: match[1] as SlotImageType, bytes: Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0)) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
