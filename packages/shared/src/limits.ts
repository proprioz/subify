/** Channels one device may follow: far more than anyone follows, and a bound on what a restore downloads. */
export const MAX_SYNC_CHANNELS = 5000;

/** Passes the sync stream keeps, 30 days of 10-minute passes: a device further behind reads its groups' snapshots. */
export const STREAM_KEPT_PASSES = 30 * 144;

/**
 * The sizes a blind evaluation batch may have: a device pads its batch with random elements up to
 * one of them, so that the request and its answer tell only which size it chose.
 */
export const BLIND_BATCH_SIZES = [10, 50] as const;

/**
 * A channel new to the catalog enters it at a random time within this long after it was read
 * (docs/FEATURES.md, D16), so that when it enters tells neither when someone added it nor which
 * channels one person added together. The device that added it has it at once; its next videos
 * may come up to this late.
 */
export const ENTRY_DELAY = 6 * 60 * 60_000;

/** The characters a YouTube channel id is made of, after its `UC`. */
const CHANNEL_ID_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The Wikidata dictionary's slices: one per third character of a channel id. */
export const DICTIONARY_SLICES = CHANNEL_ID_CHARACTERS.length;

/** The start shared by every channel id of a slice of the dictionary. */
export function dictionarySlicePrefix(slice: number): string {
  return `UC${CHANNEL_ID_CHARACTERS[slice]}`;
}
