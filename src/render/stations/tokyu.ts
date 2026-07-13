import type { StationDesign, StopLine, Glyph } from './types';
import { rect, text } from './primitives';
import { paintRectCapsule, pad2 } from './rectCapsule';
import { SIGN_LETTER_FONT, SIGN_DIGIT_FONT } from './signFonts';

// The interchange capsule and its connectors always read as dark gray with a
// black border, matching the Japanese-metro reference in both themes.
const STYLE = { capFill: '#6f6f73', capBorder: '#111111' };

// Quantize to the SVG emit grid so the white rim derives from shared values
// and stays the same width on every side (see the square-design symmetry
// note in tokyo.ts).
const q = (n: number): number => +n.toFixed(1);

/** One numbered station box, per the reference icons: a white base square
 *  (corner radius 0.20 of the side) under a route-color plate inset by 0.023
 *  of the side (the sign's white rim, radius 0.176), with the route bullet
 *  (cap 0.25 of the side, centered 0.25 above middle) over the zero-padded
 *  station number (0.40 tall, centered 0.175 below), in the route text
 *  color. */
function square(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const ink = ln.textColor || '#ffffff';
  const x0 = q(cx - s / 2), y0 = q(cy - s / 2);
  const x1 = q(cx + s / 2), y1 = q(cy + s / 2);
  const w = q(x1 - x0), h = q(y1 - y0);
  const inset = Math.max(0.1, q(s * 0.023));
  const qcx = q((x0 + x1) / 2), qcy = q((y0 + y1) / 2);
  // Text must fit across the color plate (its width less a small side margin);
  // longer bullets/numbers shrink from the prescribed size to clear it.
  const maxW = (w - 2 * inset) * 0.9;
  const g: Glyph[] = [
    rect(x0, y0, w, h, s * 0.2, { fill: '#ffffff', stroke: 'none', strokeWidth: 0 }),
    rect(q(x0 + inset), q(y0 + inset), q(w - 2 * inset), q(h - 2 * inset), s * 0.176, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(qcx, qcy - s * 0.125, ln.bullet, { fontSize: s * 0.35, fill: ink, fontFamily: SIGN_LETTER_FONT, maxWidth: maxW }));
  if (ln.seq != null) g.push(text(qcx, qcy + s * 0.375, pad2(ln.seq), { fontSize: s * 0.56, fill: ink, fontFamily: SIGN_DIGIT_FONT, maxWidth: maxW }));
  return g;
}

/**
 * Tokyu: Japanese-metro station boxes. A single-line stop is one rounded square
 * (route color, bullet over station number). Interchanges ride the shared
 * rectRows capsule painter (rectCapsule.ts). The station name stays on the
 * label layer.
 */
export const tokyu: StationDesign = {
  id: 'tokyu',
  name: 'Tokyu',
  capsule: 'rectRows',
  paint: (scene, ctx) => paintRectCapsule(scene, ctx, square, STYLE),
};
