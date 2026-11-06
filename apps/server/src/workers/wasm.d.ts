// Wrangler bundles a `.wasm` import as a compiled module (its default CompiledWasm rule).
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
