// Rotate the schematic input into the game's map orientation. The game shows
// each city with a per-city default bearing (cities.d.ts ViewState.bearing).
// Rotating the INPUT COORDINATES once, at assembly, is the only safe seam.
// Every downstream mechanism (separable warp, per-axis unproject bisection,
// axis-aligned detail-crop rects) assumes the geo↔px mapping is axis-aligned,
// so a rotation inside the projection would break them all, whereas in a
// rotated coordinate frame they all hold verbatim.
//
// Geometry: bearing B means "compass direction B is screen-up" (MapLibre
// convention). The rotation runs in the local METRIC frame (east = Δlng·cosφ0,
// north = Δlat) so it is an isometry. Angles and distances (transfer radii)
// are preserved, then it maps back to pseudo-lng/lat by dividing east by cosφ0.
// A compass-B street becomes exactly vertical, and stays vertical under the
// renderer's display stretch.
//
// Determinism: sin/cos of the bearing are quantized to 1e-9 and applied with
// + − × ÷ only, so rotated coordinates, and therefore the layout fingerprint,
// are bit-identical across engines. The fingerprint picks the rotation up
// automatically through the rotated station/track coordinates; no schema
// field needed.

import type { Coordinate } from '../types/core';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

interface RotFrame {
  cx: number;
  cy: number;
  k: number; // cos(center lat): metric east scale
  cosB: number;
  sinB: number;
}

const q9 = (v: number): number => Math.round(v * 1e9) / 1e9;

function frameFor(center: Coordinate, bearingDeg: number): RotFrame {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    cx: center[0],
    cy: center[1],
    k: q9(Math.cos((center[1] * Math.PI) / 180)),
    cosB: q9(Math.cos(rad)),
    sinB: q9(Math.sin(rad)),
  };
}

function rot(c: Coordinate, f: RotFrame): Coordinate {
  const e = (c[0] - f.cx) * f.k;
  const n = c[1] - f.cy;
  // screen-right and screen-up components when compass `bearing` points up
  const e2 = e * f.cosB - n * f.sinB;
  const n2 = e * f.sinB + n * f.cosB;
  return [f.cx + e2 / f.k, f.cy + n2];
}

/** Structural (shape-preserving) deep rotation of every coordinate the render
 *  pipeline consumes. Returns NEW objects; the game's live state is untouched. */
export function rotateSchematicInput<T extends {
  stations?: unknown[];
  tracks?: unknown[];
  routes?: unknown[];
  stationGroups?: unknown[];
  geography?: GeographyData;
}>(input: T, bearingDeg: number): T {
  if (!bearingDeg || !Number.isFinite(bearingDeg)) return input;
  // Stable rotation centre: the geography bbox midpoint when present (stamped,
  // deterministic), else the station coordinate bbox midpoint.
  let center: Coordinate | null = null;
  const gbb = input.geography?.bbox;
  if (gbb) center = [(gbb[0] + gbb[2]) / 2, (gbb[1] + gbb[3]) / 2];
  else {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const s of (input.stations ?? []) as { coords?: Coordinate }[]) {
      const c = s.coords;
      if (!c) continue;
      if (c[0] < mnX) mnX = c[0];
      if (c[0] > mxX) mxX = c[0];
      if (c[1] < mnY) mnY = c[1];
      if (c[1] > mxY) mxY = c[1];
    }
    if (mnX <= mxX) center = [(mnX + mxX) / 2, (mnY + mxY) / 2];
  }
  if (!center) return input;
  const f = frameFor(center, bearingDeg);

  const stations = (input.stations as { coords?: Coordinate }[] | undefined)?.map((s) =>
    s && s.coords ? { ...s, coords: rot(s.coords, f) } : s,
  );
  const tracks = (input.tracks as { coords?: Coordinate[] }[] | undefined)?.map((t) =>
    t && Array.isArray(t.coords) ? { ...t, coords: t.coords.map((c) => rot(c, f)) } : t,
  );
  const routes = (input.routes as { stNodes?: { center?: Coordinate }[]; stations?: { coords?: Coordinate }[] }[] | undefined)?.map(
    (r) => {
      if (!r) return r;
      const out = { ...r };
      if (Array.isArray(r.stNodes)) out.stNodes = r.stNodes.map((sn) => (sn && sn.center ? { ...sn, center: rot(sn.center, f) } : sn));
      if (Array.isArray(r.stations)) out.stations = r.stations.map((s) => (s && s.coords ? { ...s, coords: rot(s.coords, f) } : s));
      return out;
    },
  );
  const stationGroups = (input.stationGroups as { center?: Coordinate; stations?: { coords?: Coordinate }[] }[] | undefined)?.map(
    (g) => {
      if (!g) return g;
      const out = { ...g };
      if (Array.isArray(g.center) && g.center.length >= 2) out.center = rot(g.center as Coordinate, f);
      if (Array.isArray(g.stations)) out.stations = g.stations.map((s) => (s && s.coords ? { ...s, coords: rot(s.coords, f) } : s));
      return out;
    },
  );
  let geography: GeographyData | undefined = input.geography;
  if (geography) {
    // Track the tight AABB of the ROTATED polygon vertices while rotating.
    // Rotating the old bbox's corners instead would inflate the stamped frame
    // with empty diamond corners and loosen every fit that reads it.
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    const rotFeats = (feats: GeoPolyFeature[]): GeoPolyFeature[] =>
      feats.map((ft) => {
        if (ft.geometry.type !== 'Polygon') return ft;
        const coordinates = ft.geometry.coordinates.map((ring) =>
          ring.map((c) => {
            const p = rot(c, f);
            if (p[0] < mnX) mnX = p[0];
            if (p[0] > mxX) mxX = p[0];
            if (p[1] < mnY) mnY = p[1];
            if (p[1] > mxY) mxY = p[1];
            return p;
          }),
        );
        return { ...ft, geometry: { ...ft.geometry, coordinates } };
      });
    const water = rotFeats(geography.water);
    const green = rotFeats(geography.green);
    const places = geography.places?.map((pl) => ({ ...pl, coord: rot(pl.coord, f) }));
    // The rotated harvest rect is a DIAMOND in the new frame; the square canvas
    // fitted to its extremes has data-void triangles at the corners. NOTHING is
    // cropped, since cropping would cut real network and backdrop. Instead the
    // region outline is stamped as `hull`, and the renderer draws LAND only
    // inside it, so the void paints as background, never as fake land mid-ocean.
    const [b0, b1, b2, b3] = geography.bbox;
    const hull: Coordinate[] = [rot([b0, b1], f), rot([b2, b1], f), rot([b2, b3], f), rot([b0, b3], f)];
    let bbox: [number, number, number, number];
    if (mnX < mxX && mnY < mxY) bbox = [mnX, mnY, mxX, mxY];
    else {
      bbox = [
        Math.min(hull[0][0], hull[1][0], hull[2][0], hull[3][0]),
        Math.min(hull[0][1], hull[1][1], hull[2][1], hull[3][1]),
        Math.max(hull[0][0], hull[1][0], hull[2][0], hull[3][0]),
        Math.max(hull[0][1], hull[1][1], hull[2][1], hull[3][1]),
      ];
    }
    geography = { bbox, water, green, hull, ...(places ? { places } : {}) };
  }
  return { ...input, stations, tracks, routes, stationGroups, geography } as T;
}
