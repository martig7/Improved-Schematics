import type { DcEnd } from '../layout/dcStations';
import { BADGE_R } from '../layout/dcStations';
import { LINE_WIDTH } from '../constants';
import type { Glyph, PaintCtx, StopLine } from './types';
import { bullet, circle, contrastInk } from './primitives';

const CASING_EXTRA = 3;

export interface LineEndGlyphs {
  tailCasings: Glyph[];
  tailCores: Glyph[];
  badges: Glyph[];
}

/** Paint the shared route-end tail and badge vocabulary. Callers decide where
 *  station bodies sit between the tail layers and the badges. */
export function lineEndGlyphs(
  lines: readonly StopLine[],
  ends: readonly DcEnd[],
  ctx: PaintCtx,
): LineEndGlyphs {
  const byLine = new Map(lines.map((line) => [line.lineId, line]));
  const land = ctx.land ?? (ctx.dark ? '#18181b' : '#ffffff');
  const tailCasings: Glyph[] = [];
  const tailCores: Glyph[] = [];
  const badges: Glyph[] = [];
  for (const end of ends) {
    const line = byLine.get(end.lineId);
    if (!line) continue;
    const dx = end.cut[0] - line.pos[0];
    const dy = end.cut[1] - line.pos[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const over = len > 1e-6 ? CASING_EXTRA / 2 / len : 0;
    tailCasings.push({
      kind: 'line',
      x1: +line.pos[0].toFixed(2), y1: +line.pos[1].toFixed(2),
      x2: +(end.cut[0] + dx * over).toFixed(2), y2: +(end.cut[1] + dy * over).toFixed(2),
      stroke: land, strokeWidth: +(LINE_WIDTH + CASING_EXTRA).toFixed(2),
    });
    tailCores.push({
      kind: 'line',
      x1: +line.pos[0].toFixed(2), y1: +line.pos[1].toFixed(2),
      x2: +end.cut[0].toFixed(2), y2: +end.cut[1].toFixed(2),
      stroke: line.color, strokeWidth: +LINE_WIDTH.toFixed(2),
    });
    badges.push(circle(end.at[0], end.at[1], BADGE_R, {
      fill: line.color,
      stroke: 'none',
      strokeWidth: 0,
      data: { 'data-line': line.lineId },
    }));
    if (ctx.showBullets && line.bullet) {
      badges.push(bullet(end.at[0], end.at[1], line.bullet, BADGE_R, line.textColor || contrastInk(line.color)));
    }
  }
  return { tailCasings, tailCores, badges };
}
