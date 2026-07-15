// Route-set filter: drop a set of routes from the network and cascade the removal to
// every stNode / station / track / group that no surviving route still references,
// leaving a self-contained network. A box-free cousin of cropSubgraph: the linkage is
// the same (a route owns stNodes; a station owns stNodeIds and trackIds; a group owns
// stationIds), keyed by route id instead of a spatial box.
//
// When nothing is disabled the input is returned unchanged (same array references), so
// a map with no hidden routes renders byte-identically to one built without this pass.

type RouteLike = { id: string; stNodes?: { id: string }[] };
type StationLike = { id: string; stNodeIds?: string[]; trackIds?: string[] };
type TrackLike = { id: string };
type GroupLike = { stationIds?: string[]; stations?: { id?: string }[] };

export function filterRoutesByEnabled<
  R extends RouteLike,
  T extends TrackLike,
  S extends StationLike,
  G extends GroupLike,
>(
  net: { routes: R[]; tracks: T[]; stations: S[]; stationGroups?: G[] },
  disabledIds: readonly string[],
): { routes: R[]; tracks: T[]; stations: S[]; stationGroups?: G[] } {
  if (disabledIds.length === 0) return net;
  const disabled = new Set(disabledIds);

  const routes = net.routes.filter((r) => !disabled.has(r.id));
  const keptStNodes = new Set<string>();
  for (const r of routes) for (const sn of r.stNodes ?? []) keptStNodes.add(sn.id);

  const stations = net.stations.filter((s) => (s.stNodeIds ?? []).some((id) => keptStNodes.has(id)));
  const keptTracks = new Set<string>();
  for (const s of stations) for (const t of s.trackIds ?? []) keptTracks.add(t);
  const tracks = net.tracks.filter((t) => keptTracks.has(t.id));

  const keptStations = new Set(stations.map((s) => s.id));
  const stationGroups = net.stationGroups?.filter((g) =>
    (g.stationIds ?? g.stations?.map((x) => x?.id) ?? []).some((id) => typeof id === 'string' && keptStations.has(id)),
  );

  return { routes, tracks, stations, stationGroups };
}
