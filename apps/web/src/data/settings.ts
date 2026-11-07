import { getMeta, setMeta, type SubifyDb } from './db';

export type Theme = 'light' | 'dark' | 'system';

export async function loadTheme(db: SubifyDb): Promise<Theme> {
  return (await getMeta<Theme>(db, 'theme')) ?? 'system';
}

/** How long “Not now” hides the invitation to install on the feed. */
export const INSTALL_CARD_PAUSE = 7 * 24 * 60 * 60 * 1000;

/** How many times the invitation comes back before it offers to stop for good. */
export const INSTALL_CARD_RETURNS = 3;

/** What the user answered the invitation to install: how often “Not now” and when, or never again. */
export type InstallCard = { dismissals: number; lastAt: number } | 'never';

/** `null` until the user first answers. */
export async function loadInstallCard(db: SubifyDb): Promise<InstallCard | null> {
  return (await getMeta<InstallCard>(db, 'installCard')) ?? null;
}

/** Whether the feed shows the invitation now: at first, then each time a pause is over. */
export function installCardDue(card: InstallCard | null, now: number): boolean {
  return card === null || (card !== 'never' && now - card.lastAt >= INSTALL_CARD_PAUSE);
}

/** Whether the invitation, back for the last of its returns or later, offers to stop for good. */
export function installCardCanStop(card: InstallCard | null): boolean {
  return card !== null && card !== 'never' && card.dismissals >= INSTALL_CARD_RETURNS;
}

export async function dismissInstallCard(db: SubifyDb, now: number, forGood: boolean): Promise<void> {
  const card = await loadInstallCard(db);
  const dismissals = card === null || card === 'never' ? 0 : card.dismissals;

  await setMeta(db, 'installCard', forGood ? 'never' : { dismissals: dismissals + 1, lastAt: now });
}
