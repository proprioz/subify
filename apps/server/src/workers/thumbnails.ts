import jpeg from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import webp from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import type { ThumbnailModules } from '../catalog/thumbnails';

/** The thumbnail encoder's WASM modules on Workers: Wrangler compiles `.wasm` imports with the Worker. */
export async function workersThumbnailModules(): Promise<ThumbnailModules> {
  return { jpeg, webp };
}
