// Build a transit graph (station-group nodes + edges + line traversals) from the
// modding API's routes/tracks/stations. Ported from the game
// (dev/reference/buildTransitGraph.js, walkRouteVisits.js, normalizeColor.js,
// edgeKey_1.js, projectFactory.js); buildStationGroups is new glue that derives
// the game's interchange groups from Station.trackGroupId.

import type { Station, Route } from '../../types/game-state';
import type { Coordinate } from '../../types/core';
import type {
  StationGroup,
  TransitGraph,
  GraphNode,
  GraphEdge,
  LineRef,
  Visit,
  TraversalStep,
} from './types';

/** Group constructed stations into interchange nodes by trackGroupId (fallback). */
export function buildStationGroups(stations: Station[]): StationGroup[] {
  const byGroup = new Map<string, Station[]>();
  for (const s of stations) {
    if (s.buildType !== 'constructed') continue;
    const arr = byGroup.get(s.trackGroupId) ?? [];
    arr.push(s);
    byGroup.set(s.trackGroupId, arr);
  }
  const groups: StationGroup[] = [];
  for (const [id, members] of byGroup) {
    let lng = 0;
    let lat = 0;
    for (const m of members) {
      lng += m.coords[0];
      lat += m.coords[1];
    }
    groups.push({
      id,
      name: members[0].name,
      center: [lng / members.length, lat / members.length],
      stationIds: members.map((m) => m.id),
    });
  }
  return groups;
}

/**
 * Get the game's real `stationGroups` from the store — the same data the
 * in-game SchematicMapMenu uses (spatial proximity merges overlapping platforms,
 * not just shared trackGroupId). Normalizes each group's shape into our
 * StationGroup interface; computes `center` from member stations when absent.
 * Falls back to `buildStationGroups(stations)` if the API method isn't exposed
 * or returns nothing usable.
 */
