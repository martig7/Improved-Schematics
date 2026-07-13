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

/** Area-label tiers by size, coarse (largest areas) to fine (smallest). This is
 *  the basemap's own hierarchy: cities fade in at the lowest zoom, then suburbs,
 *  then neighborhoods. The rank (index) is the size order; a lower rank is a
 *  bigger area and wins a collision. Unknown kinds rank after every tier. */
export const PLACE_TIERS = ['city', 'suburb', 'neighbourhood'] as const;

/** Detail level naming an EVERY-tier view that culls hard, preferring the
 *  bigger-area labels (the ones a live map shows when zoomed out). Distinct from
 *  the finest tier, which shows the same set but at the normal spacing. */
export const ALL_DETAIL = 'all';

const norm = (kind: string): string => (kind === 'neighborhood' ? 'neighbourhood' : kind);

const KIND_LABEL: Record<string, string> = {
  city: 'Cities',
  suburb: 'Suburbs',
  neighbourhood: 'Neighborhoods',
  all: 'All',
};

/** Size rank of a kind: 0 = biggest (city); unknown kinds rank last. */
export function tierRank(kind: string): number {
  const i = (PLACE_TIERS as readonly string[]).indexOf(norm(kind));
  return i < 0 ? PLACE_TIERS.length : i;
}

/** Display name for a place tier, falling back to a capitalized raw value. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[norm(kind)] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) + 's' : kind);
}

/** The tiers present in the harvest, ordered coarse to fine (for the detail
 *  dropdown). Only known tiers, in size order. */
export function placeTiers(geo: GeographyData | undefined): string[] {
  const present = new Set<string>();
  for (const p of geo?.places ?? []) present.add(norm(p.kind));
  return PLACE_TIERS.filter((t) => present.has(t));
}

// Approximate uppercase glyph advance as a fraction of the font size (labels
// render in caps) and the collision padding as a fraction of the font size
// (mirrors the basemap's per-label textPadding). Used only to size the boxes
// the collision cull tests, never to draw.
const CHAR_ADVANCE = 0.62;
const PAD_FRAC = 0.6;

/** Keep places at or coarser than the chosen detail tier (cumulative, like
 *  zooming in). Undefined detail keeps every tier. */
export function filterPlacesTiers(places: PlacePx[] | undefined, detail: string | undefined): PlacePx[] {
  if (!places) return [];
  if (!detail) return places;
  const max = tierRank(detail);
  return places.filter((p) => tierRank(p.kind) <= max);
}

// Padding multiple for the "All" view, which spaces labels far apart for a clean
// every-tier overview (bigger areas win, small ones fill the gaps).
const STRONG_PAD_SCALE = 5;

/**
 * Cull overlapping labels the way the basemap's draw-time symbol collision does
 * (which our static fit does not inherit): keep bigger tiers first, then by name,
 * dropping any label whose text box overlaps an already-kept one. `fontPx` is the
 * paint size, so the cull matches what is actually drawn and re-runs when the
 * size setting changes. `padScale` widens the collision gap (the "All" view uses
 * a large one for a sparse overview). Deterministic (tier then name order).
 */
export function declutterPlaces(places: PlacePx[], fontPx: number, padScale = 1): PlacePx[] {
  const sorted = [...places].sort((a, b) => {
    const ra = tierRank(a.kind), rb = tierRank(b.kind);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const pad = fontPx * PAD_FRAC * padScale;
  const halfH = fontPx * 0.5 + pad * 0.5;
  const kept: { cx: number; cy: number; hw: number }[] = [];
  const out: PlacePx[] = [];
  for (const p of sorted) {
    const hw = p.name.length * CHAR_ADVANCE * fontPx * 0.5 + pad * 0.5;
    const cx = p.px[0], cy = p.px[1];
    let clear = true;
    for (const k of kept) {
      if (Math.abs(cx - k.cx) < hw + k.hw && Math.abs(cy - k.cy) < halfH * 2) { clear = false; break; }
    }
    if (!clear) continue;
    kept.push({ cx, cy, hw });
    out.push(p);
  }
  return out;
}

/**
 * Resolve the labels to paint for a detail level: the cumulative tiers to a named
 * tier at normal spacing, or ALL_DETAIL ('all') for every tier culled hard so the
 * bigger areas win and small ones only fill the gaps. Undefined behaves like the
 * finest cumulative view (all tiers, normal spacing).
 */
export function selectPlaces(places: PlacePx[] | undefined, detail: string | undefined, fontPx: number): PlacePx[] {
  const strong = detail === ALL_DETAIL;
  const tierSet = strong ? (places ?? []) : filterPlacesTiers(places, detail);
  return declutterPlaces(tierSet, fontPx, strong ? STRONG_PAD_SCALE : 1);
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
