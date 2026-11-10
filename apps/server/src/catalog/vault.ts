import {
  type AddingHours,
  addingHoursCodec,
  type CatalogState,
  catalogStateCodec,
  handleBoundsCodec,
  handleChunkCodec,
  LOT_FRAGMENT_SIZE,
  lotCodec,
  lotCount,
  type StoredLot,
  type SeedCandidate,
  seedPoolCodec,
  type SlotPayload,
  type StreamBatch,
  streamBatchCodec,
  streamBatchCount,
  slotCodec,
  type ThumbnailPayload,
  thumbnailCodec,
} from '@subify/shared/codec';
import { open, seal, sealedSize } from '../crypto/aead';
import type { ServerKeys } from '../crypto/keys';
import type { Db, Statement } from '../db/db';
import { compile, query } from '../db/query';
import { logError } from '../log';
import { POOL_ROWS } from './seed-pool';

/**
 * The only way in and out of the encrypted catalog's tables (docs/FEATURES.md, D16): it seals
 * typed payloads into blobs and opens them back. Nothing else reads or writes a `blob` column
 * (test/node/privacy-source.test.ts checks it), so everything else works on typed values.
 */

/** The vault row holding the catalog's state. */
const STATE_ROW = 1;
/** The row holding users' additions by hour of day, then the seed pool's POOL_ROWS rows. */
const HOURS_ROW = 2;
const POOL_FIRST_ROW = 3;
/** The handle index's chunk bounds; its chunks are in the `handles` table. After the pool's rows. */
const HANDLE_BOUNDS_ROW = 100;
/** Bytes of a slot id: random for a decoy, derived from the channel's VOPRF output otherwise. */
export const SLOT_ID_BYTES = 16;

export interface Slot {
  id: Uint8Array;
  payload: SlotPayload;
}

export async function readState(db: Db, keys: ServerKeys): Promise<CatalogState | undefined> {
  const row = await db.first(compile(query.selectFrom('vault').select('blob').where('id', '=', STATE_ROW)));

  return row === undefined ? undefined : opened(open(keys, catalogStateCodec, positionId(STATE_ROW), row.blob));
}

/** The state's write: an insert the first time, an update after, so each pass writes one row. */
export async function stateWrite(keys: ServerKeys, state: CatalogState, first: boolean): Promise<Statement> {
  const blob = await seal(keys, catalogStateCodec, positionId(STATE_ROW), state);

  return first
    ? compile(query.insertInto('vault').values({ id: STATE_ROW, blob }))
    : compile(query.updateTable('vault').set({ blob }).where('id', '=', STATE_ROW));
}

/** Up to `limit` slots after `after`, in id order: a pass reads the table in chunks this way. */
export async function readSlots(db: Db, keys: ServerKeys, after: Uint8Array | null, limit: number): Promise<Slot[]> {
  const rows = await db.all(
    compile(
      query
        .selectFrom('slots')
        .select(['id', 'blob'])
        .$if(after !== null, (qb) => qb.where('id', '>', after!))
        .orderBy('id')
        .limit(limit),
    ),
  );

  return Promise.all(rows.map(async (row) => ({ id: row.id, payload: await opened(open(keys, slotCodec, row.id, row.blob)) })));
}

/**
 * Every slot of a group, in id order: the ids whose leading bits are `group` among `groups`, a
 * power of two (packages/shared, `groupOf`). One range of the primary key.
 */
export async function readSlotsInGroup(db: Db, keys: ServerKeys, group: number, groups: number): Promise<Slot[]> {
  const bits = Math.log2(groups);
  const bound = (value: number) => {
    const id = new Uint8Array(SLOT_ID_BYTES);
    new DataView(id.buffer).setUint32(0, bits === 0 ? 0 : value * 2 ** (32 - bits));

    return id;
  };
  const rows = await db.all(
    compile(
      query
        .selectFrom('slots')
        .select(['id', 'blob'])
        .where('id', '>=', bound(group))
        .$if(group + 1 < groups, (qb) => qb.where('id', '<', bound(group + 1)))
        .orderBy('id'),
    ),
  );

  return Promise.all(rows.map(async (row) => ({ id: row.id, payload: await opened(open(keys, slotCodec, row.id, row.blob)) })));
}

/** One slot, by id: what a WebSub callback reads to check a notification. A read only. */
export async function readSlot(db: Db, keys: ServerKeys, id: Uint8Array): Promise<Slot | undefined> {
  const row = await db.first(compile(query.selectFrom('slots').select(['id', 'blob']).where('id', '=', id)));

  return row === undefined ? undefined : { id: row.id, payload: await opened(open(keys, slotCodec, row.id, row.blob)) };
}

/**
 * A slot taking another's row: a channel entering in place of a decoy, or a decoy under a new
 * random id in place of a channel that is gone. The table keeps its size.
 */
