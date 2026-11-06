import decodeJpeg, { init as initJpeg } from '@jsquash/jpeg/decode.js';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import { rgbaToThumbHash } from 'thumbhash';
import { logError } from '../log';
import type { Image } from '../sources/image';

/**
 * A new video's thumbnail as the catalog keeps it (docs/FEATURES.md, D3): `mqdefault.jpg`
 * re-encoded as WebP at quality 65, about 7 KB instead of 10, and its ThumbHash, the blurred
 * preview its stream entry carries. In WASM (jSquash), about 14 ms a picture in workerd. The
 * runtime compiles the modules its own way (src/entry/), so this stays the same everywhere.
 */

export interface ThumbnailModules {
  /** `@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm` */
  jpeg: WebAssembly.Module;
  /** `@jsquash/webp/codec/enc/webp_enc_simd.wasm` */
  webp: WebAssembly.Module;
}

export interface EncodedThumbnail {
  image: Image;
  /** Null when the picture couldn't be read: the app then draws its placeholder. */
  preview: Uint8Array | null;
}

/** Re-encodes a thumbnail. Never throws: a picture it can't read is kept as read, without a preview. */
export type ThumbnailEncoder = (image: Image) => Promise<EncodedThumbnail>;

const QUALITY = 65;
/** ThumbHash takes at most 100 px a side: 320×180 averaged down to this keeps the 16:9 frame. */
const PREVIEW_WIDTH = 100;
const PREVIEW_HEIGHT = 56;

export function thumbnailEncoder(load: () => Promise<ThumbnailModules>): ThumbnailEncoder {
  let ready: Promise<void> | undefined;

  return async (image) => {
    if (image.type !== 'image/jpeg' || image.bytes[0] !== 0xff || image.bytes[1] !== 0xd8) {
      return { image, preview: null };
    }

    try {
      ready ??= load().then(async ({ jpeg, webp }) => {
        await initJpeg(jpeg);
        await initWebp(webp);
      });
      await ready;
      const pixels = await decodeJpeg(image.bytes.slice().buffer);
      const webp = new Uint8Array(await encodeWebp(pixels, { quality: QUALITY }));
      const small = averageDown(pixels, PREVIEW_WIDTH, PREVIEW_HEIGHT);

      return {
        image: webp.length < image.bytes.length ? { type: 'image/webp', bytes: webp } : image,
        preview: rgbaToThumbHash(small.width, small.height, small.data),
      };
    } catch (error) {
      // A WASM module that aborted is set up again for the next picture.
      ready = undefined;
      logError('Encoding a thumbnail failed', error);

      return { image, preview: null };
    }
  };
}

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A smaller copy, each pixel the average of the ones it covers: what ThumbHash expects as input. */
export function averageDown(source: Pixels, width: number, height: number): Pixels {
  const w = Math.min(width, source.width);
  const h = Math.min(height, source.height);
  const data = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const top = Math.floor((y * source.height) / h);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * source.height) / h));

    for (let x = 0; x < w; x++) {
      const left = Math.floor((x * source.width) / w);
      const right = Math.max(left + 1, Math.floor(((x + 1) * source.width) / w));
      const sum = [0, 0, 0, 0];

      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const at = (sy * source.width + sx) * 4;

          for (let c = 0; c < 4; c++) {
            sum[c]! += source.data[at + c]!;
          }
        }
      }

      const count = (bottom - top) * (right - left);
      sum.forEach((value, c) => (data[(y * w + x) * 4 + c] = Math.round(value / count)));
    }
  }

  return { width: w, height: h, data };
}
