import { cmac } from '@noble/ciphers/aes.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import type { DBCore, DBCoreCursor, DBCoreIndex, DBCoreKeyRange, DBCoreMutateRequest, DBCoreMutateResponse, DBCoreTable, Middleware } from 'dexie';
import type { SubifyDb } from './db';

/**
 * Everything the app keeps about the user is sealed on the device with a random key, made at the
 * first launch. The key stays on the device until the user asks the app to lock: it is then sealed
 * by Face ID / a fingerprint (WebAuthn PRF), by a password, or both. A passkey whose password manager
 * gives no key (no PRF) still locks the app, as a door: the key stays on the device, and the app opens
 * it only once the passkey has confirmed it's the user. The sealing sits under Dexie,
 * so the rest of the app reads and writes plain values: each row is stored as its sealed value,
 * plus the fields its indexes need. Dates, order of addition and status stay readable; channel and video ids become
 * keyed hashes, so a copy of the database names no channel and no video.
 *
 * The ciphers are synchronous (@noble/ciphers): awaiting WebCrypto inside a transaction would let
 * IndexedDB commit it half-way.
 */

/** The password's minimum length: a PIN of 6 digits is one too, and the sheet says how fast it would fall (strength.ts). */
export const MINIMUM_PASSWORD_LENGTH = 6;

/** When the app asks to be unlocked again: at each opening, at each return, after some minutes unused, or never (the key is then kept on the device). */
export type LockAfter = 'open' | 'foreground' | 5 | 15 | 60 | 'never';

export const LOCK_AFTER_CHOICES: readonly { value: LockAfter; label: string }[] = [
  { value: 'open', label: 'Each time the app opens' },
  { value: 'foreground', label: 'Each time you come back to it' },
  { value: 5, label: 'After 5 minutes unused' },
  { value: 15, label: 'After 15 minutes unused' },
  { value: 60, label: 'After 60 minutes unused' },
];

/** What the keyring table holds: the key, sealed by each way of unlocking it. Never sealed itself. */
export interface Keyring {
  id: 'local';
  /** Null without a password. */
  kdf: { salt: Uint8Array; iterations: number; memoryKiB: number } | null;
  /** The key, sealed with the password's key. Null without a password. */
  password: Uint8Array | null;
  /**
   * Face ID / a fingerprint, on: the key sealed with what the device's passkey gives for `salt`
   * (WebAuthn PRF), or null when the passkey gives nothing: the key then stays on the device
   * (`key`), opened once the passkey confirms it's the user.
   */
  biometrics: { credential: string; salt: Uint8Array; sealed: Uint8Array | null } | null;
  /**
   * The device's passkey, kept once Face ID is off, so that turning it on again makes no new one.
   */
  passkey?: { credential: string; salt: Uint8Array };
  /** The key itself: when the app never asks, or when its passkey gives no key (`keepsKey`). */
  key: Uint8Array | null;
  lockAfter: LockAfter;
  /** Wrong passwords in a row, and until when the next one has to wait. */
  attempts?: { failures: number; until: number };
}

/** The answer to a password: wrong ones make the next wait after a few (`waitUntil`). */
export type PasswordCheck = { ok: true } | { ok: false; waitUntil: number | null };

/** Wrong passwords or PINs allowed before the app makes the user wait, then twice as long each time. */
const FREE_ATTEMPTS = 5;
const FIRST_WAIT = 30_000;

/** Until when the attempt after `failures` wrong ones in a row waits: 0 for no wait. */
export function waitAfter(failures: number, now: number): number {
  return failures >= FREE_ATTEMPTS ? now + FIRST_WAIT * 2 ** (failures - FREE_ATTEMPTS) : 0;
}

export class LockedError extends Error {
  override readonly name = 'LockedError';

  constructor() {
    super('The app is locked.');
  }
}

interface Keys {
  /** 64 bytes: what the keyring seals. */
  master: Uint8Array;
  seal: Uint8Array;
  hash: Uint8Array;
}

type State = { kind: 'plain' } | { kind: 'locked' } | { kind: 'open'; keys: Keys };

/** Whether the database is sealed and, if so, whether its key is in memory. */
export class LocalCipher {
  state: State = { kind: 'plain' };

  get isOpen(): boolean {
    return this.state.kind === 'open';
  }
}

const KEY_BYTES = 64;
const KDF = { iterations: 2, memoryKiB: 64 * 1024 };
/** A keyring asking for more is refused: it would freeze the app at each unlock. */
const MAX_KDF = { iterations: 4, memoryKiB: 256 * 1024 };

