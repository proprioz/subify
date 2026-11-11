import { ENTRY_DELAY } from '@subify/shared';

/**
 * Settings read from the environment, the same names on Workers (wrangler.toml [vars],
 * .dev.vars) and on Node (.env).
 */
export interface Config {
  /**
   * What the installed app is called (INSTANCE_NAME). Required: without it, Node refuses to start
   * and a Worker to serve, so that no server passes itself off as another by default.
   */
  instanceName: string | null;
  /** The git commit this server was built from (COMMIT), shown by /api/health; null when not set or not a commit id. */
  commit: string | null;
  /** Who runs this server and a contact for privacy requests, shown on the app's Privacy page when set. */
  operatorName: string | null;
  operatorContact: string | null;
  /**
   * Where the contact form's messages go (MESSAGES_TO). null, the default, turns the form off. The
   * address is never shown: the app only offers the form. Sending needs a mailer too: the
   * send_email binding on Workers, SMTP_URL on Node.
   */
  messagesTo: string | null;
  /** The address messages are sent from (MESSAGES_FROM); by default MESSAGES_TO. */
  messagesFrom: string | null;
  /** Messages the form may send per hour and per day, all senders together: a low ceiling against floods. */
  messagesPerHour: number;
  messagesPerDay: number;
  /** Public URL of the server, or null when it cannot be reached from the internet. */
  publicBaseUrl: string | null;
  /** An optional address added to the User-Agent. Empty by default: nothing names the instance or the project. */
  contactUrl: string | null;
  /**
   * Channels polled per scheduled run (every minute). Small by default to stay within the
   * Workers Free plan: 50 subrequests and 50 D1 queries per invocation.
   */
  pollBatchSize: number;
  /** Items published longer ago than this are purged, and never ingested. */
  retentionDays: number;
  /**
   * Channels that may enter the catalog per hour and per day, all users together: each is read
   * online, then polled for good. Past them, a new channel is refused for a while; known ones are not.
   */
  newChannelsPerHour: number;
  newChannelsPerDay: number;
  /** Submissions that may read the platform per minute, failed ones included: what keeps it from blocking the server. */
  onlineLookupsPerMinute: number;
  /**
   * Blind evaluation batches per minute, all devices together (docs/FEATURES.md, D16). Each tests
   * up to 50 channels against the catalog: the limit bounds how fast anyone can probe it.
   */
  blindBatchesPerMinute: number;
  /**
   * Channels the server adds to the catalog on its own each day, on average, so that a channel in
   * the catalog does not tell that someone follows it (docs/FEATURES.md, D15). 0, the default, turns
   * seeding off: a self-hosted catalog fills with its users' channels unless its admin sets it.
   */
  seededChannelsPerDay: number;
  /** ENTRY_DELAY, never set from the environment: tests take 0, to see a channel enter at the next pass. */
  entryDelay: number;
  /**
   * Where a name is looked for when the app's search finds no handle or link (docs/FEATURES.md,
   * D16): `wikidata` (the dictionary, downloaded by devices), `invidious`, `piped`. Default
   * `wikidata`; `none` leaves only handles and links.
   */
  searchSources: ReadonlySet<SearchSource>;
  /**
   * Sent to Wikidata only, as Wikimedia asks of every automated client: a name and a contact. Without
   * it the server doesn't download the dictionary, and devices find channels by name less often.
   */
  wikidataUserAgent: string | null;
  /** Days between two refreshes of the dictionary. */
  wikidataRefreshDays: number;
  /**
   * The Invidious and Piped instances to search, as host names. null: those the projects' official
   * lists show with an open API, read once a day.
   */
  invidiousInstances: readonly string[] | null;
  pipedInstances: readonly string[] | null;
  /** Decoy searches sent to the instances per hour, on average, besides those sent with each real search. */
  searchDecoysPerHour: number;
}

export type SearchSource = 'wikidata' | 'invidious' | 'piped';
const SEARCH_SOURCES: readonly SearchSource[] = ['wikidata', 'invidious', 'piped'];

export const DEFAULT_POLL_BATCH_SIZE = 5;
export const DEFAULT_RETENTION_DAYS = 183;
export const DEFAULT_NEW_CHANNELS_PER_HOUR = 60;
export const DEFAULT_NEW_CHANNELS_PER_DAY = 500;
export const DEFAULT_ONLINE_LOOKUPS_PER_MINUTE = 10;
export const DEFAULT_BLIND_BATCHES_PER_MINUTE = 30;
export const DEFAULT_SEEDED_CHANNELS_PER_DAY = 0;
export const DEFAULT_WIKIDATA_REFRESH_DAYS = 7;
export const DEFAULT_SEARCH_DECOYS_PER_HOUR = 2;
export const DEFAULT_MESSAGES_PER_HOUR = 5;
export const DEFAULT_MESSAGES_PER_DAY = 20;

/**
 * Polls a channel gets per day, on average: every 1 to 12 hours while it publishes, weekly once
 * it went quiet. An estimate, used only to size the catalog.
 */
