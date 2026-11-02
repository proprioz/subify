import { type Codec, reader, writer } from './bytes';

/**
 * The encrypted catalog's own state (docs/FEATURES.md, D16), in the vault row at position 1: its
 * size class, how many passes it has had, when the next growth step is due and how many channels
 * it holds. Nothing per channel.
 */
export interface CatalogState {
  /** Slots in the table, real and decoys. */
  tableSize: number;
  passes: number;
  /** When the table grows, once it crossed its threshold; null when no growth is due. */
  growthDueAt: number | null;
  /**
   * Whether a channel's feed answered during the last pass that read any. A "not found" counts
   * towards removing a channel only then: YouTube's outages answer 404 for every channel.
   */
  feedsAnswered: boolean;
  /** The thumbnail ring's next case to overwrite: the oldest. */
  ringNext: number;
  /** Channels in the table after the last pass: what seeding and the catalog's capacity go by. */
  channels: number;
}

export const catalogStateCodec: Codec<CatalogState> = {
  kind: 2,
  version: 1,
  size: 64,

  encode(value) {
    return writer(catalogStateCodec)
      .u32(value.tableSize)
      .u32(value.passes)
      .u32(Math.floor((value.growthDueAt ?? 0) / 1000))
      .u8(value.feedsAnswered ? 1 : 0)
      .u32(value.ringNext)
      .u32(value.channels)
      .finish();
  },

  decode(bytes) {
    const read = reader(catalogStateCodec, bytes);
    const tableSize = read.u32();
    const passes = read.u32();
    const due = read.u32();
    const feedsAnswered = read.upTo(read.u8(), 1) === 1;
    const ringNext = read.u32();
    const channels = read.u32();
    read.end();

    return { tableSize, passes, growthDueAt: due === 0 ? null : due * 1000, feedsAnswered, ringNext, channels };
  },
};
