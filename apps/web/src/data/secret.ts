import { getMeta, setMeta, type SubifyDb } from './db';

/**
 * Secret channels stay out of sight until the user shows them. They lock with the app's lock (Face
 * ID / a fingerprint, or the app's password, which may be a PIN), as soon as it has one, unless the
 * user turned that off. A PIN of their own, from earlier versions or a backup they made, still
 * works until the app's password replaces it. This hides them from someone looking at the unlocked
 * app; the database itself is sealed by the app's lock (vault.ts).
 */

/**
 * How secret channels unlock: the app's lock, a PIN of their own (`secretCodeHash`), or not at all
 * (`off`, the user's choice). Never chosen: the app's lock, when it has one.
 */
export type SecretUnlock = 'app' | 'pin' | 'off';

export async function secretUnlock(db: SubifyDb): Promise<SecretUnlock | null> {
  const chosen = await getMeta<SecretUnlock>(db, 'secretUnlock');

  return chosen ?? ((await hasSecretCode(db)) ? 'pin' : null);
}

export const SECRET_CODE = /^\d{4,8}$/;

/**
 * The costliest hashes accepted, a little above what this app writes (Argon2id, 19 MiB, 2 passes).
 * The device computes the hash at each unlock: a crafted backup asking for gigabytes of memory
 * would freeze the app every time.
 */
const MAX_ARGON2_KIB = 64 * 1024;
const MAX_ARGON2_PASSES = 4;

/** Wrong codes allowed before the app makes the user wait. */
const FREE_ATTEMPTS = 5;
const FIRST_WAIT = 30_000;

interface Lock {
  failures: number;
  until: number;
}

export type UnlockResult = { ok: true } | { ok: false; waitUntil: number | null };

export async function hasSecretCode(db: SubifyDb): Promise<boolean> {
  return (await getMeta<string>(db, 'secretCodeHash')) !== undefined;
}

/** Only a hash is stored, so the code cannot be read back. */
export async function setSecretCode(db: SubifyDb, code: string, random: (bytes: number) => Uint8Array = randomBytes): Promise<void> {
  if (!SECRET_CODE.test(code)) {
    throw new Error('The code has 4 to 8 digits.');
  }

  const { argon2id } = await import('hash-wasm');
  const hash = await argon2id({ password: code, salt: random(16), iterations: 2, memorySize: 19_456, parallelism: 1, hashLength: 32, outputType: 'encoded' });
  await setMeta(db, 'secretCodeHash', hash);
}

/**
 * Compares a typed code with the stored hash. After 5 wrong codes, each new one makes the user
 * wait, twice as long each time.
 */
export async function checkSecretCode(db: SubifyDb, code: string, now = Date.now()): Promise<UnlockResult> {
  const lock = (await getMeta<Lock>(db, 'secretLock')) ?? { failures: 0, until: 0 };

  if (now < lock.until) {
    return { ok: false, waitUntil: lock.until };
  }

  const hash = await getMeta<string>(db, 'secretCodeHash');

  if (hash !== undefined && SECRET_CODE.test(code) && (await verify(code, hash))) {
    await db.meta.delete('secretLock');

    return { ok: true };
  }

  const failures = lock.failures + 1;
  const until = failures >= FREE_ATTEMPTS ? now + FIRST_WAIT * 2 ** (failures - FREE_ATTEMPTS) : 0;
  await setMeta(db, 'secretLock', { failures, until } satisfies Lock);

  return { ok: false, waitUntil: until === 0 ? null : until };
}

/**
 * A forgotten code cannot be recovered: the only way out is to remove the secret channels, with
 * their videos, and the code.
 */
export async function forgetSecretChannels(db: SubifyDb): Promise<void> {
  await db.transaction('rw', db.subscriptions, db.items, db.thumbnails, db.meta, async () => {
    const secret = await db.subscriptions.filter((subscription) => subscription.secret).primaryKeys();
    // One channel at a time: channel ids are stored as hashes, which a range of several can't span.
    for (const key of secret) {
      await db.items.where('channel').equals(key).delete();
      await db.thumbnails.where('channel').equals(key).delete();
    }

    await db.subscriptions.bulkDelete(secret);
    await db.meta.bulkDelete(['secretCodeHash', 'secretCredential', 'secretLock', 'secretUnlock']);
  });
}

/**
 * The card in the Channels tab that says channels can be kept secret: from the second channel,
 * until the user says “Got it” or makes one secret. Someone who already chose how they unlock, on
 * this device or in the backup they restored, knows them.
 */
export async function secretCardDue(db: SubifyDb): Promise<boolean> {
  // Read together: a live query (useLiveQuery) only watches what it reads before its first wait on
  // the vault's decryption, and the card must follow both the channels and its dismissal.
  const [done, unlock, channels] = await Promise.all([getMeta(db, 'secretCardDone'), secretUnlock(db), db.subscriptions.toArray()]);

  return done !== true && unlock === null && channels.length >= 2 && !channels.some((channel) => channel.secret);
}

export async function dismissSecretCard(db: SubifyDb): Promise<void> {
  await setMeta(db, 'secretCardDone', true);
}

/**
 * Called as a channel is about to become secret: whether this is the first one ever on this device,
 * which starts the short tour of where secret channels show again (SecretFlow). Once only; the
 * card has nothing left to say after it.
 */
export async function beginSecretTour(db: SubifyDb): Promise<boolean> {
  if ((await getMeta(db, 'secretTourDone')) === true || (await secretUnlock(db)) !== null || (await db.subscriptions.filter((channel) => channel.secret).count()) > 0) {
    return false;
  }

  await db.meta.bulkPut([
    { key: 'secretTourDone', value: true },
    { key: 'secretCardDone', value: true },
  ]);

  return true;
}

/** Whether a secret code hash, such as one a backup brings, is one the app agrees to compute. */
export function secretHashAccepted(hash: string): boolean {
  const argon2 = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.exec(hash);

  if (argon2 === null) {
    return false;
  }

  const [memory, passes, lanes] = argon2.slice(1).map(Number) as [number, number, number];

  return memory <= MAX_ARGON2_KIB && passes >= 1 && passes <= MAX_ARGON2_PASSES && lanes === 1;
}

/** hash-wasm loads only when a code is checked, not with the app. */
async function verify(code: string, hash: string): Promise<boolean> {
  if (!secretHashAccepted(hash)) {
    return false;
  }

  const { argon2Verify } = await import('hash-wasm');

  try {
    return await argon2Verify({ password: code, hash });
  } catch {
    // A malformed hash never matches.
    return false;
  }
}

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}
