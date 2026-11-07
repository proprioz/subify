import { describe, expect, it } from 'vitest';
import { guessTimeSentence, secondsToGuess, WEAK_BELOW_SECONDS } from '../src/data/strength';

// What the user reads as they choose the app's password: a PIN must sound as weak as it is.
describe('how long a password would hold', () => {
  it('calls common and short PINs weak, and says so in plain words', () => {
    for (const pin of ['1234', '0000', '2580', '483920']) {
      expect(secondsToGuess(pin)).toBeLessThan(60);
    }

    expect(guessTimeSentence('2580')).toBe('Someone determined could guess it at once.');
    expect(secondsToGuess('48392017')).toBeLessThan(WEAK_BELOW_SECONDS);
  });

  it('counts runs and repeats as tried first, and a word with digits as a word', () => {
    expect(secondsToGuess('12345678901')).toBeLessThan(secondsToGuess('83920174652'));
    expect(secondsToGuess('chocolat2024')).toBeLessThan(WEAK_BELOW_SECONDS);
    expect(secondsToGuess('Password')).toBeLessThan(1);
  });

  it('holds a long random password or a passphrase for centuries', () => {
    expect(guessTimeSentence('tk7#Qm2!vRx9')).toBe('Someone determined would need centuries to guess it.');
    expect(guessTimeSentence('vélo rouge sous la pluie')).toBe('Someone determined would need centuries to guess it.');
  });
});
