/**
 * Neighborhood-name labels for the schematic, sourced from the same vector
 * tiles the geography backdrop comes from (GeographyData.places). Shared by
 * both render modes: geographic projects the points directly, smoothed
 * projects them through the warped projection at precompute time so the
 * names deform with the network. Painting is a cheap toggle-gated repaint.
 *
 * Sizing is normalized across modes. Geographic authors on a base-2700 canvas
 * while smoothed grows past it, so a world-space font that looks right in one
 * mode is wrong in the other. Every world measurement here (font, declutter
 * spacing, margin) is expressed in base-2700 units and rescaled by
 * `min(width, height) / 2700` at projection/paint, so one setting produces the
 * same on-screen result in both modes.
 */

import type { GeographyData } from '../geography/types';
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
// Base-2700 reference size; the paint font is this times the user multiplier
// times the per-mode canvas scale.
export const PLACE_FONT_SIZE = LABEL_FONT_SIZE * 1.5;
const FILL_DARK = 'rgba(190,193,201,0.55)';
const FILL_LIGHT = 'rgba(90,92,100,0.55)';

/** Minimum center distance between two kept labels, base-2700 world px. */
const MIN_DIST = 150;
/** Hard cap per kind so a label-dense basemap cannot wallpaper the canvas. */
const MAX_LABELS = 90;

/** Human-facing name for each place kind (for the layer dropdown). */
const KIND_LABEL: Record<string, string> = {
  neighbourhood: 'Neighborhoods',
  neighborhood: 'Neighborhoods',
  suburb: 'Suburbs',
  quarter: 'Quarters',
  borough: 'Boroughs',
  district: 'Districts',
};

/** Display name for a place kind, falling back to a capitalized raw value. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) + 's' : kind);
}

/** The distinct place kinds present in the harvest, sorted for a stable dropdown. */
export function placeKinds(geo: GeographyData | undefined): string[] {
  const kinds = new Set<string>();
  for (const p of geo?.places ?? []) kinds.add(p.kind);
  return [...kinds].sort();
}

/** Per-mode world-unit scale: base-2700 measurements times this render at the
 *  same on-screen size in either mode. Geographic is exactly 2700x2700 (=1);
 *  smoothed grows past it, so labels scale up to survive the fit-to-viewport
 *  shrink. The panel fits the frame by min(VPW/FW, VPH/FH), so the limiting axis
 *  depends on the viewport aspect; the geometric mean of the two canvas
 *  dimensions bounds the residual symmetrically whichever axis limits, instead
 *  of being exact on one axis and doubled on the other. */
export const placeCanvasScale = (width: number, height: number): number => Math.sqrt(width * height) / 2700;

/**
 * Project every harvested place through `proj` and declutter WITHIN each kind:
 * only one kind is ever shown at a time, so a label competes only with kept
 * labels of its own kind. Kept name-first (deterministic for a given harvest);
 * each newcomer must clear every same-kind kept label by MIN_DIST; points
 * outside the canvas margin are dropped. Spacing and margin scale per mode so
 * the declutter density matches on screen.
 */
export function projectPlaces(
  geo: GeographyData | undefined,
  proj: { toSVG: (c: [number, number]) => [number, number] },
  width: number,
  height: number,
): PlacePx[] {
  const places = geo?.places;
  if (!places || places.length === 0) return [];
  const scale = placeCanvasScale(width, height);
  const minDist = MIN_DIST * scale;
  const margin = PLACE_FONT_SIZE * scale;
  const sorted = [...places].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const keptByKind = new Map<string, PlacePx[]>();
  for (const p of sorted) {
    if (!p.name) continue;
    const kept = keptByKind.get(p.kind) ?? [];
    if (kept.length >= MAX_LABELS) continue;
    const [x, y] = proj.toSVG(p.coord);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue;
    let clear = true;
    for (const k of kept) {
      const dx = x - k.px[0];
      const dy = y - k.px[1];
      if (dx * dx + dy * dy < minDist * minDist) { clear = false; break; }
    }
    if (!clear) continue;
    kept.push({ name: p.name, px: [+x.toFixed(1), +y.toFixed(1)], kind: p.kind });
    keptByKind.set(p.kind, kept);
  }
  return [...keptByKind.values()].flat();
}

/** Keep only the labels of the chosen kind; an unset kind shows every kind. */
export function filterPlacesKind(places: PlacePx[] | undefined, kind: string | undefined): PlacePx[] {
  if (!places) return [];
  if (!kind) return places;
  return places.filter((p) => p.kind === kind);
}

const fillFor = (dark: boolean): string => (dark ? FILL_DARK : FILL_LIGHT);

/** SVG layer for the kept labels (empty string when there are none). `fontPx`
 *  is the paint size (base times user multiplier times per-mode scale). */
export function placesSvg(places: PlacePx[] | undefined, dark: boolean, fontPx = PLACE_FONT_SIZE): string {
  if (!places || places.length === 0) return '';
  const fs = fontPx.toFixed(1);
  const parts = places.map((p) =>
    `<text x="${p.px[0].toFixed(1)}" y="${p.px[1].toFixed(1)}" text-anchor="middle" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="${fillFor(dark)}">${escapeXml(p.name.toUpperCase())}</text>`,
  );
  return `<g class="nbhd">${parts.join('')}</g>`;
}

/** Scene prims for the kept labels (the canvas panel paints these). */
export function placesPrims(places: PlacePx[] | undefined, dark: boolean, fontPx = PLACE_FONT_SIZE): Prim[] {
  if (!places || places.length === 0) return [];
  return places.map((p): Prim => ({
    kind: 'text',
    text: p.name.toUpperCase(),
    x: p.px[0],
    y: p.px[1],
    ax: 0,
    ay: 0,
    fontSize: fontPx,
    fontWeight: 'bold',
    align: 'center',
    fill: fillFor(dark),
    layer: 'stops',
    worldScale: true,
  }));
}
