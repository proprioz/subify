import { type ApiChannel, type ApiItem, BLIND_BATCH_SIZES, type OprfKeyResponse, STREAM_KEPT_PASSES } from '@subify/shared';
import {
  chunkOf,
  fromBase64Url,
  openEntries,
  openHandleEntry,
  openSnapshotEntry,
  openSnapshotThumbnails,
  type SlotImage,
  type SnapshotChannel,
  type StreamDelta,
  snapshotChannelCodec,
  thumbnailCodec,
  toBase64Url,
} from '@subify/shared/codec';
import { type Api, ServerError } from './api';
import { itemUrl } from './channel-link';
import type { OnStep } from './subscriptions';
import { getMeta, putItems, setRetryAt, type Slot, type StoredThumbnail, type Subscription, type SubifyDb, setMeta } from './db';

/**
 * The app on a server with the encrypted catalog (docs/FEATURES.md, D16). It finds its channels
 * without naming them: a blind evaluation gives each one's slot and key, and it then downloads
 * whole groups (snapshots and the sync stream) and opens only its own entries. A channel is named
 * to the server only when the catalog doesn't have it, through POST /api/add.
 */

export type CatalogKey = OprfKeyResponse;

/** The VOPRF code, loaded only once the app needs it. */
const oprf = () => import('@subify/shared/oprf');

/** A channel found online, kept in memory until the user follows it. */
export interface NewChannel {
  channel: ApiChannel;
  items: ApiItem[];
  /** See Subscription.retryAt. */
  retryAt: number | null;
  /** Where following it starts the sync: a pass of the stream, or nothing to start from. */
  start: { pass: number } | null;
  slot?: Slot;
  thumbnails: Omit<StoredThumbnail, 'channel'>[];
}

/** Slots of these VOPRF inputs, in batches padded with random inputs to an allowed size. */
async function evaluate(api: Api, catalog: CatalogKey, inputs: readonly Uint8Array[]): Promise<Slot[]> {
  const { blind, channelSecrets, finalize } = await oprf();
  const largest = BLIND_BATCH_SIZES.at(-1)!;
  const slots: Slot[] = [];

  for (let i = 0; i < inputs.length; i += largest) {
    const chunk = inputs.slice(i, i + largest);
    const size = BLIND_BATCH_SIZES.find((allowed) => allowed >= chunk.length)!;
    const request = blind([...chunk, ...Array.from({ length: size - chunk.length }, () => crypto.getRandomValues(new Uint8Array(32)))]);
    const answer = await api.evaluate(request.blinded.map(toBase64Url));
    // Throws when the proof doesn't match the published key: such an answer would give wrong slots.
    const outputs = finalize(request, { evaluated: answer.evaluated.map(fromBase64Url), proof: fromBase64Url(answer.proof) }, fromBase64Url(catalog.publicKey));

    for (const output of outputs.slice(0, chunk.length)) {
      const secrets = await channelSecrets(output);
      slots.push({ keyId: catalog.keyId, id: secrets.slotId, key: secrets.transitKey });
    }
  }

  return slots;
}

/** Computes the slots the followed channels lack, or have under an older key. */
export async function ensureSlots(db: SubifyDb, api: Api, catalog: CatalogKey): Promise<void> {
  const { channelInput } = await oprf();
  const missing = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot?.keyId !== catalog.keyId);

  if (missing.length === 0) {
    return;
  }

  const slots = await evaluate(api, catalog, missing.map((subscription) => channelInput(subscription.source, externalId(subscription.key))));

  await db.transaction('rw', db.subscriptions, async () => {
    for (const [i, subscription] of missing.entries()) {
      await db.subscriptions.update(subscription.key, { slot: slots[i]! });
    }
  });
}

/**
 * A channel the catalog has, by its key or by the first of these @handles the handle index knows
 * (a handle typed, or those a name gives), or null. Two blind evaluations for handles.
 */
export async function findInCatalog(
  api: Api,
  catalog: CatalogKey,
  input: { key: string } | { handles: readonly string[] },
  onStep: OnStep = () => {},
): Promise<NewChannel | null> {
  const { channelInput, handleInput } = await oprf();
  let key: string;

  if ('key' in input) {
    key = input.key;
  } else {
    if (input.handles.length === 0) {
      return null;
    }

    onStep({ kind: 'blind', inputs: input.handles.length });
    const entries = await evaluate(api, catalog, input.handles.map((handle) => handleInput('youtube', handle)));
    const target = await readHandles(api, entries, onStep);

    if (target === null) {
      return null;
    }

    key = `${target.source}:${target.externalId}`;
  }

  onStep({ kind: 'blind', inputs: 1 });
  const [slot] = await evaluate(api, catalog, [channelInput(key.slice(0, key.indexOf(':')), externalId(key))]);
  onStep({ kind: 'group' });
  const found = await readSnapshots(api, [slot!], true);
  const channel = found.channels.get(hexOf(slot!.id));

  if (channel === undefined) {
    return null;
  }

  const converted = toApi(channel);

  return { ...converted, start: { pass: found.pass }, slot: slot!, thumbnails: thumbnailsOf(converted.channel.key, found.thumbnails.get(hexOf(slot!.id)) ?? new Map()) };
}

