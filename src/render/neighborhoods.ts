/**
 * Neighborhood-name labels for the schematic, sourced from the same vector
 * tiles the geography backdrop comes from (GeographyData.places). Shared by
 * both render modes: geographic projects the points directly, smoothed
 * projects them through the warped projection at precompute time so the
 * names deform with the network. Painting is a cheap toggle-gated repaint.
 *
 * We do NOT declutter the harvested points: the game's tile pipeline already
 * thins place labels per zoom, so the harvested set is deconflicted by
 * construction. We just project, drop the off-canvas ones, and render.
 *
 * The paint font is sized off the fit FRAME (the water/green extent the panel
 * fits to), not the canvas, so one setting produces the same on-screen size in
 * both modes; see placeFrameScale.
 */

import type { GeographyData } from '../geography/types';
import { escapeXml } from './escape';
import type { Prim } from './sceneIR';
import { LABEL_FONT_SIZE } from './constants';

/** One projected place label, ready to paint. */
export interface PlacePx {
  name: string;
  px: [number, number];
  kind: string;
}

// Area-label typography: larger and quieter than station labels, uppercase.
// Base-2700 reference size; the paint font is this times the user multiplier
// times the per-mode frame scale.
export const PLACE_FONT_SIZE = LABEL_FONT_SIZE * 1.5;
const FILL_DARK = 'rgba(190,193,201,0.55)';
const FILL_LIGHT = 'rgba(90,92,100,0.55)';

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

/** Per-mode world-unit scale from the CONTENT FRAME (the water/green extent the
 *  panel actually fits to), NOT the canvas. Base-2700 measurements times this
 *  render at the same on-screen size in either mode. The panel fits the frame by
 *  min(VPW/FW, VPH/FH), so for a square-ish viewport the LARGER frame dimension
 *  is what limits the zoom; scaling by max(FW, FH)/2700 therefore cancels the fit
 *  exactly (on-screen size = const) whatever the frame aspect. Keying off the
 *  frame (not the square 2700 geographic canvas) is what makes a tall city's
 *  labels the right size and density instead of oversized and over-decluttered. */
export const placeFrameScale = (frameW: number, frameH: number): number => Math.max(frameW, frameH) / 2700;

/**
 * Project every harvested place through `proj`. No decluttering: the game's tile
 * pipeline already thins labels per zoom, so the harvested set is deconflicted
 * by construction. Points landing outside the canvas margin are dropped, and the
 * result is name-sorted so the emitted SVG is deterministic regardless of
 * harvest order. The `scale` only sizes the off-canvas margin.
 */
export function projectPlaces(
  geo: GeographyData | undefined,
  proj: { toSVG: (c: [number, number]) => [number, number] },
  width: number,
  height: number,
  scale = placeFrameScale(width, height),
): PlacePx[] {
  const places = geo?.places;
  if (!places || places.length === 0) return [];
  const margin = PLACE_FONT_SIZE * scale;
  const sorted = [...places].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: PlacePx[] = [];
  for (const p of sorted) {
    if (!p.name) continue;
    const [x, y] = proj.toSVG(p.coord);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue;
    out.push({ name: p.name, px: [+x.toFixed(1), +y.toFixed(1)], kind: p.kind });
  }
  return out;
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