const POLLS_PER_CHANNEL_PER_DAY = 4;

/**
 * The most channels the catalog takes: as many as the scheduled runs can poll at their usual pace
 * (1,800 with the default batch). Past it every channel would fall behind, so new ones are refused.
 * It grows with POLL_BATCH_SIZE.
 */
export function catalogCapacity(config: Config): number {
  return Math.floor((config.pollBatchSize * 24 * 60) / POLLS_PER_CHANNEL_PER_DAY);
}

/** A generic User-Agent: it names no person, no instance and no project. */
const USER_AGENT = 'Mozilla/5.0 (compatible; feed reader)';

export function loadConfig(env: Record<string, unknown>): Config {
  const text = (name: string) => {
    const value = env[name];

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  return {
    instanceName: text('INSTANCE_NAME'),
    commit: /^[0-9a-f]{7,40}$/.test(text('COMMIT') ?? '') ? text('COMMIT') : null,
    operatorName: text('OPERATOR_NAME'),
    operatorContact: text('OPERATOR_CONTACT'),
    messagesTo: text('MESSAGES_TO'),
    messagesFrom: text('MESSAGES_FROM') ?? text('MESSAGES_TO'),
    messagesPerHour: positive(text('MESSAGES_PER_HOUR'), DEFAULT_MESSAGES_PER_HOUR),
    messagesPerDay: positive(text('MESSAGES_PER_DAY'), DEFAULT_MESSAGES_PER_DAY),
    publicBaseUrl: text('PUBLIC_BASE_URL'),
    contactUrl: text('CONTACT_URL'),
    pollBatchSize: positive(text('POLL_BATCH_SIZE'), DEFAULT_POLL_BATCH_SIZE),
    retentionDays: positive(text('RETENTION_DAYS'), DEFAULT_RETENTION_DAYS),
    newChannelsPerHour: positive(text('NEW_CHANNELS_PER_HOUR'), DEFAULT_NEW_CHANNELS_PER_HOUR),
    newChannelsPerDay: positive(text('NEW_CHANNELS_PER_DAY'), DEFAULT_NEW_CHANNELS_PER_DAY),
    onlineLookupsPerMinute: positive(text('ONLINE_LOOKUPS_PER_MINUTE'), DEFAULT_ONLINE_LOOKUPS_PER_MINUTE),
    blindBatchesPerMinute: positive(text('BLIND_BATCHES_PER_MINUTE'), DEFAULT_BLIND_BATCHES_PER_MINUTE),
    seededChannelsPerDay: positiveOrZero(text('SEEDED_CHANNELS_PER_DAY'), DEFAULT_SEEDED_CHANNELS_PER_DAY),
    entryDelay: ENTRY_DELAY,
    searchSources: searchSources(text('SEARCH_SOURCES')),
    wikidataUserAgent: text('WIKIDATA_USER_AGENT'),
    wikidataRefreshDays: positive(text('WIKIDATA_REFRESH_DAYS'), DEFAULT_WIKIDATA_REFRESH_DAYS),
    invidiousInstances: hosts(text('INVIDIOUS_INSTANCES')),
    pipedInstances: hosts(text('PIPED_INSTANCES')),
    searchDecoysPerHour: positiveOrZero(text('SEARCH_DECOYS_PER_HOUR'), DEFAULT_SEARCH_DECOYS_PER_HOUR),
  };
}

/** Comma-separated https addresses or host names, as host names; null when not set. Anything else is left out. */
function hosts(value: string | null): readonly string[] | null {
  if (value === null) {
    return null;
  }

  return value.split(',').flatMap((entry) => {
    try {
      const url = new URL(/^https?:\/\//i.test(entry.trim()) ? entry.trim() : `https://${entry.trim()}`);

      return url.protocol === 'https:' && url.port === '' && url.username === '' ? [url.hostname] : [];
    } catch {
      return [];
    }
  });
}

/** A comma-separated list; unknown names are left out. */
function searchSources(value: string | null): ReadonlySet<SearchSource> {
  const names = (value ?? 'wikidata').split(',').map((name) => name.trim().toLowerCase());

  return new Set(SEARCH_SOURCES.filter((source) => names.includes(source)));
}

function positive(value: string | null, fallback: number): number {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveOrZero(value: string | null, fallback: number): number {
  return value === '0' ? 0 : positive(value, fallback);
}

/**
 * The base of the WebSub callback, or null when WebSub must stay off: no public URL, or one the
 * hub cannot reach (local development, a private network). Polling alone keeps the catalog
 * current then.
 */
export function websubBase(config: Config): string | null {
  if (config.publicBaseUrl === null) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(config.publicBaseUrl);
  } catch {
    return null;
  }

  const host = url.hostname;
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]';

  return url.protocol === 'https:' && !local ? url.origin + url.pathname.replace(/\/$/, '') : null;
}

export function userAgent(config: Config): string {
  return config.contactUrl === null ? USER_AGENT : `${USER_AGENT.slice(0, -1)}; +${config.contactUrl})`;
}
