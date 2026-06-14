/**
 * generateSchematicSVG — dispatches to a renderer based on the requested mode:
 *   - 'geographic' (default): route lines in true positions over land/water
 *   - 'smoothed':   geographic positions relaxed toward octilinear
 *   - 'schematic':  the game's full octilinear layout (grid snap + simplify)
 *
 * Returns a self-contained SVG string suitable for innerHTML or file output.
 */

import type { Route, Track } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { WaterCollection, SchematicOptions } from './types';
import { DEFAULT_OPTIONS } from './types';
import { renderGeographic, precomputeSmoothed, drawSmoothed, type SmoothedPrecomputed } from './renderGeographic';
import { renderOctilinear } from './renderOctilinear';
import { getOrBuildStationGroups, buildTransitGraph } from './layout/graph';
import { octilinearLayout } from './layout/octilinear';
import { simplifyLayout } from './layout/simplify';
import { orderLines } from './layout/lineOrder';
import type { Station } from '../types/game-state';
import { findTransferPairs, routedGroupsOnly, DEFAULT_TRANSFER_METERS } from './transfers';

export interface SchematicInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
  /**
   * The game's `state.stationGroups` (via `api.gameState.getStationGroups()`).
   * Preferred over deriving groups from `Station.trackGroupId`, since the game
   * merges overlapping platforms by spatial proximity — what shows as an
   * interchange in the UI. Omit or pass empty to fall back to derived groups.
   */
  stationGroups?: unknown[];
  water?: WaterCollection;
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

  if (input.routes.length === 0) {
    return emptyStateSvg(opts.width, opts.height, land);
  }

  if (opts.mode === 'schematic') {
    const groups = getOrBuildStationGroups(input.stations as Station[], input.stationGroups);
    const graph = buildTransitGraph(input.stations as Station[], input.routes, groups);
    if (graph.edges.length === 0) {
      return emptyStateSvg(opts.width, opts.height, land);
    }
    let layout = octilinearLayout(graph);
    layout = simplifyLayout(layout, graph);
    orderLines(layout);
    const transfers = findTransferPairs(routedGroupsOnly(groups, graph), DEFAULT_TRANSFER_METERS);
    return renderOctilinear(layout, {
      dark: opts.dark,
      showLabels: opts.showLabels,
      water: input.water,
      transfers,
    });
  }

  return renderGeographic({ ...input, smooth: opts.mode === 'smoothed' });
}

export type { SmoothedPrecomputed };

/**
 * Two-phase smoothed render. `precomputeSmoothedSchematic` runs the expensive
 * layout (octi pipeline) once; `drawSmoothedSchematic` redraws that cached
 * result cheaply whenever only the label/station toggles change. Geographic
 * and schematic modes stay single-phase via `generateSchematicSVG`.
 *
 * Returns a ready-to-use SVG string (instead of a precomputed bundle) for the
 * empty/degenerate cases, so callers branch on `typeof result === 'string'`.
 */
export function precomputeSmoothedSchematic(input: SchematicInput): SmoothedPrecomputed | string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  if (input.routes.length === 0) {
    return emptyStateSvg(opts.width, opts.height, opts.dark ? '#18181b' : opts.theme.land);
  }
  return precomputeSmoothed({ ...input, smooth: true });
}

export function drawSmoothedSchematic(
  pre: SmoothedPrecomputed,
  options?: Partial<SchematicOptions>,
): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...options };
  return drawSmoothed(pre, { showLabels: opts.showLabels, showStations: opts.showStations });
}
