/**
 * Shared painter for square-box station designs riding the 'rectRows' capsule
 * regime. Placement produces the design-agnostic geometry (seated box centers,
 * group rounded-rects, connector necks); a concrete design supplies only its
 * per-line BOX GLYPH and the capsule colors, and this module handles the three
 * scene shapes every such design meets: the seated interchange (capsule +
 * necks + one box per line), the opaque mega-fallback box, and the single
 * stop / degenerate / preview case.
 */

import type { StopScene, StopLine, PaintCtx, Glyph } from './types';
import { rect } from './primitives';
import { MARKER_SCALE } from '../constants';
import { neckPath } from '../layout/rectSeat';

/** Draw one line's station box centered at (cx, cy) with side s. */
export type BoxGlyphFn = (cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean) => Glyph[];

/** Interchange capsule colors (the silhouette behind the boxes). */
export interface RectCapsuleStyle {
  capFill: string;
  capBorder: string;
  /** Fully round the capsule (stadium ends: corner radius = half the short
   *  side) instead of the seated group's own slight corner radius. Suits
   *  designs whose boxes are round. */
  roundEnds?: boolean;
}

/** Zero-padded two-digit station number, the numbering style shared by the
 *  square-box designs. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Paint one station of a rectRows design. A multi-line interchange seats one
 * box per line into axis-aligned rows: group capsules behind the boxes,
 * extruded connector necks joining the rows, rendered as one seamless bordered
 * silhouette by expand-and-overdraw. Neck extrusion lives with the capsule
 * geometry (layout/rectSeat.ts) and is baked into RectCapsule.necks at compute
 * time; this paint only falls back to re-extruding when a capsule cached
 * before that field existed lacks it.
 */
export function paintRectCapsule(
  scene: StopScene,
  ctx: PaintCtx,
  box: BoxGlyphFn,
  style: RectCapsuleStyle,
): Glyph[] {
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
    const rxOf = (gr: { w: number; h: number; rx: number }): number =>
      style.roundEnds ? Math.min(gr.w, gr.h) / 2 : gr.rx;
    // BORDER LAYER: each piece stroked and filled in the border color, fattening
    // it by bw on every side.
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, rxOf(gr), { fill: style.capBorder, stroke: style.capBorder, strokeWidth: 2 * bw }));
    for (const d of necks) g.push({ kind: 'path', d, fill: style.capBorder, stroke: style.capBorder, strokeWidth: 2 * bw, lineCap: 'round', lineJoin: 'round' });
    // FILL LAYER: each interior in the fill color, no stroke, covering all but
    // the border rim.
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, rxOf(gr), { fill: style.capFill, stroke: 'none', strokeWidth: 0 }));
    for (const d of necks) g.push({ kind: 'path', d, fill: style.capFill, stroke: 'none', strokeWidth: 0, lineCap: 'round', lineJoin: 'round' });

    for (const ln of scene.lines) g.push(...box(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
    return g;
  }

  if (cap.kind === 'box') {
    // Mega-fallback interchange: the opaque rounded box, still rendered.
    const rx = style.roundEnds ? Math.min(cap.w, cap.h) / 2 : cap.rx;
    return [rect(cap.x, cap.y, cap.w, cap.h, rx, { fill: style.capFill, stroke: style.capBorder, strokeWidth: 3 })];
  }

  // Single stop, degenerate interchange, or preview: one box per line at its pos.
  const single = cap.kind === 'none' || scene.lines.length <= 1;
  const baseR = single ? scene.dotRadius : scene.dotRadius / MARKER_SCALE;
  const s = 3 * baseR;
  const g: Glyph[] = [];
  for (const ln of scene.lines) g.push(...box(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
  return g;
}
