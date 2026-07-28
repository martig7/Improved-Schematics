import { MARKER_SCALE, MARK_R0, DRAW_SCALE, onDrawScale } from '../constants';
import type { Glyph, Capsule, Point } from './types';

let R0 = MARK_R0; // base dot radius (matches the solver)
onDrawScale(() => { R0 = MARK_R0; });

/** Readable bullet ink (near-black or white) for text on a solid fill. */
export function contrastInk(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111111' : '#ffffff';
}

// Cap height in ems: what a bullet's text actually occupies vertically.
const CAP_EM = 0.72;
// Fraction of the dot the text may fill, so it clears the rim rather than kissing
// it: a glyph's ink runs to the edge of its advance at the extremes.
const BULLET_FILL = 0.92;

/** Bullet font size for a dot of radius r and label name: full at 1 char, shrinking
 *  for longer bullets.
 *
 *  A bullet has to fit the DOT, not merely span it. Sizing the text to the dot's
 *  full diameter puts its corners outside the circle, since the width available at
 *  the text's own height is the chord there, not the diameter. Fitting the text's
 *  box inside the circle is the same as holding its DIAGONAL to the diameter, which
 *  is what this does. Widths come from the same per-character advances the label
 *  fitter uses, where capitals are wider than digits. */
export function bulletFontSize(r: number, name: string): number {
  let em = 0;
  for (const ch of name) em += charAdvance(ch);
  if (em <= 0) return r * 1.7;
  // sqrt, not hypot: the render must agree bit-for-bit across V8 builds.
  return Math.min(r * 1.7, (2 * r * BULLET_FILL) / Math.sqrt(em * em + CAP_EM * CAP_EM));
}

/** Ring/outline stroke width for a dot, proportional to its radius. The
 *  dotRadius/R0 ratio is the capsule-shrink fraction (scale-invariant), so the
 *  base 1.5 is multiplied by DRAW_SCALE to thin with the Line-size control. */
export function dotStrokeWidth(dotRadius: number): number {
  return 1.5 * DRAW_SCALE * (dotRadius / R0);
}

/** Border/fill stroke widths for a pill capsule so it hugs its dots. The
 *  2*dotRadius term already scales (dotRadius is scaled); the fixed rim padding
 *  scales with DRAW_SCALE so the pill stays proportional as the dots shrink. */
export function capsuleStrokeWidths(dotRadius: number): { border: number; fill: number } {
  return { border: 2 * dotRadius + 6 * MARKER_SCALE * DRAW_SCALE, fill: 2 * dotRadius + 3 * MARKER_SCALE * DRAW_SCALE };
}

export function circle(cx: number, cy: number, r: number, o: { fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }): Glyph {
  return { kind: 'circle', cx, cy, r, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth, ...(o.data ? { data: o.data } : {}) };
}

export function rect(x: number, y: number, w: number, h: number, rx: number, o: { fill: string; stroke: string; strokeWidth: number }): Glyph {
  return { kind: 'rect', x, y, w, h, rx, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth };
}

export function line(x1: number, y1: number, x2: number, y2: number, o: { stroke: string; strokeWidth: number }): Glyph {
  return { kind: 'line', x1, y1, x2, y2, stroke: o.stroke, strokeWidth: o.strokeWidth };
}

/** Per-character advance as a fraction of the font size (bold caps/digits). A
 *  slight overestimate so fitted text clears the box rather than kissing it. */
function charAdvance(ch: string): number {
  if (ch >= '0' && ch <= '9') return 0.60;
  if (ch >= 'A' && ch <= 'Z') return 0.72;
  if (ch >= 'a' && ch <= 'z') return 0.56;
  return 0.62;
}

/** Font size that fits `s` within `maxWidth`, capped at `fontSize` (the
 *  prescribed size is the MAXIMUM; long text shrinks, short text is unchanged).
 *  Deterministic width estimate so the SVG string and canvas prim agree. */
export function fitFontSize(s: string, fontSize: number, maxWidth: number): number {
  if (!s || maxWidth <= 0) return fontSize;
  let em = 0;
  for (const ch of s) em += charAdvance(ch);
  if (em <= 0) return fontSize;
  return Math.min(fontSize, maxWidth / em);
}

export function text(x: number, y: number, s: string, o: { fontSize: number; fill: string; fontWeight?: string; align?: 'start' | 'middle' | 'end'; fontFamily?: string; maxWidth?: number }): Glyph {
  const fs = o.maxWidth != null ? fitFontSize(s, o.fontSize, o.maxWidth) : o.fontSize;
  return { kind: 'text', x, y, text: s, fontSize: fs, fontWeight: o.fontWeight ?? 'bold', align: o.align ?? 'middle', fill: o.fill, ...(o.fontFamily ? { fontFamily: o.fontFamily } : {}) };
}

/** Route-bullet text centered in a dot, offset like the classic marker. */
export function bullet(cx: number, cy: number, name: string, r: number, fill: string): Glyph {
  const fs = bulletFontSize(r, name);
  return text(cx, +(cy + fs * 0.36).toFixed(1), name, { fontSize: +fs.toFixed(2), fill });
}

const f1 = (n: number): string => n.toFixed(1);

/** Path `d` through a spine: a straight RDP polyline, or a smooth Catmull-Rom
 *  bezier (clamped endpoints) when `smooth`. */
export function pillPath(points: Point[], smooth: boolean): string {
  if (points.length === 0) return '';
  if (!smooth) return 'M ' + points.map((p) => f1(p[0]) + ' ' + f1(p[1])).join(' L ');
  let d = 'M ' + f1(points[0][0]) + ' ' + f1(points[0][1]);
  if (points.length === 1) return d + ' L ' + f1(points[0][0]) + ' ' + f1(points[0][1]);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1], p1 = points[i], p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ' C ' + f1(c1x) + ' ' + f1(c1y) + ' ' + f1(c2x) + ' ' + f1(c2y) + ' ' + f1(p2[0]) + ' ' + f1(p2[1]);
  }
  return d;
}

/** Paint a computed capsule geometry with the design's chosen border/fill:
 *  ring -> filled+stroked circle; pill -> two stroked open paths (wide border,
 *  then narrow fill). */
export function capsuleGlyphs(capsule: Capsule, colors: { border: string; fill: string }, dotRadius: number): Glyph[] {
  if (capsule.kind === 'none') return [];
  if (capsule.kind === 'ring') return [circle(capsule.cx, capsule.cy, capsule.r, { fill: colors.fill, stroke: colors.border, strokeWidth: 1.5 * DRAW_SCALE })];
  if (capsule.kind === 'rectRows') return []; // painted by the rect design, not here
  const w = capsuleStrokeWidths(dotRadius);
  const d = pillPath(capsule.points, capsule.smooth);
  const p = (stroke: string, sw: number): Glyph => ({ kind: 'path', d, fill: 'none', stroke, strokeWidth: +sw.toFixed(1), lineCap: 'round', lineJoin: 'round' });
  return [p(colors.border, w.border), p(colors.fill, w.fill)];
}
