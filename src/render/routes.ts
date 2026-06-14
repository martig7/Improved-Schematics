/**
 * Reduce live game state (routes + tracks) into geographic polylines.
 *
 * Mirrors the game's own `buildGeoProjectedRoutes`: a route's geometry is the
 * concatenation of the track segments referenced by its stCombos paths, in
 * order. Track segments that stay within the same station group (e.g. parallel
 * forward/back tracks at one platform) contribute coords once — the same rule
 * as walkRouteVisits in buildTransitGraph.
 */

import type { Route, Track, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { RouteLine, StationPoint } from './types';
import { getOrBuildStationGroups, buildGroupMaps, appendComboPathGeometry } from './layout/graph';

/** Validate a hex color string, falling back to a neutral gray. */
export function sanitizeColor(color: string | undefined): string {
  if (color && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return color;
  }
  return '#888888';
}

/**
 * Build one RouteLine per non-temporary route. Skips routes without resolvable
 * track geometry. Track segments are looked up by id; missing tracks are
 * skipped so a partial route still renders what it can.
 */
export function extractRouteLines(
  routes: Route[],
  tracks: Track[],
  stations: Station[],
  apiGroups?: unknown[] | null,
): RouteLine[] {
  const trackMap = new Map<string, Track>();
  for (const track of tracks) trackMap.set(track.id, track);

  const groups = getOrBuildStationGroups(stations, apiGroups ?? null);
  const { trackToGroup } = buildGroupMaps(stations, groups);

  const lines: RouteLine[] = [];

  for (const route of routes) {
    if (route.tempParentId != null) continue;

    const combos = route.stCombos;
    if (!combos || combos.length === 0) continue;

    const points: Coordinate[] = [];
    const prevSegGroup = { value: undefined as string | undefined };
    for (const combo of combos) {
      appendComboPathGeometry(points, combo.path ?? [], trackMap, trackToGroup, prevSegGroup);
    }

    if (points.length < 2) continue;

    lines.push({
      routeId: route.id,
      color: sanitizeColor(route.color),
      bullet: route.bullet,
      points,
    });
  }

  return lines;
}

/** Collect station points (used for markers/labels). */
export function extractStationPoints(
  stations: { id: string; name: string; coords: Coordinate }[],
): StationPoint[] {
  return stations.map((s) => ({ id: s.id, name: s.name, coords: s.coords }));
}
