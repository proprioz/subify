import {
  decoyEntry,
  decoyFragment,
  sealFragment,
  splitThumbnail,
  decoyHandleEntry,
  decoySnapshotEntry,
  HANDLE_CHUNK_ENTRIES,
  HANDLE_ENTRY_SIZE,
  compareEntries,
  type SlotImage,
  type SnapshotChannel,
  type StreamDelta,
  sealEntry,
  sealHandleEntry,
  sealSnapshotEntry,
  sealSnapshotFragment,
  snapshotChannelCodec,
  thumbnailCodec,
  toBase64Url,
  fromBase64Url,
} from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, evaluateBlinded, handleInput, voprfKeys } from '@subify/shared/oprf';

/** Entries per group in every stream batch, and fragments of a snapshot's thumbnails: fixed, as on the real server. */
const PER_BATCH = 4;
const SNAPSHOT_FRAGMENTS = 24;
const ADD_THUMBNAILS = 12;

/**
 * A stand-in for a server with the encrypted catalog (docs/FEATURES.md, D16), one group of
 * everything, sealing with the same shared code as the real one. FakeServer answers through it.
 */
export class FakeCatalog {
  keys = voprfKeys(new Uint8Array(32).fill(3));
  /** By channel key. */
  readonly channels = new Map<string, SnapshotChannel>();
  /** Thumbnails by channel key, then item id. */
  readonly thumbnails = new Map<string, Map<string, SlotImage>>();
  /** What /api/add reads online for a link the catalog lacks, by link. */
  readonly online = new Map<string, SnapshotChannel>();
  /** Every channel /api/add was asked for, as the server would see it named. */
  readonly added: string[] = [];
  pass = 1;
  private readonly batches = new Map<number, { key: string; deltas: StreamDelta[] }[]>();
  /** The stream keeps nothing before this pass. */
  keptFrom = 0;
  /** Answers evaluations with another key than the published one, as a server tagging a device would. */
  otherKey = false;
  /** No handle index yet: the first hourly build hasn't run. */
  noIndex = false;
  /** Chunks of the handle index, as a larger catalog has. */
  handleChunks = 1;

  private handleIndex: { shape: string; chunks: Uint8Array[] } | undefined;

  private async buildHandleIndex(): Promise<Uint8Array[]> {
    const entries: Uint8Array[] = [];

    for (const [key, channel] of this.channels) {
      if (channel.handle !== null) {
        const secrets = await channelSecrets(evaluate(this.keys, handleInput(channel.source, channel.handle)));
        entries.push(await sealHandleEntry(secrets.slotId, secrets.transitKey, { source: channel.source, externalId: key.slice(key.indexOf(':') + 1) }));
      }
    }

    while (entries.length < this.handleChunks * HANDLE_CHUNK_ENTRIES) {
      entries.push(decoyHandleEntry());
    }

    entries.sort(compareEntries);
    const chunks = Array.from({ length: this.handleChunks }, (_, c) => {
      const chunk = new Uint8Array(HANDLE_CHUNK_ENTRIES * HANDLE_ENTRY_SIZE);
      entries.slice(c * HANDLE_CHUNK_ENTRIES, (c + 1) * HANDLE_CHUNK_ENTRIES).forEach((entry, i) => chunk.set(entry, i * HANDLE_ENTRY_SIZE));

      return chunk;
    });

    return chunks;
  }

  /** Batches per stream answer: the rest waits for the next page. */
  streamPage = 144;

  /** The current hour, as /lots counts them. */
  hour = 500_000;
  /** Lots per /lots answer. */
  lotPage = 6;
  /** Fragments per lot. */
  private readonly perLot = 12;
  /** The thumbnails each hour's lot carries; an hour absent had no pass, hence no lot. */
  private readonly lots = new Map<number, { key: string; itemId: string; image: SlotImage }[]>();

  /** The lot of `hour`, with these thumbnails, by channel key and item id. */
  lotAt(hour: number, ...thumbnails: { key: string; itemId: string; image: SlotImage }[]): this {
    this.lots.set(hour, thumbnails);

    return this;
  }

  /** Puts a channel in the catalog, as a pass would. */
  publish(channel: SnapshotChannel, thumbnails: Record<string, SlotImage> = {}): this {
    const key = `${channel.source}:${channel.externalId}`;
    this.channels.set(key, channel);
    this.thumbnails.set(key, new Map(Object.entries(thumbnails)));

    return this;
  }

  /** One pass, with these changes in its batch. */
  passWith(...changes: { key: string; deltas: StreamDelta[] }[]): this {
    this.pass++;
    this.batches.set(this.pass, changes);

    for (const { key, deltas } of changes) {
      const channel = this.channels.get(key)!;

      for (const delta of deltas) {
        if (delta.kind === 'item') {
          channel.items = [{ id: delta.id, title: delta.title, published: delta.published, type: delta.type, upcoming: delta.upcoming, preview: delta.preview }, ...channel.items.filter((item) => item.id !== delta.id)];
        } else if (delta.kind === 'channel') {
          channel.title = delta.title;
        } else if (delta.kind === 'retry') {
          channel.retryAt = delta.retryAt;
        } else {
          this.channels.delete(key);
        }
      }
    }

    return this;
  }

  private async secrets(key: string) {
    const at = key.indexOf(':');

    return channelSecrets(evaluate(this.keys, channelInput(key.slice(0, at), key.slice(at + 1))));
  }

