import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ThumbnailModules } from '../catalog/thumbnails';

// The Node types declare WebAssembly's types, not the global object itself.
const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WebAssembly.Module> } }).WebAssembly;

/** The thumbnail encoder's WASM modules on Node: read from the installed packages, compiled once. */
export async function nodeThumbnailModules(): Promise<ThumbnailModules> {
  const require = createRequire(import.meta.url);
  const compile = async (path: string) => wasm.compile(await readFile(require.resolve(path)));
  const [jpeg, webp] = await Promise.all([compile('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'), compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm')]);

  return { jpeg, webp };
}
