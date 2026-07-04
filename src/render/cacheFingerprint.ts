// Cheap, stable digest of the inputs that determine the octi layout — i.e. the
// would-be cache key for the deferred Plan B precompute cache (docs/cache-plan-B.md).
//
// Right now it has ONE use: a temporary `[fp]` diagnostic logged in the Generate
// path, so we can confirm the game emits identical ids/coords for an unchanged
// network across a save→reload (Plan B §0 — the prerequisite that decides whether
// a localStorage cache can ever hit). It returns per-component sub-hashes too, so
// if the fp differs across a reload you can see WHICH input moved (ids vs coords
// vs groups vs geography).
//
// It must mirror exactly what graph.ts / precomputeSmoothed consume (Plan B §2).

import type { Route, Track, Station } from '../types/game-state';
import type { GeographyData } from '../geography/types';
import { getOrBuildStationGroups } from './layout/graph';

const SCHEMA = 19; // bump to bust all fingerprints when the renderer's inputs change
// v2: same-bullet+colour routes (e.g. loop directions) now collapse to one line in
// buildTransitGraph — a layout change with unchanged raw inputs, so bust caches.
// v3: partner-block orientation propagation in untangle.ts changes line order on
// partner blocks (fixes the sub-area lane-braid) — a layout change, unchanged raw
// inputs; bust so main caches AND detail-inset sub-pres (both fp-keyed) re-sim.
// v4: renderOctilinear join-pass big-gap cutoff raised (OCTI_GAP_MULT) so an
// out-and-back line keeps a contiguous lane across a slot jump (B at Montgomery).
// v5: octilinear turn handling at slot-change turns — TURN-MITER (regressive
// corners, F at Ferry) pins both lane-ends to their octilinear meet corner, and
// the forward-corner DOGLEG (B at Montgomery, H/E single-corner turns) inserts a
// 45° octilinear leg — replacing the spike/loop dart. Renderer-side layout change,
// unchanged raw inputs; bust main caches + detail-inset sub-pres.
// v6: renderOctilinear node-connector big-jog cutoff raised from a fixed spacing*8
// (44px) to the incident bundle span, so a line that crosses a wide bundle at a
// dense hub (its lane slot jumping many slots — Broadway×Lex at 14 St-Union Sq:
// 45-71px) is bridged instead of left as a visible break. Reconnects NYC-difficult
// Q/R/N/W/1/4/5/6. Renderer-side draw change, unchanged raw inputs; bust so cached
// maps + detail-inset sub-pres re-sim with the contiguous geometry.
// v7: demand-driven box warp — boxes from density ∪ predicted-contraction
// clusters, per-box expansion sized to clear the octi contraction threshold,
// canvas grows (boxGrowth = max growth) instead of clawing expansion back.
// boxExpand/boxGrowth keep their option names but change semantics
// (multiplier / max-growth), so cached layouts keyed on the old meanings must
// re-sim. Layout change, unchanged raw inputs; bust main + detail-inset caches.
// v8: capsule-demand oracle (third warp-box source: interchange pairs closer
// than their combined marker-row needs; nesting-aware box merge; per-kind
// secant targets) + capsule overlap enforcement on by default (seat-time
// hull check with hull-masked retry, move-commit hull guard). Layout AND
// placement change, unchanged raw inputs; bust main + detail-inset caches.
// v9: node-connector tangents clamped to the lane band (bundle-join spike)
// and zero-progress synthetic hooks spliced to octilinear shortcuts after
// supportToLayout (LON pink-triangle). Both change drawn geometry/layouts,
// unchanged raw inputs; bust main + detail-inset caches.
// v10: jog-sliver suppression is sibling-aware — a short jogging lane piece
// is deleted only when NO co-drawn line on the same edge keeps its piece
// (deleting one lane of an interlined pair cut the line in half, flipped the
// neighbour capsule's grouping axis, and cascaded into a megabox — LON
// Coombe Gardens; also fixes the Audric Close 2.4px drawn gap). Draw change,
// unchanged raw inputs; bust main + detail-inset caches.
// v11: two renderOctilinear draw fixes. (a) Corridor-aware dogleg clamp — the
// forward-turn dogleg's bend corner B2 may no longer overshoot the outbound
// edge's FAR node along the outbound axis (declines to the S connector when it
// would), killing the out-and-back self-loop where a short micro-edge was
// forced against its corridor direction (SEA route X at Pacific Av). (b)
// Shared-anchor trim guard — a terminating lane whose (lineId, flagNode) end is
// also anchored by another split station's mark is never trimmed back to one
// station's slid marker, so the foreign marker stays on ink (SEA Burke Court,
// 12px→0px). Both change drawn geometry, unchanged raw inputs; bust main +
// detail-inset caches.
// v12: direction-intelligent box warp — each warp box's scalar expansion is
// split per axis along its crowd anisotropy (nearest-neighbour displacements:
// Manhattan's parallel vertical trunks now take their room horizontally).
// Layout change, unchanged raw inputs; bust main + detail-inset caches.
// v13: through-station split (structural dogleg fix) — a bundle that merely
// passes a station node shared with line-disjoint corridors gets its own
// coincident support node before octi (stop flags re-homed), so the router
// never doglegs it into the shared node; the capsule placer joins the split
// node back to the station. Layout change, unchanged raw inputs; bust main +
// detail-inset caches.
// v14: cross gate in the topo merge — a walk sample may only collapse onto a
// support node when some corridor through that node runs within 60° of the
// walk's travel direction, so TRANSVERSAL corridors cross at a point instead
// of zipping into a shared hairball segment (Times Sq: the 7 riding the
// 1/2/3+N/Q/R/W trunk edge and welding every midtown trunk into one blob
// node). Support-graph topology change, unchanged raw inputs; bust main +
// detail-inset caches.
// v15: bundle cap in the topo merge — corridors may weld only while the
// combined edge stays within 8 lines (containment welds, i.e. one line set a
// subset of the other, are exempt so merged corridors keep re-welding across
// rounds). Stops unrelated services aggregating into hairball mega-bundles.
// Support-graph topology change, unchanged raw inputs; bust main +
// detail-inset caches.
// v16: multi-through station split — through components at a station node are
// grouped by a rotation-system crossing test (seam-bearing interleave); only
// genuinely CROSSING corridors keep the shared node, while co-passing
// parallel corridors (7th Av vs 8th Av trunks warped into Times Sq) pull
// apart onto coincident copies, killing the artificial trunk-swap crossing.
// Support-graph topology change, unchanged raw inputs; bust main +
// detail-inset caches.
// v17: per-station graph nodes — multi-member station groups enter the pipeline
// at each platform's real coordinates (not one group-center point); the group
// survives as capsule/label metadata via stopNodes. Transit-graph topology
// change, unchanged raw inputs; bust main + detail-inset caches.
// v18: drop post-merge stationSplit, cross gate, and bundle cap — hub
// separation is handled only at data pickup (per-station nodes) plus the
// capsule placer's stopNodes join. Support-graph merge reverts to classic
// LOOM collapse; bust main + detail-inset caches.

