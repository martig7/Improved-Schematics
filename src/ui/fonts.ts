/**
 * Bundled station-design fonts, injected once into the page so the SVG panel,
 * the canvas scene painter, and in-page raster exports all resolve them.
 * Open Sans Bold carries the letters and digits of the Japanese-sign station
 * designs; libre-licensed for embedding (see assets/fonts/). Standalone .svg exports reference the families by name and
 * fall back to the Helvetica stack on machines without them.
 */

import { OPEN_SANS_BOLD_B64 } from './fontsData';

const toBuf = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
};

let loaded = false;

/** Register the bundled fonts with document.fonts (idempotent; inert outside
 *  a browser). Fire-and-forget: canvas/SVG repaint picks the faces up once
 *  loaded, and the fallback stacks render meanwhile. */
export function ensureSignFonts(): void {
  if (loaded || typeof document === 'undefined' || !('fonts' in document)) return;
  loaded = true;
  try {
    const faces = [
      new FontFace('Open Sans', toBuf(OPEN_SANS_BOLD_B64), { weight: '700' }),
    ];
    for (const f of faces) {
      document.fonts.add(f);
      f.load().catch((e) => console.warn('[ImprovedSchematics] font load failed', e));
    }
  } catch (e) {
    console.warn('[ImprovedSchematics] font registration failed', e);
  }
}
