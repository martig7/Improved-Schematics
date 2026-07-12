import type { StationDesign, StopLine, Glyph } from './types';
import { rect, text } from './primitives';
import { paintRectCapsule, pad2 } from './rectCapsule';

// Interchange capsule silhouette shared with the other square-box design, so
// mixed maps read as one visual language.
const STYLE = { capFill: '#6f6f73', capBorder: '#111111' };

// Route-color frame width as a fraction of the box side (the JR-style sign's
// thin colored frame).
const FRAME_FRAC = 1 / 15;

// Ink on the white interior in both themes; the sign itself never inverts.
const INK = '#111111';

/** One numbered station box in the JR East sign style: a rounded outer square
 *  framed in the route color, a sharp-cornered white interior inset by the
 *  frame width, and the route bullet over the zero-padded station number in
 *  dark ink. */
function square(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const bw = s * FRAME_FRAC;
  const inner = s - 2 * bw;
  const g: Glyph[] = [
    rect(cx - s / 2, cy - s / 2, s, s, s * 0.19, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
    rect(cx - inner / 2, cy - inner / 2, inner, inner, 0, { fill: '#ffffff', stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(cx, cy - s * 0.125, ln.bullet, { fontSize: s * 0.25, fill: INK }));
  if (ln.seq != null) g.push(text(cx, cy + s * 0.31, pad2(ln.seq), { fontSize: s * 0.44, fill: INK }));
  return g;
}

/**
 * Tokyo: JR-style station numbering boxes. A single-line stop is one white
 * square framed in the route color (bullet over station number in dark ink);
 * interchanges ride the shared rectRows capsule painter (rectCapsule.ts). The
 * station name stays on the label layer.
 */
export const tokyo: StationDesign = {
  id: 'tokyo',
  name: 'Tokyo',
  capsule: 'rectRows',
  paint: (scene, ctx) => paintRectCapsule(scene, ctx, square, STYLE),
};
