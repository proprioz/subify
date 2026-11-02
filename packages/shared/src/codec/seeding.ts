import { type Codec, CodecError, reader, utf8Length, writer } from './bytes';
import { SLOT_SIZE } from './slot';

/**
 * What seeding keeps in the encrypted catalog (docs/FEATURES.md, D16): its candidates, in rows of
 * the size of a slot, and when users add channels, by hour of day. Both are rewritten whole at
 * every pass, so their size and their writes say nothing about how many there are.
 */

/** A channel that a description of the catalog's videos links to. */
export interface SeedCandidate {
  source: string;
  /** As seed candidates are stored: 'channel:UC…', 'handle:name', 'other:…'. */
  input: string;
  /** How many times it was cited, at most 255: a channel cited once is the best cover. */
  cites: number;
  /** The day (since 1970) it was first cited. */
  day: number;
}

export const SEED_POOL_ROW_SIZE = SLOT_SIZE;
const MAX_TEXT = 255;
const ROW_HEADER = 1 + 2;

/** Bytes a candidate takes in a row. */
export function candidateSize(candidate: SeedCandidate): number {
  return 1 + utf8Length(candidate.source) + 1 + utf8Length(candidate.input) + 1 + 2;
}

/** Room for candidates in one row. */
export const SEED_POOL_ROW_ROOM = SEED_POOL_ROW_SIZE - ROW_HEADER;

export const seedPoolCodec: Codec<SeedCandidate[]> = {
  kind: 4,
  version: 1,
  size: SEED_POOL_ROW_SIZE,

  encode(value) {
    const out = writer(seedPoolCodec).u16(value.length);

    for (const candidate of value) {
      if (utf8Length(candidate.source) > MAX_TEXT || utf8Length(candidate.input) > MAX_TEXT) {
        throw new CodecError('Payload too large');
      }

      out.text(candidate.source).text(candidate.input).u8(Math.min(candidate.cites, 0xff)).u16(candidate.day);
    }

    return out.finish();
  },

  decode(bytes) {
    const read = reader(seedPoolCodec, bytes);
    const count = read.u16();
    const candidates: SeedCandidate[] = [];

    for (let i = 0; i < count; i++) {
      candidates.push({ source: read.text(MAX_TEXT), input: read.text(MAX_TEXT), cites: read.u8(), day: read.u16() });
    }

    read.end();

    return candidates;
  },
};

/** Users' additions by hour of day (UTC), halved once a week. */
export interface AddingHours {
  counts: number[];
  /** The day (since 1970) they were last halved. */
  halvedDay: number;
}

export const addingHoursCodec: Codec<AddingHours> = {
  kind: 5,
  version: 1,
  size: 128,

  encode(value) {
    if (value.counts.length !== 24) {
      throw new CodecError('Number out of range');
    }

    const out = writer(addingHoursCodec);
    value.counts.forEach((count) => out.u32(count));

    return out.u16(value.halvedDay).finish();
  },

  decode(bytes) {
    const read = reader(addingHoursCodec, bytes);
    const counts = Array.from({ length: 24 }, () => read.u32());
    const halvedDay = read.u16();
    read.end();

    return { counts, halvedDay };
  },
};
