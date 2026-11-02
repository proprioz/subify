import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertionVerifiesUser, biometricsAvailable, toBase64Url } from '../src/ui/biometrics';

const ORIGIN = 'https://subify.example';
const challenge = new Uint8Array([1, 2, 3, 4, 250, 251, 252]);

function assertion({ type = 'webauthn.get', sentChallenge = toBase64Url(challenge), origin = ORIGIN, flags = 0x05 } = {}) {
  const clientData = new TextEncoder().encode(JSON.stringify({ type, challenge: sentChallenge, origin })).buffer as ArrayBuffer;
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = flags;

  return [clientData, authenticatorData.buffer] as const;
}

// A check that lets an answer through without a verified user, or for another challenge, would show secret channels to anyone.
describe('a biometric answer', () => {
  it('counts when it answers our challenge, from our origin, with the user verified', () => {
    expect(assertionVerifiesUser(...assertion(), challenge, ORIGIN)).toBe(true);
  });

  it.each([
    ['another challenge', { sentChallenge: toBase64Url(new Uint8Array([9, 9, 9])) }],
    ['another origin', { origin: 'https://evil.example' }],
    ['a registration instead of a sign-in', { type: 'webauthn.create' }],
    ['a user present but not verified', { flags: 0x01 }],
    ['no user present', { flags: 0x04 }],
  ])('does not count with %s', (_, override) => {
    expect(assertionVerifiesUser(...assertion(override), challenge, ORIGIN)).toBe(false);
  });
});

// Since iOS 26.2, the detection can answer no on an iPhone with Face ID: trusting it there hid the offer.
describe('biometrics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1', 5, true],
    ['an iPad, which presents itself as a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15', 5, true],
    ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15', 0, false],
    ['an Android phone', 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36', 5, false],
  ])('when the detection says no, on %s', async (_, userAgent, maxTouchPoints, offered) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
    vi.stubGlobal('PublicKeyCredential', { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false) });

    expect(await biometricsAvailable()).toBe(offered);
  });

  it('are not offered without WebAuthn, even on an iPhone', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X)', maxTouchPoints: 5 });

    expect(await biometricsAvailable()).toBe(false);
  });
});
