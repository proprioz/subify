import type { EvaluateResponse, OprfKeyResponse } from '@subify/shared';
import { fromBase64Url, toBase64Url } from '@subify/shared/codec';
import { evaluateBlinded } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';
import type { Platform } from '../platform';
import { BudgetError } from './budgets';
import { MINUTE } from './schedule';

/**
 * Blind evaluation (docs/FEATURES.md, D16): a device gets the VOPRF output of channels without
 * naming them, and from it their slots and keys. The server sees random-looking elements only, in
 * batches of a fixed size, and its work doesn't depend on what they hide. Nothing about a request
 * is stored or logged.
 */

const BUSY = 'The server answers few of these at a time, and it has had many lately. Try again in a moment.';

export function oprfKey(keys: ServerKeys): OprfKeyResponse {
  return { v: 3, keyId: keys.keyId, publicKey: toBase64Url(keys.voprf.publicKey) };
}

/** The answer, or null when an element isn't a valid blinded element. */
export async function evaluateForDevice(platform: Platform, keys: ServerKeys, blinded: readonly string[]): Promise<EvaluateResponse | null> {
  const now = platform.clock.now();
  const window = Math.floor(now / MINUTE) * MINUTE;

  // Counted before the work, refused ones too: a probe costs its batch whether it succeeds or not.
  if (!(await platform.coordinator.take('blind_batches', window, platform.config.blindBatchesPerMinute))) {
    throw new BudgetError('busy', BUSY, Math.ceil((window + MINUTE - now) / 1000));
  }

  let answer;

  try {
    answer = evaluateBlinded(keys.voprf, blinded.map(fromBase64Url));
  } catch {
    return null;
  }

  return { v: 3, evaluated: answer.evaluated.map(toBase64Url), proof: toBase64Url(answer.proof) };
}
