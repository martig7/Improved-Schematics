/**
 * Neighborhood-name labels for the schematic, sourced from the same vector
 * tiles the geography backdrop comes from (GeographyData.places). Shared by
 * both render modes: geographic projects the points directly, smoothed
 * projects them through the warped projection at precompute time so the
 * names deform with the network. Painting is a cheap toggle-gated repaint.
 */

import type { GeographyData, GeoPlaceFeature } from '../geography/types';
import { escapeXml } from './escape';
import type { Prim } from './sceneIR';
import { LABEL_FONT_SIZE } from './constants';

/** One projected, declutter-surviving place label, ready to paint. */
export interface PlacePx {
  name: string;
  px: [number, number];
  kind: string;
}

// Area-label typography: larger and quieter than station labels, uppercase.
export const PLACE_FONT_SIZE = LABEL_FONT_SIZE * 1.5;
const FILL_DARK = 'rgba(190,193,201,0.55)';
const FILL_LIGHT = 'rgba(90,92,100,0.55)';

// Bigger administrative areas win the declutter over smaller ones.
const KIND_PRIORITY: Record<string, number> = {
  borough: 0,
  district: 0,
  suburb: 1,
  neighbourhood: 2,
  neighborhood: 2,
  quarter: 3,
};

/** Minimum center distance between two kept labels, world px. */
const MIN_DIST = 150;
/** Hard cap so a label-dense basemap cannot wallpaper the canvas. */
const MAX_LABELS = 90;

/**
 * Project every harvested place through `proj` and declutter: labels are kept
 * biggest-kind-first (name tie-break, so the pick is deterministic for a given
 * harvest), each newcomer must clear every kept label by MIN_DIST, and points
 * outside the canvas margin are dropped.
 */
export function projectPlaces(
  geo: GeographyData | undefined,
  proj: { toSVG: (c: [number, number]) => [number, number] },
  width: number,
  height: number,
): PlacePx[] {
  const places = geo?.places;
  if (!places || places.length === 0) return [];
  const sorted = [...places].sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind] ?? 9;
    const pb = KIND_PRIORITY[b.kind] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const kept: PlacePx[] = [];
  const margin = PLACE_FONT_SIZE;
  for (const p of sorted) {
    if (kept.length >= MAX_LABELS) break;
    if (!p.name) continue;
    const [x, y] = proj.toSVG(p.coord);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue;
    let clear = true;
    for (const k of kept) {
      const dx = x - k.px[0];
      const dy = y - k.px[1];
      if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) { clear = false; break; }
    }
    if (clear) kept.push({ name: p.name, px: [+x.toFixed(1), +y.toFixed(1)], kind: p.kind });
  }
  return kept;
}

const fillFor = (dark: boolean): string => (dark ? FILL_DARK : FILL_LIGHT);

/** SVG layer for the kept labels (empty string when there are none). */
export function placesSvg(places: PlacePx[] | undefined, dark: boolean): string {
  if (!places || places.length === 0) return '';
  const fs = PLACE_FONT_SIZE.toFixed(1);
  const parts = places.map((p) =>
    `<text x="${p.px[0].toFixed(1)}" y="${p.px[1].toFixed(1)}" text-anchor="middle" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="${fillFor(dark)}">${escapeXml(p.name.toUpperCase())}</text>`,
  );
  return `<g class="nbhd">${parts.join('')}</g>`;
}

/** Scene prims for the kept labels (the canvas panel paints these). */
export function placesPrims(places: PlacePx[] | undefined, dark: boolean): Prim[] {
  if (!places || places.length === 0) return [];
  return places.map((p): Prim => ({
    kind: 'text',
    text: p.name.toUpperCase(),
    x: p.px[0],
    y: p.px[1],
    ax: 0,
    ay: 0,
    fontSize: PLACE_FONT_SIZE,
    fontWeight: 'bold',
    align: 'center',
    fill: fillFor(dark),
    layer: 'stops',
    worldScale: true,
  }));
}
