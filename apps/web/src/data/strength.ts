/**
 * How long the app's password would hold, said to the user as they choose it: a PIN or a word is
 * accepted, with how fast it would fall. It stands for the key that opens the device's data
 * (vault.ts), so the measure is someone holding a copy of that data, trying passwords on computers
 * built for it, away from the app's waits between attempts. An order of magnitude, not a promise.
 */

/**
 * Guesses per second against Argon2id with 64 MiB and 2 passes (vault.ts): each guess fills 64 MiB
 * of memory twice, which caps a graphics card at a few thousand; a handful of them make ten thousand.
 */
const GUESSES_PER_SECOND = 10_000;

/** Below this, the sheet suggests a longer password. */
export const WEAK_BELOW_SECONDS = 30 * 24 * 3600;

/** Tried first by anyone guessing: the commonest PINs and passwords, in French and English. */
const COMMON = new Set([
  '0000', '1111', '1212', '1234', '2222', '4321', '5555', '6969', '7777', '9999', '123456', '12345678', '123456789', '000000', '111111', '654321', '121212',
  'password', 'motdepasse', 'azerty', 'azertyuiop', 'qwerty', 'qwertz', 'iloveyou', 'jetaime', 'soleil', 'bonjour', 'doudou', 'loulou', 'chouchou', 'football', 'marseille',
  'password1', 'abc123', 'admin', 'welcome', 'subify',
]);

/** Words a person would pick: a dictionary of this size covers most of them. */
const WORDS = 100_000;
const LETTERS_PER_WORD = 7;

/** The seconds a well-equipped guesser would need, on average, to find this password. */
export function secondsToGuess(password: string): number {
  return guesses(password) / 2 / GUESSES_PER_SECOND;
}

function guesses(password: string): number {
  if (COMMON.has(password.toLowerCase())) {
    return 1;
  }

  // A word, a capital perhaps, and digits after it: how people make a password, tried as such.
  const word = /^([a-zA-Z]+)(\d*)$/.exec(password);

  if (word !== null) {
    const [, letters = '', digits = ''] = word;
    const capital = /[A-Z]/.test(letters) ? 2 : 1;

    return Math.min(26 ** letters.length, WORDS ** (letters.length / LETTERS_PER_WORD)) * capital * 10 ** digits.length;
  }

  const pool = (/\d/.test(password) ? 10 : 0) + (/[a-z]/.test(password) ? 26 : 0) + (/[A-Z]/.test(password) ? 26 : 0) + (/[^0-9a-zA-Z]/.test(password) ? 33 : 0);

  return pool ** effectiveLength(password);
}

/** Repeated characters (“1111”) and runs (“1234”, “abcd”, “9876”) count as one: they are tried early. */
function effectiveLength(password: string): number {
  const codes = [...password].map((character) => character.codePointAt(0) ?? 0);
  let length = 0;

  for (let i = 0; i < codes.length; i++) {
    const step = i > 0 ? codes[i]! - codes[i - 1]! : null;
    const before = i > 1 ? codes[i - 1]! - codes[i - 2]! : null;
    const continues = step !== null && (step === 0 || (Math.abs(step) === 1 && step === before));

    if (!continues) {
      length++;
    }
  }

  return length;
}

/** What the sheet says under the password: who could find it, and how fast. */
export function guessTimeSentence(password: string): string {
  const seconds = secondsToGuess(password);

  if (seconds < 1) {
    return 'Someone determined could guess it at once.';
  }

  if (seconds < 60) {
    return 'Someone determined could guess it in seconds.';
  }

  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [24 * 3600, 'day'],
    [30 * 24 * 3600, 'month'],
    [365 * 24 * 3600, 'year'],
  ];

  if (seconds >= 100 * 365 * 24 * 3600) {
    return 'Someone determined would need centuries to guess it.';
  }

  // The largest unit that fits once, rounded to a whole number of it.
  const [size, name] = units.findLast(([unit]) => seconds >= unit) ?? units[0]!;
  const count = Math.round(seconds / size);

  return `Someone determined could guess it in about ${count} ${name}${count === 1 ? '' : 's'}.`;
}
