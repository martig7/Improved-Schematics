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

/** Area-label tiers by size, coarse (largest areas) to fine (smallest). The rank
 *  (index) is the size order; a lower rank is a bigger area and wins a collision.
 *  Unknown kinds rank after every tier. */
export const PLACE_TIERS = ['city', 'suburb', 'neighbourhood'] as const;

const norm = (kind: string): string => (kind === 'neighborhood' ? 'neighbourhood' : kind);

/** Size rank of a kind: 0 = biggest (city); unknown kinds rank last. */
export function tierRank(kind: string): number {
  const i = (PLACE_TIERS as readonly string[]).indexOf(norm(kind));
  return i < 0 ? PLACE_TIERS.length : i;
}

/** Each tier's zoom band [fadeIn, fadeOut] copied from the basemap style, so a
 *  chosen zoom shows exactly the tiers the live map shows at that zoom. */
const TIER_ZOOM: Record<string, [number, number]> = {
  city: [8, 13],
  suburb: [10, 14],
  neighbourhood: [12, 15],
};

/** Slider bounds and defaults for the label controls. The default zoom shows the
 *  city + suburb bands; the default padding is the basemap's own textPadding. */
export const LABEL_ZOOM_MIN = 8;
export const LABEL_ZOOM_MAX = 15;
export const DEFAULT_LABEL_ZOOM = 11;
export const LABEL_PAD_MIN = 0;
export const LABEL_PAD_MAX = 40;
export const DEFAULT_LABEL_PAD = 8;

// A label's collision box: uppercase glyph advance as a fraction of the font
// size, plus a padding derived from the slider. 8px against the basemap's ~13px
// text is ~0.6 of the font, which matches the tuned default look.
const CHAR_ADVANCE = 0.62;
const PAD_PX_TO_FRAC = 0.6 / 8;

/** The tiers visible at a given zoom, per the basemap's per-tier zoom bands. */
export function tiersAtZoom(zoom: number): Set<string> {
  const out = new Set<string>();
  for (const t of PLACE_TIERS) {
    const [lo, hi] = TIER_ZOOM[t];
    if (zoom >= lo && zoom <= hi) out.add(t);
  }
  return out;
}

/**
 * Cull overlapping labels the way the basemap's draw-time symbol collision does
 * (which our static fit does not inherit): keep bigger tiers first, then by name,
 * dropping any label whose text box overlaps an already-kept one. `fontPx` is the
 * paint size, so the cull matches what is drawn and re-runs when the size setting
 * changes. `padFrac` is the collision gap as a fraction of the font. Deterministic
 * (tier then name order).
 */
export function declutterPlaces(places: PlacePx[], fontPx: number, padFrac: number): PlacePx[] {
  const sorted = [...places].sort((a, b) => {
    const ra = tierRank(a.kind), rb = tierRank(b.kind);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const pad = fontPx * padFrac;
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
 * Resolve the labels to paint: keep the tiers visible at `zoom` (the basemap's
 * bands), then collision-cull at a gap set by `padPx` (the basemap's textPadding
 * units). Bigger tiers win a collision. Zoom/pad default to the shown constants.
 */
export function selectPlaces(
  places: PlacePx[] | undefined,
  zoom: number,
  padPx: number,
  fontPx: number,
): PlacePx[] {
  if (!places || places.length === 0) return [];
  const tiers = tiersAtZoom(zoom);
  const visible = places.filter((p) => tiers.has(norm(p.kind)));
  return declutterPlaces(visible, fontPx, padPx * PAD_PX_TO_FRAC);
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
