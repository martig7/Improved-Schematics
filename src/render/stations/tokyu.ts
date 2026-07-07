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

const SPINE_SAMPLES = 12; // resampled points per connector leg (dense waist)

/**
 * Closed polygon `d` of one connector neck, built by lateral extrusion of the
 * centerline. The centerline endpoints already sit on the two capsule
 * boundaries; each end is first TUCKED a short way INTO its capsule so the
 * extrusion merges under the capsule fill (never bulging outward). The spine is
 * then resampled densely (midpoint for a 2-point line, along both legs for a
 * bend) so the normal turns continuously with no discrete bevel. The half-width
 * profile is wide at both ends and pinched at the waist, giving a smooth neck.
 *
 * @param points connector centerline (2 or 3 pts), endpoints on capsule edges
 * @param box    box side length (world px); widths and tuck scale with it
 * @returns closed path d-string, or null for a degenerate centerline
 */
function neckPolygon(points: Point[], box: number): string | null {
  if (points.length < 2) return null;
  const WIDE = box * 0.42;
  const WAIST = box * 0.26;
  const TUCK = box * 0.10;

  // Tuck each end inward along the connector's own end direction so the neck
  // starts under the capsule fill rather than flush with (or past) its border.
  const src = points.slice();
  const n0 = src.length;
  const inDir0 = unitVec(src[0], src[1]);           // toward the interior from the first end
  const inDirN = unitVec(src[n0 - 1], src[n0 - 2]); // toward the interior from the last end
  if (inDir0) src[0] = [src[0][0] + inDir0[0] * TUCK, src[0][1] + inDir0[1] * TUCK];
  if (inDirN) src[n0 - 1] = [src[n0 - 1][0] + inDirN[0] * TUCK, src[n0 - 1][1] + inDirN[1] * TUCK];

  // Dense spine: sample each leg evenly so the waist and any bend are smooth.
  const spine: Point[] = [];
  for (let leg = 0; leg < src.length - 1; leg++) {
    const a = src[leg], b = src[leg + 1];
    const last = leg === src.length - 2;
    const steps = last ? SPINE_SAMPLES : SPINE_SAMPLES - 1; // avoid duplicating the shared bend vertex
    for (let s = 0; s <= steps; s++) {
      const t = s / SPINE_SAMPLES;
      spine.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  const m = spine.length;
  if (m < 2) return null;

  // Per-point unit tangent from adjacent samples, then left-normal N = (-Ty, Tx)
  // and half-width from the bump profile (1 at both ends, 0 at the waist).
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < m; i++) {
    const a = spine[i === 0 ? 0 : i - 1];
    const b = spine[i === m - 1 ? m - 1 : i + 1];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len === 0) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
    const nx = -ty, ny = tx;
    const t = i / (m - 1);
    const bump = (2 * t - 1) * (2 * t - 1); // 1 at ends, 0 at the waist
    const hw = WAIST + (WIDE - WAIST) * bump;
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
