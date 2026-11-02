import { createHarness, type Harness } from '#harness';
import { describe, expect, it } from 'vitest';
import { runPass, runPassIfDue } from '../../src/catalog/pass';
import { DAY, MINUTE } from '../../src/catalog/schedule';
import { GROWTH_WINDOW } from '../../src/catalog/sizing';
import { readSlots, readState, slotWrite } from '../../src/catalog/vault';
import { channel, item } from '../fixtures/payloads/golden';
import { START } from '../harness/types';

const SMALL = { firstTableSize: 8 };

async function setup(): Promise<Harness> {
  return createHarness();
}

async function blobs(harness: Harness): Promise<{ id: string; blob: string }[]> {
  const rows = await harness.db.all<{ id: Uint8Array; blob: Uint8Array }>('SELECT id, blob FROM slots');

  return rows.map((row) => ({ id: hex(row.id), blob: hex(row.blob) }));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Turns the first `count` decoys into channels, as a later step's additions will. */
async function occupy(harness: Harness, count: number): Promise<void> {
  const keys = await harness.platform.keys;
  const slots = (await readSlots(harness.db, keys, null, count)).slice(0, count);
  await harness.db.batch(await Promise.all(slots.map((slot, i) => slotWrite(keys, { id: slot.id, payload: { ...channel([item(1, `Video ${i}`)]), externalId: `UC${i}` } }))));
}

// What the database shows must not depend on what it holds: every row the same size, all rewritten at each pass.
describe('the encrypted catalog’s pass', () => {
  it('starts with decoys only, every blob the same size, nothing readable', async () => {
    const harness = await setup();
    await runPassIfDue(harness.platform, undefined, SMALL);

    const rows = await blobs(harness);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.blob.length))).toEqual(new Set([2 * 40 * 1024]));
    expect(await harness.db.all('SELECT id FROM vault')).toEqual([{ id: 1 }]);
  });

  it('rewrites every slot at each pass, changed or not, and keeps the table’s size', async () => {
    const harness = await setup();
    await runPassIfDue(harness.platform, undefined, SMALL);
    await occupy(harness, 2);
    const before = await blobs(harness);

    harness.setNow(START + 10 * MINUTE);
    expect(await runPassIfDue(harness.platform, undefined, SMALL)).toBe(true);
    const after = await blobs(harness);

    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    after.forEach((row, i) => expect(row.blob).not.toBe(before[i]!.blob));
    // The channels are still there, unchanged.
    const keys = await harness.platform.keys;
    expect((await readSlots(harness.db, keys, null, 8)).filter((slot) => slot.payload.kind === 'channel')).toHaveLength(2);
  });

  // A table read in insertion order would tell which channels came in last.
  it('lists rows in id order, whatever order they were written in', async () => {
    const harness = await setup();
    await runPassIfDue(harness.platform, undefined, SMALL);
    const ids = (await blobs(harness)).map((row) => row.id);

    expect(ids).toEqual([...ids].sort());
  });

  it('runs only when its period comes round', async () => {
    const harness = await setup();
    await runPassIfDue(harness.platform, undefined, SMALL);

    harness.setNow(START + 3 * MINUTE);
    expect(await runPassIfDue(harness.platform, undefined, SMALL)).toBe(false);
  });

  // The table's size may reveal only that the catalog crossed half of it, never when exactly.
  it('grows by ×1.5 once half full, at a time drawn within the growth window, and only then', async () => {
    const harness = await setup();
    const keys = await harness.platform.keys;
    harness.platform.random = () => 0.5;
    let state = await runPass(harness.platform, keys, undefined, SMALL);
    await occupy(harness, 3);

    state = await runPass(harness.platform, keys, state, SMALL);
    expect(state).toMatchObject({ tableSize: 8, growthDueAt: null });

    await occupy(harness, 4);
    state = await runPass(harness.platform, keys, state, SMALL);
    expect(state).toMatchObject({ tableSize: 8, growthDueAt: START + GROWTH_WINDOW / 2 });

    harness.setNow(START + GROWTH_WINDOW / 2);
    state = await runPass(harness.platform, keys, state, SMALL);
    expect(state).toMatchObject({ tableSize: 12, growthDueAt: null });
    expect(await blobs(harness)).toHaveLength(12);
    expect(await readState(harness.db, keys)).toEqual(state);

    harness.setNow(START + DAY);
    expect((await runPass(harness.platform, keys, state, SMALL)).tableSize).toBe(12);
  });
});