export async function readKeyring(db: SubifyDb): Promise<Keyring | undefined> {
  return db.keyring.get('local');
}

/**
 * At launch: no keyring yet is a first visit; a key kept because the app never asks opens at once;
 * otherwise locked, a key kept for a passkey without one included.
 */
export async function startVault(db: SubifyDb): Promise<'setup' | 'locked' | 'open'> {
  const keyring = await readKeyring(db);

  if (keyring === undefined) {
    db.cipher.state = { kind: 'plain' };

    return 'setup';
  }

  if (keyring.key !== null && keyring.lockAfter === 'never') {
    db.cipher.state = { kind: 'open', keys: deriveKeys(keyring.key) };

    return 'open';
  }

  db.cipher.state = { kind: 'locked' };

  return 'locked';
}

/**
 * Makes the key and seals what the device already holds, in one transaction. The key stays on the
 * device (“never”) until the user sets a way to unlock and asks the app to lock.
 */
export async function createVault(db: SubifyDb, random: (bytes: number) => Uint8Array = randomBytes): Promise<void> {
  const master = random(KEY_BYTES);
  const keyring: Keyring = { id: 'local', kdf: null, password: null, biometrics: null, key: master, lockAfter: 'never' };

  await db.transaction('rw', [db.subscriptions, db.items, db.thumbnails, db.meta, db.keyring], async () => {
    const rows = {
      subscriptions: await db.subscriptions.toArray(),
      items: await db.items.toArray(),
      thumbnails: await db.thumbnails.toArray(),
      meta: await db.meta.toArray(),
    };

    await Promise.all([db.subscriptions.clear(), db.items.clear(), db.thumbnails.clear(), db.meta.clear()]);
    db.cipher.state = { kind: 'open', keys: deriveKeys(master) };

    try {
      await db.subscriptions.bulkPut(rows.subscriptions);
      await db.items.bulkPut(rows.items);
      await db.thumbnails.bulkPut(rows.thumbnails);
      await db.meta.bulkPut(rows.meta);
      await db.keyring.put(keyring);
    } catch (error) {
      db.cipher.state = { kind: 'plain' };
      throw error;
    }
  });
}

/** Whether the app can be locked: a password, or Face ID, whether its passkey gives the key or not. */
export function canUnlock(keyring: Keyring | undefined): boolean {
  return (keyring?.password ?? null) !== null || (keyring?.biometrics ?? null) !== null;
}

/**
 * Whether the key stays on the device: when the app never asks, or when Face ID is on with a
 * passkey that gives no key, which could not open it otherwise.
 */
function keepsKey(keyring: Pick<Keyring, 'lockAfter' | 'biometrics'>): boolean {
  return keyring.lockAfter === 'never' || (keyring.biometrics !== null && keyring.biometrics.sealed === null);
}

/** Opens the database with the password. Wrong, it counts towards the wait. */
export async function unlockWithPassword(db: SubifyDb, password: string, now = Date.now()): Promise<PasswordCheck> {
  const result = await tryPassword(db, password, now);

  if (result.master !== null) {
    await opened(db, result.master);

    return { ok: true };
  }

  return { ok: false, waitUntil: result.waitUntil };
}

/**
 * Opens the database with the key kept for a passkey that gives none. Only once that passkey has
 * confirmed it's the user (verifyBiometrics): this is the door it guards.
 */
export async function unlockWithKeptKey(db: SubifyDb): Promise<boolean> {
  const keyring = await readKeyring(db);

  if (keyring?.key == null || keyring.biometrics === null) {
    return false;
  }

  db.cipher.state = { kind: 'open', keys: deriveKeys(keyring.key) };

  return true;
}

/** Opens the database with what the passkey gave. False when it doesn't open the key. */
export async function unlockWithBiometrics(db: SubifyDb, output: Uint8Array): Promise<boolean> {
  const sealed = (await readKeyring(db))?.biometrics?.sealed ?? null;
  const master = sealed === null ? null : openBytes(output, sealed, aad('biometrics'));

  if (master !== null) {
    await opened(db, master);
  }

  return master !== null;
}

/** An unlock puts back a key the device should keep and doesn't (a passkey without one, turned on before this version). */
async function opened(db: SubifyDb, master: Uint8Array): Promise<void> {
  db.cipher.state = { kind: 'open', keys: deriveKeys(master) };
  const keyring = await readKeyring(db);

  if (keyring !== undefined && keepsKey(keyring) && keyring.key === null) {
    await db.keyring.update('local', { key: master });
  }
}

