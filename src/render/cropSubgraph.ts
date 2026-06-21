// Sub-graph crop for the magnifier inset. Given a CORE set of input station ids
// (the stations inside the user's drawn box), build a self-contained network of
// just that cluster plus one combo-hop of neighbours, so re-simulating it in a
// full canvas gives the dense cluster room to spread (its mega-boxes resolve).
//
// Filtering is at the stNode/stCombo level — the real route↔station linkage:
// a route's path is a sequence of stCombos (startStNodeId -> endStNodeId), and a
// station owns stNodeIds. (route.stations is empty in game dumps.)
//
// Geography is kept but CLIPPED to the cluster's geographic extent (not dropped,
// not the whole city): re-simulating projects the backdrop through the same
// density-warped projection as the network, so the cropped water/parks deform
// with — and stay aligned to — the spread-out cluster. Clipping keeps the layout
// bounds + warp re-fit tight on the region instead of the whole city.

import type { SchematicInput } from './schematic';
import type { Coordinate, BoundingBox } from '../types/core';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

type StationLike = {
  id: string;
  stNodeIds?: string[];
  trackIds?: string[];
  coords?: Coordinate;
};
type RouteLike = {
  stNodes?: { id: string }[];
  stCombos?: { startStNodeId: string; endStNodeId: string }[];
};
type GroupLike = { stationIds?: string[]; stations?: unknown[] };

/** Sutherland-Hodgman clip of one polygon ring against an axis-aligned rect
 *  (in geographic lng/lat space). Returns the clipped vertex list (open, no
 *  repeated closing point); empty when the ring lies wholly outside. */
function clipRingToRect(ring: Coordinate[], minX: number, minY: number, maxX: number, maxY: number): Coordinate[] {
  const edges: { inside: (p: Coordinate) => boolean; isect: (a: Coordinate, b: Coordinate) => Coordinate }[] = [
    { inside: (p) => p[0] >= minX, isect: (a, b) => { const t = (minX - a[0]) / (b[0] - a[0]); return [minX, a[1] + t * (b[1] - a[1])]; } },
    { inside: (p) => p[0] <= maxX, isect: (a, b) => { const t = (maxX - a[0]) / (b[0] - a[0]); return [maxX, a[1] + t * (b[1] - a[1])]; } },
    { inside: (p) => p[1] >= minY, isect: (a, b) => { const t = (minY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minY]; } },
    { inside: (p) => p[1] <= maxY, isect: (a, b) => { const t = (maxY - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxY]; } },
  ];
  let out = ring;
  for (const e of edges) {
    if (out.length === 0) break;
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      const curIn = e.inside(cur);
      const prevIn = e.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(e.isect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(e.isect(prev, cur));
      }
    }
  }
  return out;
}

/** Clip every water/green polygon to `bbox` and stamp the cropped bbox, so the
 *  backdrop — and the layout's framing — cover only the cluster's region. */
function clipGeographyToBox(geo: GeographyData, bbox: BoundingBox): GeographyData {
  const [minX, minY, maxX, maxY] = bbox;
  const clipFeats = (feats: GeoPolyFeature[]): GeoPolyFeature[] => {
    const out: GeoPolyFeature[] = [];
    for (const f of feats) {
      if (f.geometry.type !== 'Polygon') continue;
      const src = f.geometry.coordinates;
      if (src.length === 0) continue;
      const ext = clipRingToRect(src[0], minX, minY, maxX, maxY);
      if (ext.length < 3) continue; // exterior ring gone → polygon is outside the box
      const rings: Coordinate[][] = [ext];
      for (let i = 1; i < src.length; i++) {
        const hole = clipRingToRect(src[i], minX, minY, maxX, maxY);
        if (hole.length >= 3) rings.push(hole);
      }
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings } });
    }
    return out;
  };
  return { bbox, water: clipFeats(geo.water), green: clipFeats(geo.green) };
}

export function cropSubgraph(input: SchematicInput, coreStationIds: Set<string>): SchematicInput {
  const routes = input.routes as unknown as RouteLike[];
  const tracks = input.tracks as unknown as { id: string }[];
  const stations = input.stations as unknown as StationLike[];

  // core stNodes = the core stations' stNodeIds
  const coreStNodes = new Set<string>();
  for (const s of stations) if (coreStationIds.has(s.id)) for (const sn of s.stNodeIds ?? []) coreStNodes.add(sn);

  // one combo-hop ring so cropped lines head OUT toward their next stop
  const keptStNodes = new Set<string>(coreStNodes);
  for (const r of routes)
    for (const c of r.stCombos ?? []) {
      if (coreStNodes.has(c.startStNodeId) && !coreStNodes.has(c.endStNodeId)) keptStNodes.add(c.endStNodeId);
      if (coreStNodes.has(c.endStNodeId) && !coreStNodes.has(c.startStNodeId)) keptStNodes.add(c.startStNodeId);
    }

  const fStations = stations.filter((s) => (s.stNodeIds ?? []).some((sn) => keptStNodes.has(sn)));
  const fRoutes = routes
    .map((r) => ({
      ...r,
      stNodes: (r.stNodes ?? []).filter((sn) => keptStNodes.has(sn.id)),
      stCombos: (r.stCombos ?? []).filter((c) => keptStNodes.has(c.startStNodeId) && keptStNodes.has(c.endStNodeId)),
    }))
    .filter((r) => (r.stCombos?.length ?? 0) >= 1);
  const keptTracks = new Set<string>();
  for (const s of fStations) for (const t of s.trackIds ?? []) keptTracks.add(t);
  const fTracks = tracks.filter((t) => keptTracks.has(t.id));

  const keptIds = new Set(fStations.map((s) => s.id));
  const fGroups = (input.stationGroups as GroupLike[] | undefined)?.filter((g) =>
    (g.stationIds ?? (g.stations as { id?: string }[] | undefined)?.map((x) => x?.id) ?? []).some(
      (sid) => typeof sid === 'string' && keptIds.has(sid),
    ),
  );

  // Crop the geography backdrop to EXACTLY the selected region: the bbox of the
  // CORE stations (the ones inside the user's box), with no margin. The one-hop
  // ring stations sit outside this box, so the cropped geography ends at the
  // selection edge and the lines heading out to those neighbours visibly leave
  // it. Projected through the re-sim's warped projection, the backdrop deforms
  // with and stays aligned to the spread-out cluster.
  let croppedGeo: GeographyData | undefined;
  const geo = input.geography;
  if (geo) {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const s of stations) {
      if (!coreStationIds.has(s.id)) continue;
      const c = s.coords;
      if (!c) continue;
      if (c[0] < mnX) mnX = c[0];
      if (c[0] > mxX) mxX = c[0];
      if (c[1] < mnY) mnY = c[1];
      if (c[1] > mxY) mxY = c[1];
    }
    if (mnX < mxX && mnY < mxY) croppedGeo = clipGeographyToBox(geo, [mnX, mnY, mxX, mxY]);
  }

  return {
    ...input,
    routes: fRoutes as never,
    tracks: fTracks as never,
    stations: fStations as never,
    stationGroups: fGroups as never,
    geography: croppedGeo, // cluster-region backdrop (undefined if no geography)
  };
}
