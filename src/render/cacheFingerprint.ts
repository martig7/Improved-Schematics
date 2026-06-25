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

const SCHEMA = 1; // bump to bust all fingerprints when the renderer's inputs change

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