  async answer(url: URL, method: string, body: { url?: string; blinded?: string[] }): Promise<unknown> {
    const path = url.pathname;

    if (path === '/api/oprf' && method === 'GET') {
      return { v: 3, keyId: 1, publicKey: toBase64Url(this.keys.publicKey) };
    }

    if (path === '/api/oprf/evaluate' && method === 'POST') {
      const keys = this.otherKey ? voprfKeys(new Uint8Array(32).fill(4)) : this.keys;
      const answer = evaluateBlinded(keys, (body.blinded ?? []).map(fromBase64Url));

      return { v: 3, evaluated: answer.evaluated.map(toBase64Url), proof: toBase64Url(answer.proof) };
    }

    if (path === '/api/snapshot' && method === 'GET') {
      const entries: Uint8Array[] = [];

      for (const [key, channel] of this.channels) {
        const secrets = await this.secrets(key);
        entries.push(await sealSnapshotEntry(secrets.slotId, secrets.transitKey, channel));
      }

      entries.push(decoySnapshotEntry(crypto.getRandomValues(new Uint8Array(16))));

      return { v: 5, pass: this.pass, groups: 1, entries: toBase64Url(concat(entries)) };
    }

    if (path === '/api/snapshot/thumbnails' && method === 'GET') {
      const fragments: Uint8Array[] = [];

      for (const [key, thumbnails] of this.thumbnails) {
        const secrets = await this.secrets(key);
        let index = 0;

        for (const [itemId, image] of thumbnails) {
          for (const fragment of splitThumbnail(itemId, image)) {
            fragments.push(await sealSnapshotFragment(secrets.transitKey, this.pass, index++, fragment));
          }
        }
      }

      while (fragments.length < SNAPSHOT_FRAGMENTS) {
        fragments.push(decoyFragment());
      }

      return { v: 5, pass: this.pass, groups: 1, latest: this.hour, fragments: toBase64Url(concat(fragments)) };
    }

    if (path === '/api/lots' && method === 'GET') {
      const until = url.searchParams.has('until') ? Number(url.searchParams.get('until')) : this.hour;
      const lots = [];

      for (let hour = Math.min(until, this.hour); hour > until - this.lotPage && hour > this.hour - 168; hour--) {
        const thumbnails = this.lots.get(hour);

        if (thumbnails === undefined) {
          continue;
        }

        const fragments: Uint8Array[] = [];
        const sealed = new Map<string, number>();

        for (const { key, itemId, image } of thumbnails) {
          const secrets = await this.secrets(key);

          for (const fragment of splitThumbnail(itemId, image)) {
            fragments.push(await sealFragment(secrets.transitKey, hour, sealed.get(key) ?? 0, fragment));
            sealed.set(key, (sealed.get(key) ?? 0) + 1);
          }
        }

        while (fragments.length < this.perLot) {
          fragments.push(decoyFragment());
        }

        lots.push({ hour, fragments: toBase64Url(concat(fragments)) });
      }

      return { v: 3, latest: this.hour, groups: 1, page: this.lotPage, lots };
    }

    if (path === '/api/stream' && method === 'GET') {
      const since = Number(url.searchParams.get('since'));

      if (since < this.keptFrom) {
        return { v: 4, latest: this.pass, groups: 1, k: 1, expired: true, more: false, page: this.streamPage, batches: [] };
      }

      const batches = [];
      const last = Math.min(this.pass, since + this.streamPage);

      for (let pass = since + 1; pass <= last; pass++) {
        const entries: Uint8Array[] = [];

        for (const { key, deltas } of this.batches.get(pass) ?? []) {
          const secrets = await this.secrets(key);

          for (const [index, delta] of deltas.entries()) {
            entries.push(await sealEntry(secrets.transitKey, pass, index, delta));
          }
        }

        while (entries.length < PER_BATCH) {
          entries.push(decoyEntry());
        }

        batches.push({ pass, entries: toBase64Url(concat(entries)) });
      }

      return { v: 4, latest: this.pass, groups: 1, k: this.channels.size, expired: false, more: last < this.pass, page: this.streamPage, batches };
    }

    if (path.startsWith('/api/handles') && method === 'GET') {
      if (this.noIndex) {
        return null;
      }

      // Built once, as the server stores it, and rebuilt only when the catalog changes: random
      // decoys drawn anew at each request would move the chunks' bounds between two requests.
      const shape = JSON.stringify([this.handleChunks, [...this.channels].map(([key, channel]) => [key, channel.source, channel.handle])]);

      if (this.handleIndex?.shape !== shape) {
        this.handleIndex = { shape, chunks: await this.buildHandleIndex() };
      }

      const { chunks } = this.handleIndex;

      return path === '/api/handles' ? { v: 3, chunks: chunks.map((chunk) => toBase64Url(chunk.slice(0, 16))) } : { v: 3, entries: toBase64Url(chunks[Number(path.split('/').at(-1))]!) };
    }

    if (path === '/api/add' && method === 'POST') {
      const link = body.url ?? '';
      const id = /UC[\w-]{22}/.exec(link)?.[0];
      const channel = this.online.get(link) ?? (id === undefined ? undefined : this.channels.get(`youtube:${id}`));

      if (channel === undefined) {
        return null;
      }

      const key = `${channel.source}:${channel.externalId}`;
      this.added.push(key);
      const cases = [...(this.thumbnails.get(key) ?? [])].map(([itemId, image]) => thumbnailCodec.encode({ kind: 'thumbnail', itemId, image }));

      while (cases.length < ADD_THUMBNAILS) {
        cases.push(thumbnailCodec.encode({ kind: 'empty' }));
      }

      return { v: 5, channel: toBase64Url(snapshotChannelCodec.encode(channel)), thumbnails: toBase64Url(concat(cases)) };
    }

    return undefined;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  parts.forEach((part) => {
    all.set(part, at);
    at += part.length;
  });

  return all;
}
