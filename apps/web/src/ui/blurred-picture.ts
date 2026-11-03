/**
 * In place of a missing image (a video's thumbnail), a picture seen through
 * frosted glass: soft patches of near hues and tones over a lighter top and a darker bottom,
 * only gently uneven. It is drawn from a key (the video's), so the same key always gets the same one, and nothing is stored or loaded. A CSS `background` value.
 */
export function blurredPicture(key: string): string {
  // FNV-1a, then mulberry32: the same key always draws the same numbers.
  let seed = 2166136261;
  for (const char of key) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  }
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (low: number, high: number) => Math.round(low + random() * (high - low));
  const hue = between(0, 359);
  const saturation = between(30, 55);
  const lightness = between(40, 60);
  const tone = (spread: number, shift: number, contrast: number) =>
    `hsl(${(hue + between(-spread, spread) + 360) % 360} ${saturation}% ${lightness + shift + between(-contrast, contrast)}%)`;
  // One smaller patch, like a subject in the frame, over larger, softer ones of near hues and tones.
  const patches = Array.from({ length: 5 }, (_, i) => {
    const size = i === 0 ? [between(25, 40), between(40, 60)] : [between(45, 85), between(55, 100)];
    return `radial-gradient(ellipse ${size[0]}% ${size[1]}% at ${between(10, 90)}% ${between(15, 85)}%, ${tone(35, 0, i === 0 ? 18 : 12)}, transparent)`;
  });
  const sky = tone(20, 12, 4);
  const ground = tone(20, -12, 4);

  return [...patches, `linear-gradient(${between(160, 200)}deg, ${sky}, ${ground})`].join(', ');
}
