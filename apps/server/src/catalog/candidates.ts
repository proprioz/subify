import type { ParsedInput } from '../sources/source';

/**
 * Seed candidates (docs/FEATURES.md, D15): channels that the descriptions of the catalog's videos
 * link to. They come from public descriptions only, never from what a user sent.
 */

/** An input as stored: 'channel:UC…', 'handle:name' (lowercase: handles ignore case), 'other:…'. */
export function candidateInput(input: ParsedInput): string {
  switch (input.kind) {
    case 'channel':
      return `channel:${input.externalId}`;
    case 'handle':
      return `handle:${input.handle.toLowerCase()}`;
    case 'other':
      return `other:${input.value}`;
  }
}

export function parseCandidateInput(stored: string): ParsedInput | null {
  const separator = stored.indexOf(':');
  const [kind, value] = [stored.slice(0, separator), stored.slice(separator + 1)];

  switch (kind) {
    case 'channel':
      return { kind: 'channel', externalId: value };
    case 'handle':
      return { kind: 'handle', handle: value };
    case 'other':
      return { kind: 'other', value };
    default:
      return null;
  }
}
