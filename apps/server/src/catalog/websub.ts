import { userAgent } from '../config';
import { Http } from '../http';
import { logError } from '../log';
import type { Platform } from '../platform';
import type { SourceAdapter } from '../sources/source';
import { slotIdOf } from './slot-id';
import { hex, LEASE_SECONDS } from './tend';
import { enqueueUpdate } from './updates';
import { readSlot } from './vault';

/**
 * WebSub for the encrypted catalog (docs/FEATURES.md, D16). The callback URL names a channel by a
 * random token kept inside its slot, never by anything derived from the channel. The hub's
 * requests only read: what they change waits in the coordinator for the next pass.
 */

/** A slot's callback token: 16 random bytes in hex. */
const CALLBACK = /^[0-9a-f]{32}$/;

export interface Verification {
  channel: string;
  mode: string;
  topic: string;
  challenge: string;
  leaseSeconds: string | undefined;
}

/** The channel a callback is about, if its slot holds this token. */
async function slotOf(platform: Platform, source: SourceAdapter | undefined, token: string, externalId: string | null | undefined) {
  // Anything that is not such a token is refused without reading the database.
  if (!CALLBACK.test(token) || source === undefined || externalId === null || externalId === undefined) {
    return undefined;
  }

  const keys = await platform.keys;
  const slot = await readSlot(platform.db, keys, await slotIdOf(keys, source.source, externalId));

  if (slot?.payload.kind !== 'channel' || slot.payload.schedule.callbackToken === null || hex(slot.payload.schedule.callbackToken) !== token) {
    return undefined;
  }

  return { keys, source, channel: slot.payload };
}

/** The hub's GET to confirm a request. Returns the body to answer with, or null for a 404. */
export async function verifySubscription(platform: Platform, sources: readonly SourceAdapter[], request: Verification): Promise<string | null> {
  const source = sources.find((candidate) => (candidate.websub?.channelOfTopic(request.topic) ?? null) !== null);
  const found = await slotOf(platform, source, request.channel, source?.websub?.channelOfTopic(request.topic));

  if (found === undefined) {
    return null;
  }

  const { keys, channel } = found;

  if (request.mode === 'subscribe' && channel.schedule.websubStatus === 'pending' && request.challenge !== '') {
    const lease = Number(request.leaseSeconds);
    const seconds = Number.isInteger(lease) && lease > 0 ? Math.min(lease, LEASE_SECONDS) : LEASE_SECONDS;
    await enqueueUpdate(platform.coordinator, keys, {
      kind: 'websub',
      source: channel.source,
      externalId: channel.externalId,
      status: 'active',
      expiresAt: platform.clock.now() + seconds * 1000,
    });

    return request.challenge;
  }

  if (request.mode === 'denied' && channel.schedule.websubStatus !== 'off') {
    await enqueueUpdate(platform.coordinator, keys, { kind: 'websub', source: channel.source, externalId: channel.externalId, status: 'off', expiresAt: null });

    return '';
  }

  return null;
}

/**
 * A notification from the hub, acted upon only when its signature matches the secret in the
 * channel's slot. Answering comes first; the feeds are read after the response, and what they say
 * waits for the pass.
 */
export async function receiveNotification(platform: Platform, sources: readonly SourceAdapter[], token: string, body: string, signature: string | undefined): Promise<boolean> {
  const source = sources.find((candidate) => (candidate.websub?.parseNotification(body) ?? null) !== null);
  const notification = source?.websub?.parseNotification(body) ?? null;
  const found = await slotOf(platform, source, token, notification?.externalId);

  if (found === undefined || notification === null || found.channel.schedule.websubSecret === null || !(await signatureMatches(hex(found.channel.schedule.websubSecret), body, signature))) {
    return false;
  }

  const { keys, source: adapter, channel } = found;

  platform.afterResponse(
    (async () => {
      const update = { kind: 'feed' as const, source: channel.source, externalId: channel.externalId, title: '', items: [], dropped: [] as string[], deleted: notification.deletedIds };

      if (notification.videoIds.length > 0) {
        const known = channel.items.filter((item) => !item.deleted);
        const result = await adapter.poll(channel.externalId, new Http(platform.fetch, userAgent(platform.config), adapter.hosts), {
          validators: new Map(),
          knownTypes: new Map(known.map((item) => [item.id, item.type])),
          upcoming: new Set(known.filter((item) => item.upcoming).map((item) => item.id)),
          force: true,
          now: platform.clock.now(),
        });

        Object.assign(update, { title: result.snapshot?.title ?? '', items: result.snapshot?.items ?? [], dropped: result.droppedUpcoming ?? [], mentions: result.snapshot?.mentions ?? [] });
      }

      await enqueueUpdate(platform.coordinator, keys, update);
    })().catch((error: unknown) => logError('Handling a WebSub notification failed', error)),
  );

  return true;
}

const ALGORITHMS: Record<string, string> = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

/** `X-Hub-Signature: sha1=<hex>`, compared in constant time. */
export async function signatureMatches(secret: string, body: string, header: string | undefined): Promise<boolean> {
  const [method = '', expected = ''] = (header ?? '').split('=', 2);
  const algorithm = ALGORITHMS[method.toLowerCase()];

  if (algorithm === undefined || !/^[0-9a-f]+$/i.test(expected)) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  const actual = [...signed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const given = expected.toLowerCase();
  let difference = actual.length ^ given.length;

  for (let i = 0; i < actual.length; i++) {
    difference |= actual.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  }

  return difference === 0;
}
