// Offscreen-harvest diagnostics. Extracted from harvest.ts so the harvest
// routine keeps only the call sites. These logs are UNCONDITIONAL (no env
// gate) — they trace the one-time geography harvest in the browser console —
// so the extracted functions reproduce that output verbatim, byte-for-byte.
import type { BoundingBox } from '../../types/core';

const TAG = '[ImprovedSchematics] geography:';

/** Trace the fitBounds result: the bbox we fit to, the resulting zoom, and the
 *  detail level that chose the offscreen container (the tile level of detail the
 *  whole backdrop is limited by). */
export function logHarvestFit(
  bbox: BoundingBox,
  zoom: number,
  detail: string,
  containerPx: number,
  tiles: number,
  maxzoom?: number,
): void {
  const cap = typeof maxzoom === 'number' && Number.isFinite(maxzoom) ? `, source maxzoom ${maxzoom}` : '';
  console.info(
    `${TAG} fit to [${bbox.map((n) => n.toFixed(3)).join(', ')}] → offscreen zoom ${zoom.toFixed(1)} ` +
    `(detail '${detail}', container ${containerPx}px, ~${tiles} tiles${cap})`,
  );
}

/** Trace the harvested per-source-layer counts, plus the "not serving yet" and
 *  "still loading" warnings that gate on the same diagnostic state. */
export function logHarvestCounts(
  counts: Record<string, number>,
  loaded: boolean,
  tileErrors: number,
  outLength: number,
  tileWaitMs: number,
  errKinds?: ReadonlyMap<string, number>,
): void {
  console.info(`${TAG} harvested per source-layer:`, counts, `(tilesLoaded=${loaded}, tileErrors=${tileErrors})`);
  if (errKinds && errKinds.size > 0) {
    // Ranked, so the dominant failure is first. A tiled source 404s for tiles
    // outside coverage as a matter of course, which is expected at the corners
    // of a rectangular harvest bbox; anything else deserves attention.
    const ranked = [...errKinds.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    console.info(`${TAG} tile error kinds: ` + ranked.map(([k, n]) => `${n}x ${k}`).join(' | '));
  }
  if (outLength === 0 && tileErrors > 0) {
    console.warn(`${TAG} 0 features with ${tileErrors} tile error(s) — basemap not serving tiles yet; caller will retry`);
  } else if (tileErrors > 0) {
    // areTilesLoaded() reports true once every tile has SETTLED, and a tile that
    // failed has settled, so a partial harvest otherwise passes silently: features
    // arrive, nothing complains, and the gap only shows up later as missing
    // geography. Say so, since the result is cached and reused as if complete.
    console.warn(`${TAG} harvested ${outLength} features but ${tileErrors} tile request(s) errored — this harvest may be MISSING geography (it is still cached; see the tile error kinds above)`);
  } else if (!loaded) {
    console.warn(`${TAG} tiles still loading after ${tileWaitMs}ms — harvest may be partial; caller will retry`);
  }
}

/** Trace an offscreen-harvest failure (thrown before/while querying features). */
export function logHarvestFailed(err: unknown): void {
  console.warn(`${TAG} offscreen harvest failed:`, err);
}

/** Trace offscreen-map teardown with how long the map lived. */
export function logHarvestDisposed(ms: number): void {
  console.info(`${TAG} offscreen map disposed (lived ${ms}ms)`);
}
