import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { coordinatorOf } from '../../src/workers/coordinator';

// Between two passes the database takes no writes: an update the Durable Object lost, or gave twice after it was applied, would drop or repeat a channel's change.
it('keeps sealed updates in arrival order until they are removed, and counts budgets', async () => {
  const coordinator = coordinatorOf(env.COORDINATOR);
  await coordinator.enqueue(Uint8Array.of(1));
  await coordinator.enqueue(Uint8Array.of(2));
  await coordinator.enqueue(Uint8Array.of(3));

  const pending = await coordinator.pending(10);
  expect(pending.map((update) => [...update.message])).toEqual([[1], [2], [3]]);

  await coordinator.remove(pending.slice(0, 2).map((update) => update.key));
  expect((await coordinator.pending(10)).map((update) => [...update.message])).toEqual([[3]]);

  expect(await coordinator.take('new_channels_hour', 0, 2)).toBe(true);
  expect(await coordinator.take('new_channels_hour', 0, 2)).toBe(true);
  expect(await coordinator.take('new_channels_hour', 0, 2)).toBe(false);
  expect(await coordinator.spent('new_channels_hour', 0)).toBe(2);
  // A new window starts over.
  expect(await coordinator.take('new_channels_hour', 3_600_000, 2)).toBe(true);
});

// A channel new to the catalog waits for its entry time there: given early, it would enter at the next pass (docs/FEATURES.md, D16).
it('holds an update until its time, for a pass that asks for those due', async () => {
  const coordinator = coordinatorOf(env.COORDINATOR);
  await coordinator.remove((await coordinator.pending(100)).map((update) => update.key));
  const now = Date.now();
  await coordinator.enqueue(Uint8Array.of(4), now + 60_000);
  await coordinator.enqueue(Uint8Array.of(5));

  expect((await coordinator.pending(10, now + 59_999)).map((update) => [...update.message])).toEqual([[5]]);
  expect((await coordinator.pending(10, now + 60_000)).map((update) => [...update.message])).toEqual([[5], [4]]);
  expect((await coordinator.pending(10)).map((update) => [...update.message])).toEqual([[5], [4]]);
});
