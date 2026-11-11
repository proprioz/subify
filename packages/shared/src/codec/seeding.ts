import { type Codec, CodecError, flags, reader, utf8Length, writer } from './bytes';
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
  /** The channel whose video cited it last, by its id on the source; empty for a candidate of version 1. */
  citer: string;
  /** That video's id; empty for a candidate of version 1. */
  video: string;
  /** The day (since 1970) that video was published: a later citation takes its place. */
  cited: number;
  /** That video has left its channel's public feeds: the candidate may be drawn. */
  ripe: boolean;
}

export const SEED_POOL_ROW_SIZE = SLOT_SIZE;
const MAX_TEXT = 255;
const ROW_HEADER = 1 + 2;

/** Bytes a candidate takes in a row. */
export function candidateSize(candidate: SeedCandidate): number {
  return 1 + utf8Length(candidate.source) + 1 + utf8Length(candidate.input) + 1 + 2 + 1 + utf8Length(candidate.citer) + 1 + utf8Length(candidate.video) + 2 + 1;
}

/** Room for candidates in one row. */
export const SEED_POOL_ROW_ROOM = SEED_POOL_ROW_SIZE - ROW_HEADER;

export const seedPoolCodec: Codec<SeedCandidate[]> = {
  kind: 4,
  version: 2,
  size: SEED_POOL_ROW_SIZE,

  encode(value) {
    const out = writer(seedPoolCodec).u16(value.length);

    for (const candidate of value) {
      if ([candidate.source, candidate.input, candidate.citer, candidate.video].some((text) => utf8Length(text) > MAX_TEXT)) {
        throw new CodecError('Payload too large');
      }

      out.text(candidate.source).text(candidate.input).u8(Math.min(candidate.cites, 0xff)).u16(candidate.day);
      out.text(candidate.citer).text(candidate.video).u16(candidate.cited).u8(candidate.ripe ? 1 : 0);
    }

    return out.finish();
  },

  // Version 1 kept no citing video: such a candidate ripens by its day (src/catalog/seed-pool.ts).
  decode(bytes) {
    const read = reader(seedPoolCodec, bytes, 1);
    const count = read.u16();
    const candidates: SeedCandidate[] = [];

    for (let i = 0; i < count; i++) {
      const candidate: SeedCandidate = { source: read.text(MAX_TEXT), input: read.text(MAX_TEXT), cites: read.u8(), day: read.u16(), citer: '', video: '', cited: 0, ripe: false };

      if (read.version > 1) {
        Object.assign(candidate, { citer: read.text(MAX_TEXT), video: read.text(MAX_TEXT), cited: read.u16(), ripe: flags(read.u8(), 1) === 1 });
      }

      candidates.push(candidate);
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
