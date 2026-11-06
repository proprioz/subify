// Generated from migrations/ by test/node/db-schema.test.ts: do not edit. After a migration, run
// `pnpm --filter @subify/server exec vitest run --project node -u` to update it.

import type { ItemType } from '@subify/shared';
import type { Generated } from 'kysely';

export interface DictionaryTable {
  slice: number;
  data: Uint8Array;
}

export interface DictionaryStateTable {
  id: number;
  next_slice: number;
  next_at: number;
  version: number | null;
}

export interface HandlesTable {
  position: number;
  blob: Uint8Array;
}

export interface LotsTable {
  position: number;
  blob: Uint8Array;
}

export interface SlotsTable {
  id: Uint8Array;
  blob: Uint8Array;
}

export interface StreamTable {
  position: number;
  blob: Uint8Array;
}

export interface ThumbnailsTable {
  position: number;
  blob: Uint8Array;
}

export interface VaultTable {
  id: number;
  blob: Uint8Array;
}

export interface Database {
  dictionary: DictionaryTable;
  dictionary_state: DictionaryStateTable;
  handles: HandlesTable;
  lots: LotsTable;
  slots: SlotsTable;
  stream: StreamTable;
  thumbnails: ThumbnailsTable;
  vault: VaultTable;
}
