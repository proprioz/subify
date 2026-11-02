/**
 * Labels for dates. Days are counted in the device's time zone, from
 * midnight to midnight, so "Yesterday" means the calendar day before.
 */

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): Date {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);

  return date;
}

function daysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / DAY);
}

/** The stretch of time a video belongs to, used as the feed's section headings. */
export function periodLabel(published: number, now = Date.now()): string {
  const days = daysBetween(published, now);

  if (days <= 0) {
    return 'Today';
  }

  if (days === 1) {
    return 'Yesterday';
  }

  if (days < 7) {
    return 'This week';
  }

  const date = new Date(published);
  const today = new Date(now);

  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) {
    return 'Earlier this month';
  }

  return date.toLocaleDateString('en', date.getFullYear() === today.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

type AgeUnit = 'day' | 'week' | 'month' | 'year';

/** How long ago a video was published, in days, weeks, months or years: “3 days ago”. */
export function ageLabel(published: number, now = Date.now()): string {
  const age = ageOf(published, now);

  return age === null ? 'today' : `${age.count} ${age.unit}${age.count === 1 ? '' : 's'} ago`;
}

const SHORT_UNITS: Record<AgeUnit, string> = { day: 'd', week: 'w', month: 'mo', year: 'y' };

/** The same age, abbreviated for a line that must not wrap: “3d”, “2w”, “5mo”, “1y”. */
export function shortAgeLabel(published: number, now = Date.now()): string {
  const age = ageOf(published, now);

  return age === null ? 'today' : `${age.count}${SHORT_UNITS[age.unit]}`;
}

/** The age in its largest whole unit, or null for a video published today. */
function ageOf(published: number, now: number): { count: number; unit: AgeUnit } | null {
  const days = daysBetween(published, now);

  if (days <= 0) {
    return null;
  }

  if (days < 7) {
    return { count: days, unit: 'day' };
  }

  if (days < 35) {
    return { count: Math.floor(days / 7), unit: 'week' };
  }

  const from = new Date(published);
  const to = new Date(now);
  const months = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() - (to.getDate() < from.getDate() ? 1 : 0);

  if (months < 12) {
    return { count: Math.max(1, months), unit: 'month' };
  }

  return { count: Math.max(1, Math.floor(months / 12)), unit: 'year' };
}

/** "Updated just now", "Updated 5 min ago"… for the last successful sync. */
export function updatedLabel(at: number | undefined, now = Date.now()): string | null {
  if (at === undefined) {
    return null;
  }

  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) {
    return 'Updated just now';
  }

  if (minutes < 60) {
    return `Updated ${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `Updated ${hours} h ago` : `Updated ${Math.floor(hours / 24)} d ago`;
}

/** A country's name in English, from its ISO 3166 code, such as “Switzerland” for 'CH'. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A country's flag as an emoji, such as 🇧🇪 for 'BE': its two letters as regional indicator
 * symbols, which the system draws as the flag. Null for anything but two capital letters, so a
 * code from an unexpected server never turns into stray symbols.
 */
export function countryFlag(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) {
    return null;
  }

  return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}
