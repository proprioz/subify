import { MAX_SYNC_CHANNELS } from '@subify/shared';
import type { Api } from './api';
import { BackupError, isSealed, MINIMUM_PASSWORD_LENGTH, open, seal } from './backup-cipher';
import { ALL_TYPES, getMeta, setMeta, type ShownType, type SubifyDb } from './db';
import { type ChannelSort, loadShowUpcoming, loadTypeFilter, type TypeFilter } from './feed';
import { followMany, type FollowManyResult } from './follow-many';
import { connectionCheckOn } from './connection-check';
import { secretHashAccepted } from './secret';
import type { Theme } from './settings';

/**
 * A backup holds the channels, the feed filters and sort, the theme, the connection check and the
 * secret code's hash, sealed with a password. Videos are not saved: they come back from the server.
 *
 * The payload is spelled out here rather than taken from the app's types, so that renaming a field
 * in the app never changes the file. A new PAYLOAD_VERSION must keep reading every earlier one
 * (test/fixtures/backup-v1.json).
 */

const PAYLOAD_VERSION = 1;
const CHANNEL_KEY = /^youtube:UC[0-9A-Za-z_-]{22}$/;
const SORTS: readonly ChannelSort[] = ['recent', 'oldest', 'name', 'name-desc'];
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

interface Payload {
  version: number;
  exportedAt: string;
  channels: { key: string; title: string; handle: string | null; secret: boolean; types: ShownType[] }[];
  typeFilter: { video: boolean; live: boolean; short: boolean };
  showUpcoming: boolean;
  channelSort: ChannelSort;
  theme: Theme;
  checkConnection: boolean;
  secretCodeHash: string | null;
}

export interface Backup {
  channels: { key: string; title: string; handle: string | null; secret: boolean; types: ShownType[] }[];
  typeFilter: TypeFilter;
  showUpcoming: boolean;
  channelSort: ChannelSort;
  secretCodeHash: string | null;
  theme: Theme;
  checkConnection: boolean;
}

export async function exportBackup(db: SubifyDb, password: string, now = Date.now()): Promise<string> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new BackupError(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }

  const filter = await loadTypeFilter(db);
  const subscriptions = await db.subscriptions.orderBy('addedAt').toArray();
  const payload: Payload = {
    version: PAYLOAD_VERSION,
    exportedAt: new Date(now).toISOString(),
    channels: subscriptions.map(({ key, title, handle, secret, types }) => ({ key, title, handle, secret, types })),
    typeFilter: { video: filter.video, live: filter.live, short: filter.short },
    showUpcoming: await loadShowUpcoming(db),
    channelSort: (await getMeta<ChannelSort>(db, 'channelSort')) ?? 'recent',
    theme: (await getMeta<Theme>(db, 'theme')) ?? 'system',
    checkConnection: await connectionCheckOn(db),
    secretCodeHash: (await getMeta<string>(db, 'secretCodeHash')) ?? null,
  };

  const file = await seal(JSON.stringify(payload), password);
  await setMeta(db, 'lastExportAt', now);

  return file;
}

/** Whether the file looks like a backup, before asking for its password. */
export function isBackupFile(file: string): boolean {
  return isSealed(file);
}

/** Opens and checks a backup file. Throws BackupError with a sentence the app can show. */
export async function readBackup(file: string, password: string): Promise<Backup> {
  const text = await open(file, password);
  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new BackupError('This backup file is damaged.');
  }

  return parsePayload(payload);
}

/**
 * Replaces everything on the device with the backup, then follows its channels like an import:
 * those the catalog knows at once, with the thumbnails of their last 7 days, the others through
 * the queue, one at a time. The backup holds no thumbnail: they come back from the server.
 */
export async function restoreBackup(db: SubifyDb, api: Api, backup: Backup, now = Date.now()): Promise<FollowManyResult> {
  await db.transaction('rw', db.subscriptions, db.items, db.thumbnails, db.meta, async () => {
    await db.items.clear();
    await db.thumbnails.clear();
    await db.subscriptions.clear();
    // An approval remembered for the connection check belongs to this device, never to a backup.
    // Biometrics too: the restored device asks for the code first.
    await db.meta.bulkDelete(['queueNextAt', 'secretLock', 'connectionTrust', 'secretCredential', 'secretUnlock']);
    await setMeta(db, 'typeFilter', backup.typeFilter);
    await setMeta(db, 'showUpcoming', backup.showUpcoming);
    await setMeta(db, 'checkConnection', backup.checkConnection);
    await setMeta(db, 'channelSort', backup.channelSort);
    await setMeta(db, 'theme', backup.theme);

    if (backup.secretCodeHash === null) {
      await db.meta.delete('secretCodeHash');
    } else {
      await setMeta(db, 'secretCodeHash', backup.secretCodeHash);
    }
  });

  return followMany(db, api, backup.channels, now, { thumbnails: true });
}

function parsePayload(value: unknown): Backup {
  const payload = value as Partial<Payload> | null;

  if (payload === null || typeof payload !== 'object' || payload.version !== PAYLOAD_VERSION) {
    throw new BackupError('This backup was made by a version of the app this one doesn’t know.');
  }

  const { channels, typeFilter, secretCodeHash } = payload;

  if (!Array.isArray(channels) || typeFilter === undefined || typeFilter === null) {
    throw new BackupError('This backup file is incomplete.');
  }

  // Checked before the restore replaces anything: a backup the device could not sync is refused whole.
  if (channels.length > MAX_SYNC_CHANNELS) {
    throw new BackupError(`This backup holds ${channels.length.toLocaleString('en')} channels; the app can follow up to ${MAX_SYNC_CHANNELS.toLocaleString('en')}.`);
  }

  const filter: TypeFilter = { video: typeFilter.video !== false, live: typeFilter.live !== false, short: typeFilter.short !== false };

  if (!ALL_TYPES.some((type) => filter[type])) {
    throw new BackupError('This backup turns every kind of video off.');
  }

  const hash = typeof secretCodeHash === 'string' ? secretCodeHash : null;

  if (hash !== null && !secretHashAccepted(hash)) {
    throw new BackupError('The secret code in this backup is invalid.');
  }

  return {
    channels: channels.map((channel) => {
      if (typeof channel?.key !== 'string' || !CHANNEL_KEY.test(channel.key)) {
        throw new BackupError('A channel in this backup is invalid.');
      }

      const types = Array.isArray(channel.types) ? channel.types.filter((type) => ALL_TYPES.includes(type)) : [];

      return {
        key: channel.key,
        title: typeof channel.title === 'string' && channel.title !== '' ? channel.title : channel.key.slice(channel.key.indexOf(':') + 1),
        handle: typeof channel.handle === 'string' ? channel.handle : null,
        secret: channel.secret === true,
        types: types.length > 0 ? types : [...ALL_TYPES],
      };
    }),
    typeFilter: filter,
    showUpcoming: payload.showUpcoming !== false,
    channelSort: SORTS.includes(payload.channelSort as ChannelSort) ? (payload.channelSort as ChannelSort) : 'recent',
    secretCodeHash: hash,
    theme: THEMES.includes(payload.theme as Theme) ? (payload.theme as Theme) : 'system',
    checkConnection: payload.checkConnection === true,
  };
}
