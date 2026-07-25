/**
 * How much land detail to harvest from the basemap's vector tiles.
 *
 * The harvest fits a hidden offscreen map to the whole city bbox, so the
 * container's pixel size IS the harvest resolution: fitBounds picks the zoom that
 * maps the bbox onto exactly that many pixels, and vector tiles arrive already
 * simplified for that zoom. Detail thrown away by the tile pipeline cannot be
 * recovered downstream, so this is the only place that decides how faithful the
 * coastline can ever be. Later stages (clean, then the draw-time landmass styles)
 * only ever simplify what is harvested here.
 *
 * The legacy container was 512px, which resolves a city at roughly a fifth of the
 * render canvas, hence blocky coastlines. The levels below are chosen against the
 * render resolution: `detailed` is the largest power of two at or below the base
 * canvas, so land carries about one vertex per rendered pixel; `ultra` doubles
 * that for headroom when a crop magnifies a sub-region past the full-map scale.
 *
 * Cost is quadratic: the offscreen map loads roughly (containerPx/512)^2 tiles,
 * so 512 -> 2048 is ~16 tiles and 4096 is ~64. The harvest is once per city and
 * cached, but it does block the first generation.
 */
import type { BoundingBox } from '../types/core';

export type LandDetail = 'standard' | 'detailed' | 'ultra';

export const LAND_DETAILS: ReadonlyArray<{ id: LandDetail; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'ultra', label: 'Super detailed' },
];

export const DEFAULT_LAND_DETAIL: LandDetail = 'detailed';

/** Offscreen container size (px) per level. Powers of two, so the derived zoom
 *  moves in whole steps and a rounding wobble can never change the choice. */
export const DETAIL_CONTAINER_PX: Record<LandDetail, number> = {
  standard: 512,
  detailed: 2048,
  ultra: 4096,
};

/** Smallest container we will ever harvest at (one tile across the bbox). */
const MIN_CONTAINER_PX = 512;

const mercY = (lat: number): number => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/**
 * The zoom MapLibre's fitBounds lands on for this bbox in a square container of
 * `containerPx` (tile size 512, no padding): the axis that runs out of room wins.
 */
export function fitZoom(bbox: BoundingBox, containerPx: number): number {
  const dLng = Math.abs(bbox[2] - bbox[0]) / 360;
  const dY = Math.abs(mercY(bbox[3]) - mercY(bbox[1]));
  if (!(dLng > 0) || !(dY > 0)) return 0;
  return Math.min(Math.log2(containerPx / (512 * dLng)), Math.log2(containerPx / (512 * dY)));
}

/**
 * Container size for `detail`, reduced while the implied zoom would exceed the
 * source's `maxzoom`. Past maxzoom a vector source serves overzoomed parent
 * tiles, so the request costs four times the tiles per step and returns no new
 * geometry. Absent/invalid maxzoom means no clamp. Never goes below one tile.
 */
export function harvestContainerPx(bbox: BoundingBox, detail: LandDetail, maxzoom?: number): number {
  let px = DETAIL_CONTAINER_PX[detail] ?? DETAIL_CONTAINER_PX[DEFAULT_LAND_DETAIL];
  if (typeof maxzoom === 'number' && Number.isFinite(maxzoom)) {
    while (px > MIN_CONTAINER_PX && fitZoom(bbox, px) > maxzoom) px /= 2;
  }
  return px;
}

/** Rough count of tiles the offscreen map must load, for the harvest log. */
export function tileEstimate(containerPx: number): number {
  const across = Math.ceil(containerPx / 512);
  return across * across;
}

/** One offscreen harvest pass: a region to fit, and the container that sets its
 *  zoom. Several passes are unioned, so a small region can be sampled far finer
 *  than the whole map without paying for the whole map at that resolution. */
export interface HarvestRegion {
  bbox: BoundingBox;
  containerPx: number;
  /** Names the pass in the harvest log. */
  label: string;
}

/** A region must be this much smaller than the full extent (by area) before it is
 *  worth a second pass; below that it would re-fetch nearly the same tiles for
 *  nearly the same zoom. */
const TIER_AREA_FRAC = 0.5;

const bboxArea = (b: BoundingBox): number => Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);

/**
 * The passes to harvest for this map.
 *
 * A single pass over the whole demand extent is resolution-bound: the extent is
 * far larger than the built network, so a channel a few tens of metres wide lands
 * below one pixel and the tiles deliver it already broken. Raising the zoom
 * uniformly is not affordable, because tile count grows with the square.
 *
 * So sample where it matters instead. The network's own extent gets a second pass
 * at the SAME container, which costs the same tiles yet lands at a higher zoom
 * purely because it covers less ground. Keyed on the NETWORK, never on where the
 * water is: the water is what the harvest produces, so targeting it would be
 * circular and could not be computed before harvesting.
 *
 * Regions are returned coarsest first, so a later pass's finer geometry is
 * unioned over the earlier one.
 */
export function harvestRegions(
  full: BoundingBox,
  network: BoundingBox | null,
  detail: LandDetail,
  maxzoom?: number,
): HarvestRegion[] {
  const out: HarvestRegion[] = [
    { bbox: full, containerPx: harvestContainerPx(full, detail, maxzoom), label: 'full' },
  ];
  if (!network) return out;
  const fa = bboxArea(full);
  if (!(fa > 0) || !(bboxArea(network) > 0)) return out;
  if (bboxArea(network) / fa > TIER_AREA_FRAC) return out; // not enough smaller to pay for a pass
  const px = harvestContainerPx(network, detail, maxzoom);
  // Only worth it if the smaller extent actually buys resolution.
  if (fitZoom(network, px) <= fitZoom(full, out[0].containerPx) + 0.5) return out;
  out.push({ bbox: network, containerPx: px, label: 'network' });
  return out;
}

// The chosen level, held module-wide so the background warm-up (which runs from
// city load, with no panel in scope) harvests at the same detail the panel would.
// Mirrors the draw-scale binding in render/constants.
let current: LandDetail = DEFAULT_LAND_DETAIL;

/** Set the level future harvests use. Unknown values are ignored. */
export function setLandDetail(detail: LandDetail): void {
  if (LAND_DETAILS.some((d) => d.id === detail)) current = detail;
}

/** The level future harvests will use. */
export function getLandDetail(): LandDetail {
  return current;
}