/**
 * The channel the first of these handles' entries leads to in the handle index, or null. The
 * chunks read are those of the entries when they all fall in one, else every chunk: the set of
 * chunks a name's guesses fall in would point the server to the name.
 */
async function readHandles(api: Api, entries: readonly Slot[], onStep: OnStep): Promise<{ source: string; externalId: string } | null> {
  try {
    const bounds = (await api.handleBounds()).chunks.map(fromBase64Url);
    const wanted = new Set(entries.map((entry) => chunkOf(bounds, entry.id)));
    const read = wanted.size === 1 ? [...wanted] : bounds.map((_, chunk) => chunk);
    const chunks = new Map<number, Uint8Array>();

    for (const [index, chunk] of read.entries()) {
      onStep({ kind: 'handles', chunk: index + 1, chunks: read.length });
      chunks.set(chunk, fromBase64Url((await api.handleChunk(chunk)).entries));
    }

    for (const entry of entries) {
      const target = await openHandleEntry(entry.id, entry.key, chunks.get(chunkOf(bounds, entry.id))!);

      if (target !== null) {
        return target;
      }
    }

    return null;
  } catch (error) {
    // No index yet: the server's first hourly build hasn't run.
    if (error instanceof ServerError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

/** Adds a channel by link the clear way: the server reads it online if the catalog doesn't have it. */
export async function addByLink(api: Api, url: string): Promise<NewChannel> {
  const answer = await api.add(url);
  const converted = toApi(snapshotChannelCodec.decode(fromBase64Url(answer.channel)));
  const cases = fromBase64Url(answer.thumbnails);
  const images = new Map<string, SlotImage>();

  for (let at = 0; at < cases.length; at += thumbnailCodec.size) {
    const payload = thumbnailCodec.decode(cases.subarray(at, at + thumbnailCodec.size));

    if (payload.kind === 'thumbnail') {
      images.set(payload.itemId, payload.image);
    }
  }

  return { ...converted, start: null, thumbnails: thumbnailsOf(converted.channel.key, images) };
}

interface Snapshots {
  /** By slot id in hex: the channels found. */
  channels: Map<string, SnapshotChannel>;
  thumbnails: Map<string, Map<string, SlotImage>>;
  /** The earliest pass among the snapshots read: the stream continues from there. */
  pass: number;
}

/**
 * Reads the snapshots of every group these slots are in, each group once. The number of groups
 * comes from the server's answer: when it changed since the last time, the groups are worked out
 * again.
 */
async function readSnapshots(api: Api, slots: readonly Slot[], withThumbnails: boolean, knownGroups = 1): Promise<Snapshots> {
  const { groupOf } = await oprf();
  const found: Snapshots = { channels: new Map(), thumbnails: new Map(), pass: Infinity };
  const groups = new Map<number, Slot[]>();
  slots.forEach((slot) => groups.set(groupOf(slot.id, knownGroups), [...(groups.get(groupOf(slot.id, knownGroups)) ?? []), slot]));

  for (const [group, members] of groups) {
    const answer = await api.snapshot(group, withThumbnails);

    if (answer.groups !== knownGroups) {
      return readSnapshots(api, slots, withThumbnails, answer.groups);
    }

    const entries = fromBase64Url(answer.entries);
    const thumbnails = fromBase64Url(answer.thumbnails);
    found.pass = Math.min(found.pass, answer.pass);

    for (const slot of members) {
      const channel = await openSnapshotEntry(slot.id, slot.key, entries);

      if (channel !== null) {
        found.channels.set(hexOf(slot.id), channel);
        found.thumbnails.set(hexOf(slot.id), await openSnapshotThumbnails(slot.key, answer.pass, thumbnails));
      }
    }
  }

  return found;
}

/** Waits this long after adding a channel before resubmitting it for a missing slot: it enters at the next pass. */
const SLOT_GRACE = 60 * 60_000;

/**
 * Fills the followed channels from their groups' snapshots: after a restore, at the first refresh
 * on this server, or after a longer absence than the stream keeps. A channel the catalog lacks
 * goes back to the import queue (the safety net), unless it is gone or was added in clear within
 * the hour.
 * Sets the stream's cursor when it has none, or is past what the snapshots show.
 */
export async function catchUp(db: SubifyDb, api: Api, catalog: CatalogKey, now = Date.now()): Promise<{ found: number }> {
  await ensureSlots(db, api, catalog);
  const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');
  const snapshots = await readSnapshots(api, subscriptions.map((subscription) => subscription.slot!), false);
  let found = 0;

  await db.transaction('rw', db.subscriptions, db.items, db.meta, async () => {
    for (const subscription of subscriptions) {
      const channel = snapshots.channels.get(hexOf(subscription.slot!.id));

      if (channel !== undefined) {
        const converted = toApi(channel);
        await db.subscriptions.update(subscription.key, (stored) => {
          Object.assign(stored, { title: converted.channel.title, handle: converted.channel.handle, avatar: converted.channel.avatar, status: 'ready' });
          delete stored.submittedAt;
          setRetryAt(stored, converted.retryAt);
        });
        await putItems(db, converted.items);
        found++;
      } else if (subscription.status === 'ready' && (subscription.submittedAt ?? 0) < now - SLOT_GRACE) {
        await db.subscriptions.update(subscription.key, { status: 'pending_submit' });
      }
    }

    if (subscriptions.length > 0) {
      await setMeta(db, 'streamPass', snapshots.pass);
      // The snapshots show where every channel stands: a sync cut short has nothing left to read.
      await db.meta.delete('streamRun');
    }
  });

  return { found };
}

/** A `since` past any pass the stream will reach: the answer gives `latest` alone. */
const LATEST_ONLY = 999_999_999;

/** Groups asked for at once, for each page. */
const PARALLEL = 6;

/**
 * A sync under way, kept so that one cut short resumes where it stopped: it has read the passes in
 * (below, top], newest first; those in (streamPass, below] are left.
 */
interface StreamRun {
  top: number;
  below: number;
  /** Batches per answer, as the server pages them. */
  page: number;
}

/** Whether a sync started before was cut short, the app closed meanwhile: the user may resume it. */
export async function unfinishedSync(db: SubifyDb): Promise<boolean> {
  return (await getMeta<StreamRun>(db, 'streamRun')) !== undefined;
}

/**
 * Brings the followed channels up to date from the sync stream, newest first: it learns the latest
 * pass, then reads its groups' pages back from there to the last pass it has, so the feed shows
 * the latest videos first after a long absence. Each page is written in one transaction with where
 * the sync stands, so an app suspended mid-sync (iOS does that) resumes where it stopped, without a
 * duplicate or a gap. A change older than one already written for the same item or channel is
 * skipped. Without a cursor, or further behind than the stream keeps, it catches up from snapshots
 * instead, as it does an hour after a channel was added in clear. `onProgress` gets the share of
 * the passes read, from 0 to 1.
 */
export async function syncStream(db: SubifyDb, api: Api, catalog: CatalogKey, now = Date.now(), onProgress: (share: number) => void = () => {}): Promise<{ written: number }> {
  const { groupOf } = await oprf();
  await ensureSlots(db, api, catalog);
  let written = 0;
  const unchecked = (await db.subscriptions.toArray()).some((subscription) => subscription.status === 'ready' && subscription.submittedAt !== undefined && subscription.submittedAt < now - SLOT_GRACE);

  // A channel added in clear over an hour ago should be in the catalog by now: the snapshots tell.
  if (unchecked && (await getMeta<number>(db, 'streamPass')) !== undefined) {
    await catchUp(db, api, catalog, now);
  }

  for (;;) {
    const since = await getMeta<number>(db, 'streamPass');
    const subscriptions = (await db.subscriptions.toArray()).filter((subscription) => subscription.slot !== undefined && subscription.status !== 'gone');

    if (subscriptions.length === 0) {
      await db.meta.delete('streamRun');

      return { written };
    }

    if (since === undefined) {
      await catchUp(db, api, catalog, now);
      continue;
    }

    let run = await getMeta<StreamRun>(db, 'streamRun');

    if (run === undefined) {
      const latest = await api.stream(LATEST_ONLY, 0);
      await setMeta(db, 'streamGroups', latest.groups);

      // A catalog started over, or further behind than the stream keeps: snapshots tell the rest.
      if (latest.latest < since || since + 1 <= latest.latest - STREAM_KEPT_PASSES) {
        await catchUp(db, api, catalog, now);
        continue;
      }

      if (latest.latest === since) {
        onProgress(1);

        return { written };
      }

      run = { top: latest.latest, below: latest.latest, page: latest.page };
      await setMeta(db, 'streamRun', run);
    }

    onProgress(run.top === since ? 1 : (run.top - run.below) / (run.top - since));
    const from = Math.max(since, run.below - run.page);
    const groups = (await getMeta<number>(db, 'streamGroups')) ?? 1;
    const wanted = [...new Set(subscriptions.map((subscription) => groupOf(subscription.slot!.id, groups)))];
    const pages = await inParallel(wanted, PARALLEL, async (group) => ({ group, page: await api.stream(from, group) }));
    const regrouped = pages.find(({ page }) => page.groups !== groups);

    if (regrouped !== undefined) {
      await setMeta(db, 'streamGroups', regrouped.page.groups);
      continue;
    }

    if (pages.some(({ page }) => page.expired || page.latest < from)) {
      await catchUp(db, api, catalog, now);
      continue;
    }

    const changes: { subscription: Subscription; pass: number; deltas: StreamDelta[] }[] = [];

    for (const { group, page } of pages) {
      for (const subscription of subscriptions.filter((candidate) => groupOf(candidate.slot!.id, groups) === group)) {
        // Passes after `below` were read already: the page may reach past it on its last range.
        for (const batch of page.batches.filter((candidate) => candidate.pass <= run.below)) {
          const deltas = await openEntries(subscription.slot!.key, batch.pass, fromBase64Url(batch.entries));

          if (deltas.length > 0) {
            changes.push({ subscription, pass: batch.pass, deltas });
          }
        }
      }
    }

    const done = from === since;

    await db.transaction('rw', db.subscriptions, db.items, db.meta, async () => {
      for (const { subscription, pass, deltas } of changes) {
        // A channel removed while the page was on its way must not get its items back.
        if ((await db.subscriptions.get(subscription.key)) !== undefined) {
          written += await apply(db, subscription, pass, deltas);
        }
      }

      if (done) {
        await setMeta(db, 'streamPass', run.top);
        await db.meta.delete('streamRun');
      } else {
        await setMeta(db, 'streamRun', { ...run, below: from });
      }
    });

    if (done) {
      onProgress(1);

      return { written };
    }
  }
}

/** Applies one pass's changes of a channel, but not over a change from a later pass, read before. */
async function apply(db: SubifyDb, subscription: Subscription, pass: number, deltas: readonly StreamDelta[]): Promise<number> {
  const items: ApiItem[] = [];

  for (const delta of deltas) {
    switch (delta.kind) {
      case 'item': {
        const item = toApiItem(subscription.key, delta);

        if (((await db.items.get(item.key))?.pass ?? -1) < pass) {
          items.push(item);
        }

        break;
      }
      case 'channel':
        if (((await db.subscriptions.get(subscription.key))?.renamedAt ?? -1) < pass) {
          await db.subscriptions.update(subscription.key, { title: delta.title, handle: delta.handle, renamedAt: pass });
        }

        break;
      case 'gone':
        await db.subscriptions.update(subscription.key, { status: 'gone' });
        break;
      case 'retry':
        await db.subscriptions.update(subscription.key, (stored) => setRetryAt(stored, delta.retryAt));
        break;
    }
  }

  await putItems(db, items, pass);

  return items.length;
}

/** Runs `run` on every value, at most `limit` at a time, and gives the results in order. */
async function inParallel<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const at = next++;
        results[at] = await run(values[at]!);
      }
    }),
  );

  return results;
}