export async function slotReplace(keys: ServerKeys, replaced: Uint8Array, slot: Slot): Promise<Statement[]> {
  return [
    compile(query.deleteFrom('slots').where('id', '=', replaced)),
    compile(query.insertInto('slots').values({ id: slot.id, blob: await seal(keys, slotCodec, slot.id, slot.payload) })),
  ];
}

/** A random id for a new decoy. */
export function decoyId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SLOT_ID_BYTES));
}

/** Rewrites a slot under a fresh nonce, changed or not. */
export async function slotWrite(keys: ServerKeys, slot: Slot): Promise<Statement> {
  return compile(query.updateTable('slots').set({ blob: await seal(keys, slotCodec, slot.id, slot.payload) }).where('id', '=', slot.id));
}

/** Before the table is first filled: whatever a start that failed halfway left, slots and ring. */
export function clearSlots(): Statement[] {
  return [compile(query.deleteFrom('slots')), compile(query.deleteFrom('thumbnails')), compile(query.deleteFrom('stream')), compile(query.deleteFrom('handles')), compile(query.deleteFrom('lots')), compile(query.deleteFrom('vault').where('id', '!=', STATE_ROW))];
}

/** New decoys, each under a random id: the table grows only by these. */
export async function decoyInserts(keys: ServerKeys, count: number): Promise<Statement[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const id = decoyId();

      return compile(query.insertInto('slots').values({ id, blob: await seal(keys, slotCodec, id, { kind: 'empty' }) }));
    }),
  );
}

/** Users' additions by hour of day; undefined before the first pass that wrote them. */
export async function readHours(db: Db, keys: ServerKeys): Promise<AddingHours | undefined> {
  const row = await db.first(compile(query.selectFrom('vault').select('blob').where('id', '=', HOURS_ROW)));

  return row === undefined ? undefined : opened(open(keys, addingHoursCodec, positionId(HOURS_ROW), row.blob));
}

/** Every seed candidate, in the pool's order. */
export async function readPool(db: Db, keys: ServerKeys): Promise<SeedCandidate[]> {
  const rows = await db.all(
    compile(
      query
        .selectFrom('vault')
        .select(['id', 'blob'])
        .where('id', '>=', POOL_FIRST_ROW)
        .where('id', '<', POOL_FIRST_ROW + POOL_ROWS)
        .orderBy('id'),
    ),
  );

  return (await Promise.all(rows.map((row) => opened(open(keys, seedPoolCodec, positionId(row.id), row.blob))))).flat();
}

/** The hours row and every pool row, written whole at every pass (inserted the first time). */
export async function seedingWrites(keys: ServerKeys, hours: AddingHours, pool: readonly SeedCandidate[][]): Promise<Statement[]> {
  const upsert = (id: number, blob: Uint8Array) => compile(query.insertInto('vault').values({ id, blob }).onConflict((oc) => oc.column('id').doUpdateSet({ blob })));

  return [
    upsert(HOURS_ROW, await seal(keys, addingHoursCodec, positionId(HOURS_ROW), hours)),
    ...(await Promise.all(pool.map(async (row, i) => upsert(POOL_FIRST_ROW + i, await seal(keys, seedPoolCodec, positionId(POOL_FIRST_ROW + i), row))))),
  ];
}

/** The stream's batches at these positions of its ring, by position. One not written yet is absent. */
export async function readBatches(db: Db, keys: ServerKeys, positions: readonly number[]): Promise<Map<number, StreamBatch>> {
  // D1 binds at most 100 parameters a statement: a page of the stream is 144 batches.
  const chunks = Array.from({ length: Math.ceil(positions.length / 100) }, (_, i) => positions.slice(i * 100, (i + 1) * 100));
  const rows = (await Promise.all(chunks.map((chunk) => db.all(compile(query.selectFrom('stream').select(['position', 'blob']).where('position', 'in', chunk)))))).flat();
  // The sealed overhead, from a codec of no entries.
  const overhead = sealedSize(streamBatchCodec(0)) - streamBatchCodec(0).size;

  return new Map(
    await Promise.all(
      rows.map(async (row) => [row.position, await opened(open(keys, streamBatchCodec(streamBatchCount(row.blob.length, overhead)), casePositionId(row.position), row.blob))] as const),
    ),
  );
}

/** A pass's batch, at its position in the ring: one row written per pass. */
export async function batchWrite(keys: ServerKeys, position: number, batch: StreamBatch): Promise<Statement> {
  const blob = await seal(keys, streamBatchCodec(batch.groups * batch.perGroup), casePositionId(position), batch);

  return compile(query.insertInto('stream').values({ position, blob }).onConflict((oc) => oc.column('position').doUpdateSet({ blob })));
}

