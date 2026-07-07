/**
 * Station design registry. A "design" is how a station marker is drawn — the
 * on-map smoothed marker (renderStops) AND the small example-station preview
 * shown in the picker. Keeping both here makes the registry the single source of
 * truth so the preview and the real marker cannot drift. Framework-free (no
 * React) like the rest of render/, so it is unit-testable and usable offline.
 *
 * Draw-time only: the selected design never enters the layout fingerprint, so
 * switching it is a cheap repaint (see cacheFingerprint.ts, which hashes only
 * enumerated layout fields).
 */

import { renderStops } from './stops';
import { escapeXml } from './escape';

/** The smoothed/ribbon stop renderer signature (the existing renderStops). */
export type RenderStopsFn = typeof renderStops;

/** The example station a preview tile draws: one route's bullet + colors. */
export interface ExampleStation {
  bullet: string;
  /** Line color (hex). */
  color: string;
  /** Bullet text color (hex) — used by designs that color the letter; Classic
   *  draws the letter in the theme's neutral ink, not this. */
  textColor: string;
}

export interface StationDesign {
  /** Stable key persisted in settings. */
  id: string;
  /** Shown in the settings row and under each picker tile. */
  name: string;
  /** Optional one-line description (reserved for future city styles). */
  blurb?: string;
  /** Standalone <svg> string drawing one example station in this design. */
  renderPreview: (ex: ExampleStation, dark: boolean) => string;
  /** The smoothed-mode marker renderer for this design. */
  renderStops: RenderStopsFn;
}

export const DEFAULT_STATION_DESIGN = 'classic';

export const EXAMPLE_STATION_DEFAULT: ExampleStation = {
  bullet: 'A',
  color: '#dc2626',
  textColor: '#ffffff',
};

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Validate a hex color, else a neutral gray (mirrors routes.ts sanitizeColor;
 *  inlined so the registry stays a light leaf module). */
function okColor(c: string | undefined): string {
  return c && HEX.test(c) ? c : '#888888';
}

/**
 * The example station for the picker: the first non-temporary route that has a
 * non-empty bullet, else the A/red default. Minimal structural param so this
 * stays framework-free (accepts the game's Route[] directly).
 */
export function pickExampleRoute(
  routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>,
): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    const bullet = (r.bullet ?? '').trim();
    if (bullet) return { bullet, color: okColor(r.color), textColor: r.textColor || '#ffffff' };
  }
  return EXAMPLE_STATION_DEFAULT;
}

/**
 * Classic preview: faithful to what renderStops draws for a single-line stop —
 * a hollow disc, a ring in the line color, the bullet centered inside in the
 * theme's neutral ink (NOT the route text color, matching renderStops). Sized
 * for a tile in its own viewBox.
 */
function classicPreview(ex: ExampleStation, dark: boolean): string {
  const fill = dark ? '#18181b' : '#ffffff';
  const ink = dark ? '#ffffff' : '#111111';
  const cx = 22;
  const cy = 22;
  const r = 13;
  const name = ex.bullet;
  // Mirror renderStops' bullet font sizing (dr === r for a plain dot).
  const fs = name.length <= 1 ? r * 1.7 : Math.min(r * 1.7, (2 * r * 0.92) / (0.6 * name.length));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${escapeXml(ex.color)}" stroke-width="6"/>` +
    `<text x="${cx}" y="${(cy + fs * 0.36).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" ` +
    `font-size="${fs.toFixed(2)}" font-weight="bold" fill="${ink}">${escapeXml(name)}</text>` +
    `</svg>`
  );
}

const classic: StationDesign = {
  id: 'classic',
  name: 'Classic',
  renderPreview: classicPreview,
  renderStops,
};

export const STATION_DESIGNS: StationDesign[] = [classic];

/** Registry lookup; falls back to Classic for unknown/undefined ids. */
export function getStationDesign(id: string | undefined): StationDesign {
  return STATION_DESIGNS.find((d) => d.id === id) ?? classic;
}
