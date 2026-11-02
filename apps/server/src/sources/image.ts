import { type Http, UpstreamError } from '../http';

/** An image the catalog hands to clients as is: a channel's avatar or an item's thumbnail. */
export interface Image {
  type: ImageType;
  bytes: Uint8Array;
}

/**
 * The only image types passed on. SVG is left out: it can carry script, and the app shows these
 * images from its own origin.
 */
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

const TYPES: readonly ImageType[] = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Reads one image. Null when the platform has none (404), or sends something that is not one
 * of the accepted types. Throws UpstreamError when it failed, so the caller may try again later.
 */
export async function readImage(http: Http, url: string, maxBytes: number): Promise<Image | null> {
  const response = await http.getBytes(url, { maxBytes });

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new UpstreamError('status', response.status);
  }

  const type = TYPES.find((candidate) => (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() === candidate);

  return type === undefined || response.bytes.byteLength === 0 ? null : { type, bytes: response.bytes };
}

/** The image as a data: URL, which the app shows without going online. */
export function dataUrl(image: Image): string {
  let binary = '';

  // In chunks: spreading a whole image into one call can overflow the argument limit.
  for (let i = 0; i < image.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...image.bytes.subarray(i, i + 0x8000));
  }

  return `data:${image.type};base64,${btoa(binary)}`;
}
