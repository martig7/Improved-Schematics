import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph } from './types';
import { rect, text, line } from './primitives';
import { MARKER_SCALE } from '../constants';

const pad2 = (n: number): string => String(n).padStart(2, '0');

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

/**
 * Tokyu: Japanese-metro station boxes. A single-line stop is one rounded square
 * (route color, bullet over station number). A multi-line interchange seats one
 * box per line into axis-aligned rows (the 'rectRows' capsule from placement):
 * gray group capsules behind the boxes, octilinear connectors joining the rows,
 * and a box per line at its solved center. The station name stays on the label
 * layer.
 */
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const cap = scene.capsule;
  const capBg = ctx.dark ? '#27272a' : '#ffffff';
  const capBorder = ctx.dark ? '#5a5a5f' : '#c9c9c9';

  if (cap.kind === 'rectRows') {
    const s = cap.box;
    const g: Glyph[] = [];
    // Group capsules first, then connectors, then boxes: boxes sit on top.
    for (const gr of cap.groups) g.push(rect(gr.x, gr.y, gr.w, gr.h, gr.rx, { fill: capBg, stroke: capBorder, strokeWidth: +(s * 0.045).toFixed(2) }));
    for (const c of cap.connectors) for (let i = 1; i < c.points.length; i++) g.push(line(c.points[i - 1][0], c.points[i - 1][1], c.points[i][0], c.points[i][1], { stroke: capBorder, strokeWidth: s * 0.5 }));
    for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
    return g;
  }

  if (cap.kind === 'box') {
    // Mega-fallback interchange: the opaque rounded box, still rendered.
    return [rect(cap.x, cap.y, cap.w, cap.h, cap.rx, { fill: capBg, stroke: capBorder, strokeWidth: 3 })];
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
