/**
 * A Short's thumbnail is 16:9, its vertical frame in the middle and, on each side, the same frame
 * blown up and blurred by the platform. The card shows the frame alone, over the blurred picture
 * missing thumbnails get (blurred-picture.ts) in the frame's main colour, rather than that coarse
 * enlargement.
 */
import type { Hsl } from './blurred-picture';

/**
 * The frame's share of the thumbnail's width. The platform's frame is 100 px of 320, edged on
 * each side by a dark shadow; 98 keeps clear of it. theme.css crops the card's image the same way.
 */
const FRAME_SHARE = 98 / 320;
/** The frame is read at this size: enough to find its main colour, cheap for a whole feed. */
const SAMPLE = 16;

/**
 * The colour most of the frame is: the most common of its colours rounded to 32 levels a channel,
 * then the mean of the pixels so rounded. Not the mean of all pixels, which a frame of two colours
 * would turn into a third one, in neither.
 */
export function mainColor(pixels: Uint8ClampedArray): Hsl {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let at = 0; at < pixels.length; at += 4) {
    const [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    buckets.set(key, { count: bucket.count + 1, r: bucket.r + r, g: bucket.g + g, b: bucket.b + b });
  }

  let main = { count: 0, r: 0, g: 0, b: 0 };
  buckets.forEach((bucket) => {
    if (bucket.count > main.count) {
      main = bucket;
    }
  });

  return main.count === 0 ? { hue: 0, saturation: 0, lightness: 0 } : hsl(main.r / main.count, main.g / main.count, main.b / main.count);
}

/** The usual RGB to HSL conversion, from 0–255 channels. */
function hsl(red: number, green: number, blue: number): Hsl {
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  const sector = chroma === 0 ? 0 : max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;

  return { hue: Math.round(sector * 60) % 360, saturation: Math.round(saturation * 100), lightness: Math.round(lightness * 100) };
}

const known = new Map<string, Hsl>();

/**
 * The main colour of the frame in this Short's thumbnail, kept by item so that a card scrolled
 * back into view gets it at once. Null when the image can't be read.
 */
export async function shortFill(key: string, url: string): Promise<Hsl | null> {
  const kept = known.get(key);

  if (kept !== undefined) {
    return kept;
  }

  const image = new Image();
  image.src = url;

  try {
    await image.decode();
  } catch {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (context === null) {
    return null;
  }

  const width = image.naturalWidth * FRAME_SHARE;
  context.drawImage(image, (image.naturalWidth - width) / 2, 0, width, image.naturalHeight, 0, 0, SAMPLE, SAMPLE);
  const color = mainColor(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
  known.set(key, color);

  return color;
}
