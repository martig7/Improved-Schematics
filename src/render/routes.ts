/**
 * Reduce live game state (routes + tracks) into geographic polylines.
 *
 * Mirrors the game's own `buildGeoProjectedRoutes`: a route's geometry is the
 * concatenation of the track segments referenced by its stCombos paths, in
 * order. We keep the coordinates geographic (unprojected) so the caller can
 * apply a shared projection alongside the water layer.
 */

import type { Route, Track } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type { RouteLine, StationPoint } from './types';

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
export function extractRouteLines(routes: Route[], tracks: Track[]): RouteLine[] {
  const trackMap = new Map<string, Track>();
  for (const track of tracks) trackMap.set(track.id, track);

  const lines: RouteLine[] = [];

  for (const route of routes) {
    // tempParentId marks an in-progress edit clone of a real route — skip it.
    if (route.tempParentId != null) continue;

    const combos = route.stCombos;
    if (!combos || combos.length === 0) continue;

    const points: Coordinate[] = [];
    for (const combo of combos) {
      for (const segment of combo.path) {
        const track = trackMap.get(segment.trackId);
        if (!track) continue;
        // Append this segment's coordinates. Reversed segments are walked
        // backwards so the polyline stays continuous.
        const coords = segment.reversed ? [...track.coords].reverse() : track.coords;
        for (const c of coords) points.push(c);
      }
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
