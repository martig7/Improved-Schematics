// Sub-graph crop for the magnifier inset. Given a CORE set of input station ids
// (the stations inside the user's drawn box), build a self-contained network of
// just that cluster plus one combo-hop of neighbours, so re-simulating it in a
// full canvas gives the dense cluster room to spread (its mega-boxes resolve).
//
// Filtering is at the stNode/stCombo level, the real route↔station linkage:
// a route's path is a sequence of stCombos (startStNodeId -> endStNodeId), and a
// station owns stNodeIds. (route.stations is empty in game dumps.)
//
// Geography is kept but CLIPPED to the cluster's geographic extent (not dropped,
// not the whole city): re-simulating projects the backdrop through the same
// density-warped projection as the network, so the cropped water/parks deform
// with the spread-out cluster and stay aligned to it. Clipping keeps the layout
// bounds and warp re-fit tight on the region instead of the whole city.

import type { SchematicInput } from './schematic';
import type { Coordinate, BoundingBox } from '../types/core';
import type { GeographyData, GeoPolyFeature } from '../geography/types';

type StationLike = {
  id: string;
  stNodeIds?: string[];
  trackIds?: string[];
  coords?: Coordinate;
  name?: string;
  buildType?: string;
};
type PathSeg = { trackId: string; reversed?: boolean; length?: number; signals?: unknown[] };
type ComboLike = { startStNodeId: string; endStNodeId: string; path?: PathSeg[]; distance?: number };
type StNodeLike = { id: string; center?: Coordinate; trackIds?: string[]; buildType?: string };
type RouteLike = {
  stNodes?: StNodeLike[];
  stCombos?: ComboLike[];
};
type TrackLike = { id: string; coords?: Coordinate[]; buildType?: string };
type GroupLike = { stationIds?: string[]; stations?: unknown[] };

/** Sutherland-Hodgman clip of one polygon ring against an axis-aligned rect
 *  (in geographic lng/lat space). Returns the clipped vertex list (open, no
 *  repeated closing point); empty when the ring lies wholly outside. */
