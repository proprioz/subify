import { describe, expect, it } from 'vitest';
import { countryFlag } from '../src/data/format';
import { type AskConnection, ConnectionGate, type ConnectionTrust, isCancelled, setConnectionCheck } from '../src/data/connection-check';
import { FakeServer, freshDb, NOW } from './fake-server';

/** A dialog that answers `answers` in turn and remembers each country it showed. */
function dialog(...answers: (ConnectionTrust | null)[]): AskConnection & { shown: (string | null)[] } {
  const shown: (string | null)[] = [];
  const ask = async (country: string | null) => {
    shown.push(country);

    return answers.shift() ?? null;
  };

  return Object.assign(ask, { shown });
}

async function setup(on: boolean, ask: AskConnection, now = () => NOW) {
  const db = freshDb();
  await setConnectionCheck(db, on);
  const server = new FakeServer();
  const gate = new ConnectionGate(db, ask, now);
  const api = server.api(gate.guard);

  return { db, server, gate, api, step: () => gate.run(api, () => api.health()) };
}

// Off by default, the check must not add a request or a dialog to anything.
it('lets every step through without asking while the check is off', async () => {
  const ask = dialog();
  const { server, step } = await setup(false, ask);

  await step();

  expect(ask.shown).toEqual([]);
  expect(server.paths).toEqual(['GET /api/health']);
});

// The check’s promise: until the user continues, the only request is the country, and cancelling sends nothing else.
describe('with the check on', () => {
  it('shows the country first, and sends nothing else when the user cancels', async () => {
    const ask = dialog(null);
    const { server, step } = await setup(true, ask);

    const failure = await step().catch((error: unknown) => error);

    expect(isCancelled(failure)).toBe(true);
    expect(ask.shown).toEqual(['CH']);
    expect(server.paths).toEqual(['GET /api/connection']);
  });

  it('runs the step once the user continues, and asks again next time', async () => {
    const ask = dialog('once', 'once');
    const { server, step } = await setup(true, ask);

    await step();
    await step();

    expect(server.paths).toEqual(['GET /api/connection', 'GET /api/health', 'GET /api/connection', 'GET /api/health']);
  });

  // A self-hosted server can’t tell the country: the user still decides, with no wrong place shown.
  it('asks without a country when the server can’t tell', async () => {
    const ask = dialog('once');
    const { server, step } = await setup(true, ask);
    server.country = null;

    await step();

    expect(ask.shown).toEqual([null]);
  });

  // A refresh and an added channel can start together: the user must see one dialog, not two.
  it('asks once for steps that start together', async () => {
    const ask = dialog('once');
    const { gate, api, step } = await setup(true, ask);

    await Promise.all([step(), gate.run(api, () => api.health())]);

    expect(ask.shown).toHaveLength(1);
  });

  // A request that skips the gate (a forgotten call site) must not leave before the user approved.
  it('stops a request made outside an approved step', async () => {
    const { server, api } = await setup(true, dialog());

    await expect(api.health()).rejects.toSatisfy(isCancelled);
    expect(server.paths).toEqual([]);
  });

  // The import queue moves on its own every few seconds: it must neither pop a dialog nor go online unapproved.
  it('keeps steps the app starts on its own waiting, without asking', async () => {
    const ask = dialog();
    const { server, gate, api } = await setup(true, ask);

    expect(await gate.whenApproved(() => api.health())).toBeUndefined();
    expect(ask.shown).toEqual([]);
    expect(server.paths).toEqual([]);
  });
});

describe('a remembered approval', () => {
  it('skips the check for the chosen time, then asks again', async () => {
    let now = NOW;
    const ask = dialog('5-minutes', 'once');
    const { gate, step } = await setup(true, ask, () => now);

    await step();
    now += 4 * 60 * 1000;
    await step();
    expect(await gate.whenApproved(async () => 'ran')).toBe('ran');
    now += 2 * 60 * 1000;
    await step();

    expect(ask.shown).toHaveLength(2);
  });

  it('lasts until the app closes, and a new launch asks again', async () => {
    const ask = dialog('until-app-closes', 'once');
    const { db, server, step } = await setup(true, ask);

    await step();
    await step();
    expect(ask.shown).toHaveLength(1);

    const relaunched = new ConnectionGate(db, ask, () => NOW);
    await relaunched.run(server.api(relaunched.guard), async () => {});

    expect(ask.shown).toHaveLength(2);
  });

  // Turning the check off and on again must not keep an approval given before.
  it('is forgotten when the check is turned off or on', async () => {
    const ask = dialog('1-day', 'once');
    const { db, step } = await setup(true, ask);

    await step();
    await setConnectionCheck(db, false);
    await setConnectionCheck(db, true);
    await step();

    expect(ask.shown).toHaveLength(2);
  });
});

// The dialog shows the country's flag: a wrong letter mapping would show the wrong country, and a
// code that isn't two capital letters must not become stray symbols.
describe('countryFlag', () => {
  it('builds the flag from the two letters and refuses anything else', () => {
    expect(countryFlag('BE')).toBe('🇧🇪');
    expect(countryFlag('CH')).toBe('🇨🇭');
    expect(countryFlag('be')).toBeNull();
    expect(countryFlag('T1')).toBeNull();
    expect(countryFlag('BEL')).toBeNull();
  });
});
