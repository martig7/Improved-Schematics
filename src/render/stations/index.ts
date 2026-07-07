import type { StationDesign, ExampleStation } from './types';
import { classic } from './classic';
import { nycSolid } from './nycSolid';
import { nycMap } from './nycMap';
import { previewSvg } from './serialize';

export type { StationDesign, ExampleStation, StopScene, PaintCtx, Glyph, Capsule, StopLine } from './types';

export const STATION_DESIGNS: StationDesign[] = [classic, nycSolid, nycMap];
export const DEFAULT_STATION_DESIGN = 'classic';
export const EXAMPLE_STATION_DEFAULT: ExampleStation = { bullet: 'A', color: '#dc2626', textColor: '#ffffff' };

export function getStationDesign(id: string | undefined): StationDesign {
  return STATION_DESIGNS.find((d) => d.id === id) ?? classic;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const okColor = (c: string | undefined): string => (c && HEX.test(c) ? c : '#888888');

/** Representative example route for the picker: first non-temporary bulleted
 *  route, else the A/red default. Framework-free (accepts the game's Route[]). */
export function pickExampleRoute(routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    const bullet = (r.bullet ?? '').trim();
    if (bullet) return { bullet, color: okColor(r.color), textColor: r.textColor || '' };
  }
  return EXAMPLE_STATION_DEFAULT;
}

/** Standalone preview SVG for a design + example (delegates to serialize). */
export function renderStationPreview(design: StationDesign, ex: ExampleStation, dark: boolean): string {
  return previewSvg(design, ex, dark);
}
