/**
 * Publish pako as a global before upng-js is evaluated.
 *
 * upng-js resolves its deflate/inflate dependency once, at module-evaluation
 * time, with `typeof require == "function" ? require("pako") : window.pako`. In
 * a browser bundle the `require` branch is not taken, so without a global the
 * dependency lands as `undefined` and the first encode fails with
 * "Cannot read properties of undefined (reading 'deflate')". Under Node (tests,
 * dev harness) the require branch resolves it and this module is inert.
 *
 * Import this module BEFORE upng-js: `import` declarations are hoisted, so an
 * assignment written next to the upng-js import would run too late. A dedicated
 * module makes the ordering explicit and enforceable, since ES modules evaluate
 * in import-declaration order.
 */
import * as pakoNs from 'pako';

// The CJS namespace may arrive wrapped in `default` depending on interop.
const pako = ((pakoNs as unknown as { default?: unknown }).default ?? pakoNs) as { deflate?: unknown };

if (typeof pako?.deflate === 'function') {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.pako) g.pako = pako;
  // upng-js reads `window.pako` specifically.
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    if (!w.pako) w.pako = pako;
  }
}

/** True when a deflate implementation is reachable the way upng-js resolves it.
 *  Lets the encoder fail with a named cause instead of a property-of-undefined. */
export function pakoAvailable(): boolean {
  if (typeof pako?.deflate === 'function') return true;
  const g = globalThis as unknown as { pako?: { deflate?: unknown } };
  return typeof g.pako?.deflate === 'function';
}
