import { describe, expect, it } from 'vitest';
import { mainColor } from '../src/ui/short-fill';

const pixels = (...colors: [number, number, number, number][]) =>
  new Uint8ClampedArray(colors.flatMap(([r, g, b, count]) => Array.from({ length: count }, () => [r, g, b, 255]).flat()));

// A Short's fill must take the colour most of its frame is: a mean would paint a red and blue frame purple, a colour it doesn't have.
describe('a Short’s main colour', () => {
  it('is its most common colour, not the mean of all its pixels', () => {
    expect(mainColor(pixels([200, 20, 20, 150], [20, 20, 200, 106]))).toEqual({ hue: 0, saturation: 82, lightness: 43 });
    expect(mainColor(pixels([200, 20, 20, 106], [20, 20, 200, 150]))).toEqual({ hue: 240, saturation: 82, lightness: 43 });
  });

  it('gathers shades a few levels apart, and averages them', () => {
    expect(mainColor(pixels([200, 20, 20, 80], [202, 22, 22, 80], [20, 20, 200, 96]))).toEqual({ hue: 0, saturation: 81, lightness: 44 });
  });
});
