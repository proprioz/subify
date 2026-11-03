import { type Codec, CodecError, reader, writer } from './bytes';
import type { SlotImage, SlotImageType } from './slot';

/**
 * One case of the thumbnail ring (docs/FEATURES.md, D16): an item's thumbnail, or a decoy of the
 * same size. The case names its item, so that a slot pointing at a case the ring has since
 * overwritten finds another item there, not a wrong picture.
 */
export type ThumbnailPayload = { kind: 'empty' } | { kind: 'thumbnail'; itemId: string; image: SlotImage };

/**
 * 24 KB per stored case, the AEAD's 30 bytes included. `mqdefault.jpg` (320×180) measured 9.6 KB
 * on average, 16.2 KB at the 95th percentile and at most 21.2 KB on 75 videos in November 2026;
 * larger thumbnails are not kept.
 */
export const THUMBNAIL_CASE_SIZE = 24 * 1024 - 30;
const MAX_ID = 64;
/** The largest image a case holds: the case, less its flag, item id and image type and length. */
export const THUMBNAIL_MAX_BYTES = THUMBNAIL_CASE_SIZE - 1 - 1 - (1 + MAX_ID) - 1 - 2;

const IMAGE_TYPES: readonly SlotImageType[] = ['image/jpeg', 'image/png', 'image/webp'];

export const thumbnailCodec: Codec<ThumbnailPayload> = {
  kind: 3,
  version: 1,
  size: THUMBNAIL_CASE_SIZE,

  encode(value) {
    const out = writer(thumbnailCodec);

    if (value.kind === 'empty') {
      return out.u8(0).finish();
    }

    if (value.itemId.length > MAX_ID || value.image.bytes.length > THUMBNAIL_MAX_BYTES) {
      throw new CodecError('Payload too large');
    }

    return out.u8(1).text(value.itemId).u8(IMAGE_TYPES.indexOf(value.image.type)).blob(value.image.bytes).finish();
  },

  decode(bytes) {
    const read = reader(thumbnailCodec, bytes);
    const flag = read.upTo(read.u8(), 1);

    if (flag === 0) {
      read.end();

      return { kind: 'empty' };
    }

    const itemId = read.text(MAX_ID);
    const type = IMAGE_TYPES[read.upTo(read.u8(), IMAGE_TYPES.length - 1)]!;
    const image = read.blob(THUMBNAIL_MAX_BYTES);
    read.end();

    return { kind: 'thumbnail', itemId, image: { type, bytes: image } };
  },
};
