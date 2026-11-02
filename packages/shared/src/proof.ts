/**
 * The contact form's robot check: a proof of work in ALTCHA's format (https://altcha.org), so
 * that its libraries could take over without changing the protocol. The server signs a challenge:
 * the SHA-256 of a salt and a secret number up to `maxnumber`. The device finds the number by
 * trying them all, which takes a second or two, and sends it back. No third party, no cookie, no
 * image to read: what it costs a robot is time.
 */

export interface ProofChallenge {
  algorithm: 'SHA-256';
  /** Hex SHA-256 of `salt` followed by the number, in decimal. */
  challenge: string;
  maxnumber: number;
  /** Random hex, then `?expires=` and a time in seconds since the Unix epoch. */
  salt: string;
  /** Hex HMAC-SHA-256 of `challenge` under the server's key: the device can't make its own. */
  signature: string;
}

/** What the device sends back, as ALTCHA does: this JSON, in base64. */
export interface ProofSolution {
  algorithm: 'SHA-256';
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Hashes this many numbers at once: one digest at a time leaves the browser's crypto idle between them. */
const BATCH = 500;

/**
 * The solved challenge, ready to send, or null when no number up to `maxnumber` matches (a
 * challenge this server didn't make). `signal` stops the search, when the form closes.
 */
export async function solveChallenge(challenge: ProofChallenge, signal?: AbortSignal): Promise<string | null> {
  for (let start = 0; start <= challenge.maxnumber; start += BATCH) {
    signal?.throwIfAborted();

    const numbers = Array.from({ length: Math.min(BATCH, challenge.maxnumber - start + 1) }, (_, index) => start + index);
    const hashes = await Promise.all(numbers.map((number) => sha256Hex(`${challenge.salt}${number}`)));
    const found = hashes.indexOf(challenge.challenge);

    if (found !== -1) {
      const { algorithm, salt, signature } = challenge;
      const solution: ProofSolution = { algorithm, challenge: challenge.challenge, number: numbers[found]!, salt, signature };

      return btoa(JSON.stringify(solution));
    }
  }

  return null;
}
