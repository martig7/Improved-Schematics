import type { StationDesign, StopLine, Glyph } from './types';
import { rect, text } from './primitives';
import { paintRectCapsule, pad2 } from './rectCapsule';

// Interchange capsule silhouette shared with the other square-box design, so
// mixed maps read as one visual language.
const STYLE = { capFill: '#6f6f73', capBorder: '#111111' };

// Route-color frame width as a fraction of the box side (the JR-style sign's
// thin colored frame).
const FRAME_FRAC = 1 / 8;

// Ink on the white interior in both themes; the sign itself never inverts.
const INK = '#111111';

// The SVG emit quantizes every rect coordinate independently to this grid; a
// frame drawn from unquantized floats can round to different widths on
// opposite sides. All box geometry is pre-quantized here so both rects land
// on shared grid values and the frame is symmetric by construction.
const q = (n: number): number => +n.toFixed(1);

/** One numbered station box in the JR East sign style: a rounded outer square
 *  framed in the route color, a sharp-cornered white interior inset by the
 *  frame width, and the route bullet over the zero-padded station number in
 *  dark ink. */
function square(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const x0 = q(cx - s / 2), y0 = q(cy - s / 2);
  const x1 = q(cx + s / 2), y1 = q(cy + s / 2);
  const w = q(x1 - x0), h = q(y1 - y0);
  const bw = Math.max(0.1, q(s * FRAME_FRAC)); // one shared frame width, all four sides
  const qcx = q((x0 + x1) / 2), qcy = q((y0 + y1) / 2);
  const g: Glyph[] = [
    rect(x0, y0, w, h, s * 0.19, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
    rect(q(x0 + bw), q(y0 + bw), q(w - 2 * bw), q(h - 2 * bw), 0, { fill: '#ffffff', stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(qcx, qcy - s * 0.08, ln.bullet, { fontSize: s * 0.3, fill: INK }));
  if (ln.seq != null) g.push(text(qcx, qcy + s * 0.31, pad2(ln.seq), { fontSize: s * 0.44, fill: INK }));
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