function toApiItem(channel: string, item: { id: string; title: string; published: number; type: ApiItem['type']; upcoming: boolean; deleted?: boolean }): ApiItem {
  const source = channel.slice(0, channel.indexOf(':'));

  return {
    key: `${source}:${item.id}`,
    channel,
    title: item.title,
    url: itemUrl(source, item.id, item.type),
    thumbnail: null,
    published: item.published,
    type: item.type,
    ...(item.deleted === true ? { deleted: true as const } : {}),
    ...(item.upcoming ? { upcoming: true as const } : {}),
  };
}

/** A channel as a snapshot or an addition gives it, as the app stores channels and items. */
export function toApi(channel: SnapshotChannel): { channel: ApiChannel; items: ApiItem[]; retryAt: number | null } {
  const key = `${channel.source}:${channel.externalId}`;

  return {
    channel: { key, source: channel.source, title: channel.title, handle: channel.handle, icon: null, avatar: channel.avatar === null ? null : dataUrl(channel.avatar) },
    items: channel.items.map((item) => toApiItem(key, item)),
    retryAt: channel.retryAt,
  };
}

function thumbnailsOf(channel: string, images: ReadonlyMap<string, SlotImage>): Omit<StoredThumbnail, 'channel'>[] {
  const source = channel.slice(0, channel.indexOf(':'));

  return [...images].map(([id, image]) => ({ key: `${source}:${id}`, type: image.type, data: image.bytes.slice().buffer }));
}

function dataUrl(image: SlotImage): string {
  let binary = '';
  image.bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return `data:${image.type};base64,${btoa(binary)}`;
}

function externalId(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
