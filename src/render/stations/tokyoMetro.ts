import type { StationDesign, StopLine, Glyph } from './types';
import { circle, text } from './primitives';
import { paintRectCapsule, pad2 } from './rectCapsule';

// Interchange capsule silhouette shared with the other square-box designs, so
// mixed maps read as one visual language.
const STYLE = { capFill: '#6f6f73', capBorder: '#111111' };

// Route-color ring width as a fraction of the glyph diameter (the metro-style
// sign's bold colored ring).
const RING_FRAC = 1 / 8;

// Ink on the white interior in both themes; the sign itself never inverts.
const INK = '#111111';

// Quantize to the SVG emit grid so both circles carry the same rounded center
// and radii; a circle is then symmetric by construction.
const q = (n: number): number => +n.toFixed(1);

/** One numbered station disc in the Tokyo Metro sign style: a circle ringed in
 *  the route color around a white interior, with the route bullet over the
 *  zero-padded station number in bold dark ink. */
function disc(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const qcx = q(cx), qcy = q(cy);
  const rOuter = q(s / 2);
  const rInner = q(s / 2 - s * RING_FRAC);
  const g: Glyph[] = [
    circle(qcx, qcy, rOuter, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
    circle(qcx, qcy, rInner, { fill: '#ffffff', stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(qcx, qcy - s * 0.08, ln.bullet, { fontSize: s * 0.3, fill: INK }));
  if (ln.seq != null) g.push(text(qcx, qcy + s * 0.31, pad2(ln.seq), { fontSize: s * 0.44, fill: INK }));
  return g;
}

/**
 * Tokyo Metro: round station numbering discs. A single-line stop is one white
 * disc ringed in the route color (bullet over station number in bold dark
 * ink); interchanges ride the shared rectRows capsule painter (rectCapsule.ts).
 * The station name stays on the label layer.
 */
export const tokyoMetro: StationDesign = {
  id: 'tokyoMetro',
  name: 'Tokyo Metro',
  capsule: 'rectRows',
  paint: (scene, ctx) => paintRectCapsule(scene, ctx, disc, STYLE),
};
