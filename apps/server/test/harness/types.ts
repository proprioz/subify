import type { ThumbnailEncoder, ThumbnailModules } from '../../src/catalog/thumbnails';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/db';
import type { Mailer, Platform } from '../../src/platform';
import type { SourceAdapter } from '../../src/sources/source';
import type { FakeFetch } from '../support/fake-fetch';

/**
 * What a server test can do, whichever runtime runs it. test/harness/node.ts (better-sqlite3)
 * and test/harness/workers.ts (local D1) implement it; tests import it as `#harness`, which
 * each Vitest project points at its own runtime.
 */
export interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Posts `body` as JSON. */
  post(path: string, body: unknown): Promise<Response>;
  /** Posts `{ url }` to /api/add, the only way to add a channel. */
  add(url: string): Promise<Response>;
  db: Db;
  platform: Platform;
  fake: FakeFetch;
  /** Moves the clock: tests start on 2026-10-20 at noon UTC. */
  setNow(ms: number): void;
  /** Every row of every catalog table, as text, to check nothing leaked into the database. */
  dump(): Promise<string>;
  /** How many times the app asked for the connection's country since the harness was built. */
  countryReads(): number;
}

export interface HarnessOptions {
  fake?: FakeFetch;
  config?: Partial<Config>;
  sources?: readonly SourceAdapter[];
  /** What the host says about each request's country, as Cloudflare does. Left out: Node, which says nothing. */
  country?: string;
  /** How the contact form sends: none by default, so the form is off. */
  mailer?: Mailer;
  /** How new thumbnails are re-encoded: kept as read by default. */
  thumbnails?: ThumbnailEncoder;
}

/** Loads the thumbnail encoder's WASM modules the way this runtime's entry point does. */
export type ThumbnailModulesLoader = () => Promise<ThumbnailModules>;

export const START = Date.UTC(2026, 9, 20, 12);
