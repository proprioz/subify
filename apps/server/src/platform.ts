import type { Coordinator } from './catalog/coordinator';
import type { Config } from './config';
import type { ServerKeys } from './crypto/keys';
import type { ThumbnailEncoder } from './catalog/thumbnails';
import type { Db } from './db/db';

/**
 * What the application needs from the runtime. Each entry point (Node, Workers) provides these,
 * so the logic is the same everywhere and tests can replace any of them.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** The only way the server reaches the network. Wrapped by Http (src/http.ts) for every platform call. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Keeps work going after the response is sent: `ctx.waitUntil` on Workers, a tracked promise on
 * Node. Workers cuts it off 30 seconds after the response.
 */
export type AfterResponse = (work: Promise<unknown>) => void;

export interface Platform {
  clock: Clock;
  /** Waits, to space requests out. Tests make it instant. */
  sleep(ms: number): Promise<void>;
  /** A number in [0, 1), for jitter. Tests make it predictable. */
  random(): number;
  fetch: Fetcher;
  afterResponse: AfterResponse;
  db: Db;
  config: Config;
  /** Derived from the master secret: the encrypted catalog's keys. */
  keys: Promise<ServerKeys>;
  /** Where the encrypted catalog's updates wait for the pass, and the shared budgets. */
  coordinator: Coordinator;
  /** Sends the contact form's messages, or null when this runtime has no way to. */
  mailer: Mailer | null;
  /**
   * Re-encodes a new video's thumbnail and computes its preview (src/catalog/thumbnails.ts), with
   * the WASM modules the runtime loads; null keeps thumbnails as read, without previews.
   */
  thumbnails: ThumbnailEncoder | null;
}

/** A plain-text email, nothing else: no HTML, no attachment. */
export interface Mail {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;
