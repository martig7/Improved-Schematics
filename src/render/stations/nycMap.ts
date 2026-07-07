import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, bullet, capsuleGlyphs, dotStrokeWidth } from './primitives';

// Fixed "paper map" palette: black ink on white paper in BOTH themes.
const INK = '#111111';
const PAPER = '#ffffff';

function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const sw = dotStrokeWidth(scene.dotRadius);
  // Capsule is the OPPOSITE of the dot: a white pill with a black border, so the
  // black dots read on top. Fixed in both themes.
  const g: Glyph[] = capsuleGlyphs(scene.capsule, { border: INK, fill: PAPER }, scene.dotRadius);
  for (const ln of scene.lines) {
    g.push(circle(ln.pos[0], ln.pos[1], scene.dotRadius, { fill: INK, stroke: INK, strokeWidth: sw, data: { 'data-line': ln.lineId } }));
    if (ctx.showBullets && ln.bullet) g.push(bullet(ln.pos[0], ln.pos[1], ln.bullet, scene.dotRadius, PAPER));
  }
  return g;
}

// Preview is a single dot (the black "A" circle); the paper capsule still shows
// on the map for real interchanges.
export const nycMap: StationDesign = { id: 'nyc-map', name: 'NYC-Map', paint };
