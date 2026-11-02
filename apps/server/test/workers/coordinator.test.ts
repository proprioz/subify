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
