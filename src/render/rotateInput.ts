// Rotate the schematic input into the GAME's map orientation. The game shows
// each city with a per-city default bearing (cities.d.ts ViewState.bearing —
// e.g. NYC is rotated so Manhattan runs vertically, the classic MTA trick);
// the mod previously rendered true-north-up regardless. Rotating the INPUT
// COORDINATES once, at assembly, is the only safe seam: every downstream
// mechanism (separable warp, per-axis unproject bisection, axis-aligned
// detail-crop rects) assumes the geo↔px mapping is axis-aligned, so a
// rotation inside the projection would break them all — whereas in a rotated
// coordinate frame they all hold verbatim.
//
// Geometry: bearing B means "compass direction B is screen-up" (MapLibre
// convention). The rotation runs in the local METRIC frame (east = Δlng·cosφ0,
// north = Δlat) so it is an isometry — angles and distances (transfer radii!)
// are preserved — then maps back to pseudo-lng/lat by dividing east by cosφ0.
// A compass-B street becomes exactly vertical, and stays vertical under the
// renderer's (historically cos-less) display stretch.
//
// Determinism: sin/cos of the bearing are quantized to 1e-9 (the same
// convention as transfers.ts) and applied with + − × ÷ only, so rotated
// coordinates — and therefore the layout fingerprint — are bit-identical
// across engines. The fingerprint picks the rotation up automatically through
// the rotated station/track coordinates; no schema field needed.

import type { Coordinate } from '../types/core';
import type { GeographyData, GeoPolyFeature } from '../geography/types';
import { clipRingToRect } from './cropSubgraph';

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
    const rotFeats = (feats: GeoPolyFeature[]): GeoPolyFeature[] =>
      feats.map((ft) =>
        ft.geometry.type === 'Polygon'
          ? { ...ft, geometry: { ...ft.geometry, coordinates: ft.geometry.coordinates.map((ring) => ring.map((c) => rot(c, f))) } }
          : ft,
      );
    // The rotated harvest region is a DIAMOND in the new frame; a square canvas
    // fitted to its extremes leaves data-void triangles at the corners that
    // render as land — mid-ocean. Crop to the LARGEST AXIS-ALIGNED RECTANGLE
    // inscribed in the rotated region (the standard rotated-image crop, computed
    // in the metric frame), so every rendered pixel is backed by data and the
    // ocean reaches the canvas edge again. Geography outside the rect is
    // clipped; the network is left untouched (it lives well inside the harvest
    // area — and clipping stations would change the layout, not just the frame).
    const [b0, b1, b2, b3] = geography.bbox;
    const W = (b2 - b0) * f.k; // metric spans of the ORIGINAL harvest rect
    const H = b3 - b1;
    const sinA = f.sinB < 0 ? -f.sinB : f.sinB;
    const cosA = f.cosB < 0 ? -f.cosB : f.cosB;
    let wr = W;
    let hr = H;
    if (sinA > 1e-9 && cosA > 1e-9) {
      // largest axis-aligned rectangle inside a W×H rect rotated by the bearing
      const shorter = W <= H ? W : H;
      const longer = W <= H ? H : W;
      const diff = sinA - cosA;
      if (shorter <= 2 * sinA * cosA * longer || (diff < 1e-9 && diff > -1e-9)) {
        const x = shorter / 2;
        wr = W >= H ? x / sinA : x / cosA;
        hr = W >= H ? x / cosA : x / sinA;
      } else {
        const cos2a = cosA * cosA - sinA * sinA;
        wr = (W * cosA - H * sinA) / cos2a;
        hr = (H * cosA - W * sinA) / cos2a;
      }
      if (wr > W) wr = W;
      if (hr > H) hr = H;
    }
    const rect: [number, number, number, number] = [
      f.cx - wr / 2 / f.k,
      f.cy - hr / 2,
      f.cx + wr / 2 / f.k,
      f.cy + hr / 2,
    ];
    const clipFeats = (feats: GeoPolyFeature[]): GeoPolyFeature[] => {
      const out: GeoPolyFeature[] = [];
      for (const ft of feats) {
        if (ft.geometry.type !== 'Polygon') continue;
        const src = ft.geometry.coordinates;
        if (src.length === 0) continue;
        const ext = clipRingToRect(src[0] as Coordinate[], rect[0], rect[1], rect[2], rect[3]);
        if (ext.length < 3) continue;
        const rings: Coordinate[][] = [ext];
        for (let i = 1; i < src.length; i++) {
          const hole = clipRingToRect(src[i] as Coordinate[], rect[0], rect[1], rect[2], rect[3]);
          if (hole.length >= 3) rings.push(hole);
        }
        out.push({ ...ft, geometry: { ...ft.geometry, coordinates: rings } });
      }
      return out;
    };
    geography = {
      bbox: rect,
      water: clipFeats(rotFeats(geography.water)),
      green: clipFeats(rotFeats(geography.green)),
    };
  }
  return { ...input, stations, tracks, routes, stationGroups, geography } as T;
}
