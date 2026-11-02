import { channelInput, channelSecrets, evaluate } from '@subify/shared/oprf';
import type { ServerKeys } from '../crypto/keys';

/**
 * A channel's slot id, as the server computes it: the same a device derives from its blind
 * evaluation (docs/FEATURES.md, D16). About 1.5 ms of CPU.
 */
export async function slotIdOf(keys: ServerKeys, source: string, externalId: string): Promise<Uint8Array> {
  return (await channelSecrets(evaluate(keys.voprf, channelInput(source, externalId)))).slotId;
}
