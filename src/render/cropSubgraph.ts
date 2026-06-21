// Sub-graph crop for the magnifier inset. Given a CORE set of input station ids
// (the stations inside the user's drawn box), build a self-contained network of
// just that cluster plus one combo-hop of neighbours, so re-simulating it in a
// full canvas gives the dense cluster room to spread (its mega-boxes resolve).
//
// Filtering is at the stNode/stCombo level — the real route↔station linkage:
// a route's path is a sequence of stCombos (startStNodeId -> endStNodeId), and a
// station owns stNodeIds. (route.stations is empty in game dumps.) Geography is
// dropped so the render frames on the network extent, not the whole city.

import type { SchematicInput } from './schematic';

type StationLike = {
  id: string;
  stNodeIds?: string[];
  trackIds?: string[];
};
type RouteLike = {
  stNodes?: { id: string }[];
  stCombos?: { startStNodeId: string; endStNodeId: string }[];
};
type GroupLike = { stationIds?: string[]; stations?: unknown[] };

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

  return {
    ...input,
    routes: fRoutes as never,
    tracks: fTracks as never,
    stations: fStations as never,
    stationGroups: fGroups as never,
    geography: undefined, // frame on the cluster, not the whole city
  };
}
