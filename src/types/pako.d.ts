// Minimal ambient declaration for pako (ships no types). Only the surface
// upng-js reaches for is described; we never call it directly, we just publish
// it as the global upng-js resolves in a browser bundle (see render/pakoGlobal).
declare module 'pako' {
  export function deflate(data: Uint8Array | ArrayBuffer, options?: Record<string, unknown>): Uint8Array;
  export function inflate(data: Uint8Array | ArrayBuffer, options?: Record<string, unknown>): Uint8Array;
}
