import { isIos } from './install';

/**
 * Face ID, Touch ID, a fingerprint or Windows Hello, through one WebAuthn passkey per device. The
 * device keeps it in its password manager (Passwords on Apple devices, Google Password Manager on
 * Android, Windows Hello on Windows, or the one the user set up instead), never Subify's server,
 * and the app checks itself that the device verified the user for the challenge it just made. The
 * same passkey shows secret channels and, when it gives a key (WebAuthn PRF), unlocks the app.
 *
 * The passkey is made with the same user id each time on a device (`passkeyUser`, in the sealed
 * `meta`): a password manager that meets it again replaces the passkey instead of adding one. The
 * id never leaves the device and isn't in backups.
 */

export type Platform = 'ios' | 'mac' | 'android' | 'windows' | 'other';

export function platformOf(userAgent: string, maxTouchPoints: number): Platform {
  if (isIos(userAgent, maxTouchPoints)) {
    return 'ios';
  }

  if (/Android/.test(userAgent)) {
    return 'android';
  }

  if (/Macintosh/.test(userAgent)) {
    return 'mac';
  }

  return /Windows/.test(userAgent) ? 'windows' : 'other';
}

export function thisPlatform(): Platform {
  return platformOf(navigator.userAgent, navigator.maxTouchPoints);
}

/** How the passkey checks it's the user, on each kind of device: what the setting mentions under “Passkey”. */
export function biometricsLabel(platform: Platform): string {
  switch (platform) {
    case 'ios':
      return 'Face ID or Touch ID';
    case 'mac':
      return 'Touch ID';
    case 'android':
      return 'Fingerprint or face';
    case 'windows':
      return 'Windows Hello';
    case 'other':
      return 'Face ID or fingerprint';
  }
}

/** The name the passkey carries in the password manager, so that each device's is told apart. */
export function deviceName(userAgent: string, maxTouchPoints: number): string {
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) {
    return 'iPad';
  }

  if (/iPhone|iPod/.test(userAgent)) {
    return 'iPhone';
  }

  if (/Android/.test(userAgent)) {
    return /Mobile/.test(userAgent) ? 'Android phone' : 'Android tablet';
  }

  if (/Macintosh/.test(userAgent)) {
    return 'Mac';
  }

  if (/Windows/.test(userAgent)) {
    return 'Windows PC';
  }

  return /CrOS/.test(userAgent) ? 'Chromebook' : 'Computer';
}

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

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };

/**
 * Why no passkey came: the user closed the device's sheet, or the device showed none, most often
 * because no password manager keeps passkeys there (Passwords turned off on an iPhone).
 */
export type PasskeyFailure = 'cancelled' | 'unavailable';

export type Enrolled = { credential: string; salt: Uint8Array; output: Uint8Array | null };

/**
 * Made, but not used yet: the device asks for the passkey again to give its key, and the user
 * closed that sheet. On an iPhone it lists only Passwords' passkeys: one kept in another password
 * manager hides behind “More from…”. The passkey exists, so it is kept, to be used next time.
 */
export type Unconfirmed = { credential: string; salt: Uint8Array; unconfirmed: true };

/**
 * A refusal this fast came before the user could see a sheet: the device had nowhere to keep the
 * passkey. A heuristic, since WebAuthn answers NotAllowedError in both cases.
 */
const NO_SHEET_MS = 1000;

/**
 * Makes the device's passkey, after the user verified with it. `output` is the key it gives for
 * `salt` (WebAuthn PRF), null when it gives none: it then only guards secret channels.
 */
export async function createPasskey(userId: Uint8Array, now: () => number = () => performance.now()): Promise<Enrolled | Unconfirmed | PasskeyFailure> {
  const salt = randomBytes(32);
  const name = deviceName(navigator.userAgent, navigator.maxTouchPoints);
  const started = now();
  let created: PublicKeyCredential | null;

  try {
    created = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Subify' },
        user: { id: userId as Uint8Array<ArrayBuffer>, name, displayName: `Subify on ${name}` },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
  } catch (error) {
    const cancelled = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError') && now() - started >= NO_SHEET_MS;

    return cancelled ? 'cancelled' : 'unavailable';
  }

  if (created === null) {
    return 'cancelled';
  }

  const credential = toBase64Url(new Uint8Array(created.rawId));
  const prf = (created.getClientExtensionResults() as PrfResults).prf;
  const first = prf?.results?.first;

  if (first !== undefined) {
    return { credential, salt, output: toBytes(first) };
  }

  if (prf?.enabled === false) {
    return { credential, salt, output: null };
  }

  // Most devices only give the key when the passkey is used, not when it is made.
  const used = await askPasskey(credential, salt);

  return used === null ? { credential, salt, unconfirmed: true } : { credential, salt, output: used.output };
}

/**
 * Asks the device to verify the user with the passkey. Null when it didn't, for this challenge and
 * this app; otherwise what the passkey gives for `salt`, null when it gives nothing.
 */
export async function askPasskey(credentialId: string, salt?: Uint8Array): Promise<{ output: Uint8Array | null } | null> {
  const challenge = randomBytes(32);

  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
        ...(salt === undefined ? {} : { extensions: { prf: { eval: { first: salt } } } }),
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    const response = credential?.response as AuthenticatorAssertionResponse | undefined;

    if (credential === null || response === undefined || !assertionVerifiesUser(response.clientDataJSON, response.authenticatorData, challenge, location.origin)) {
      return null;
    }

    const first = (credential.getClientExtensionResults() as PrfResults).prf?.results?.first;

    return { output: first === undefined ? null : toBytes(first) };
  } catch {
    return null;
  }
}

/** Asks the device to verify the user. True only when it did, for this challenge and this app. */
export async function verifyBiometrics(credentialId: string): Promise<boolean> {
  return (await askPasskey(credentialId)) !== null;
}

function toBytes(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
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