/** Forgets the key in memory. A key kept on the device (“never”) stays. */
export function lockVault(db: SubifyDb): void {
  if (db.cipher.state.kind === 'open') {
    db.cipher.state = { kind: 'locked' };
  }
}

/** Whether a password is the app's, without opening anything. Wrong, it counts towards the wait. */
export async function checkAppPassword(db: SubifyDb, password: string, now = Date.now()): Promise<PasswordCheck> {
  const result = await tryPassword(db, password, now);

  return result.master !== null ? { ok: true } : { ok: false, waitUntil: result.waitUntil };
}

/** Only while unlocked: sets the password, or replaces it. */
export async function setPassword(db: SubifyDb, password: string, random: (bytes: number) => Uint8Array = randomBytes): Promise<void> {
  checkLength(password);
  const keys = openKeys(db);
  const salt = random(16);
  const passwordKey = await stretch(password, salt, KDF.iterations, KDF.memoryKiB);
  await db.keyring.update('local', { kdf: { salt, ...KDF }, password: sealBytes(passwordKey, keys.master, aad('password'), random) });
}

export async function changePassword(db: SubifyDb, current: string, next: string, now = Date.now(), random: (bytes: number) => Uint8Array = randomBytes): Promise<PasswordCheck> {
  checkLength(next);
  const check = await checkAppPassword(db, current, now);

  if (check.ok) {
    await setPassword(db, next, random);
  }

  return check;
}

/**
 * Only while unlocked: “never” keeps the key on the device; any other choice needs a way to
 * unlock, and removes the key unless a passkey without one needs it.
 */
export async function setLockAfter(db: SubifyDb, lockAfter: LockAfter): Promise<void> {
  const keys = openKeys(db);
  const keyring = await readKeyring(db);

  if (keyring === undefined || (lockAfter !== 'never' && !canUnlock(keyring))) {
    throw new Error('Nothing would unlock the app.');
  }

  await db.keyring.update('local', { lockAfter, key: keepsKey({ ...keyring, lockAfter }) ? keys.master : null });
}

/** Turns Face ID on with the device's passkey. `output` is what it gives, null when it gives nothing. */
export async function addBiometrics(
  db: SubifyDb,
  credential: string,
  salt: Uint8Array,
  output: Uint8Array | null,
  random: (bytes: number) => Uint8Array = randomBytes,
): Promise<void> {
  const keys = openKeys(db);
  const keyring = await readKeyring(db);

  if (keyring === undefined) {
    return;
  }

  const biometrics = { credential, salt, sealed: output === null ? null : sealBytes(output, keys.master, aad('biometrics'), random) };
  await db.keyring.update('local', { biometrics, passkey: { credential, salt }, key: keepsKey({ ...keyring, biometrics }) ? keys.master : null });
}

/** Remembers the device's passkey, made but not used yet, so that the next try uses it rather than making another. */
export async function rememberPasskey(db: SubifyDb, credential: string, salt: Uint8Array): Promise<void> {
  await db.keyring.update('local', { passkey: { credential, salt } });
}

/**
 * Only while unlocked: Face ID off. The passkey is remembered, to be used again. Without a
 * password, nothing else unlocks the app: it then opens without asking. With one, the key the
 * passkey may have kept on the device goes.
 */
export async function removeBiometrics(db: SubifyDb): Promise<void> {
  const keys = openKeys(db);
  const keyring = await readKeyring(db);

  if (keyring === undefined) {
    return;
  }

  const passkey = keyring.passkey ?? (keyring.biometrics === null ? undefined : { credential: keyring.biometrics.credential, salt: keyring.biometrics.salt });
  const lockAfter = keyring.password === null ? 'never' : keyring.lockAfter;
  const key = keepsKey({ lockAfter, biometrics: null }) ? keys.master : null;
  await db.keyring.update('local', { biometrics: null, ...(passkey === undefined ? {} : { passkey }), lockAfter, key });
}

/** The key, if the password opens it. Wrong, it counts towards the wait: a PIN is short. */
async function tryPassword(db: SubifyDb, password: string, now: number): Promise<{ master: Uint8Array } | { master: null; waitUntil: number | null }> {
  const attempts = (await readKeyring(db))?.attempts ?? { failures: 0, until: 0 };

  if (now < attempts.until) {
    return { master: null, waitUntil: attempts.until };
  }

  const master = await masterFromPassword(db, password);

  if (master !== null) {
    if (attempts.failures > 0) {
      await db.keyring.update('local', { attempts: { failures: 0, until: 0 } });
    }

    return { master };
  }

  const failures = attempts.failures + 1;
  const until = waitAfter(failures, now);
  await db.keyring.update('local', { attempts: { failures, until } });

  return { master: null, waitUntil: until === 0 ? null : until };
}

