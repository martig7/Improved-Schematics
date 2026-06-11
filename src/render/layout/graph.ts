// Build a transit graph (station-group nodes + edges + line traversals) from the
// modding API's routes/tracks/stations. Ported from the game
// (dev/reference/buildTransitGraph.js, walkRouteVisits.js, normalizeColor.js,
// edgeKey_1.js, projectFactory.js); buildStationGroups is new glue that derives
// the game's interchange groups from Station.trackGroupId.

import type { Station, Route, Track } from '../../types/game-state';
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

/** Coerce API stationGroups (array, Map, or id→group record) into a list. */
export function normalizeApiStationGroups(raw: unknown): unknown[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (raw instanceof Map) return [...raw.values()];
  if (typeof raw === 'object') {
    const vals = Object.values(raw as Record<string, unknown>);
    if (vals.length > 0 && vals.every((v) => v && typeof v === 'object')) return vals;
  }
  return null;
}

/** Read station groups from live gameState (getStationGroups() or state field). */
export function resolveStationGroupsFromGameState(gameState: unknown): unknown[] | undefined {
  if (!gameState || typeof gameState !== 'object') return undefined;
  const gs = gameState as Record<string, unknown>;
  if (typeof gs.getStationGroups === 'function') {
    const list = normalizeApiStationGroups((gs.getStationGroups as () => unknown).call(gameState));
    if (list?.length) return list;
  }
  return normalizeApiStationGroups(gs.stationGroups) ?? undefined;
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
  const normalized = apiGroups ? normalizeApiStationGroups(apiGroups) : null;
  if (!normalized || normalized.length === 0) {
    return buildStationGroups(stations);
  }

  const stationById = new Map<string, Station>();
  for (const s of stations) stationById.set(s.id, s);

  const groups: StationGroup[] = [];
  for (const raw of normalized) {
    if (!raw || typeof raw !== 'object') continue;
    const g = raw as Record<string, unknown>;
    const id = typeof g.id === 'string' ? g.id : undefined;
    const stationIds: string[] = Array.isArray(g.stationIds)
      ? (g.stationIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : Array.isArray(g.stations)
        ? (g.stations as unknown[])
            .map((s) => (typeof s === 'string' ? s : (s as Record<string, unknown>)?.id))
            .filter((x): x is string => typeof x === 'string')
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

/** Maps from the game's stNodes/tracks to merged station-group ids. */
export function buildGroupMaps(
  stations: Station[],
  groups: StationGroup[],
): {
  stationToGroup: Map<string, string>;
  stNodeToGroup: Map<string, string>;
  trackToGroup: Map<string, string>;
} {
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
  return { stationToGroup, stNodeToGroup, trackToGroup };
}

/** Station ids touched by at least one real route's stop nodes. Stations
 *  with no service must not count toward a group's member tally (a phantom
 *  routeless platform otherwise turns its group into an "interchange" and
 *  draws a capsule — Emerson St). Mirrors buildGroupMaps' constructed-only
 *  filter. */
export function servedStationIds(stations: Station[], routes: Route[]): Set<string> {
  const stNodeToStation = new Map<string, string>();
  for (const s of stations) {
    if (s.buildType !== 'constructed') continue;
    for (const n of s.stNodeIds) stNodeToStation.set(n, s.id);
  }
  const served = new Set<string>();
  const touch = (stNodeId?: string) => {
    if (!stNodeId) return;
    const sid = stNodeToStation.get(stNodeId);
    if (sid) served.add(sid);
  };
  for (const r of routes) {
    if (r.tempParentId) continue;
    for (const combo of r.stCombos ?? []) {
      touch(combo.startStNodeId);
      touch(combo.endStNodeId);
    }
    for (const sn of r.stNodes ?? []) touch(sn.id);
  }
  return served;
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

export function appendTrackCoords(points: Coordinate[], track: Track, reversed: boolean): void {
  const coords = reversed ? [...track.coords].reverse() : track.coords;
  for (const c of coords) {
    const last = points[points.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    points.push(c);
  }
}

const CORRIDOR_TOL = 1e-5; // ~1 m in degrees

function distDeg(a: Coordinate, b: Coordinate): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function trackEndpoints(track: Track, reversed: boolean): [Coordinate, Coordinate] {
  const c = track.coords;
  if (c.length < 2) return [c[0], c[0]];
  return reversed ? [c[c.length - 1], c[0]] : [c[0], c[c.length - 1]];
}

/** Corridor tracks (not owned by any station) are skipped in walkRouteVisits.
 *  When building geometry, skip parallel forward/back duplicates that share the
 *  same corridor endpoints; still chain end-to-end mainline segments. */
function sharesCorridorEndpoints(
  pending: Coordinate[],
  track: Track,
  reversed: boolean,
  tol: number,
): boolean {
  if (pending.length < 2) return false;
  const [start, end] = trackEndpoints(track, reversed);
  const p0 = pending[0];
  const p1 = pending[pending.length - 1];
  const near = (a: Coordinate, b: Coordinate) => distDeg(a, b) <= tol;
  return (near(start, p0) && near(end, p1)) || (near(start, p1) && near(end, p0));
}

function shouldAppendCorridorSegment(pending: Coordinate[], track: Track, reversed: boolean): boolean {
  if (pending.length < 2) return true;
  const [start, end] = trackEndpoints(track, reversed);
  const last = pending[pending.length - 1];
  const first = pending[0];
  if (sharesCorridorEndpoints(pending, track, reversed, 2e-4)) return false;
  if (distDeg(last, start) <= CORRIDOR_TOL) {
    // Tip-chaining, but reject the return leg of a forward/back pair (B→A after A→B).
    if (distDeg(end, first) <= 2e-4) return false;
    return true;
  }
  return true;
}

/** Append stCombo path coords using the same group/corridor rules as walkRouteGeometry.
 *  Pass `prevSegGroup` across consecutive combos on one route so platform tracks at
 *  combo boundaries are not re-drawn. */
export function appendComboPathGeometry(
  pending: Coordinate[],
  path: { trackId: string; reversed: boolean }[],
  trackMap: Map<string, Track>,
  trackToGroup: Map<string, string>,
  prevSegGroup?: { value: string | undefined },
): void {
  let prev = prevSegGroup?.value;
  for (const seg of path) {
    const track = trackMap.get(seg.trackId);
    if (!track) continue;
    const g = trackToGroup.get(seg.trackId);
    if (g) {
      if (g !== prev) appendTrackCoords(pending, track, seg.reversed);
      prev = g;
    } else if (shouldAppendCorridorSegment(pending, track, seg.reversed)) {
      appendTrackCoords(pending, track, seg.reversed);
    }
  }
  if (prevSegGroup) prevSegGroup.value = prev;
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

/** Collapse to stop visits only — matches how geographic mode connects stations. */
export function stopOnlyVisits(visits: Visit[]): Visit[] {
  const out: Visit[] = [];
  for (const v of visits) {
    if (!v.isStop) continue;
    const last = out[out.length - 1];
    if (last && last.groupId === v.groupId) continue;
    out.push({ groupId: v.groupId, isStop: true });
  }
  return out;
}

interface GroupTransition {
  from: string;
  to: string;
  coords: Coordinate[];
}

/** One combo → corridor polyline between its endpoint station groups. */
function comboCorridorGeometry(
  combo: NonNullable<Route['stCombos']>[number],
  trackMap: Map<string, Track>,
  trackToGroup: Map<string, string>,
  stNodeToGroup: Map<string, string>,
): GroupTransition | null {
  const from = stNodeToGroup.get(combo.startStNodeId);
  const to = stNodeToGroup.get(combo.endStNodeId);
  if (!from || !to || from === to) return null;
  const coords: Coordinate[] = [];
  appendComboPathGeometry(coords, combo.path ?? [], trackMap, trackToGroup);
  return coords.length >= 2 ? { from, to, coords } : null;
}

export function buildTransitGraph(
  stations: Station[],
  routes: Route[],
  groups: StationGroup[],
  tracks?: Track[],
): TransitGraph {
  if (groups.length === 0) {
    return { nodes: new Map(), edges: [], adj: new Map(), lineTraversals: new Map() };
  }

  const { stNodeToGroup, trackToGroup } = buildGroupMaps(stations, groups);

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

  if (tracks && tracks.length > 0) {
    const trackMap = new Map<string, Track>();
    for (const t of tracks) trackMap.set(t.id, t);
    const geomByDir = new Map<string, Coordinate[]>();
    for (const route of routes) {
      if (route.tempParentId) continue;
      for (const combo of route.stCombos ?? []) {
        const tr = comboCorridorGeometry(combo, trackMap, trackToGroup, stNodeToGroup);
        if (!tr) continue;
        const key = tr.from + '>' + tr.to;
        if (!geomByDir.has(key)) geomByDir.set(key, tr.coords);
      }
    }
    for (const e of edges) {
      const fwd = geomByDir.get(e.from + '>' + e.to);
      if (fwd) {
        e.geo = fwd;
        continue;
      }
      const rev = geomByDir.get(e.to + '>' + e.from);
      if (rev) e.geo = [...rev].reverse();
    }
  }

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
