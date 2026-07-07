/**
 * generateSchematicSVG dispatches to a renderer based on the requested mode.
 * 'geographic' (the default) draws route lines in true positions over land and
 * water; 'smoothed' relaxes those positions toward octilinear.
 *
 * Returns a self-contained SVG string suitable for innerHTML or file output.
 */

import type { Route, Track } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { WaterCollection, SchematicOptions } from './types';
import type { GeographyData } from '../geography/types';
import { DEFAULT_OPTIONS } from './types';
import { renderGeographic, precomputeSmoothed, drawSmoothed, type SmoothedPrecomputed } from './renderGeographic';
import { landmassParams } from './geoSimplify';
import type { SceneOut } from './renderOctilinear';

export interface SchematicInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
  /**
   * The game's `state.stationGroups` (via `api.gameState.getStationGroups()`).
   * Preferred over deriving groups from `Station.trackGroupId`, since the game
   * merges overlapping platforms by spatial proximity. This is what shows as an
   * interchange in the UI. Omit or pass empty to fall back to derived groups.
   */
  stationGroups?: unknown[];
  water?: WaterCollection;
  geography?: GeographyData;
  options?: Partial<SchematicOptions>;
}

function emptyStateSvg(width: number, height: number, land: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${land}"/>` +
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#888">` +
    `Build at least one route to see a schematic.</text></svg>`
  );
}

export function generateSchematicSVG(input: SchematicInput): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const land = opts.dark ? '#18181b' : opts.theme.land;

  // With no routes, still show the geography backdrop if we have it (renderGeographic
  // frames on the geography extent); only show the prompt when there's nothing to draw.
  if (input.routes.length === 0 && !input.geography) {
    return emptyStateSvg(opts.width, opts.height, land);
  }

  return renderGeographic({ ...input, smooth: opts.mode === 'smoothed' });
}

export type { SmoothedPrecomputed };

/**
 * Two-phase smoothed render. `precomputeSmoothedSchematic` runs the expensive
 * layout (octi pipeline) once; `drawSmoothedSchematic` redraws that cached
 * result cheaply whenever only the label/station toggles change. Geographic
 * mode stays single-phase via `generateSchematicSVG`.
 *
 * Returns a ready-to-use SVG string (instead of a precomputed bundle) for the
 * empty/degenerate cases, so callers branch on `typeof result === 'string'`.
 */
export function precomputeSmoothedSchematic(input: SchematicInput): SmoothedPrecomputed | string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  if (input.routes.length === 0 && !input.geography) {
    return emptyStateSvg(opts.width, opts.height, opts.dark ? '#18181b' : opts.theme.land);
  }
  // No routes but geography present: precomputeSmoothed sees an empty graph and
  // falls back to the geographic render (the geography backdrop) as a string.
  return precomputeSmoothed({ ...input, smooth: true });
}

export function drawSmoothedSchematic(
  pre: SmoothedPrecomputed,
  options?: Partial<SchematicOptions>,
  sceneOut?: SceneOut,
): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...options };
  return drawSmoothed(
    pre,
    {
      showLabels: opts.showLabels,
      showStations: opts.showStations,
      megaFallback: opts.megaFallback,
      stationDesign: opts.stationDesign,
      landmass: landmassParams(opts.landmass ?? 'faithful', opts.landmassDetail ?? 0.5),
    },
    sceneOut,
  );
}
