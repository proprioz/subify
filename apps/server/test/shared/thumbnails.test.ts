import { thumbHashToAverageRGBA } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import { averageDown, thumbnailEncoder } from '../../src/catalog/thumbnails';
import { thumbnailModules } from '#harness';
import jpegBase64 from '../fixtures/thumbnail-320x180.jpg.b64?raw';

// A 320×180 JPEG (ImageMagick plasma, quality 92) whose average colour is about rgb(130, 78, 131).
const jpeg = Uint8Array.from(atob(jpegBase64.trim()), (char) => char.charCodeAt(0));

// Each runtime loads the WASM modules its own way: a broken load in one would leave every new video without its thumbnail there.
describe('the thumbnail encoder', () => {
  it('re-encodes a JPEG as a smaller WebP, with a ThumbHash of the picture’s colours', async () => {
    const encode = thumbnailEncoder(thumbnailModules);
    const { image, preview } = await encode({ type: 'image/jpeg', bytes: jpeg });

    expect(image.type).toBe('image/webp');
    expect(new TextDecoder().decode(image.bytes.subarray(8, 12))).toBe('WEBP');
    expect(image.bytes.length).toBeLessThan(jpeg.length / 2);
    expect(preview!.length).toBeLessThanOrEqual(25);
    const { r, g, b } = thumbHashToAverageRGBA(preview!);
    expect([r * 255, g * 255, b * 255].map((value, i) => Math.abs(value - [130, 78, 131][i]!))).toSatisfy((gaps: number[]) => gaps.every((gap) => gap < 12));
  });

  // A platform that sends something else under image/jpeg must not cost the thumbnail, nor break the next one.
  it('keeps a picture it can’t read as it is, without a preview, and reads the next one', async () => {
    const encode = thumbnailEncoder(thumbnailModules);
    const broken = { type: 'image/jpeg' as const, bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3) };

    expect(await encode(broken)).toEqual({ image: broken, preview: null });
    expect((await encode({ type: 'image/jpeg', bytes: jpeg })).image.type).toBe('image/webp');
  });
});

// ThumbHash reads at most 100×100: a wrong average would tint every preview, or shift it sideways.
describe('averageDown', () => {
  it('averages each block of pixels it covers', () => {
    // 4×2: a red left half and a blue right half, the bottom row darker.
    const data = new Uint8ClampedArray([200, 0, 0, 255, 200, 0, 0, 255, 0, 0, 100, 255, 0, 0, 100, 255, 100, 0, 0, 255, 100, 0, 0, 255, 0, 0, 50, 255, 0, 0, 50, 255]);

    expect([...averageDown({ width: 4, height: 2, data }, 2, 1).data]).toEqual([150, 0, 0, 255, 0, 0, 75, 255]);
  });
});