/** djb2 → 8 hex chars. Cheap and cross-engine stable. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}
const r5 = (n: number): number => Math.round(n * 1e5) / 1e5; // ~1 m coord rounding
const byId = <T extends { id: string }>(a: ReadonlyArray<T>): T[] =>
  [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

export interface FingerprintInput {
  routes: Route[];
  tracks: Track[];
  stations: Station[];
  stationGroups?: unknown[];
  geography?: GeographyData;
  options?: {
    padding?: number;
    warpAlpha?: number;
    geographicAffinity?: number;
    boxExpand?: number;
    boxGrowth?: number;
    boxFrac?: number;
    dark?: boolean;
    theme?: { lineWidth?: number };
  };
}

export interface Fingerprint {
  fp: string;
  parts: { stations: string; routes: string; tracks: string; groups: string; options: string; geo: string };
}

/** Compute the layout fingerprint + per-component sub-hashes. Pure. */
export function fingerprintInputs(input: FingerprintInput): Fingerprint {
  // Stations (constructed only — graph.ts filters buildType==='constructed').
  const stationsStr = byId(input.stations.filter((s) => (s.buildType ?? 'constructed') === 'constructed'))
    .map((s) =>
      [
        s.id,
        r5(s.coords[0]) + ',' + r5(s.coords[1]),
        s.trackGroupId ?? '',
        s.buildType ?? '',
        [...(s.stNodeIds ?? [])].sort().join(','),
        [...(s.trackIds ?? [])].sort().join(','),
        s.name ?? '',
      ].join('|'),
    )
    .join(';');

  // Routes (skip tempParentId, as graph.ts does). Combos drive edge existence
  // (incl. distance, which feeds positioning-leg suppression).
  const routesStr = byId(input.routes.filter((r) => !r.tempParentId))
    .map((r) => {
      const combos = (r.stCombos ?? [])
        .map(
          (c) =>
            c.startStNodeId +
            '>' +
            c.endStNodeId +
            '@' +
            (c.distance ?? 0) +
            ':' +
            (c.path ?? []).map((p) => p.trackId + (p.reversed ? 'r' : 'f')).join(','),
        )
        .join('/');
      const stNodes = (r.stNodes ?? []).map((n) => n.id).join(',');
      return [r.id, String(r.bullet ?? ''), r.color ?? '', combos, stNodes].join('|');
    })
    .join(';');

  // Tracks: id + point count + endpoints + a hash of the rounded polyline.
  const tracksStr = byId(input.tracks)
    .map((t) => {
      const c = t.coords ?? [];
      const coordHash = hash(c.map((p) => r5(p[0]) + ',' + r5(p[1])).join(' '));
      const first = c[0] ? r5(c[0][0]) + ',' + r5(c[0][1]) : '';
      const last = c.length ? r5(c[c.length - 1][0]) + ',' + r5(c[c.length - 1][1]) : '';
      return [t.id, c.length, first, last, coordHash].join('|');
    })
    .join(';');

  // Resolved station groups (the merge that defines nodes), as graph.ts sees them.
  const groups = getOrBuildStationGroups(input.stations, input.stationGroups ?? null);
  const groupsStr = byId(groups)
    .map((g) => g.id + '|' + [...g.stationIds].sort().join(','))
    .join(';');

  // Layout options that bake into `pre` (NOT showLabels/showStations/labelScale/
  // stationRadius — those are draw-time and applied fresh on restore).
  const o = input.options ?? {};
  const optionsStr = [
    o.padding ?? '',
    o.warpAlpha ?? '',
    o.geographicAffinity ?? '',
    o.boxExpand ?? '',
    o.boxGrowth ?? '',
    o.boxFrac ?? '',
    o.dark ? 'd' : 'l',
    o.theme?.lineWidth ?? '',
  ].join('|');

  // Geography token — presence + coarse content (NOT bbox, which drifts).
  const g = input.geography;
  const geoStr = g ? 'geo:' + (g.water?.length ?? 0) + ':' + (g.green?.length ?? 0) : 'nogeo';

  const parts = {
    stations: hash(stationsStr),
    routes: hash(routesStr),
    tracks: hash(tracksStr),
    groups: hash(groupsStr),
    options: hash(optionsStr),
    geo: hash(geoStr),
  };
  const fp =
    'v' + SCHEMA + '-' + hash([SCHEMA, parts.stations, parts.routes, parts.tracks, parts.groups, parts.options, parts.geo].join('|'));
  return { fp, parts };
}
