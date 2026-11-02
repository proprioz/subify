/** A valid @handle, without its @. */
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const MAX_LENGTH = 2048;
/** Text that may be a channel's name: nothing that belongs to a link or a @handle. */
const NAME = /^[^/:@?#]+$/;
const SEPARATORS = ['.', '_', '-'];

/**
 * The @handles a channel typed by its name (“Léna Situations”) most likely has, most likely
 * first: its words run together (lenasituations), then joined by each separator handles allow
 * (lena.situations…), lowercase and without accents, and last run together with their accents
 * (lénasituations). Handles ignore case. Only valid handles are given; none for a link.
 * A leading @ is allowed: “@Léna Situations” is a name too. The server and the app guess alike.
 */
export function guessHandles(raw: string): string[] {
  const input = raw.trim().replace(/^@/, '');

  if (input.length > MAX_LENGTH || !NAME.test(input)) {
    return [];
  }

  const wordsOf = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s._-]+/u)
      .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((word) => word !== '');
  const words = wordsOf(input.normalize('NFD').replace(/\p{M}/gu, ''));
  const accented = wordsOf(input.normalize('NFC'));
  const guesses = [words.join(''), ...(words.length > 1 ? SEPARATORS.map((separator) => words.join(separator)) : []), accented.join('')];

  return [...new Set(guesses)].filter((guess) => HANDLE.test(guess));
}
