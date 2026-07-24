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
): void {
  console.info(`${TAG} harvested per source-layer:`, counts, `(tilesLoaded=${loaded}, tileErrors=${tileErrors})`);
  if (outLength === 0 && tileErrors > 0) {
    console.warn(`${TAG} 0 features with ${tileErrors} tile error(s) — basemap not serving tiles yet; caller will retry`);
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