async function masterFromPassword(db: SubifyDb, password: string): Promise<Uint8Array | null> {
  const keyring = await readKeyring(db);

  if (keyring === undefined || keyring.kdf === null || keyring.password === null) {
    return null;
  }

  const { salt, iterations, memoryKiB } = keyring.kdf;

  if (iterations > MAX_KDF.iterations || memoryKiB > MAX_KDF.memoryKiB) {
    return null;
  }

  return openBytes(await stretch(password, salt, iterations, memoryKiB), keyring.password, aad('password'));
}

function openKeys(db: SubifyDb): Keys {
  if (db.cipher.state.kind !== 'open') {
    throw new LockedError();
  }

  return db.cipher.state.keys;
}

function checkLength(password: string): void {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`The password needs at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
}

/** hash-wasm loads only when a password is checked, not with the app. */
async function stretch(password: string, salt: Uint8Array, iterations: number, memoryKiB: number): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm');

  return argon2id({ password, salt, iterations, memorySize: memoryKiB, parallelism: 1, hashLength: 32, outputType: 'binary' });
}

function deriveKeys(master: Uint8Array): Keys {
  return { master, seal: master.slice(0, 32), hash: master.slice(32, 64) };
}

function aad(...parts: string[]): Uint8Array {
  return new TextEncoder().encode(['subify-local', ...parts].join('|'));
}

const NONCE_BYTES = 24;

function sealBytes(key: Uint8Array, plaintext: Uint8Array, associated: Uint8Array, random: (bytes: number) => Uint8Array = randomBytes): Uint8Array {
  const nonce = random(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, associated).encrypt(plaintext);
  const sealed = new Uint8Array(NONCE_BYTES + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, NONCE_BYTES);

  return sealed;
}

function openBytes(key: Uint8Array, sealed: Uint8Array, associated: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, sealed.subarray(0, NONCE_BYTES), associated).decrypt(sealed.subarray(NONCE_BYTES));
  } catch {
    return null;
  }
}

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

// --- The sealing middleware ---

interface TableSpec {
  /** Whether the primary key is a channel or video id, stored as a keyed hash. */
  hashKey: boolean;
  /** Fields kept readable for their indexes. */
  clear: readonly string[];
  /** Fields stored as a keyed hash for their indexes. */
  hashed: readonly string[];
}

const SEALED: Record<string, TableSpec> = {
  subscriptions: { hashKey: true, clear: ['addedAt', 'status'], hashed: [] },
  items: { hashKey: true, clear: ['published', 'upcoming'], hashed: ['channel'] },
  thumbnails: { hashKey: true, clear: [], hashed: ['channel'] },
  meta: { hashKey: false, clear: [], hashed: [] },
};

/** Settings the locked screen needs, stored readable: nothing about the user's channels. */
const CLEAR_META = new Set(['theme']);

const RANGE_EQUAL = 1;
const RANGE_ANY = 3;
const RANGE_NEVER = 4;

export function sealing(cipher: LocalCipher): Middleware<DBCore> {
  return {
    stack: 'dbcore',
    name: 'sealing',
    create: (down) => ({
      ...down,
      table: (name) => {
        const table = down.table(name);
        const spec = SEALED[name];

        return spec === undefined ? table : sealedTable(table, name, spec, cipher);
      },
    }),
  };
}

interface Row {
  key: string;
  /** The real key, sealed: only for hashed keys. */
  x?: Uint8Array;
  v: Uint8Array;
  [field: string]: unknown;
}

function isSealedRow(row: unknown): row is Row {
  return typeof row === 'object' && row !== null && (row as { v?: unknown }).v instanceof Uint8Array;
}

function sealedTable(table: DBCoreTable, name: string, spec: TableSpec, cipher: LocalCipher): DBCoreTable {
  const clearKey = (key: unknown) => !spec.hashKey && typeof key === 'string' && CLEAR_META.has(key);

  /** The keys, null while nothing is sealed yet. */
  const keys = (): Keys | null => {
    switch (cipher.state.kind) {
      case 'plain':
        return null;
      case 'locked':
        throw new LockedError();
      case 'open':
        return cipher.state.keys;
    }
  };

  const hash = (keys: Keys, value: unknown): unknown =>
    typeof value === 'string' ? toBase64Url(cmac(new TextEncoder().encode(value), keys.hash)) : value;
  const stored = (keys: Keys, key: unknown) => (spec.hashKey ? hash(keys, key) : key);

  const seal = (keys: Keys, value: Record<string, unknown>): unknown => {
    if (clearKey(value.key)) {
      return value;
    }

    const key = stored(keys, value.key) as string;
    const row: Row = { key, v: sealBytes(keys.seal, encodeValue(value), aad(name, key)) };

    for (const field of spec.clear) {
      if (value[field] !== undefined) {
        row[field] = value[field];
      }
    }

    for (const field of spec.hashed) {
      row[field] = hash(keys, value[field]);
    }

    if (spec.hashKey) {
      row.x = sealBytes(keys.seal, new TextEncoder().encode(String(value.key)), aad(name, key, 'key'));
    }

    return row;
  };

  const open = (row: unknown): unknown => {
    if (!isSealedRow(row)) {
      return row;
    }

    const opened = openBytes(sealKey(), row.v, aad(name, row.key));

    if (opened === null) {
      throw new Error(`A row of ${name} doesn’t open with this key.`);
    }

    return decodeValue(opened);
  };

  const realKey = (row: unknown): unknown => {
    if (!isSealedRow(row) || !spec.hashKey) {
      return (row as { key?: unknown } | undefined)?.key;
    }

    const opened = row.x === undefined ? null : openBytes(sealKey(), row.x, aad(name, row.key, 'key'));

    if (opened === null) {
      throw new Error(`A key of ${name} doesn’t open with this key.`);
    }

    return new TextDecoder().decode(opened);
  };

  // A sealed row read without the key means the app is locked, whatever the state says.
  const sealKey = (): Uint8Array => {
    if (cipher.state.kind !== 'open') {
      throw new LockedError();
    }

    return cipher.state.keys.seal;
  };

  const hashedParts = (index: DBCoreIndex): boolean[] => {
    const paths = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath ?? 'key'];

    return paths.map((path) => (index.isPrimaryKey ? spec.hashKey : spec.hashed.includes(path)));
  };

  const translateKey = (keys: Keys, index: DBCoreIndex, key: unknown): unknown => {
    const parts = hashedParts(index);

    if (Array.isArray(index.keyPath)) {
      return (key as unknown[]).map((part, i) => (parts[i] ? hash(keys, part) : part));
    }

    return parts[0] ? hash(keys, key) : key;
  };

  const translateRange = (keys: Keys, index: DBCoreIndex, range: DBCoreKeyRange): DBCoreKeyRange => {
    const parts = hashedParts(index);

    if (!parts.includes(true) || range.type === RANGE_ANY || range.type === RANGE_NEVER) {
      return range;
    }

    const compound = Array.isArray(index.keyPath);
    const lower = compound ? (range.lower as unknown[]) : [range.lower];
    const upper = compound ? (range.upper as unknown[]) : [range.upper];
    const exact = parts.every((hashed, i) => !hashed || (typeof lower[i] === 'string' && lower[i] === upper[i]));

    if (!exact || (!compound && range.type !== RANGE_EQUAL && (range.lowerOpen || range.upperOpen))) {
      throw new Error(`Only exact values can be looked up in ${name}.${String(index.name)}: they are stored as hashes.`);
    }

    return { ...range, lower: translateKey(keys, index, range.lower), upper: translateKey(keys, index, range.upper) };
  };

  const indexKey = (index: DBCoreIndex, cursor: DBCoreCursor, value: () => Record<string, unknown>, primaryKey: () => unknown): unknown => {
    const parts = hashedParts(index);

    if (!parts.includes(true)) {
      return cursor.key;
    }

    if (index.isPrimaryKey) {
      return primaryKey();
    }

    if (Array.isArray(index.keyPath)) {
      return index.keyPath.map((path, i) => (parts[i] ? value()[path] : (cursor.key as unknown[])[i]));
    }

    return value()[index.keyPath as string];
  };

  return {
    ...table,

    mutate: async (req: DBCoreMutateRequest) => {
      const k = keys();

      if (k === null) {
        return table.mutate(req);
      }

      switch (req.type) {
        case 'add':
        case 'put': {
          const realKeys = req.values.map((value) => (value as { key: unknown }).key);
          const { criteria: _criteria, changeSpec: _changeSpec, updates: _updates, ...rest } = req as typeof req & { criteria?: unknown; changeSpec?: unknown; updates?: unknown };
          const sealedReq = { ...rest, values: req.values.map((value) => seal(k, value as Record<string, unknown>)) };

          if (Array.isArray(rest.keys)) {
            sealedReq.keys = rest.keys.map((key) => stored(k, key));
          }

          const result = await table.mutate(sealedReq);

          // Dexie expects the keys the app wrote, not their hashes.
          const response: DBCoreMutateResponse = {
            numFailures: result.numFailures,
            failures: result.failures,
            lastResult: result.lastResult === undefined ? undefined : realKeys[realKeys.length - 1],
          };

          if (result.results !== undefined) {
            response.results = result.results.map((_, i) => realKeys[i]);
          }

          return response;
        }
        case 'delete':
          return table.mutate({ ...req, keys: req.keys.map((key) => stored(k, key)) });
        case 'deleteRange':
          return table.mutate({ ...req, range: translateRange(k, table.schema.primaryKey, req.range) });
      }
    },

    get: async (req) => {
      if (clearKey(req.key)) {
        return table.get(req);
      }

      const k = keys();

      return k === null ? refuseSealed(await table.get(req)) : open(await table.get({ ...req, key: stored(k, req.key) }));
    },

    getMany: async (req) => {
      const k = keys();

      if (k === null) {
        return (await table.getMany(req)).map(refuseSealed);
      }

      return (await table.getMany({ ...req, keys: req.keys.map((key) => stored(k, key)) })).map(open);
    },

    count: async (req) => {
      const k = keys();

      return table.count(k === null ? req : { ...req, query: { ...req.query, range: translateRange(k, req.query.index, req.query.range) } });
    },

    query: async (req) => {
      const k = keys();

      if (k === null) {
        const result = await table.query(req);

        return req.values ? { ...result, result: result.result.map(refuseSealed) } : result;
      }

      const query = { ...req.query, range: translateRange(k, req.query.index, req.query.range) };
      const keysOnly = !req.values;

      if (keysOnly && !spec.hashKey) {
        return table.query({ ...req, query });
      }

      const result = await table.query({ ...req, query, values: true });

      return { ...result, result: result.result.map(keysOnly ? realKey : open) };
    },

    openCursor: async (req) => {
      const k = keys();

      if (k === null) {
        return table.openCursor(req);
      }

      const { index } = req.query;
      const cursor = await table.openCursor({ ...req, values: true, query: { ...req.query, range: translateRange(k, index, req.query.range) } });

      if (cursor === null) {
        return null;
      }

      // Opened once per position, however many times Dexie reads it.
      let at: unknown;
      let opened: Record<string, unknown> | undefined;
      const value = () => {
        if (opened === undefined || at !== cursor.primaryKey) {
          at = cursor.primaryKey;
          opened = open(cursor.value) as Record<string, unknown>;
        }

        return opened;
      };
      const primaryKey = () => (spec.hashKey ? value().key : cursor.primaryKey);

      return Object.create(cursor, {
        value: { get: value },
        primaryKey: { get: primaryKey },
        key: { get: () => indexKey(index, cursor, value, primaryKey) },
        continue: { value: (key?: unknown) => (key === undefined ? cursor.continue() : cursor.continue(translateKey(k, index, key))) },
        continuePrimaryKey: { value: (key: unknown, primary: unknown) => cursor.continuePrimaryKey(translateKey(k, index, key), stored(k, primary)) },
      }) as DBCoreCursor;
    },
  };
}

/** Before any key is set, a sealed row means a locked database read too early. */
function refuseSealed(row: unknown): unknown {
  if (isSealedRow(row)) {
    throw new LockedError();
  }

  return row;
}

/** JSON, with binary fields (avatars' bytes, slot ids, thumbnails) kept as base64. */
function encodeValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, function (this: Record<string, unknown>, key, json: unknown) {
      const raw = this[key];

      if (raw instanceof Uint8Array) {
        return { $u8: toBase64Url(raw) };
      }

      if (raw instanceof ArrayBuffer) {
        return { $ab: toBase64Url(new Uint8Array(raw)) };
      }

      return json;
    }),
  );
}

function decodeValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes), (_, json: unknown) => {
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;

      if (typeof record.$u8 === 'string' && Object.keys(record).length === 1) {
        return fromBase64Url(record.$u8);
      }

      if (typeof record.$ab === 'string' && Object.keys(record).length === 1) {
        return fromBase64Url(record.$ab).buffer;
      }
    }

    return json;
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