/** The first entry id of each chunk of the handle index; undefined before its first build. */
export async function readHandleBounds(db: Db, keys: ServerKeys): Promise<Uint8Array[] | undefined> {
  const row = await db.first(compile(query.selectFrom('vault').select('blob').where('id', '=', HANDLE_BOUNDS_ROW)));

  if (row === undefined) {
    return undefined;
  }

  // The chunk count, from the sealed length: it changes only when the table grows.
  const overhead = sealedSize(handleBoundsCodec(0)) - handleBoundsCodec(0).size;

  return opened(open(keys, handleBoundsCodec((row.blob.length - overhead - 3) / 16), positionId(HANDLE_BOUNDS_ROW), row.blob));
}

/** One chunk of the handle index: its sorted entries. */
export async function readHandleChunk(db: Db, keys: ServerKeys, position: number): Promise<Uint8Array | undefined> {
  const row = await db.first(compile(query.selectFrom('handles').select('blob').where('position', '=', position)));

  return row === undefined ? undefined : opened(open(keys, handleChunkCodec, casePositionId(position), row.blob));
}

/** The whole handle index, rewritten: every chunk and their bounds. */
export async function handleIndexWrites(keys: ServerKeys, chunks: readonly Uint8Array[], bounds: readonly Uint8Array[]): Promise<Statement[]> {
  const boundsBlob = await seal(keys, handleBoundsCodec(bounds.length), positionId(HANDLE_BOUNDS_ROW), [...bounds]);

  return [
    ...(await Promise.all(
      chunks.map(async (chunk, position) => {
        const blob = await seal(keys, handleChunkCodec, casePositionId(position), chunk);

        return compile(query.insertInto('handles').values({ position, blob }).onConflict((oc) => oc.column('position').doUpdateSet({ blob })));
      }),
    )),
    compile(query.insertInto('vault').values({ id: HANDLE_BOUNDS_ROW, blob: boundsBlob }).onConflict((oc) => oc.column('id').doUpdateSet({ blob: boundsBlob }))),
  ];
}

/** The ring's cases at these positions, by position. A case not written yet is absent. */
export async function readCases(db: Db, keys: ServerKeys, positions: readonly number[]): Promise<Map<number, ThumbnailPayload>> {
  const unique = [...new Set(positions)];
  // D1 binds at most 100 parameters a statement: a group's thumbnails of 7 days can be more.
  const chunks = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, (i + 1) * 100));
  const rows = (await Promise.all(chunks.map((chunk) => db.all(compile(query.selectFrom('thumbnails').select(['position', 'blob']).where('position', 'in', chunk)))))).flat();

  return new Map(await Promise.all(rows.map(async (row) => [row.position, await opened(open(keys, thumbnailCodec, casePositionId(row.position), row.blob))] as const)));
}

/**
 * Overwrites a case of the ring, or writes it the first time: the ring fills as it turns, one
 * row written per case either way.
 */
export async function caseWrite(keys: ServerKeys, position: number, payload: ThumbnailPayload): Promise<Statement> {
  const blob = await seal(keys, thumbnailCodec, casePositionId(position), payload);

  return compile(query.insertInto('thumbnails').values({ position, blob }).onConflict((oc) => oc.column('position').doUpdateSet({ blob })));
}

/** The thumbnail lots at these positions, by position. One not written yet is absent. */
export async function readLots(db: Db, keys: ServerKeys, positions: readonly number[]): Promise<Map<number, StoredLot>> {
  const unique = [...new Set(positions)];
  // D1 binds at most 100 parameters a statement.
  const chunks = Array.from({ length: Math.ceil(unique.length / 100) }, (_, i) => unique.slice(i * 100, (i + 1) * 100));
  const rows = (await Promise.all(chunks.map((chunk) => db.all(compile(query.selectFrom('lots').select(['position', 'blob']).where('position', 'in', chunk)))))).flat();
  const overhead = sealedSize(lotCodec(0)) - lotCodec(0).size;

  return new Map(await Promise.all(rows.map(async (row) => [row.position, await opened(open(keys, lotCodec(lotCount(row.blob.length, overhead)), casePositionId(row.position), row.blob))] as const)));
}

/** A group's lot of the hour, at its position: overwrites the one of the same hour a week earlier. */
export async function lotWrite(keys: ServerKeys, position: number, lot: StoredLot): Promise<Statement> {
  const blob = await seal(keys, lotCodec(lot.fragments.length / LOT_FRAGMENT_SIZE), casePositionId(position), lot);

  return compile(query.insertInto('lots').values({ position, blob }).onConflict((oc) => oc.column('position').doUpdateSet({ blob })));
}

function casePositionId(position: number): Uint8Array {
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, position);

  return id;
}

/** A vault row's position as the row id its payload is bound to. */
function positionId(position: number): Uint8Array {
  return Uint8Array.of(position);
}

/**
 * A payload that authenticates but doesn't decode is a bug, not an attack: logged by event name
 * only, never with its content, then left to fail the work that read it.
 */
async function opened<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    logError('Opening a payload failed', error);
    throw error;
  }
}
