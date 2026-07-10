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

/** Unit vector a -> b, or null when the two points coincide. Uses sqrt (not
 *  hypot) for cross-V8 determinism. */
function unitVec(a: Point, b: Point): Point | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return null;
  return [dx / len, dy / len];
}

const LEG_SAMPLES = 10; // extrusion samples per centerline leg (smooth bends)
// Connector neck half-width (fraction of box). A thin constant-width line joining
// the two capsules; tune here to taste.
const NECK_HW_FRAC = 0.15;

/**
 * Closed polygon `d` of one connector neck: a thin CONSTANT-WIDTH line joining
 * two capsules. The centerline is a 4-point polyline [tuckA, faceA, faceB, tuckB]:
 * the middle leg faceA->faceB is the visible gap between the two capsule edges,
 * and the two outer legs run PERPENDICULAR into each capsule (the edge inward
 * normal) so the line's ends are buried under the capsule fill and the join is
 * seamless (no dividing line, no overshoot). The width is uniform, so the neck
 * reads as a slim link that follows the true direction between the boxes.
 *
 * @param points connector centerline (4 pts; 2 for a legacy straight connector)
 * @param box    box side length (world px); the width scales with it
 * @returns closed path d-string, or null for a degenerate centerline
 */
function neckPolygon(points: Point[], box: number): string | null {
  if (points.length < 2) return null;
  // A degenerate connector (coincident endpoints, emitted when two capsules
  // already overlap) has no direction; skip it so it paints no stray sliver.
  if (!unitVec(points[0], points[points.length - 1])) return null;

  const hw = box * NECK_HW_FRAC; // constant half-width

  // Resample every leg into a dense spine so the perpendicular-to-diagonal bends
  // turn smoothly rather than as hard vertices.
  const spine: Point[] = [];
  for (let leg = 0; leg < points.length - 1; leg++) {
    const a = points[leg], b = points[leg + 1];
    for (let k = 0; k <= LEG_SAMPLES; k++) {
      if (leg > 0 && k === 0) continue; // shared vertex already pushed
      const t = k / LEG_SAMPLES;
      spine.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  const m = spine.length;
  if (m < 2) return null;
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < m; i++) {
    // Unit tangent from adjacent samples, then left-normal N = (-Ty, Tx).
    const a = spine[i === 0 ? 0 : i - 1];
    const b = spine[i === m - 1 ? m - 1 : i + 1];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len === 0) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
    const nx = -ty, ny = tx;
    const p = spine[i];
    left.push([p[0] + hw * nx, p[1] + hw * ny]);
    right.push([p[0] - hw * nx, p[1] - hw * ny]);
  }

  let d = 'M ' + f1(left[0][0]) + ' ' + f1(left[0][1]);
  for (let i = 1; i < m; i++) d += ' L ' + f1(left[i][0]) + ' ' + f1(left[i][1]);
  for (let i = m - 1; i >= 0; i--) d += ' L ' + f1(right[i][0]) + ' ' + f1(right[i][1]);
  return d + ' Z';
}

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
    const necks = cap.connectors
      .map((c) => neckPolygon(c.points, s))
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
