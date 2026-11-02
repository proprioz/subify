import { createHarness, type Harness } from '#harness';
import { describe, expect, it } from 'vitest';
import { runPass } from '../../src/catalog/pass';
import { DAY, HOUR, MINUTE } from '../../src/catalog/schedule';
import { readState, stateWrite } from '../../src/catalog/vault';
import type { Config } from '../../src/config';
import { START } from '../harness/types';
import { FakeSource, item } from '../support/fake-source';

const WIDE: Partial<Config> = { newChannelsPerHour: 100, newChannelsPerDay: 100, onlineLookupsPerMinute: 100 };

async function setup(config: Partial<Config>): Promise<{ harness: Harness; source: FakeSource }> {
  const source = new FakeSource();
  ['a', 'b', 'c'].forEach((id) => source.channel(id, [item(`${id}1`, START - HOUR)]));

  return { harness: await createHarness({ sources: [source], config: { ...WIDE, ...config } }), source };
}

async function refusal(response: Response): Promise<{ status: number; error: string; retryAfter: string | null }> {
  const body = (await response.json()) as { error: string };

  return { status: response.status, error: body.error, retryAfter: response.headers.get('Retry-After') };
}

// Without budgets shared by everyone, a script could add thousands of channels: each is read
// online and then polled for good, so polling would fall behind for every user and the platform
// could block the server.
describe('budgets for new channels', () => {
  it('refuses new channels past the hour’s budget until the next hour, never a known one, and writes nothing to the database', async () => {
    const { harness, source } = await setup({ newChannelsPerHour: 2 });
    const keys = await harness.platform.keys;
    await runPass(harness.platform, keys, undefined, { firstTableSize: 8 });
    const before = await harness.dump();

    expect((await harness.add('fake:a')).status).toBe(200);
    expect((await harness.add('fake:b')).status).toBe(200);
    expect(await refusal(await harness.add('fake:c'))).toEqual({ status: 503, error: 'busy', retryAfter: '3600' });
    // With the encrypted catalog, the database takes no write between two passes: its timing would tell when someone added a channel.
    expect(await harness.dump()).toBe(before);

    // Once in its slot, a channel is answered whatever the budgets say.
    harness.setNow(START + 10 * MINUTE);
    await runPass(harness.platform, keys, await readState(harness.db, keys), { firstTableSize: 8 }, [source]);
    expect((await harness.add('fake:a')).status).toBe(200);

    harness.setNow(START + HOUR);
    expect((await harness.add('fake:c')).status).toBe(200);
  });

  it('refuses new channels past the day’s budget until the next day', async () => {
    const { harness } = await setup({ newChannelsPerDay: 2 });
    await harness.add('fake:a');
    await harness.add('fake:b');

    // The tests start at noon UTC: the day's window ends at midnight.
    expect(await refusal(await harness.add('fake:c'))).toEqual({ status: 503, error: 'busy', retryAfter: String(DAY / 2 / 1000) });

    harness.setNow(START + DAY / 2);
    expect((await harness.add('fake:c')).status).toBe(200);
  });

  // A @handle that does not exist costs a page read too: failures must count, or a script could
  // read the platform without limit.
  it('counts every submission that reads the platform, failed ones included, per minute', async () => {
    const { harness } = await setup({ onlineLookupsPerMinute: 2 });

    expect((await harness.add('fake:nobody')).status).toBe(404);
    expect((await harness.add('fake:noone')).status).toBe(404);
    expect(await refusal(await harness.add('fake:a'))).toEqual({ status: 503, error: 'busy', retryAfter: '60' });

    harness.setNow(START + MINUTE);
    expect((await harness.add('fake:a')).status).toBe(200);
  });

  it('lets only one of two submissions at once take the last read of the minute', async () => {
    const { harness } = await setup({ onlineLookupsPerMinute: 1 });

    const statuses = (await Promise.all([harness.add('fake:a'), harness.add('fake:b')])).map((response) => response.status);

    expect(statuses.sort()).toEqual([200, 503]);
  });

  it('refuses new channels once the catalog holds as many as polling can keep up with', async () => {
    // One channel per run, every minute, about four polls a channel a day: 360 channels, as the last pass counted them.
    const { harness, source } = await setup({ pollBatchSize: 1 });
    const keys = await harness.platform.keys;
    await runPass(harness.platform, keys, undefined, { firstTableSize: 8 });
    await harness.add('fake:a');
    harness.setNow(START + 10 * MINUTE);
    const state = await runPass(harness.platform, keys, await readState(harness.db, keys), { firstTableSize: 8 }, [source]);
    expect(state.channels).toBe(1);
    await harness.db.run(await stateWrite(keys, { ...state, channels: 360 }, false));

    expect(await refusal(await harness.add('fake:b'))).toEqual({ status: 503, error: 'catalog_full', retryAfter: String(DAY / 1000) });
    expect((await harness.add('fake:a')).status).toBe(200);
  });
});
