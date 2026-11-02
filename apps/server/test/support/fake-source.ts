import type { ItemType } from '@subify/shared';
import { UpstreamError } from '../../src/http';
import type { Image } from '../../src/sources/image';
import {
  type ChannelSnapshot,
  type IncomingItem,
  InputError,
  type ParsedInput,
  type PollContext,
  type PollResult,
  type ResolvedChannel,
  type SourceAdapter,
} from '../../src/sources/source';

/**
 * A made-up video platform. Tests use it to drive the catalog with exactly the items they need,
 * and to show the catalog and the sync work without anything YouTube-specific. Links look like
 * `fake:<channel id>`.
 */
export class FakeSource implements SourceAdapter {
  readonly source = 'fake';
  readonly hosts = new Set(['fake.test']);
  private readonly channels = new Map<string, ChannelSnapshot & { version: number }>();
  /** Every poll, in order, with what the catalog sent along. */
  readonly polls: { id: string; context: PollContext }[] = [];
  /** Channels whose next polls fail, and how many times. */
  readonly failing = new Map<string, number>();
  /** Avatars and thumbnails by URL: null when the platform has none. Any other URL fails. */
  readonly images = new Map<string, Image | null>();
  /** Every image URL read, in order. */
  readonly imageReads: string[] = [];
  /** By channel: the links its items' descriptions hold, sent with each of its snapshots. */
  readonly mentions = new Map<string, ParsedInput[]>();

  /** Makes a channel exist on the platform, with these items. */
  channel(id: string, items: IncomingItem[] = [], title = `Channel ${id}`): this {
    this.channels.set(id, { title, items, version: 1 });

    return this;
  }

  /** Publishes more items on an existing channel, or changes ones with the same id. */
  publish(id: string, ...items: IncomingItem[]): this {
    const channel = this.channels.get(id)!;
    const byId = new Map(channel.items.map((item) => [item.externalId, item]));
    items.forEach((item) => byId.set(item.externalId, item));
    channel.items = [...byId.values()];
    channel.version++;

    return this;
  }

  parseInput(raw: string): ParsedInput | null {
    const match = /^fake:(\w+)$/.exec(raw.trim());

    return match?.[1] === undefined ? null : { kind: 'channel', externalId: match[1] };
  }

  async resolve(input: ParsedInput): Promise<ResolvedChannel> {
    if (input.kind !== 'channel') {
      throw new InputError('invalid_link', 'Not a fake channel.');
    }

    return { kind: 'resolved', externalId: input.externalId, confirmed: false, title: null, handle: null, iconUrl: null };
  }

  async readAvatar(iconUrl: string): Promise<Image | null> {
    return this.readImage(iconUrl);
  }

  async readThumbnail(thumbnailUrl: string): Promise<Image | null> {
    return this.readImage(thumbnailUrl);
  }

  smallThumbnailUrl(itemId: string): string {
    return `https://fake.test/small/${itemId}`;
  }

  private readImage(url: string): Image | null {
    this.imageReads.push(url);
    const image = this.images.get(url);

    if (image === undefined) {
      throw new UpstreamError('status', 500);
    }

    return image;
  }

  /** Channels whose page doesn't answer: the platform says nothing about whether they exist. */
  readonly pageDown = new Set<string>();

  async exists(externalId: string): Promise<boolean | null> {
    return this.pageDown.has(externalId) ? null : this.channels.has(externalId);
  }

  /** Removes a channel from the platform: its feed answers 404 from now on. */
  remove(id: string): this {
    this.channels.delete(id);

    return this;
  }

  async fetchLatest(externalId: string): Promise<ChannelSnapshot> {
    const channel = this.channels.get(externalId);

    if (channel === undefined) {
      throw new InputError('channel_not_found', 'No such fake channel.');
    }

    return { title: channel.title, items: structuredClone(channel.items), mentions: this.mentions.get(externalId) ?? [] };
  }

  /** Answers like a platform with ETags: unchanged since the last poll gives no snapshot. */
  async poll(externalId: string, _http: unknown, context: PollContext): Promise<PollResult> {
    this.polls.push({ id: externalId, context });
    const remaining = this.failing.get(externalId) ?? 0;

    if (remaining > 0) {
      this.failing.set(externalId, remaining - 1);
      throw new UpstreamError('status', 500);
    }

    const channel = this.channels.get(externalId);

    if (channel === undefined) {
      throw new UpstreamError('status', 404);
    }

    const etag = `"${channel.version}"`;
    const validators = new Map([['channel', { etag, lastModified: null }]]);
    const unchanged = !context.force && context.validators.get('channel')?.etag === etag;

    const snapshot = { title: channel.title, items: structuredClone(channel.items), mentions: this.mentions.get(externalId) ?? [] };

    return { snapshot: unchanged ? null : snapshot, validators };
  }
}

export function item(id: string, published: number, type: ItemType = 'video', title = `Video ${id}`): IncomingItem {
  return { externalId: id, title, url: `https://fake.test/watch/${id}`, thumbnailUrl: null, published, type };
}
