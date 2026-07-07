import type { StationDesign, StopScene, StopLine, PaintCtx, Glyph } from './types';
import { rect, text } from './primitives';
import { MARKER_SCALE } from '../constants';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** One numbered station box: a rounded square in the line color with the route
 *  bullet on top and the zero-padded station number below, in the route text
 *  color with a thin keyline. */
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
 * (route color, bullet over station number). A multi-line stop is a ROW of those
 * boxes grouped inside a rounded-square "capsule" (so they fit instead of
 * overlapping), one box per line. The station name stays on the label layer.
 */
function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const single = scene.capsule.kind === 'none' || scene.lines.length <= 1;
  // Un-shrink the capsule dot radius so interchange boxes match single-stop boxes.
  const baseR = single ? scene.dotRadius : scene.dotRadius / MARKER_SCALE;
  const s = 3 * baseR;

  if (single) {
    const g: Glyph[] = [];
    for (const ln of scene.lines) g.push(...square(ln.pos[0], ln.pos[1], s, ln, ctx.showBullets));
    return g;
  }

  // Interchange: a rounded-square capsule bounding a horizontal row of boxes.
  const lines = [...scene.lines].sort((a, b) => a.chain - b.chain);
  const gap = s * 0.14;
  const totalW = lines.length * s + (lines.length - 1) * gap;
  const [ax, ay] = scene.anchor;
  const x0 = ax - totalW / 2;
  const pad = s * 0.16;
  const capBg = ctx.dark ? '#27272a' : '#ffffff';
  const capBorder = ctx.dark ? '#5a5a5f' : '#c9c9c9';
  const g: Glyph[] = [
    rect(x0 - pad, ay - s / 2 - pad, totalW + 2 * pad, s + 2 * pad, (s + 2 * pad) * 0.16, { fill: capBg, stroke: capBorder, strokeWidth: +(s * 0.045).toFixed(2) }),
  ];
  lines.forEach((ln, i) => { g.push(...square(x0 + i * (s + gap) + s / 2, ay, s, ln, ctx.showBullets)); });
  return g;
}

export const tokyu: StationDesign = { id: 'tokyu', name: 'Tokyu', paint };
