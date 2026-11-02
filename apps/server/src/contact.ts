import type { ContactChallengeResponse } from '@subify/shared';
import { type ProofSolution, sha256Hex } from '@subify/shared/proof';
import type { ContactRequest } from '@subify/shared/schemas';
import type { z } from 'zod';
import { HOUR, DAY, MINUTE } from './catalog/schedule';
import type { ServerKeys } from './crypto/keys';
import { logError } from './log';
import type { Platform } from './platform';

/**
 * The contact form: a message from anyone to whoever runs the server, sent by email to the
 * address its admin set (MESSAGES_TO), which no one else sees. The server keeps nothing of it.
 * What reaches the operator is plain text only, without invisible characters, with links made
 * unclickable. A robot check (packages/shared, proof.ts), a hidden field robots fill in, and a
 * ceiling on messages per hour and per day, all senders together, hold floods back; the limit per
 * address is the hosting platform's, in front of the server (docs/SELF-HOSTING.md): the code never
 * reads an IP.
 */

/** How long a robot check can be solved and used: long enough to write a message. */
const CHALLENGE_LIFETIME = 30 * MINUTE;
/** The secret number's range: a second or two of hashing on a device. */
const MAX_NUMBER = 100_000;

export function messagesOn(platform: Pick<Platform, 'config' | 'mailer'>): boolean {
  return platform.config.messagesTo !== null && platform.mailer !== null;
}

export async function createChallenge(platform: Pick<Platform, 'clock' | 'random'>, keys: ServerKeys): Promise<Omit<ContactChallengeResponse, 'v'>> {
  const expires = Math.floor((platform.clock.now() + CHALLENGE_LIFETIME) / 1000);
  const salt = `${hex(crypto.getRandomValues(new Uint8Array(12)))}?expires=${expires}`;
  const number = Math.floor(platform.random() * MAX_NUMBER);
  const challenge = await sha256Hex(`${salt}${number}`);

  return { algorithm: 'SHA-256', challenge, maxnumber: MAX_NUMBER, salt, signature: await sign(keys, challenge) };
}

export type SendResult = 'sent' | 'off' | 'bad_proof' | 'busy' | 'failed';

/**
 * Checks the message and sends it. A filled-in hidden field answers 'sent' and sends nothing: a
 * robot learns nothing from it. A robot check is good for one message only.
 */
export async function sendMessage(platform: Platform, keys: ServerKeys, message: z.infer<typeof ContactRequest>): Promise<{ result: SendResult; retryAfter?: number }> {
  const { config, mailer, coordinator } = platform;

  if (!messagesOn(platform) || mailer === null || config.messagesTo === null) {
    return { result: 'off' };
  }

  if ((message.website ?? '') !== '') {
    return { result: 'sent' };
  }

  const solution = await checkProof(platform, keys, message.proof);

  if (solution === null || !(await coordinator.take(`proof:${solution.challenge}`, 0, 1))) {
    return { result: 'bad_proof' };
  }

  const at = platform.clock.now();
  const hour = Math.floor(at / HOUR) * HOUR;
  const day = Math.floor(at / DAY) * DAY;
  const [inHour, inDay] = await Promise.all([coordinator.spent('messages_hour', hour), coordinator.spent('messages_day', day)]);

  if (inDay >= config.messagesPerDay) {
    return { result: 'busy', retryAfter: Math.ceil((day + DAY - at) / 1000) };
  }

  if (inHour >= config.messagesPerHour) {
    return { result: 'busy', retryAfter: Math.ceil((hour + HOUR - at) / 1000) };
  }

  await Promise.all([coordinator.take('messages_hour', hour, null), coordinator.take('messages_day', day, null)]);

  const name = cleanLine(message.name);
  const text = cleanText(message.text);
  const instance = config.instanceName ?? 'Subify';

  try {
    await mailer({
      to: config.messagesTo,
      from: config.messagesFrom ?? config.messagesTo,
      replyTo: message.email,
      subject: `Message from the contact form of ${instance}`,
      text: [
        `${name} <${defang(message.email)}> wrote, through the contact form of ${instance}:`,
        '',
        text,
        '',
        '—',
        'Links in this message are disabled (hxxps://, [.]). Replying answers the address they gave, which nobody checked.',
      ].join('\n'),
    });
  } catch (error) {
    logError('contact_send', error);

    return { result: 'failed' };
  }

  return { result: 'sent' };
}

/** The solution, when it solves a challenge this server signed that hasn't expired; null otherwise. */
async function checkProof(platform: Pick<Platform, 'clock'>, keys: ServerKeys, proof: string): Promise<ProofSolution | null> {
  let solution: Partial<ProofSolution>;

  try {
    solution = JSON.parse(atob(proof)) as Partial<ProofSolution>;
  } catch {
    return null;
  }

  const { algorithm, challenge, number, salt, signature } = solution;

  if (algorithm !== 'SHA-256' || typeof challenge !== 'string' || typeof salt !== 'string' || typeof signature !== 'string') {
    return null;
  }

  if (!Number.isSafeInteger(number) || number! < 0 || number! > MAX_NUMBER || !/^[0-9a-f]{64}$/.test(signature)) {
    return null;
  }

  const expires = Number(new URLSearchParams(salt.split('?')[1] ?? '').get('expires'));

  if (!Number.isFinite(expires) || expires * 1000 <= platform.clock.now()) {
    return null;
  }

  const signed = await crypto.subtle.verify('HMAC', keys.challenges, unhex(signature), new TextEncoder().encode(challenge));

  return signed && (await sha256Hex(`${salt}${number}`)) === challenge ? { algorithm, challenge, number: number!, salt, signature } : null;
}

async function sign(keys: ServerKeys, challenge: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', keys.challenges, new TextEncoder().encode(challenge))));
}

/**
 * Characters that show nothing or change how the rest shows: controls (but line breaks), soft
 * hyphens, zero-width and joiner characters, the marks that reverse text's direction, variation
 * selectors and tags. They can hide words, or make a link read as another.
 */
const INVISIBLE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\u{E0000}-\u{E0FFF}]/gu;

/** The message as the operator reads it: plain lines, no invisible characters, no clickable link. */
export function cleanText(text: string): string {
  return defang(
    text
      .normalize('NFC')
      .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
      .replace(/\t/g, ' ')
      .replace(INVISIBLE, '')
      .replace(/[ \u00A0]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/** A name: one line, single spaces, nothing invisible, no clickable link. */
export function cleanLine(text: string): string {
  return defang(
    text
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .replace(INVISIBLE, '')
      .trim(),
  );
}

/**
 * Makes links unclickable, the way security teams pass them around: `https://` becomes
 * `hxxps://`, and a dot before a domain's ending becomes `[.]`, since mail apps turn a bare
 * `example.com` into a link too.
 */
function defang(text: string): string {
  return text
    .replace(/\b(h)tt(ps?):\/\//gi, '$1xx$2://')
    .replace(/\b(f)t(p):\/\//gi, '$1x$2://')
    .replace(/([\p{L}\p{N}-])\.(?=\p{L}{2,})/gu, '$1[.]');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}
