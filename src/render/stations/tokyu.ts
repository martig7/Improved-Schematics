import type { StationDesign, StopLine, Glyph } from './types';
import { rect, text } from './primitives';
import { paintRectCapsule, pad2 } from './rectCapsule';
import { SIGN_LETTER_FONT, SIGN_DIGIT_FONT } from './signFonts';

// The interchange capsule and its connectors always read as dark gray with a
// black border, matching the Japanese-metro reference in both themes.
const STYLE = { capFill: '#6f6f73', capBorder: '#111111' };

/** One numbered station box: a rounded square in the line color with the route
 *  bullet on top and the zero-padded station number below, both in the route
 *  text color. */
function square(cx: number, cy: number, s: number, ln: StopLine, showBullets: boolean): Glyph[] {
  const ink = ln.textColor || '#ffffff';
  const g: Glyph[] = [
    rect(cx - s / 2, cy - s / 2, s, s, s * 0.19, { fill: ln.color, stroke: 'none', strokeWidth: 0 }),
  ];
  if (showBullets && ln.bullet) g.push(text(cx, cy - s * 0.17, ln.bullet, { fontSize: s * 0.36, fill: ink, fontFamily: SIGN_LETTER_FONT }));
  if (ln.seq != null) g.push(text(cx, cy + s * 0.34, pad2(ln.seq), { fontSize: s * 0.54, fill: ink, fontFamily: SIGN_DIGIT_FONT }));
  return g;
}

/**
 * Tokyu: Japanese-metro station boxes. A single-line stop is one rounded square
 * (route color, bullet over station number). Interchanges ride the shared
 * rectRows capsule painter (rectCapsule.ts). The station name stays on the
 * label layer.
 */
export const tokyu: StationDesign = {
  id: 'tokyu',
  name: 'Tokyu',
  capsule: 'rectRows',
  paint: (scene, ctx) => paintRectCapsule(scene, ctx, square, STYLE),
};
