import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph, Point } from './types';
import { rect, text } from './primitives';
import { MARKER_SCALE } from '../constants';

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

const f1 = (n: number): string => n.toFixed(1);

/** Unit perpendicular (left-hand normal) of the segment a -> b, or null when
 *  the two points coincide. Uses sqrt (not hypot) for cross-V8 determinism. */
function unitPerp(a: Point, b: Point): Point | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;
  return [-dy / len, dx / len];
}

/**
 * A single filled, tapered connector polygon as a closed path `d`. It is widest
 * where it meets each group capsule (the two endpoints, the sources) and narrows
 * at every interior waist vertex. A 2-point connector gets a synthesized
 * midpoint so it always has a waist. Half-widths are in world px.
 */
function taperedConnectorPath(points: Point[], wideHalf: number, waistHalf: number): string | null {
  if (points.length < 2) return null;
  const v: Point[] = points.length === 2
    ? [points[0], [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2], points[1]]
    : points.slice();
  const n = v.length;

  // Per-vertex outward perpendicular: an endpoint uses its single adjacent
  // segment; an interior vertex uses the normalized sum of its two neighbors'
  // unit perpendiculars (the bevel bisector).
  const perp: Point[] = [];
  for (let i = 0; i < n; i++) {
    let p: Point | null;
    if (i === 0) p = unitPerp(v[0], v[1]);
    else if (i === n - 1) p = unitPerp(v[n - 2], v[n - 1]);
    else {
      const a = unitPerp(v[i - 1], v[i]);
      const b = unitPerp(v[i], v[i + 1]);
      if (a && b) {
        const sx = a[0] + b[0], sy = a[1] + b[1];
        const len = Math.sqrt(sx * sx + sy * sy);
        p = len === 0 ? a : [sx / len, sy / len];
      } else p = a || b;
    }
    perp.push(p || [0, 0]);
  }

  const half = (i: number): number => (i === 0 || i === n - 1 ? wideHalf : waistHalf);
  const left: Point[] = v.map((pt, i) => [pt[0] + half(i) * perp[i][0], pt[1] + half(i) * perp[i][1]]);
  const right: Point[] = v.map((pt, i) => [pt[0] - half(i) * perp[i][0], pt[1] - half(i) * perp[i][1]]);

  let d = 'M ' + f1(left[0][0]) + ' ' + f1(left[0][1]);
  for (let i = 1; i < n; i++) d += ' L ' + f1(left[i][0]) + ' ' + f1(left[i][1]);
  for (let i = n - 1; i >= 0; i--) d += ' L ' + f1(right[i][0]) + ' ' + f1(right[i][1]);
  return d + ' Z';
}

/**
 * Tokyu: Japanese-metro station boxes. A single-line stop is one rounded square
 * (route color, bullet over station number). A multi-line interchange seats one
 * box per line into axis-aligned rows (the 'rectRows' capsule from placement):
 * dark-gray group capsules behind the boxes, filled tapered connectors joining
 * the rows, and a box per line at its solved center. The station name stays on
 * the label layer.
 */
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;

  if (cap.kind === 'rectRows') {
    const s = cap.box;
    const border = +(s * 0.06).toFixed(2);
    const g: Glyph[] = [];
    // Connectors first (behind), then group capsules, then boxes on top: each
    // tapered neck merges under the dark-gray capsules it joins.
    for (const c of cap.connectors) {
      const d = taperedConnectorPath(c.points, s * 0.42, s * 0.26);
      if (d) g.push({ kind: 'path', d, fill: CAP_FILL, stroke: CAP_BORDER, strokeWidth: border, lineCap: 'round', lineJoin: 'round' });
    }
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, gr.rx, { fill: CAP_FILL, stroke: CAP_BORDER, strokeWidth: border }));
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
