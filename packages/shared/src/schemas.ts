/**
 * The API's contract: what each request may carry and what each answer holds. The server
 * validates requests and declares its answers with these schemas; `index.ts` derives the types
 * both sides use from them. Only the server imports this module: it is the one that needs Zod at
 * runtime.
 */
import { z } from 'zod';
import { BLIND_BATCH_SIZES } from './limits';

/** Version of the API response format. A client refuses an answer with a version it does not know. */
const version = z.literal(2);

/** The encrypted catalog's routes (docs/FEATURES.md, D16) answer in version 3, next to version 2's. */
const version3 = z.literal(3);

/** Answers that carry snapshot entries or stream deltas: version 4 since they may hold a channel's retry time. */
const version4 = z.literal(4);

/** `bytes` bytes in base64url, without padding. */
function bytes(count: number) {
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((count * 4) / 3)}}$`));
}

/** No query parameter: an unknown one is refused, like an unknown body field. */
export const NoQuery = z.strictObject({});

export const HealthResponse = z.object({
  v: version,
  ok: z.literal(true),
  /** The git commit the server says it was built from, so anyone can compare it with the public repository; null when its admin didn't set it. */
  commit: z.string().nullable(),
});

export const ConnectionResponse = z.object({
  v: version,
  /** ISO 3166 alpha-2 code, such as 'CH'. */
  country: z.string().nullable(),
});

export const ItemType = z.enum(['video', 'short', 'live', 'unknown']);

/** How the app stores a channel, and a backup carries it: no route answers with it. */
export const ApiChannel = z.object({
  /** '<source>:<id on the platform>', such as 'youtube:UC…'. */
  key: z.string(),
  source: z.string(),
  title: z.string(),
  /** The @handle, without the "@", when the server knows it. */
  handle: z.string().nullable(),
  /** The avatar's URL on the platform. Kept for backups only: the app never loads it. */
  icon: z.string().nullable(),
  /** The avatar itself, small, as a data: URL the app shows without going online. */
  avatar: z.string().nullable(),
}).meta({ id: 'ApiChannel' });

/** How the app stores an item. */
export const ApiItem = z.object({
  /** '<source>:<video id>'. */
  key: z.string(),
  /** The channel's key. */
  channel: z.string(),
  title: z.string(),
  url: z.string(),
  thumbnail: z.string().nullable(),
  /** Publication time, in milliseconds since the Unix epoch. */
  published: z.number(),
  type: ItemType,
  /** Present on a video that was deleted on the platform. */
  deleted: z.literal(true).optional(),
  /**
   * Present on a premiere or a live announced but not aired yet. There is no start time: until it
   * airs, `published` is when it was scheduled; once it airs, the time the server saw it start.
   */
  upcoming: z.literal(true).optional(),
}).meta({ id: 'ApiItem' });

/** `POST /api/add`: one link to a channel, its @handle or one of its videos. */
export const SubmitRequest = z.strictObject({
  url: z.string(),
});

/** The server's VOPRF public key: a device keeps the first it sees, and refuses answers proved under another. */
export const OprfKeyResponse = z.object({
  v: version3,
  keyId: z.number().int(),
  publicKey: bytes(32),
});

export const EvaluateRequest = z.strictObject({
  /** Blinded elements (ristretto255), the device's real ones padded with random ones. */
  blinded: z.array(bytes(32)).refine((list) => (BLIND_BATCH_SIZES as readonly number[]).includes(list.length), { message: 'Batch size not allowed' }),
});

export const EvaluateResponse = z.object({
  v: version3,
  evaluated: z.array(bytes(32)),
  /** One proof for the whole batch, against the published key. */
  proof: bytes(64),
});

/** A count or a pass number, in a query string. */
const count = z.string().regex(/^\d{1,9}$/).transform(Number);

export const StreamQuery = z.strictObject({
  /** The last pass the device has, the `latest` of a previous answer. */
  since: count,
  /** The device's group: its channels' group seeds modulo `groups`. A device with channels in several groups asks for each. */
  group: count,
});

export const StreamResponse = z.object({
  v: version4,
  /** The latest pass: the next `since` once `more` is false. */
  latest: z.number(),
  groups: z.number(),
  /** Channels per group, the same for every device: 1/k is the best guess at which one a device follows. */
  k: z.number(),
  /** The device is further behind than the stream keeps (30 days): it reads its channels' slots instead. */
  expired: z.boolean(),
  /** More batches follow: ask again with the last batch's pass. */
  more: z.boolean(),
  batches: z.array(z.object({ pass: z.number(), entries: z.string() })),
});

export const HandleBoundsResponse = z.object({
  v: version3,
  /** The first entry id of each chunk of the handle index: a device reads the last one not above its entry's. */
  chunks: z.array(bytes(16)),
});

export const HandleChunkParams = z.strictObject({ chunk: count });

export const HandleChunkResponse = z.object({
  v: version3,
  /** The chunk's entries, sorted by id. */
  entries: z.string(),
});

export const DictionaryResponse = z.object({
  v: version3,
  /** When the dictionary was last refreshed in full: a device downloads it again when this is newer than its copy. */
  version: z.number(),
  /** Its slices, all to download: GET /dictionary/{slice} for each, from 0. */
  slices: z.number(),
});

export const DictionarySliceParams = z.strictObject({ slice: count });

export const DictionarySliceResponse = z.object({
  v: version3,
  /** The slice's lines, gzipped: `id`, tab, `handle` or nothing, tab, the names separated by U+001F, tab, the audience as one base-36 digit or nothing. */
  data: z.string(),
});

export const SearchRequest = z.strictObject({
  /** A channel's name, as the user typed it: sent only when nothing on the device found it. */
  q: z.string().trim().min(3).max(100),
});

export const SearchResult = z.object({
  /** The channel id, `UC…`: the app then looks the channel up by it, like a link. */
  id: z.string(),
  /** As the channel's own feed names it: every result was checked against it. */
  name: z.string(),
  handle: z.string().nullable(),
  description: z.string(),
});

export const SearchResponse = z.object({
  v: version3,
  /** At most 5, empty when no search service answered: the app then tries the name's likely handles. */
  results: z.array(SearchResult),
});

export const InstanceResponse = z.object({
  v: version3,
  /** The name its admin gave this server (INSTANCE_NAME): what the installed app is called. */
  name: z.string(),
  /**
   * Who runs it, when the admin said so. `contact` is an address to write to, given only when the
   * server takes no messages: with the contact form on, the operator's address is never shown.
   */
  operator: z.object({ name: z.string().nullable(), contact: z.string().nullable() }).nullable(),
  /** Whether the contact form sends messages to the operator (POST /contact). */
  messages: z.boolean(),
});

/** A robot check to solve before sending a message (packages/shared, proof.ts). */
export const ContactChallengeResponse = z.object({
  v: version3,
  algorithm: z.literal('SHA-256'),
  challenge: z.string(),
  maxnumber: z.number(),
  salt: z.string(),
  signature: z.string(),
});

/** A message to the server's operator. The server cleans it further before sending it as plain text. */
export const ContactRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  /** Where the operator's reply goes; nobody checks it is the sender's. */
  email: z.email().max(254),
  text: z.string().trim().min(10).max(2000),
  /** Left empty by people: a field robots fill in, hidden from sight and from screen readers. */
  website: z.string().max(200).optional(),
  /** The solved robot check, in base64. */
  proof: z.string().max(1000),
});

export const ContactResponse = z.object({ v: version3, sent: z.literal(true) });

export const SnapshotQuery = z.strictObject({
  group: count,
  /** 1 to get the group's thumbnails of the last 7 days too: an addition asks for them, a restore doesn't. */
  thumbnails: z.enum(['0', '1']).transform((value) => value === '1'),
});

export const SnapshotResponse = z.object({
  v: version4,
  /** The pass the thumbnails' tags are for. */
  pass: z.number(),
  /** Snapshot groups: about 40 channels each. */
  groups: z.number(),
  /** Every slot of the group, in id order, 16 KB each: a slot id, then the channel sealed under its key, or random bytes. */
  entries: z.string(),
  /** The thumbnails, a fixed number for the group, sealed under tags only each channel's key finds; empty without `thumbnails=1`. */
  thumbnails: z.string(),
});

export const AddResponse = z.object({
  v: version4,
  /** The channel, as a snapshot gives it (packages/shared, codec/snapshot.ts), in clear: the device asked for it by name. */
  channel: z.string(),
  /** Its thumbnails of the last 7 days, a fixed number of thumbnail cases, empty ones last. */
  thumbnails: z.string(),
});

export const ApiErrorCode = z.enum(['invalid_request', 'invalid_link', 'channel_not_found', 'upstream_unavailable', 'busy', 'catalog_full']);

export const ApiError = z.object({
  v: version,
  error: ApiErrorCode,
  /** A sentence the app can show as is. */
  message: z.string(),
}).meta({ id: 'ApiError' });
