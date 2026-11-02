import { isIos } from './install';

/**
 * Face ID, Touch ID or a fingerprint to show secret channels, through a WebAuthn passkey. The
 * device keeps it in the password manager the user picks (Apple Passwords, Bitwarden…), never
 * Subify's server, and the app only checks that the device verified the user for the challenge it
 * just made. For secret channels it guards the screen; to unlock the app, the passkey also gives
 * the key that opens the database (WebAuthn PRF).
 */

/**
 * Every iPhone and iPad can make the credential (iOS sets up what it lacks), but since iOS 26.2
 * the detection can answer no there, Face ID or not: iOS is not asked.
 */
export async function biometricsAvailable(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (isIos(navigator.userAgent, navigator.maxTouchPoints) || (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()))
    );
  } catch {
    return false;
  }
}

/** Creates the credential, after the user verified with the device. Returns its id, to store. */
export async function enrollBiometrics(): Promise<string> {
  const credential = await createCredential('Secret channels');

  if (credential === null) {
    throw new Error('No credential was created.');
  }

  return toBase64Url(new Uint8Array(credential.rawId));
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

/**
 * Whether the browser can turn a passkey into a key (WebAuthn PRF: iOS 18.4+ with iCloud
 * Keychain, Android with Google Password Manager). A browser that can't tell yet counts as able:
 * enrolling checks it for real.
 */
export async function biometricsKeyAvailable(): Promise<boolean> {
  if (!(await biometricsAvailable())) {
    return false;
  }

  try {
    const capabilities = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.();

    return capabilities?.['extension:prf'] !== false;
  } catch {
    return true;
  }
}

/**
 * Creates a passkey that unlocks the app: what it gives for `salt` is the key that opens the
 * database's key. null when the device made no passkey, or one that gives no key.
 */
export async function enrollBiometricsKey(): Promise<{ credential: string; salt: Uint8Array; output: Uint8Array } | null> {
  const salt = randomBytes(32);
  const created = await createCredential('Unlock Subify', salt);

  if (created === null) {
    return null;
  }

  const credential = toBase64Url(new Uint8Array(created.rawId));
  const prf = (created.getClientExtensionResults() as PrfResults).prf;

  if (prf?.enabled === false) {
    return null;
  }

  // Most devices only give the key when the passkey is used, not when it is made.
  const first = prf?.results?.first;
  const output = first === undefined ? await biometricsKey(credential, salt) : toBytes(first);

  return output === null ? null : { credential, salt, output };
}

/** Asks the device to verify the user, and returns what the passkey gives for `salt`. */
export async function biometricsKey(credentialId: string, salt: Uint8Array): Promise<Uint8Array | null> {
  const challenge = randomBytes(32);

  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    const response = credential?.response as AuthenticatorAssertionResponse | undefined;

    if (credential === null || response === undefined || !assertionVerifiesUser(response.clientDataJSON, response.authenticatorData, challenge, location.origin)) {
      return null;
    }

    const first = (credential.getClientExtensionResults() as PrfResults).prf?.results?.first;

    return first === undefined ? null : toBytes(first);
  } catch {
    return null;
  }
}

function toBytes(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

async function createCredential(name: string, prfSalt?: Uint8Array): Promise<PublicKeyCredential | null> {
  return (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Subify' },
      user: { id: randomBytes(16), name, displayName: name },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60_000,
      ...(prfSalt === undefined ? {} : { extensions: { prf: { eval: { first: prfSalt } } } }),
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
}

/** Asks the device to verify the user. True only when it did, for this challenge and this app. */
export async function verifyBiometrics(credentialId: string): Promise<boolean> {
  const challenge = randomBytes(32);

  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    const response = credential?.response as AuthenticatorAssertionResponse | undefined;

    return response !== undefined && assertionVerifiesUser(response.clientDataJSON, response.authenticatorData, challenge, location.origin);
  } catch {
    return false;
  }
}

/**
 * Whether an assertion answers this challenge, from this origin, with the user present and
 * verified (flags UP and UV of the authenticator data).
 */
export function assertionVerifiesUser(clientDataJSON: ArrayBuffer, authenticatorData: ArrayBuffer, challenge: Uint8Array, origin: string): boolean {
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };

  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as typeof clientData;
  } catch {
    return false;
  }

  const flags = new Uint8Array(authenticatorData)[32] ?? 0;
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;

  return clientData.type === 'webauthn.get' && clientData.challenge === toBase64Url(challenge) && clientData.origin === origin && userPresent && userVerified;
}

function randomBytes(count: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(count));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
