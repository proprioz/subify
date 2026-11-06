/**
 * Types and limits shared by the PWA and the server, derived from the API's schemas
 * (`./schemas`). This module imports the schemas as types only, so it carries no runtime
 * dependency: the PWA imports it without pulling Zod in.
 */
import type { z } from 'zod';
import type * as schemas from './schemas';

export * from './limits';
export * from './names';

/** Version of the API response format. A client refuses an answer with a version it does not know. */
export type ApiVersion = 2;

/** The answer to `GET /api/health`. */
export type HealthResponse = z.infer<typeof schemas.HealthResponse>;

/**
 * The answer to `GET /api/connection`: the country the server's host places this request in,
 * from its IP address, so a user can check their VPN before anything else is sent. Only this
 * request reads it, and nothing keeps it. null when the host does not say (a self-hosted server).
 */
export type ConnectionResponse = z.infer<typeof schemas.ConnectionResponse>;

export type ItemType = z.infer<typeof schemas.ItemType>;

export type ApiChannel = z.infer<typeof schemas.ApiChannel>;

export type ApiItem = z.infer<typeof schemas.ApiItem>;

/** `POST /api/add` with `{ url }`: one link to a channel, its @handle or one of its videos. */
export type SubmitRequest = z.infer<typeof schemas.SubmitRequest>;

export type OprfKeyResponse = z.infer<typeof schemas.OprfKeyResponse>;

export type EvaluateRequest = z.infer<typeof schemas.EvaluateRequest>;

export type EvaluateResponse = z.infer<typeof schemas.EvaluateResponse>;

export type StreamResponse = z.infer<typeof schemas.StreamResponse>;

export type LotsResponse = z.infer<typeof schemas.LotsResponse>;

export type HandleBoundsResponse = z.infer<typeof schemas.HandleBoundsResponse>;

export type HandleChunkResponse = z.infer<typeof schemas.HandleChunkResponse>;

export type DictionaryResponse = z.infer<typeof schemas.DictionaryResponse>;

export type DictionarySliceResponse = z.infer<typeof schemas.DictionarySliceResponse>;

export type SearchResult = z.infer<typeof schemas.SearchResult>;

export type SearchResponse = z.infer<typeof schemas.SearchResponse>;

export type InstanceResponse = z.infer<typeof schemas.InstanceResponse>;
export type ContactChallengeResponse = z.infer<typeof schemas.ContactChallengeResponse>;
export type ContactRequest = z.input<typeof schemas.ContactRequest>;

export type SnapshotResponse = z.infer<typeof schemas.SnapshotResponse>;
export type SnapshotThumbnailsResponse = z.infer<typeof schemas.SnapshotThumbnailsResponse>;

export type AddResponse = z.infer<typeof schemas.AddResponse>;

export type ApiErrorCode = z.infer<typeof schemas.ApiErrorCode>;

export type ApiError = z.infer<typeof schemas.ApiError>;
