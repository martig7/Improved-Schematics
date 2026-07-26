import type { StationDesign, ExampleStation } from './types';
import { classic } from './classic';
import { nycSolid } from './nycSolid';
import { nycMap } from './nycMap';
import { tokyu } from './tokyu';
import { tokyo } from './tokyo';
import { tokyoMetro } from './tokyoMetro';
import { london } from './london';
import { toronto } from './toronto';
import { dc } from './dc';
import { previewSvg } from './serialize';

export type { StationDesign, ExampleStation, StopScene, PaintCtx, Glyph, Capsule, StopLine } from './types';

export const STATION_DESIGNS: StationDesign[] = [classic, nycSolid, nycMap, tokyu, tokyo, tokyoMetro, london, toronto, dc];
export const DEFAULT_STATION_DESIGN = 'classic';
export const EXAMPLE_STATION_DEFAULT: ExampleStation = { bullet: 'A', color: '#dc2626', textColor: '#ffffff' };

export function getStationDesign(id: string | undefined): StationDesign {
  return STATION_DESIGNS.find((d) => d.id === id) ?? classic;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const okColor = (c: string | undefined): string => (c && HEX.test(c) ? c : '#888888');

/** Representative example route for the picker: first non-temporary bulleted
 *  route, else the A/red default. Framework-free (accepts the game's Route[]). */
/** Map one route to an ExampleStation: bullet trimmed, color validated, textColor
 *  defaulted to ''. Used by the route-menu tiles and by pickExampleRoute. */
export function routeToExample(r: { bullet?: string; color?: string; textColor?: string }): ExampleStation {
  return { bullet: (r.bullet ?? '').trim(), color: okColor(r.color), textColor: r.textColor || '' };
}

export function pickExampleRoute(routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    if ((r.bullet ?? '').trim()) return routeToExample(r);
  }
  return EXAMPLE_STATION_DEFAULT;
}

/** Standalone preview SVG for a design + example (delegates to serialize). */
export function renderStationPreview(design: StationDesign, ex: ExampleStation, dark: boolean): string {
  return previewSvg(design, ex, dark);
}