export function clipRingToRect(ring: Coordinate[], minX: number, minY: number, maxX: number, maxY: number): Coordinate[] {
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

/** Clip every water/green polygon to `bbox` and stamp the cropped bbox, so both
 *  the backdrop and the layout's framing cover only the cluster's region. */
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

// A boundary line is terminated at a synthetic node placed at the TRUE box-edge
// crossing plus this small outward margin (a fraction of the box size). The canvas
// clips to the box, so the marker is hidden while the line reaches the faithful
// crossing. Kept small so the terminus stays right at the edge — a larger offset
// pushes nodes far out (inflating the octi grid) and, for a line grazing along the
// edge, drags the exit stub far along the edge instead of cleanly off it.
const BOUNDARY_MARGIN = 0.03;

function inRect([x, y]: Coordinate, [minX, minY, maxX, maxY]: BoundingBox): boolean {
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}
/** First point where the ray from `a` (inside the rect) along `dir` meets the rect
 *  boundary. Null if `dir` is degenerate / never exits. */
function rayRectExit(a: Coordinate, dir: Coordinate, [minX, minY, maxX, maxY]: BoundingBox): Coordinate | null {
  const [dx, dy] = dir;
  let best = Infinity;
  const consider = (t: number, onVertical: boolean) => {
    if (!(t > 1e-12)) return;
    const px = a[0] + dx * t, py = a[1] + dy * t;
    const ok = onVertical ? py >= minY - 1e-9 && py <= maxY + 1e-9 : px >= minX - 1e-9 && px <= maxX + 1e-9;
    if (ok && t < best) best = t;
  };
  if (dx !== 0) { consider((minX - a[0]) / dx, true); consider((maxX - a[0]) / dx, true); }
  if (dy !== 0) { consider((minY - a[1]) / dy, false); consider((maxY - a[1]) / dy, false); }
  return Number.isFinite(best) ? [a[0] + dx * best, a[1] + dy * best] : null;
}
/** The geographic course of a combo: its path tracks concatenated (each reversed
 *  per its segment flag), start-stNode -> end-stNode. */
function comboCoords(combo: ComboLike, trackById: Map<string, TrackLike>): Coordinate[] {
  const pts: Coordinate[] = [];
  for (const seg of combo.path ?? []) {
    const cs = trackById.get(seg.trackId)?.coords;
    if (!cs || cs.length === 0) continue;
    const ordered = seg.reversed ? cs.slice().reverse() : cs;
    for (const c of ordered) {
      const last = pts[pts.length - 1];
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      pts.push([c[0], c[1]]);
    }
  }
  return pts;
}
/** Given a boundary line's course oriented CORE -> outside, terminate it just past
 *  the crop box: find where it first crosses the box edge, and push the terminus a
 *  small margin OUTWARD (along the crossed edge's normal) so its marker clips off
 *  while the line reaches the true crossing. Returns that point + the course core
 *  -> crossing -> terminus. Null if the course never leaves the box (degenerate). */
function boundaryExit(pts: Coordinate[], box: BoundingBox): { end: Coordinate; coords: Coordinate[] } | null {
  if (pts.length < 2) return null;
  const [minX, minY, maxX, maxY] = box;
  const bx = maxX - minX, by = maxY - minY;
  const on = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  for (let i = 1; i < pts.length; i++) {
    if (inRect(pts[i], box)) continue;
    const dir: Coordinate = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const x = rayRectExit(pts[i - 1], dir, box);
    if (!x) return null;
    // Outward normal of the edge the crossing lies on; push the terminus off the box.
    let nx = 0, ny = 0;
    if (on(x[0], minX)) nx = -1; else if (on(x[0], maxX)) nx = 1;
    if (on(x[1], minY)) ny = -1; else if (on(x[1], maxY)) ny = 1;
    if (nx === 0 && ny === 0) { const l = Math.hypot(dir[0], dir[1]) || 1; nx = dir[0] / l; ny = dir[1] / l; }
    const end: Coordinate = [x[0] + nx * bx * BOUNDARY_MARGIN, x[1] + ny * by * BOUNDARY_MARGIN];
    return { end, coords: [...pts.slice(0, i), x, end] };
  }
  return null;
}

export function cropSubgraph(
  input: SchematicInput,
  coreStationIds: Set<string>,
  clipBbox?: BoundingBox,
  /** width/height of the user's DRAWN BOX (render px). When given, the sub-
   *  canvas takes the box's aspect (long side keeps the base size), so the
   *  re-sim fills a box-shaped canvas and the popout frame matches the drawn
   *  region's shape instead of being stretched into a square. */
  frameAspect?: number,
): SchematicInput {
  const routes = input.routes as unknown as RouteLike[];
  const tracks = input.tracks as unknown as TrackLike[];
  const stations = input.stations as unknown as StationLike[];
  const trackById = new Map<string, TrackLike>();
  for (const t of tracks) trackById.set(t.id, t);

  // core stNodes = the core stations' stNodeIds
  const coreStNodes = new Set<string>();
  for (const s of stations) if (coreStationIds.has(s.id)) for (const sn of s.stNodeIds ?? []) coreStNodes.add(sn);

  // The crop box in geographic space: the caller's unprojected drawn box, else the
  // core stations' coord bbox (harnesses with no projection). Used both to place
  // the boundary exit nodes and to clip the geography.
  const cropBox: BoundingBox | undefined = clipBbox ?? ((): BoundingBox | undefined => {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const s of stations) {
      if (!coreStationIds.has(s.id)) continue;
      const c = s.coords; if (!c) continue;
      if (c[0] < mnX) mnX = c[0]; if (c[0] > mxX) mxX = c[0];
      if (c[1] < mnY) mnY = c[1]; if (c[1] > mxY) mxY = c[1];
    }
    return mnX < mxX && mnY < mxY ? [mnX, mnY, mxX, mxY] : undefined;
  })();

  // Boundary handling: instead of keeping the next real station (which may sit just
  // inside the padded frame and dangle), terminate each line that leaves the box at
  // a SYNTHETIC node placed just beyond the frame ON THE LINE'S TRUE COURSE, so the
  // line exits the visible edge at the faithful crossing and its marker clips away
  // off-canvas. Combos fully inside are kept; fully-outside are dropped.
  const synthStations: StationLike[] = [];
  const synthTracks: TrackLike[] = [];
  let bnd = 0;
  const fRoutes = routes
    .map((r) => {
      const newCombos: ComboLike[] = [];
      const keepNodeIds = new Set<string>();
      const synthNodes: StNodeLike[] = [];
      for (const c of r.stCombos ?? []) {
        const aIn = coreStNodes.has(c.startStNodeId);
        const bIn = coreStNodes.has(c.endStNodeId);
        if (aIn && bIn) { newCombos.push(c); keepNodeIds.add(c.startStNodeId); keepNodeIds.add(c.endStNodeId); continue; }
        if (!aIn && !bIn) continue; // fully outside the crop
        const coreId = aIn ? c.startStNodeId : c.endStNodeId;
        keepNodeIds.add(coreId);
        const course = comboCoords(c, trackById);
        const oriented = aIn ? course : course.slice().reverse(); // core -> outside
        const ex = cropBox ? boundaryExit(oriented, cropBox) : null;
        if (!ex) continue; // no geometry to place an exit; the line just stops at core
        const nid = `bnd_${bnd}`, sid = `bndst_${bnd}`, tid = `bndtk_${bnd}`;
        bnd++;
        // Track geometry reads start -> end: a start-core combo is core -> exit; an
        // end-core combo is exit -> core (reverse the truncated course).
        synthTracks.push({ id: tid, coords: aIn ? ex.coords : ex.coords.slice().reverse(), buildType: 'constructed' });
        synthStations.push({ id: sid, name: '', coords: ex.end, stNodeIds: [nid], trackIds: [tid], buildType: 'constructed' });
        synthNodes.push({ id: nid, center: ex.end, trackIds: [tid], buildType: 'constructed' });
        keepNodeIds.add(nid);
        newCombos.push(aIn
          ? { startStNodeId: coreId, endStNodeId: nid, path: [{ trackId: tid, reversed: false, length: 0, signals: [] }], distance: c.distance ?? 1 }
          : { startStNodeId: nid, endStNodeId: coreId, path: [{ trackId: tid, reversed: false, length: 0, signals: [] }], distance: c.distance ?? 1 });
      }
      return { ...r, stNodes: [...(r.stNodes ?? []).filter((sn) => keepNodeIds.has(sn.id)), ...synthNodes], stCombos: newCombos };
    })
    .filter((r) => (r.stCombos?.length ?? 0) >= 1);

  const keptStNodes = new Set<string>(coreStNodes);
  for (const st of synthStations) for (const sn of st.stNodeIds ?? []) keptStNodes.add(sn);
  const fStations = [
    ...stations.filter((s) => (s.stNodeIds ?? []).some((sn) => coreStNodes.has(sn))),
    ...synthStations,
  ];
  const keptTracks = new Set<string>();
  for (const s of fStations) for (const t of s.trackIds ?? []) keptTracks.add(t);
  const fTracks = [...tracks.filter((t) => keptTracks.has(t.id)), ...synthTracks];

  const keptIds = new Set(fStations.map((s) => s.id));
  const fGroups = (input.stationGroups as GroupLike[] | undefined)?.filter((g) =>
    (g.stationIds ?? (g.stations as { id?: string }[] | undefined)?.map((x) => x?.id) ?? []).some(
      (sid) => typeof sid === 'string' && keptIds.has(sid),
    ),
  );

  // Crop the geography backdrop to EXACTLY the selected region (`cropBox`: the
  // user's drawn box unprojected through the warped main projection into
  // geographic space, else the core coord bbox). The box is a rectangle in warped
  // pixel space, so its true geographic preimage (not the bbox of whichever
  // stations land inside) is what we clip to. Boundary exit nodes sit just past
  // this box, so the geography ends at the selection edge and the lines leaving it
  // cross that edge faithfully.
  let croppedGeo: GeographyData | undefined;
  const geo = input.geography;
  if (geo) {
    const box = cropBox;
    if (box) {
      // Clip with a margin PAST the selection (but stamp the exact selection as
      // the bbox/frame): the popout frames on the stamped bbox, and the margin
      // lets water/parks continue seamlessly past the frame edge, exactly like
      // the main map, instead of being amputated at the frame. 0.35 > the
      // renderer's 0.25 canvas margin (detailCrop), so the margin backdrop
      // covers the whole sub-canvas.
      const PAD = 0.35;
      const pw = (box[2] - box[0]) * PAD;
      const ph = (box[3] - box[1]) * PAD;
      croppedGeo = {
        ...clipGeographyToBox(geo, [box[0] - pw, box[1] - ph, box[2] + pw, box[3] + ph]),
        bbox: box,
      };
    }
  }

  // Detail-crop render options: flag the sub-render (the re-fit pins the clip
  // rect's corners on-canvas, see SchematicOptions.detailCrop) and shape the
  // sub-canvas to the drawn box's aspect so the popout frame matches it.
  const baseOpts = (input as { options?: { width?: number; height?: number } }).options;
  let options: typeof baseOpts = { ...baseOpts, detailCrop: true } as typeof baseOpts;
  if (frameAspect !== undefined && Number.isFinite(frameAspect) && frameAspect > 0) {
    const base = Math.max(baseOpts?.width ?? 2700, baseOpts?.height ?? 2700);
    const w = frameAspect >= 1 ? base : Math.max(400, Math.round(base * frameAspect));
    const h = frameAspect >= 1 ? Math.max(400, Math.round(base / frameAspect)) : base;
    options = { ...options, width: w, height: h };
  }

  return {
    ...input,
    options: options as never,
    routes: fRoutes as never,
    tracks: fTracks as never,
    stations: fStations as never,
    stationGroups: fGroups as never,
    geography: croppedGeo, // cluster-region backdrop (undefined if no geography)
  };
}
