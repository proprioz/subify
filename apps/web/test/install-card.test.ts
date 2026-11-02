import { describe, expect, it } from 'vitest';
import { SubifyDb } from '../src/data/db';
import { dismissInstallCard, INSTALL_CARD_PAUSE, installCardCanStop, installCardDue, loadInstallCard } from '../src/data/settings';

const DAY = 24 * 60 * 60 * 1000;

// The owner wants the invitation to install back every 7 days, at least 3 times, before it can be turned off for good.
describe('the invitation to install on the feed', () => {
  it('comes back 7 days after each “Not now”, and offers to stop only once back for the third time', async () => {
    const db = new SubifyDb(`install-card-${Math.random()}`);
    let now = 1_000 * DAY;

    expect(installCardDue(await loadInstallCard(db), now)).toBe(true);

    for (let returns = 1; returns <= 3; returns++) {
      expect(installCardCanStop(await loadInstallCard(db))).toBe(false);
      await dismissInstallCard(db, now, false);
      expect(installCardDue(await loadInstallCard(db), now + INSTALL_CARD_PAUSE - 1)).toBe(false);
      now += 7 * DAY;
      expect(installCardDue(await loadInstallCard(db), now)).toBe(true);
    }

    expect(installCardCanStop(await loadInstallCard(db))).toBe(true);
    await dismissInstallCard(db, now, true);
    expect(installCardDue(await loadInstallCard(db), now + 365 * DAY)).toBe(false);
  });
});
