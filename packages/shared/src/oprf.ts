/**
 * The catalog's VOPRF (RFC 9497, ristretto255-SHA512) and what derives from its output
 * (docs/FEATURES.md, D16). A device gets a channel's output O without the server learning which
 * channel it asked for; the server computes the same O directly. From O come the channel's slot
 * id, its transit key K_c and its group.
 *
 * It pulls in @noble/curves: the PWA loads this module on demand, never with its first screen.
 */
import { ristretto255_oprf } from '@noble/curves/ed25519.js';
import { utf8 } from './codec/bytes';

const voprf = ristretto255_oprf.voprf;

/** Channels per blind evaluation request. */
export const MAX_BLIND_BATCH = 50;

/** A channel's VOPRF input: its key, '<source>:<id on the platform>'. */
export function channelInput(source: string, externalId: string): Uint8Array {
  return utf8(`${source}:${externalId}`);
}

/**
 * A handle's VOPRF input, for the handle index: '<source>:@<handle>', lowercase as handles ignore
 * case. An id never holds '@', so it can't be mistaken for a channel's input.
 */
export function handleInput(source: string, handle: string): Uint8Array {
  return utf8(`${source}:@${handle.toLowerCase()}`);
}

export interface VoprfKeys {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** The server's key pair, from a 32-byte seed derived from its master secret. */
export function voprfKeys(seed: Uint8Array): VoprfKeys {
  return voprf.deriveKeyPair(seed, utf8('subify voprf key'));
}

/** Server side, for a channel it knows: the same O a device gets by blind evaluation. */
export function evaluate(keys: VoprfKeys, input: Uint8Array): Uint8Array {
  // The VOPRF bundle has `evaluate` (RFC 9497, section 3.3.2), but its type declarations leave it out.
  return (voprf as unknown as { evaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array }).evaluate(keys.secretKey, input);
}

export interface BlindEvaluation {
  evaluated: Uint8Array[];
  /** One proof for the whole batch: the device checks the server used its published key. */
  proof: Uint8Array;
}

/** Server side: evaluates blinded elements without learning what they hide. Throws on a malformed element. */
export function evaluateBlinded(keys: VoprfKeys, blinded: readonly Uint8Array[]): BlindEvaluation {
  if (blinded.length === 0 || blinded.length > MAX_BLIND_BATCH) {
    throw new RangeError('Batch size out of range');
  }

  return voprf.blindEvaluateBatch(keys.secretKey, keys.publicKey, [...blinded]);
}

export interface Blinded {
  inputs: Uint8Array[];
  blinds: Uint8Array[];
  /** What goes to the server. */
  blinded: Uint8Array[];
}

/** Device side, first step: blinds the inputs. The blinds never leave the device. */
export function blind(inputs: readonly Uint8Array[]): Blinded {
  const results = inputs.map((input) => voprf.blind(input));

  return { inputs: [...inputs], blinds: results.map((result) => result.blind), blinded: results.map((result) => result.blinded) };
}

/**
 * Device side, last step: checks the server's proof against its public key, then unblinds. Throws
 * when the proof fails: an answer computed with another key would give the device wrong slots.
 */
export function finalize(request: Blinded, answer: BlindEvaluation, publicKey: Uint8Array): Uint8Array[] {
  if (answer.evaluated.length !== request.inputs.length) {
    throw new RangeError('Answer size mismatch');
  }

  return voprf.finalizeBatch(
    request.inputs.map((input, i) => ({ input, blind: request.blinds[i]!, blinded: request.blinded[i]!, evaluated: answer.evaluated[i]! })),
    publicKey,
    answer.proof,
  );
}

/** What a channel's O gives: where its slot is, and the key its sync entries are sealed with. */
export interface ChannelSecrets {
  /** 16 bytes. Its leading bits are the channel's group (see {@link groupOf}). */
  slotId: Uint8Array;
  /** 32 bytes, an AES-256-GCM key. */
  transitKey: Uint8Array;
}

export async function channelSecrets(output: Uint8Array): Promise<ChannelSecrets> {
  const [slot, transit] = await Promise.all(['slot', 'transit'].map((label) => labelled(label, output)));

  return { slotId: slot!.slice(0, 16), transitKey: transit! };
}

/**
 * The group of a slot among `groups`, a power of two: the leading bits of its id. Groups nest:
 * with half as many groups, a slot's group is this one halved, and a group's slots are one range
 * of ids, which the server reads in one query.
 */
export function groupOf(slotId: Uint8Array, groups: number): number {
  const bits = Math.log2(groups);

  if (!Number.isInteger(bits) || bits > 16) {
    throw new RangeError('Groups must be a power of two, at most 65,536');
  }

  return bits === 0 ? 0 : new DataView(slotId.buffer, slotId.byteOffset, 4).getUint32(0) >>> (32 - bits);
}

/** SHA-256 over a label and O: O is uniformly random, so one hash per label separates the uses. */
async function labelled(label: string, output: Uint8Array): Promise<Uint8Array> {
  const prefix = utf8(`subify/${label}\0`);
  const message = new Uint8Array(prefix.length + output.length);
  message.set(prefix);
  message.set(output, prefix.length);

  return new Uint8Array(await crypto.subtle.digest('SHA-256', message));
}
