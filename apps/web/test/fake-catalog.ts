import {
  decoyEntry,
  decoyHandleEntry,
  decoySnapshotEntry,
  decoySnapshotThumbnail,
  HANDLE_CHUNK_ENTRIES,
  HANDLE_ENTRY_SIZE,
  compareEntries,
  type SlotImage,
  type SnapshotChannel,
  type StreamDelta,
  sealEntry,
  sealHandleEntry,
  sealSnapshotEntry,
  sealSnapshotThumbnail,
  snapshotChannelCodec,
  thumbnailCodec,
  toBase64Url,
  fromBase64Url,
} from '@subify/shared/codec';
import { channelInput, channelSecrets, evaluate, evaluateBlinded, handleInput, voprfKeys } from '@subify/shared/oprf';

/** Entries per group in every stream batch, and thumbnails per snapshot: fixed, as on the real server. */
const PER_BATCH = 4;
const SNAPSHOT_THUMBNAILS = 6;
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
          channel.items = [{ id: delta.id, title: delta.title, published: delta.published, type: delta.type, upcoming: delta.upcoming }, ...channel.items.filter((item) => item.id !== delta.id)];
        } else if (delta.kind === 'channel') {
          channel.title = delta.title;
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
      const thumbnails: Uint8Array[] = [];

      for (const [key, channel] of this.channels) {
        const secrets = await this.secrets(key);
        entries.push(await sealSnapshotEntry(secrets.slotId, secrets.transitKey, channel));
        let index = 0;

        for (const [itemId, image] of this.thumbnails.get(key) ?? []) {
          thumbnails.push(await sealSnapshotThumbnail(secrets.transitKey, this.pass, index++, { kind: 'thumbnail', itemId, image }));
        }
      }

      entries.push(decoySnapshotEntry(crypto.getRandomValues(new Uint8Array(16))));

      while (thumbnails.length < SNAPSHOT_THUMBNAILS) {
        thumbnails.push(decoySnapshotThumbnail());
      }

      const withThumbnails = url.searchParams.get('thumbnails') === '1';

      return { v: 3, pass: this.pass, groups: 1, entries: toBase64Url(concat(entries)), thumbnails: withThumbnails ? toBase64Url(concat(thumbnails)) : '' };
    }

    if (path === '/api/stream' && method === 'GET') {
      const since = Number(url.searchParams.get('since'));

      if (since < this.keptFrom) {
        return { v: 3, latest: this.pass, groups: 1, k: 1, expired: true, more: false, batches: [] };
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

      return { v: 3, latest: this.pass, groups: 1, k: this.channels.size, expired: false, more: last < this.pass, batches };
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

      return { v: 3, channel: toBase64Url(snapshotChannelCodec.encode(channel)), thumbnails: toBase64Url(concat(cases)) };
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
