import { voprfKeys, type VoprfKeys } from '@subify/shared/oprf';

/**
 * The keys the server derives from its one master secret (docs/FEATURES.md, D16): an AES-256-GCM
 * key for what it stores, its VOPRF key pair, and an HMAC key for the contact form's robot
 * checks. The master secret never reaches the database or the repository; losing it makes the
 * catalog unreadable.
 */
export interface ServerKeys {
  /** Written at the start of every blob, so that a later key can be told from this one. */
  keyId: number;
  aes: AesKey;
  voprf: VoprfKeys;
  /** Signs the contact form's robot checks (src/contact.ts). */
  challenges: HmacKey;
}

/** CryptoKey, named the same way on Node and Workers. */
type AesKey = Awaited<ReturnType<typeof crypto.subtle.deriveKey>>;
type HmacKey = AesKey;

export const MASTER_SECRET_BYTES = 32;
/** The first key. A rotation would derive the next one under another id, and keep reading this one. */
const KEY_ID = 1;

export async function deriveKeys(masterSecret: Uint8Array): Promise<ServerKeys> {
  if (masterSecret.length !== MASTER_SECRET_BYTES) {
    throw new RangeError(`The master secret must be ${MASTER_SECRET_BYTES} bytes`);
  }

  const base = await crypto.subtle.importKey('raw', new Uint8Array(masterSecret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const info = (label: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(`subify ${label} ${KEY_ID}`) });
  const aes = await crypto.subtle.deriveKey(info('aes-256-gcm'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const seed = new Uint8Array(await crypto.subtle.deriveBits(info('voprf'), base, 256));

  const challenges = await crypto.subtle.deriveKey(info('challenges'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);

  return { keyId: KEY_ID, aes, voprf: voprfKeys(seed), challenges };
}