export function getOrBuildStationGroups(
  stations: Station[],
  apiGroups: unknown[] | undefined | null,
): StationGroup[] {
  if (!Array.isArray(apiGroups) || apiGroups.length === 0) {
    return buildStationGroups(stations);
  }

  const stationById = new Map<string, Station>();
  for (const s of stations) stationById.set(s.id, s);

  const groups: StationGroup[] = [];
  for (const raw of apiGroups) {
    if (!raw || typeof raw !== 'object') continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === 'string' ? g.id : undefined;
    const stationIds: string[] = Array.isArray(g.stationIds)
      ? (g.stationIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (!id || stationIds.length === 0) continue;

    let center: [number, number] | undefined;
    if (Array.isArray(g.center) && g.center.length >= 2 && typeof g.center[0] === 'number' && typeof g.center[1] === 'number') {
      center = [g.center[0] as number, g.center[1] as number];
    } else {
      let lng = 0;
      let lat = 0;
      let n = 0;
      for (const sid of stationIds) {
        const s = stationById.get(sid);
        if (!s) continue;
        lng += s.coords[0];
        lat += s.coords[1];
        n++;
      }
      if (n === 0) continue;
      center = [lng / n, lat / n];
    }

    const firstStation = stationById.get(stationIds[0]);
    const name =
      (typeof g.name === 'string' && g.name) ||
      (typeof g.stationGroupName === 'string' && g.stationGroupName) ||
      firstStation?.name ||
      id;

    groups.push({ id, name, center, stationIds });
  }

  return groups.length > 0 ? groups : buildStationGroups(stations);
}

function normalizeColor(c: string | undefined): string {
  if (!c) return '#888888';
  return c.startsWith('#') ? c : '#' + c;
}

function groupEdgeKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

/** Equirectangular meters projection centered at `lat0` (degrees). */
function projectFactory(lat0: number): (lng: number, lat: number) => [number, number] {
  const R = 6371e3;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  return (lng, lat) => [(R * lng * Math.PI * cosLat) / 180, (R * lat * Math.PI) / 180];
}

/** Ordered group visits along a route (stops + pass-throughs), de-duplicated. */
export function walkRouteVisits(
  route: Route,
  stNodeToGroup: Map<string, string>,
  trackToGroup: Map<string, string>,
): Visit[] {
  const visits: Visit[] = [];
  const push = (groupId: string | undefined, isStop: boolean) => {
    if (!groupId) return;
    const last = visits[visits.length - 1];
    if (last && last.groupId === groupId) {
      if (isStop) last.isStop = true;
      return;
    }
    visits.push({ groupId, isStop });
  };

  const combos = route.stCombos ?? [];
  if (combos.length > 0) {
    for (const combo of combos) {
      push(stNodeToGroup.get(combo.startStNodeId), true);
      for (const seg of combo.path ?? []) push(trackToGroup.get(seg.trackId), false);
      push(stNodeToGroup.get(combo.endStNodeId), true);
    }
    return visits;
  }
  for (const stNode of route.stNodes ?? []) push(stNodeToGroup.get(stNode.id), true);
  return visits;
}

export function buildTransitGraph(
  stations: Station[],
  routes: Route[],
  groups: StationGroup[],
): TransitGraph {
  if (groups.length === 0) {
    return { nodes: new Map(), edges: [], adj: new Map(), lineTraversals: new Map() };
  }

  const stationToGroup = new Map<string, string>();
  for (const g of groups) {
    for (const sid of g.stationIds) stationToGroup.set(sid, g.id);
  }

  const stNodeToGroup = new Map<string, string>();
  const trackToGroup = new Map<string, string>();
  for (const s of stations) {
    if (s.buildType !== 'constructed') continue;
    const gid = stationToGroup.get(s.id);
    if (!gid) continue;
    for (const n of s.stNodeIds) stNodeToGroup.set(n, gid);
    for (const t of s.trackIds) trackToGroup.set(t, gid);
  }

  const meanLat = groups.reduce((acc, g) => acc + g.center[1], 0) / groups.length;
  const project = projectFactory(meanLat);

  const nodes = new Map<string, GraphNode>();
  for (const g of groups) {
    const [lng, lat] = g.center;
    nodes.set(g.id, { id: g.id, label: g.name, pos: project(lng, lat), lngLat: [lng, lat] as Coordinate });
  }

  const edgeMap = new Map<string, GraphEdge>();
  let edgeN = 0;
  const lineTraversals = new Map<string, TraversalStep[]>();

  for (const route of routes) {
    if (route.tempParentId) continue;
    const visits = walkRouteVisits(route, stNodeToGroup, trackToGroup);
    const line: LineRef = { id: route.id, label: route.bullet || route.id, color: normalizeColor(route.color) };
    const traversal: TraversalStep[] = [];

    for (let i = 0; i < visits.length - 1; i++) {
      const a = visits[i];
      const b = visits[i + 1];
      if (a.groupId === b.groupId) continue;
      const key = groupEdgeKey(a.groupId, b.groupId);
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { id: 'e' + edgeN++, from: a.groupId, to: b.groupId, lines: [], stops: new Map() };
        edgeMap.set(key, edge);
      }
      if (!edge.lines.some((l) => l.id === line.id)) edge.lines.push(line);

      const forward = edge.from === a.groupId;
      const atFrom = forward ? a.isStop : b.isStop;
      const atTo = forward ? b.isStop : a.isStop;
      const existing = edge.stops.get(line.id);
      if (existing) {
        existing.atFrom = existing.atFrom || atFrom;
        existing.atTo = existing.atTo || atTo;
      } else {
        edge.stops.set(line.id, { atFrom, atTo });
      }
      traversal.push({ edgeId: edge.id, reversed: !forward });
    }

    if (traversal.length > 0) lineTraversals.set(line.id, traversal);
  }

  const edges = [...edgeMap.values()];
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.from)!.push(e.id);
    adj.get(e.to)!.push(e.id);
  }
  for (const [id, ids] of adj) {
    if (ids.length === 0) {
      nodes.delete(id);
      adj.delete(id);
    }
  }

  return { nodes, edges, adj, lineTraversals };
}
