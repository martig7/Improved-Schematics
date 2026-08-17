import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, bullet, capsuleGlyphs, dotStrokeWidth } from './primitives';

function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const bg = ctx.dark ? '#18181b' : '#ffffff';
  const ink = ctx.dark ? '#e4e4e7' : '#111111';
  const nameFill = ctx.dark ? '#ffffff' : '#111111';
  const sw = dotStrokeWidth(scene.dotRadius);
  const g: Glyph[] = capsuleGlyphs(scene.capsule, { border: ink, fill: bg }, scene.dotRadius);
  for (const ln of scene.lines) {
    g.push(circle(ln.pos[0], ln.pos[1], scene.dotRadius, { fill: bg, stroke: ln.color, strokeWidth: sw, data: { 'data-line': ln.lineId } }));
    if (ctx.showBullets && ln.bullet) g.push(bullet(ln.pos[0], ln.pos[1], ln.bullet, scene.dotRadius, nameFill));
  }
  return g;
}

export const classic: StationDesign = { id: 'classic', name: 'Classic', paint, capsule: 'pill' };
