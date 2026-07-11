import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph } from './types';
import { rect, text } from './primitives';
import { MARKER_SCALE } from '../constants';
import { neckPath } from '../layout/rectSeat';

const pad2 = (n: number): string => String(n).padStart(2, '0');

// The interchange capsule and its connectors always read as dark gray with a
// black border, matching the Japanese-metro reference in both themes.
const CAP_FILL = '#6f6f73';
const CAP_BORDER = '#111111';

/** One numbered station box: a rounded square in the line color with the route
 *  bullet on top and the zero-padded station number below, both in the route
 *  text color. */
function square(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const ink = ln.textColor || '#ffffff';
  const g: Glyph[] = [
    rect(cx - s / 2, cy - s / 2, s, s, s * 0.19, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(cx, cy - s * 0.125, ln.bullet, { fontSize: s * 0.25, fill: ink }));
  if (ln.seq != null) g.push(text(cx, cy + s * 0.31, pad2(ln.seq), { fontSize: s * 0.44, fill: ink }));
  return g;
}

// Neck extrusion lives with the capsule geometry (layout/rectSeat.ts) and is
// baked into RectCapsule.necks at compute time; paint below only falls back to
// re-extruding when a capsule cached before that field existed lacks it.

/**
 * Tokyu: Japanese-metro station boxes. A single-line stop is one rounded square
 * (route color, bullet over station number). A multi-line interchange seats one
 * box per line into axis-aligned rows (the 'rectRows' capsule from placement):
 * dark-gray group capsules behind the boxes, extruded connector necks joining
 * the rows, and a box per line at its solved center. Capsules and necks are
 * rendered as one seamless bordered silhouette by expand-and-overdraw. The
 * station name stays on the label layer.
 */
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;

  if (cap.kind === 'rectRows') {
    const s = cap.box;
    const bw = +(s * 0.06).toFixed(2); // border rim half-width
    const g: Glyph[] = [];
    const necks = cap.necks ?? cap.connectors
      .map((c) => neckPath(c.points, s))
      .filter((d): d is string => d != null);

    // Expand-and-overdraw: draw every piece (group capsules and connector necks)
    // fattened in the border color first, then redraw every interior in the fill
    // color. The fattened pieces union into one outer silhouette, so only a
    // uniform border rim survives and the capsules and necks read as ONE
    // seamless shape, flush at every junction with no seam line.
    // BORDER LAYER: each piece stroked and filled in the border color, fattening
    // it by bw on every side.
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, gr.rx, { fill: CAP_BORDER, stroke: CAP_BORDER, strokeWidth: 2 * bw }));
    for (const d of necks) g.push({ kind: 'path', d, fill: CAP_BORDER, stroke: CAP_BORDER, strokeWidth: 2 * bw, lineCap: 'round', lineJoin: 'round' });
    // FILL LAYER: each interior in the fill color, no stroke, covering all but
    // the border rim.
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, gr.rx, { fill: CAP_FILL, stroke: 'none', strokeWidth: 0 }));
    for (const d of necks) g.push({ kind: 'path', d, fill: CAP_FILL, stroke: 'none', strokeWidth: 0, lineCap: 'round', lineJoin: 'round' });

    for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
    return g;
  }

  if (cap.kind === 'box') {
    // Mega-fallback interchange: the opaque rounded box, still rendered.
    return [rect(cap.x, cap.y, cap.w, cap.h, cap.rx, { fill: CAP_FILL, stroke: CAP_BORDER, strokeWidth: 3 })];
  }

  // Single stop, degenerate interchange, or preview: one box per line at its pos.
  const single = cap.kind === 'none' || scene.lines.length <= 1;
  const baseR = single ? scene.dotRadius : scene.dotRadius / MARKER_SCALE;
  const s = 3 * baseR;
  const g: Glyph[] = [];
  for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
  return g;
}

export const tokyu: StationDesign = { id: 'tokyu', name: 'Tokyu', capsule: 'rectRows', paint };
