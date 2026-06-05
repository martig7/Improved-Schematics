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
import { renderGeographic } from './renderGeographic';
import { renderOctilinear } from './renderOctilinear';
import { buildStationGroups, buildTransitGraph } from './layout/graph';
import { octilinearLayout } from './layout/octilinear';
import { simplifyLayout } from './layout/simplify';
import { orderLines } from './layout/lineOrder';
import type { Station } from '../types/game-state';

export interface SchematicInput {
  routes: Route[];
  tracks: Track[];
  stations: { id: string; name: string; coords: Coordinate }[];
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
    const groups = buildStationGroups(input.stations as Station[]);
    const graph = buildTransitGraph(input.stations as Station[], input.routes, groups);
    if (graph.edges.length === 0) {
      return emptyStateSvg(opts.width, opts.height, land);
    }
    let layout = octilinearLayout(graph);
    layout = simplifyLayout(layout, graph);
    orderLines(layout);
    return renderOctilinear(layout, {
      dark: opts.dark,
      showLabels: opts.showLabels,
      water: input.water,
    });
  }

  return renderGeographic({ ...input, smooth: opts.mode === 'smoothed' });
}
