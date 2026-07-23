// Reusable ribbon renderer. The ribbon core (renderRibbons) takes
// pre-projected node pixels and paints the route lines, stops, and labels for
// the smoothed renderer.

import {
  joinTraceTarget, makeJoinLog, reportPaintedLoops, reportBundleClips, reportVanishedStations,
  reportFarAttach, reportSplitFit, reportCapsOverlap, reportPlatformSplit,
  reportCapsOvlStats, reportCapsAudit,
  reportRigidSlideDeclined, reportSlideStackDeclined,
  reportSlideSelfCross, reportSlideClashDeclined, corridorSpreadDebug,
  reportCorridorAbandon, reportCorridorSpread, reportCorridorSpreadSummary,
  reportNoOverlapFloorResidual, reportEgregiousOverlaps,
  reportSlidStations, reportEvictedStations,
  reportConnTrace, reportRibbonSummary, reportZigzags, reportSpikes, reportStairs, reportContiguity, reportLaneSeats, reportFanZones, reportStopSeating, reportZoneCrossings, reportChains,
} from './debug/renderOctilinear.debug';
import { reportChainSeats } from './debug/chainSeats.debug';
import { envStr, envNum } from '../env';
import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import { connectorControls } from './layout/connectorClamp';
import type { WaterCollection } from './types';
import { LINE_WIDTH, LINE_GAP, MARKER_SCALE, MARK_R0, onDrawScale } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { offsetPolyline, curveLaneJoin, taperLaneEnd } from './layout/offsets';
import { buildFanJoins } from './fanJoin';
import { assembleDByLine } from './assemblePath';
import { computePaintGroups } from './paintLayers';
import { findParallelPairs, applyJointSeating } from './layout/corridorSep';
import { detectChains } from './chains';
import { computeChainSeats } from './chainSeats';
import { buildLaneCurve, curveTangent } from './layout/chainPlace';
import { solveRows, lineCrossNearest } from './layout/rowPlace';
import { buildSeatInkOracle, type SeatInkOracle } from './layout/seatInk';
import { chooseMutualSlide, penBetween, segSegDist, type Hull } from './layout/capsuleSlide';
import { planSplitConnectors } from './layout/splitConnect';
import { rectSeat, rectSeatToCapsule, type RectMember, type RectCapsule } from './layout/rectSeat';
import { laneSeatAll, type LaneItem, type LaneStation, type LaneObstacle } from './layout/laneSeat';
import { rescueRectAndSingles, type SingleStop } from './layout/rectRescue';
import { resolveSimplifiedLines, simplifiedSignature, type SimplifiedStyle, type SimplifiedScope, type SimplifiedRoutes } from './simplify';
import { computeLondonByNode, type LondonCapsule } from './layout/londonBubbles';
import { computeTorontoByNode, type TorontoCross } from './layout/torontoCross';
import { sampleQuadratic } from './layout/segGeom';
import { cropLaneToShape, shapeMinExtent, insetShape, type Box, type CropShape } from './laneCrop';
import { getStationDesign } from './stations';
import { placesSvg, placesPrims, selectPlaces, DEFAULT_LABEL_ZOOM, DEFAULT_LABEL_PAD, PLACE_FONT_SIZE, type PlacePx } from './neighborhoods';
import { renderStations } from './stations/render';
import { placeLabels, renderLabel, labelAnchor, type Segment } from './labels';
import { escapeXml } from './escape';
import type { FrameRect } from './projection';
import type { Scene, Prim } from './sceneIR';
import { sceneFromSvg } from './sceneFromSvg';

// sqrt(a²+b²) — correctly-rounded cross-V8 (Math.hypot is not), so the rendered
// marker/ribbon geometry is bit-identical on any engine. SIN1DEG = sin(1°).
const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const SIN1DEG = 0.017452406437283513;
// nearest octilinear axis (mod 180°) to a direction — trig-free argmax of
// |dir·axis| over the 4 axes (deterministic tie → lowest index), so the axis
// snap is bit-identical cross-V8 (no atan2). Module scope: used by both the
// spineOctilinear gate and the rigid-row collision slide.
const AXES4: Pixel[] = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2]];

/** One point formatted at the emitted-SVG coordinate precision. */
const fmtPt = (p: Pixel): string => p[0].toFixed(1) + ',' + p[1].toFixed(1);

/**
 * Build the per-line 'd' command arrays from a lane bundle (`segPath`) and its
 * node join curves, exactly as the inline emission does. Extracted so the lanes
 * can be re-emitted from a CROPPED clone of segPath without duplicating the
 * fillet math. Pure over its inputs: it reads segPath / joinCurves and writes a
 * fresh Map, never touching module state.
 *
 * Iteration order matches the original emission (segPath insertion order, then
 * joinCurves order) so the joined path strings are byte-identical. Interior
 * corners get a `filletR`-radius quadratic fillet (clamped per corner to half
 * each adjacent segment); a near-straight corner degrades to a plain line-to.
 *
 * `segmentsOut`, when given, collects the straight sub-segments each lane
 * contributes (used downstream for label placement / collision). Pass the real
 * segments array for the live build; omit it for a throwaway crop re-emit so the
 * live collision set is not polluted.
 */
export function buildDByLine(
  segPath: Map<string, Pixel[]>,
  joinCurves: Array<{ lineId: string; node: string; a: Pixel; apex: Pixel; b: Pixel }>,
  filletR: number,
  segmentsOut?: Segment[],
): Map<string, string[]> {
  const dByLine = new Map<string, string[]>();
  const push = (lineId: string, poly: Pixel[]) => {
    let d = dByLine.get(lineId);
    if (!d) dByLine.set(lineId, (d = []));
    if (segmentsOut) for (let k = 1; k < poly.length; k++) segmentsOut.push({ p1: poly[k - 1], p2: poly[k] });
    d.push('M' + fmtPt(poly[0]));
    for (let k = 1; k < poly.length - 1; k++) {
      const a = poly[k - 1];
      const v = poly[k];
      const b = poly[k + 1];
      const l1 = hyp(v[0] - a[0], v[1] - a[1]);
      const l2 = hyp(b[0] - v[0], b[1] - v[1]);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const u1: Pixel = [(v[0] - a[0]) / l1, (v[1] - a[1]) / l1];
      const u2: Pixel = [(b[0] - v[0]) / l2, (b[1] - v[1]) / l2];
      const cross = u1[0] * u2[1] - u1[1] * u2[0];
      const dot = u1[0] * u2[0] + u1[1] * u2[1];
      if (Math.abs(cross) < 0.05 && dot > 0) {
        d.push('L' + fmtPt(v)); // effectively straight
        continue;
      }
      const f = Math.min(filletR, l1 / 2, l2 / 2);
      d.push(
        'L' + fmtPt([v[0] - u1[0] * f, v[1] - u1[1] * f]),
        'Q' + fmtPt(v) + ' ' + fmtPt([v[0] + u2[0] * f, v[1] + u2[1] * f]),
      );
    }
    d.push('L' + fmtPt(poly[poly.length - 1]));
  };
  for (const [key, poly] of segPath) push(key.slice(key.indexOf('|') + 1), poly);
  for (const jc of joinCurves) {
    let d = dByLine.get(jc.lineId);
    if (!d) dByLine.set(jc.lineId, (d = []));
    d.push('M' + fmtPt(jc.a), 'Q' + fmtPt(jc.apex) + ' ' + fmtPt(jc.b));
    if (segmentsOut) segmentsOut.push({ p1: jc.a, p2: jc.b });
  }
  return dByLine;
}

/** Parse the finished per-line 'd' command arrays back into drawn segments (Q
 *  curves sampled), so a consumer can operate on the exact ink — every fillet,
 *  join and connector included — without re-deriving lane geometry. */
export function drawnSegsByLine(dByLine: Map<string, string[]>): Map<string, Array<[Pixel, Pixel]>> {
  const out = new Map<string, Array<[Pixel, Pixel]>>();
  for (const [lineId, cmds] of dByLine) {
    const segs: Array<[Pixel, Pixel]> = [];
    let cur: Pixel | null = null;
    for (const cmd of cmds) {
      const nums = cmd.slice(1).match(/-?\d+(?:\.\d+)?/g);
      if (!nums) continue;
      const pts: Pixel[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([+nums[i], +nums[i + 1]]);
      if (cmd[0] === 'M') cur = pts[0] ?? cur;
      else if (cmd[0] === 'L' && cur && pts[0]) { segs.push([cur, pts[0]]); cur = pts[0]; }
      else if (cmd[0] === 'Q' && cur && pts[1]) {
        const s = sampleQuadratic(cur, pts[0], pts[1], 6);
        for (let i = 1; i < s.length; i++) segs.push([s[i - 1], s[i]]);
        cur = pts[1];
      } else if (cmd[0] === 'C' && cur && pts[2]) {
        // cubic transitions (in-path lateral jogs): sampled like quadratics
        // so the censuses measure this ink too
        let prev: Pixel = cur;
        for (let i = 1; i <= 6; i++) {
          const t = i / 6, u = 1 - t;
          const p: Pixel = [
            u * u * u * cur[0] + 3 * u * u * t * pts[0][0] + 3 * u * t * t * pts[1][0] + t * t * t * pts[2][0],
            u * u * u * cur[1] + 3 * u * u * t * pts[0][1] + 3 * u * t * t * pts[1][1] + t * t * t * pts[2][1],
          ];
          segs.push([prev, p]);
          prev = p;
        }
        cur = pts[2];
      }
    }
    out.set(lineId, segs);
  }
  return out;
}

/** One lane end to crop to a seated rectangle-capsule box. `flagNode` is the
 *  support node the mark sits on: an incident drawn lane is `segPath[edgeId|lineId]`
 *  for an edge with from/to == flagNode. `shared` means the terminus-trim
 *  shared-anchor guard flagged this end as anchoring more than one station, so it
 *  is left uncropped (cropping to one station's box would orphan the other). */
export interface LaneCropTarget {
  lineId: string;
  flagNode: string;
  /** The DRAWN marker shape this line's stop sits on (a design's interchange
   *  footprint: a capsule group rect, a single-stop box, an interchange bubble
   *  disc). The lane is cropped to this exact painted shape, whatever its kind. */
  shape: CropShape;
  shared: boolean;
}

/**
 * Re-emit the per-line 'd' strings from a segPath whose incident lane ends have
 * been cropped so each terminates exactly on its mark's painted marker shape
 * (the active design's interchange footprint: a capsule rect, a bubble disc,
 * ...). Builds on a CLONE of segPath (only the polylines actually edited are
 * deep-cloned; the real segPath is never mutated). For each target, every
 * incident drawn lane at its support node is oriented node-end-first and cropped
 * by cropLaneToShape (cut back when it overshoots into or through the shape,
 * extended straight when it falls short). Shared-anchor ends are skipped. A
 * through line with an incident lane at each of two nodes is cropped at each end
 * independently because each end is a separate target. Design-agnostic: it reads
 * only the shape on each target, so a new design supplies its footprint shapes
 * and needs no crop code of its own.
 *
 * Deterministic: cropLaneToShape uses Math.sqrt only and a fixed scan order;
 * targets are applied in their given (stable placement) order.
 *
 * Returns the per-line 'd' command ARRAYS (not joined), so the node-connector
 * pass can append its cross-node jog commands to them exactly as it does to the
 * live dByLine, and the caller joins them into strings once at the end.
 */
export function computeLaneCrops(
  targets: LaneCropTarget[],
  segPath: Map<string, Pixel[]>,
  edges: Array<{ id: string; from: string; to: string }>,
  joinCurves: Array<{ lineId: string; node: string; a: Pixel; apex: Pixel; b: Pixel }>,
  filletR: number,
  inset = 0,
  emitD?: (seg: Map<string, Pixel[]>) => Map<string, string[]>,
): Map<string, string[]> {
  // A shallow copy of the segPath map: entries start as the real polyline
  // references and are REPLACED (not mutated) with fresh cropped arrays, so the
  // real segPath and its polylines are never touched.
  const cropSeg = new Map(segPath);
  const incidentByNode = new Map<string, Array<{ id: string; from: string; to: string }>>();
  for (const e of edges) {
    let a = incidentByNode.get(e.from);
    if (!a) incidentByNode.set(e.from, (a = []));
    a.push(e);
    if (e.to !== e.from) {
      let b = incidentByNode.get(e.to);
      if (!b) incidentByNode.set(e.to, (b = []));
      b.push(e);
    }
  }

  // FREE-END gate: a lane end may be cropped or extended only when it is a true
  // END of the line's drawn course, i.e. no other lane of the SAME line has an
  // endpoint continuing from it and no fillet join bridges away from it. The
  // endpoint set is the lanes' own ends PLUS every joinCurve bridge point (a
  // filleted interior join separates the raw lane ends by several px, with the
  // arc living outside segPath, so the bridge points stand in for continuity).
  // Built once from the INPUT segPath so in-loop cropping cannot change the gate.
  // Plain lane endpoints use a tight tolerance (a fold terminus keeps its two
  // pass ends a pitch apart and both must stay croppable); join-curve bridge
  // points use a wide one, because a jog may move the lane end most of a pitch
  // away from the splice it still continues into (an absorbed-corner retreat
  // amputated by the crop looked like a free end under one tight tolerance).
  const FREE_TOL2 = 3 * 3;
  const BRIDGE_TOL2 = 7 * 7;
  const endsByLine = new Map<string, Array<{ p: Pixel; tol2: number }>>();
  const pushEnd = (lineId: string, p: Pixel, tol2: number) => {
    let arr = endsByLine.get(lineId);
    if (!arr) endsByLine.set(lineId, (arr = []));
    arr.push({ p, tol2 });
  };
  for (const [key, poly] of segPath) {
    if (poly.length < 2) continue;
    const lineId = key.slice(key.indexOf('|') + 1);
    pushEnd(lineId, poly[0], FREE_TOL2);
    pushEnd(lineId, poly[poly.length - 1], FREE_TOL2);
  }
  for (const jc of joinCurves) {
    pushEnd(jc.lineId, jc.a, BRIDGE_TOL2);
    pushEnd(jc.lineId, jc.b, BRIDGE_TOL2);
  }
  const isFreeEnd = (lineId: string, p: Pixel): boolean => {
    const arr = endsByLine.get(lineId);
    if (!arr) return false;
    let hits = 0;
    for (const q of arr) {
      const dx = p[0] - q.p[0], dy = p[1] - q.p[1];
      if (dx * dx + dy * dy <= q.tol2) { hits++; if (hits > 1) return false; }
    }
    return hits === 1; // only itself
  };
  // Second, independent signal: the line has exactly ONE incident drawn lane at
  // the node (it arrives and stops). BOTH signals must agree before an end is
  // touched, so neither a fillet shuffle nor a stray extra lane can ever expose
  // an interior end to the crop.
  const laneCountAt = (lineId: string, flagNode: string): number => {
    const inc = incidentByNode.get(flagNode);
    if (!inc) return 0;
    let c = 0;
    for (const e of inc) if (segPath.has(e.id + '|' + lineId)) c++;
    return c;
  };

  for (const t of targets) {
    if (t.shared) continue; // shared terminus: leave the lane at its tip
    const inc = incidentByNode.get(t.flagNode);
    if (!inc) continue;
    if (laneCountAt(t.lineId, t.flagNode) !== 1) continue; // endings only
    // Extension cap: the near-terminus trims a lane back by a marker's worth of
    // arc, so allow a short straight extension to the capsule wall, scaled by
    // the capsule's thin side and hard-bounded so no long fabrication can slip
    // through even at a wide row capsule.
    // Crop to the shape pulled in by the inset, so the stroke's round cap ends
    // under the marker rather than poking past its edge.
    const shape = inset > 0 ? insetShape(t.shape, inset) : t.shape;
    const maxExt = Math.min(4 * shapeMinExtent(shape), 48);
    for (const e of inc) {
      const key = e.id + '|' + t.lineId;
      const poly = cropSeg.get(key);
      if (!poly || poly.length < 2) continue;
      // orient node-end-first (poly[0] near flagNode), as trimLaneAt/arcToPoint do
      const atStart = e.from === t.flagNode;
      const nodeFirst = atStart ? poly : [...poly].reverse();
      if (!isFreeEnd(t.lineId, nodeFirst[0])) continue; // endings only
      const cropped = cropLaneToShape(nodeFirst, shape, maxExt);
      const back = atStart ? cropped : [...cropped].reverse();
      cropSeg.set(key, back);
    }
  }

  // Re-emit from the cropped clone; segments are the live collision set, so
  // neither emitter gets a sink here (the crop re-emit must not pollute it).
  return emitD ? emitD(cropSeg) : buildDByLine(cropSeg, joinCurves, filletR);
}

const snapAxis = (dx: number, dy: number): Pixel => {
  let best = 0, bv = -1;
  for (let k = 0; k < 4; k++) {
    const v = Math.abs(dx * AXES4[k][0] + dy * AXES4[k][1]);
    if (v > bv) { bv = v; best = k; }
  }
  return AXES4[best];
};

/** Map water polygons into the schematic's pixel frame via a bbox affine. */
function waterBackdrop(layout: Layout, nodePx: Map<string, Pixel>, water: WaterCollection, dark: boolean): string {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes.values()) {
    const [lng, lat] = n.lngLat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    const px = nodePx.get(n.id)!;
    if (px[0] < minX) minX = px[0];
    if (px[0] > maxX) maxX = px[0];
    if (px[1] < minY) minY = px[1];
    if (px[1] > maxY) maxY = px[1];
  }
  const gw = maxLng - minLng || 1e-9;
  const gh = maxLat - minLat || 1e-9;
  const pw = maxX - minX || 1;
  const ph = maxY - minY || 1;
  const map = ([lng, lat]: [number, number]): Pixel => [
    minX + ((lng - minLng) / gw) * pw,
    minY + ((maxLat - lat) / gh) * ph,
  ];

  let paths = '';
  for (const f of water.features) {
    if (f.geometry.type !== 'Polygon') continue;
    let d = '';
    for (const ring of f.geometry.coordinates) {
      ring.forEach((c, i) => {
        const [x, y] = map(c as [number, number]);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      });
      d += 'Z ';
    }
    if (d) paths += '<path d="' + d.trim() + '"/>';
  }
  if (!paths) return '';
  const fill = dark ? DARK_THEME.water : DEFAULT_THEME.water;
  return '<g class="water" fill="' + fill + '" fill-rule="evenodd" stroke="none">' + paths + '</g>';
}

/**
 * Core ribbon renderer: bundles parallel co-running lines, draws stops as
 * pills, and places labels. Operates in caller-chosen pixel space — both
 * grid-octilinear (renderOctilinear) and smoothed-graph (renderSmoothedRibbons)
 * use this.
 *
 * Stops are placed at offset-path endpoints along the full service traversal
 * (topo support nodes). Line geometry may deduplicate revisited corridors so
 * round-trip patterns draw a single centerline like geographic mode.
 */
export interface RenderRibbonsArgs {
  layout: Layout;
  nodePx: Map<string, Pixel>;
  edgePolyline: (edge: Layout['edges'][number]) => Pixel[];
  width: number;
  height: number;
  dark: boolean;
  showLabels: boolean;
  /** Stations toggle: when false, the line-name bullets inside stop dots are
   *  hidden (markers themselves always render in ribbon modes). */
  showStations?: boolean;
  /** Station design id (marker style); resolved via getStationDesign, unknown →
   *  Classic. Draw-time only, consumed in paintRibbons. */
  stationDesign?: string;
  /** Per-route simplified display (route id -> style id). Resolved to per-LINE
   *  styles in paintRibbons. Draw-time only; never changes the layout. */
  simplifiedRoutes?: SimplifiedRoutes;
  /** Land / background color from the selected colorset. Draw-time; the smoothed
   *  map paints its casing halos and canvas on it. Absent falls back to the
   *  built-in light/dark land. */
  land?: string;
  /** Station-name label color from the colorset (cityLabel). Absent -> default. */
  labelColor?: string;
  /** Neighborhood-label color from the colorset (neighborhoodLabel). Absent -> default. */
  placeColor?: string;
  /** Neighborhood labels (pre-projected through the warped projection), drawn
   *  between the backdrop and the route lanes when present. Draw-time only. */
  placesPx?: PlacePx[];
  /** Virtual zoom picking the visible area-label tiers; the pre bakes every tier's
   *  points and the tier select + cull run at paint. */
  placesZoom?: number;
  /** Area-label collision padding (basemap textPadding units). */
  placesPad?: number;
  /** Area-label paint size, already scaled for this grown canvas. */
  placesFontPx?: number;
  water?: WaterCollection;
  /** Geography backdrop (water/green groups), built at DRAW time by
   *  drawSmoothed from the pre's projected rings — faithful polygons or the
   *  simplified landmass blobs, per the landmass style. Drawn under
   *  gridOverlay. */
  backdrop?: string;
  /** Optional pre-rendered SVG snippet (a single `<g>...</g>`) drawn between
   *  the water layer and the route ribbons. Used to overlay the Hanan grid
   *  for diagnostic purposes (showGrid option). On legacy pres this also
   *  carries the baked water polygons. */
  gridOverlay?: string;
  /** Station-group marker data (smoothed mode): ONE marker per group at its
   *  node — capsule iff the group has multiple member stations — gathering
   *  the marks of its lines from their per-line stop-flag nodes. Without
   *  this, markers fall back to the legacy per-node edge.stops model. */
  stations?: Array<{ nodeId: string; members: number; stopNodes: Map<string, string> }>;
  /** Fit/export crop rect in pixel space, emitted as `data-frame` on the root
   *  svg. Set by topo-geographic mode (which keeps a real projection); octi
   *  modes leave it unset so fit/export use the already-tight content viewBox. */
  frame?: FrameRect;
}

/** Tight pixel-space bbox of the drawn network — node dots + edge centerlines —
 *  padded so offset lanes, capsule markers and casing aren't clipped, then
 *  clamped to the canvas. Used as the fit/export frame for octi-based modes
 *  (smoothed, schematic) when there's no geography extent to frame on. */
function contentFrame(
  nodePx: Map<string, Pixel>,
  edges: Layout['edges'],
  edgePolyline: (edge: Layout['edges'][number]) => Pixel[],
  width: number,
  height: number,
): FrameRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (p: Pixel) => {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const p of nodePx.values()) grow(p);
  for (const e of edges) for (const p of edgePolyline(e)) grow(p);
  if (!isFinite(minX)) return { x: 0, y: 0, w: width, h: height };
  // Margin ≈ a dense hub's lane fan + capsule marker + casing (markers/lanes
  // bow out past the centerline). ~1% of a 2700px canvas — still a tight frame.
  const m = LINE_WIDTH * 10;
  minX = Math.max(0, minX - m);
  minY = Math.max(0, minY - m);
  maxX = Math.min(width, maxX + m);
  maxY = Math.min(height, maxY + m);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Optional Scene-IR sink: when provided, renderRibbons fills `.scene` with a
// display list built from the SAME geometry it serializes, so the panel can paint
// a canvas without re-parsing the SVG string (Phase 3). Purely additive — the SVG
// string output is unchanged whether or not this is passed.
export interface SceneOut {
  scene: Scene | null;
}

// The toggle-independent geometry produced by computeRibbonGeometry and consumed
// by paintRibbons. All plain Maps/arrays of primitives (no closures) — so it can
// be serialized and hoisted into precompute later. See docs/cache-read-perf.md.
export interface RibbonGeometry {
  stopsByNode: Map<string, StopMark[]>;
  membersByNode: Map<string, number> | undefined;
  dByLine: Map<string, string[]>;
  segments: Segment[];
  lineById: Map<string, { id: string; label?: string; color: string; textColor?: string }>;
  orderOf: Map<string, string[]>;
  /** Platform-split groups (spec 2026-07-04 §2.4): base station nodeId ->
   *  every placement-unit nodeId (in stopsByNode) that split off from it,
   *  INCLUDING the shrunken primary. Only entries with >=2 units are kept.
   *  Positions in stopsByNode are final by the time this map is built, so
   *  taxicab connectors planned from it read the same dots the markers draw.
   *  OPTIONAL: geometry serialized BEFORE this field existed (older saved
   *  maps / dump bundles — mapCache v8 / schema 18 predate it) deserializes
   *  without it; paintRibbons must draw with no connectors, not crash. */
  splitGroups?: Map<string, string[]>;
  /** Per node: the precomputed rectangle-capsule interchange geometry (seated
   *  boxes, group rects, connectors), deconflicted across stations. Design-
   *  agnostic geometry built unconditionally; only the rectangle-capsule design
   *  reads it. OPTIONAL: geometry serialized BEFORE this field existed
   *  deserializes without it; paint falls back to seating at draw time. */
  rectByNode?: Map<string, RectCapsule>;
  /** Per single Tokyu stop: its rescued marker position (nodeId -> [x, y]),
   *  deconflicted against the interchange capsules and other singles in the same
   *  compute-time rescue. Design-agnostic and inert for non-rect designs, which
   *  never read it. OPTIONAL: absent in geometry serialized before it existed;
   *  paint then falls back to the mark's own position. */
  tokyuStopPos?: Map<string, [number, number]>;
  /** Per capsule REGIME (rectRows, londonBubbles): the per-line 'd' strings
   *  re-emitted from a segPath whose incident lane ends were cropped (cut back or
   *  extended) to terminate exactly on that design's painted marker footprint.
   *  The active design consults the entry for its own regime; a design whose
   *  regime is absent reads dByLine, so its drawn output is byte-identical.
   *  OPTIONAL: absent in geometry serialized before it existed (and when there
   *  are no cropped lanes); paint falls back to dByLine per line. */
  croppedLaneByLine?: Map<string, Map<string, string>>;
  /** Fallback content frame (drawn extent + margin), scanned once at compute
   *  time. Used only when no geography frame is passed. OPTIONAL: absent in
   *  geometry serialized before it existed; paint then rescans inline. */
  contentFrame?: FrameRect;
  /** Ordered paint layers: groups of bundle-mate line ids, longest bundle
   *  first, so overlapping bundles stack coherently (each group paints its
   *  casings then its strokes). OPTIONAL: absent in geometry serialized
   *  before it existed; paint then falls back to the flat all-casings,
   *  all-strokes order. */
  paintGroups?: string[][];
  /** Per node: the London bubble-chain interchange geometry (paired ticket-hall
   *  bubbles + connector bars), built from the final mark positions. Design-
   *  agnostic and inert for non-London designs, which never read it. OPTIONAL:
   *  absent in geometry serialized before it existed; the London design then
   *  falls back to per-line ticks at those interchanges. */
  bubbleByNode?: Map<string, LondonCapsule>;
  /** Per-node Toronto direct-intersection center (a perfect crossing collapsed
   *  to one dot), built from the final mark positions. Design-agnostic and inert
   *  for non-Toronto designs. OPTIONAL: absent in geometry serialized before it
   *  existed; the Toronto design then paints those crossings as pills. */
  torontoByNode?: Map<string, TorontoCross>;
}

// Repaint memo of label placements per geometry (see the paintRibbons label
// block). Weakly keyed so an evicted precompute releases its placements. The
// layout/nodePx the placements were computed against ride along so a caller
// pairing this geometry with a DIFFERENT layout can never be served stale
// placements; identity mismatch recomputes.
const labelPlacementsMemo = new WeakMap<RibbonGeometry, {
  layout: Layout;
  nodePx: Map<string, Pixel>;
  simpSig: string;
  placements: ReturnType<typeof placeLabels>;
}>();

/** Capsule geometry for ONE regime, re-derived when a simplified route has left
 *  some stations and the compute-time maps (solved over the full membership)
 *  would paint a bead or seat with no dot behind it.
 *
 *  Only the active regime is built, and only while a simplification is active.
 *  The lane accessors the compute-time pass supplies (a lane-curve item source
 *  for large-hub rect seating, a per-stop lane for the Toronto crossing test) are
 *  optional in both solvers and live inside computeRibbonGeometry, so the
 *  re-derived geometry uses the mark-only path: the seat is still correct for the
 *  reduced membership, it just forgoes those refinements at the affected hubs.
 *  Memoized per (geometry, regime, simplification signature). */
interface DerivedCapsules {
  rectByNode?: Map<string, RectCapsule>;
  tokyuStopPos?: Map<string, [number, number]>;
  bubbleByNode?: Map<string, LondonCapsule>;
  torontoByNode?: Map<string, TorontoCross>;
}
const derivedCapsulesMemo = new WeakMap<RibbonGeometry, Map<string, DerivedCapsules | undefined>>();

function deriveCapsules(
  stopsByNode: Map<string, StopMark[]>,
  regime: string | undefined,
  geom: RibbonGeometry,
  simpSig: string,
): DerivedCapsules | undefined {
  const key = (regime ?? 'pill') + '#' + simpSig;
  let byKey = derivedCapsulesMemo.get(geom);
  if (!byKey) { byKey = new Map(); derivedCapsulesMemo.set(geom, byKey); }
  if (byKey.has(key)) return byKey.get(key);

  // Which CAPSULE nodes actually lost a member? A capsule sits at a multi-line
  // station, and the default scope keeps every mark at such a station, so usually
  // NOTHING changes and the cached geometry (seated with the lane-extent clamp
  // that keeps a box on its line and off past a terminus) must be kept verbatim.
  // Re-seating an unchanged capsule from the mark-only path drops that clamp and
  // slides it off its lanes. Only nodes whose membership differs AND that are a
  // capsule on either side are re-derived; the rest keep the cache.
  const lineSet = (marks: StopMark[] | undefined): string =>
    (marks ?? []).map((m) => m.lineId).sort().join(',');
  const changed = new Set<string>();
  for (const nodeId of new Set([...geom.stopsByNode.keys(), ...stopsByNode.keys()])) {
    const before = geom.stopsByNode.get(nodeId), after = stopsByNode.get(nodeId);
    if (lineSet(before) === lineSet(after)) continue;
    if ((before?.length ?? 0) >= 2 || (after?.length ?? 0) >= 2) changed.add(nodeId);
  }
  let out: DerivedCapsules | undefined;
  if (changed.size === 0) {
    out = undefined; // no capsule touched -> keep every cached map (and cropped lanes)
  } else if (regime === 'rectRows') {
    const gathered = [...stopsByNode.entries()].map(([nodeId, marks]) => ({ nodeId, marks }));
    const re = computeRectByNode(gathered as Parameters<typeof computeRectByNode>[0], RECT_BOX);
    out = {
      rectByNode: mergeChanged(geom.rectByNode, re.rectByNode, changed),
      tokyuStopPos: mergeChanged(geom.tokyuStopPos, re.tokyuStopPos, changed),
    };
  } else if (regime === 'londonBubbles') {
    out = { bubbleByNode: mergeChanged(geom.bubbleByNode, computeLondonByNode(stopsByNode, LINE_WIDTH), changed) };
  } else if (regime === 'toronto') {
    out = { torontoByNode: mergeChanged(geom.torontoByNode, computeTorontoByNode(stopsByNode), changed) };
  }
  byKey.set(key, out);
  return out;
}

/** Cached map with only the CHANGED nodes replaced by the re-derived values (and
 *  removed where the re-derivation has no entry). Unchanged nodes keep their
 *  cached, correctly-seated geometry. */
function mergeChanged<V>(
  cached: Map<string, V> | undefined,
  reDerived: Map<string, V> | undefined,
  changed: Set<string>,
): Map<string, V> {
  const out = new Map(cached ?? []);
  for (const nodeId of changed) {
    const v = reDerived?.get(nodeId);
    if (v !== undefined) out.set(nodeId, v);
    else out.delete(nodeId);
  }
  return out;
}

// Single-stop box side length used to seat rectangle-capsule interchanges. R0 and
// RCAP are defined exactly as the placement geometry defines them so the seated
// box matches the marker sizing; S = 3*RCAP/MARKER_SCALE = the single-stop box.
let RECT_R0 = MARK_R0;
let RECT_RCAP = RECT_R0 * MARKER_SCALE;
let RECT_BOX = 3 * RECT_RCAP / MARKER_SCALE;
onDrawScale(() => { RECT_R0 = MARK_R0; RECT_RCAP = RECT_R0 * MARKER_SCALE; RECT_BOX = 3 * RECT_RCAP / MARKER_SCALE; });
// Above this member count a hub is seated by the LANE-AWARE path (matching
// rectSeat's ENUM_MAX): each box slides along its own drawn lane instead of being
// packed into an abstract row.
const LANECROP_SPREAD_MIN = 6;

// One gathered station's data the rect-capsule seating needs: its nodeId and the
// marks whose pre-solve home/axis feed the solver, plus each mark's final marker
// position (single stops seat at pos, not home). Matches the StMarks shape.
export interface RectSeatStation {
  nodeId: string;
  marks: Array<{ lineId: string; home?: Pixel; axis?: number; pos?: Pixel; flagNode?: string }>;
}

/** Build the drawn lane curve + on-lane anchor for one mark, so large hubs seat by
 *  sliding boxes along their real lanes. Returns null when the mark has no drawn
 *  lane (then the caller falls back to the abstract seater). */
export type LaneItemFor = (lineId: string, flagNode: string, anchor: Pixel) => LaneItem | null;

/** Compute-time rect placement for the full Tokyu stop set: the multi-line
 *  capsules keyed by nodeId (already cross-station deconflicted), plus the
 *  rescued marker position of every single Tokyu stop keyed by nodeId. */
export interface RectPlacement {
  rectByNode: Map<string, RectCapsule>;
  tokyuStopPos: Map<string, [number, number]>;
}

/**
 * Build the design-agnostic rectangle-capsule geometry for every multi-line
 * station whose marks all carry a pre-solve home and run axis (the GEOMETRIC
 * predicate; this never reads the active design). Mega interchanges are included:
 * in the Tokyu design their cached capsule is the drawn shape (a compact grid of
 * numbered boxes), so seating them here is real, not a phantom, and non-rectRows
 * designs ignore rectByNode entirely. Each qualifying station is
 * seated with rectSeat at the shared box/gap and converted to the serialization-
 * safe RectCapsule. Single Tokyu stops (one mark) contribute a box-sized
 * footprint at their final marker position. The whole set (interchange capsules
 * AND singles) is then deconflicted across stations by one shared cross-station
 * rescue, so a single box and an interchange capsule never overlap. Stations are
 * visited in their given order (the caller passes them in the deterministic
 * placement order), so the maps are stable.
 */
// Unit direction of an octilinear run-axis (0..3, mod 180 deg), or undefined when
// no axis was captured. Sign is irrelevant (the rescue slides both ways). Uses a
// literal sqrt(1/2) so it is byte-identical across V8 versions.
const AXIS_S = 0.7071067811865476;
function axisDir(axis: number | undefined): [number, number] | undefined {
  switch (axis) {
    case 0: return [1, 0];
    case 1: return [AXIS_S, AXIS_S];
    case 2: return [0, 1];
    case 3: return [-AXIS_S, AXIS_S];
    default: return undefined;
  }
}

// Normalize a lane tangent to a unit vector (sqrt, not hypot, for cross-V8
// byte-identity). The exact local direction of the line at a stop, unquantized:
// tick-style markers strike strictly perpendicular to it, where the quantized
// axis would be up to 22.5 deg off on a curved or non-octilinear approach.
function unitTangent(tg: [number, number]): Pixel {
  const len = Math.sqrt(tg[0] * tg[0] + tg[1] * tg[1]);
  return len > 1e-9 ? [tg[0] / len, tg[1] / len] : [1, 0];
}

/** The dominant run-axis unit direction of a capsule's marks (the corridor the
 *  capsule sits on): the mode of the member axes, ties to the lower axis. Used to
 *  constrain the cross-station rescue so a capsule slides ALONG its corridor
 *  instead of freely off its lines. */
function dominantDir(marks: RectSeatStation['marks']): [number, number] | undefined {
  const counts = [0, 0, 0, 0];
  for (const m of marks) if (m.axis !== undefined) counts[((m.axis % 4) + 4) % 4]++;
  let best = 0;
  for (let a = 1; a < 4; a++) if (counts[a] > counts[best]) best = a;
  return axisDir(best);
}

export function computeRectByNode(
  gathered: RectSeatStation[],
  box: number = RECT_BOX,
  laneItemFor?: LaneItemFor,
): RectPlacement {
  const rectByNode = new Map<string, RectCapsule>();
  const capDir = new Map<string, [number, number] | undefined>();
  const singles: SingleStop[] = [];
  // Single-stop box side: side 3*R0 centered at the marker position, matching the
  // box the rect design draws for a lone stop. RECT_BOX equals 3*R0 already.
  const singleBox = 3 * RECT_R0;
  const gap = box * 0.14;
  // Partition: stations whose EVERY mark has a drawn lane curve join the global
  // lane-true pool (each box slides only along its own line, cross-station
  // deconfliction included); the rest fall back to the abstract seater + the
  // rigid rescue. Singles without a lane stay put as static obstacles.
  const pool: LaneStation[] = [];
  const poolStations = new Map<string, RectSeatStation>();
  // Finite-input boundary: one non-finite coordinate poisons the whole shared
  // solve (a NaN part rect makes every overlap comparison false, and the
  // connector MST then indexes a rect it never picked). A station carrying a
  // non-finite mark, or producing a non-finite lane curve, is left unseated
  // and reported, so the rest of the map still seats and the log names the
  // offender for root-causing.
  const finitePt = (p?: Pixel): boolean => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  // A pooled box slides along its curve, so the curve must offer real arc to
  // slide on. When a line has no usable drawn lane at its flag node the curve
  // builder falls back to a synthetic sub-pixel stub; a box cannot seat on a
  // point, and its infinite lane distance used to poison the shared least
  // squares.
  const MIN_LANE_ARC = 0.5;
  const usableCurve = (li: LaneItem): boolean => {
    const total = li.curve.cum[li.curve.cum.length - 1];
    return Number.isFinite(li.t0) && Number.isFinite(li.curve.anchorT) &&
      Number.isFinite(total) && total >= MIN_LANE_ARC;
  };
  // A mark whose lane is missing or degenerate (a terminus stub consumed by the
  // corner joins, for instance) is PINNED instead of evicting its whole station
  // into the abstract fallback: it enters the pool on a point curve at its own
  // stop, so it cannot slide anywhere, least of all past its line's end, and
  // the station's other members still seat lane-true.
  const pinnedItem = (lineId: string, pos: Pixel): LaneItem => ({
    lineId,
    curve: { pts: [[pos[0], pos[1]], [pos[0] + 1e-6, pos[1]]], cum: [0, 1e-6], anchorT: 0 },
    t0: 0,
  });
  for (const s of gathered) {
    if (s.marks.length === 0) continue;
    if (s.marks.some((m) => (m.pos && !finitePt(m.pos)) || (m.home && !finitePt(m.home)))) {
      console.warn('[ImprovedSchematics] rect seating: non-finite mark position at station ' + s.nodeId + '; left unseated');
      continue;
    }
    const items: LaneItem[] = [];
    let usable = 0;
    if (laneItemFor !== undefined && s.marks.every((m) => m.pos)) {
      for (const m of s.marks) {
        const li = m.flagNode ? laneItemFor(m.lineId, m.flagNode, m.pos as Pixel) : null;
        if (li && usableCurve(li)) { items.push(li); usable++; }
        else items.push(pinnedItem(m.lineId, m.pos as Pixel));
      }
    }
    // Pool when at least one member can really slide; an all-pinned station has
    // nothing to deconflict with and belongs to the abstract fallback below.
    if (usable > 0) {
      pool.push({ station: s.nodeId, items });
      poolStations.set(s.nodeId, s);
      continue;
    }
    if (s.marks.length === 1) {
      const m = s.marks[0];
      if (m.pos) singles.push({ nodeId: s.nodeId, pos: [m.pos[0], m.pos[1]], box: singleBox });
      continue;
    }
    // Fallback: abstract row seat from pre-solve homes (the cached capsule IS
    // the drawn shape for the rect design, and non-rectRows designs never read
    // it).
    if (!s.marks.every((m) => m.home && m.axis !== undefined)) continue;
    const members: RectMember[] = s.marks.map((m) => ({
      lineId: m.lineId, home: m.home as Pixel, axis: m.axis as number,
    }));
    rectByNode.set(s.nodeId, rectSeatToCapsule(rectSeat(members, box, gap), box));
    capDir.set(s.nodeId, dominantDir(s.marks));
  }
  // Fallback capsules and static singles deconflict rigidly first (the old
  // rescue), then their footprints become immovable obstacles for the pool.
  const tokyuStopPos = rescueRectAndSingles(rectByNode, singles, capDir);
  const obstacles: LaneObstacle[] = [];
  for (const [, cap] of rectByNode) {
    for (const g of cap.groups) obstacles.push({ x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h });
  }
  for (const s of singles) {
    const p = tokyuStopPos.get(s.nodeId)!;
    const h = s.box / 2;
    obstacles.push({ x0: p[0] - h, y0: p[1] - h, x1: p[0] + h, y1: p[1] + h });
  }
  // Global lane-true seat: every pooled box (single or interchange member)
  // deconflicts along its OWN lane against every other, then clusters into its
  // station's flush capsule parts. No box ever translates off its line.
  const seated = laneSeatAll(pool, box, gap, obstacles);
  for (const [nodeId, seat] of seated.byStation) {
    rectByNode.set(nodeId, rectSeatToCapsule(seat, box));
  }
  for (const st of pool) {
    if (st.items.length !== 1) continue;
    const p = seated.posByStation.get(st.station)?.[0];
    if (p) tokyuStopPos.set(st.station, [p[0], p[1]]);
  }
  return { rectByNode, tokyuStopPos };
}

export function renderRibbons(args: RenderRibbonsArgs, sceneOut?: SceneOut): string {
  return paintRibbons(args, computeRibbonGeometry(args), sceneOut);
}

// The expensive, toggle-INDEPENDENT half of the draw: per-edge lane bundle
// geometry + the rigid-row marker-placement solver (~80-90% of draw time). A pure
// function of the layout — it never reads showLabels/showStations/dark/stationRadius
// (those only drive the paint tail), so its result can be cached/hoisted into
// precompute. Verified by adversarial audit; see docs/cache-read-perf.md.
export function computeRibbonGeometry(args: RenderRibbonsArgs): RibbonGeometry {
  const { layout, nodePx, edgePolyline } = args;

  const stopsByNode = new Map<string, StopMark[]>();
  // Seat-ink oracle (I10), built inside the stations block from pre-marker
  // ink; held at function scope so the fanzone census can re-query final
  // mark positions at the end.
  let seatInkOracle: SeatInkOracle | undefined;
  // Platform-split groups: base nodeId -> its placement-unit nodeIds (the
  // shrunken primary keeps s.nodeId itself; each spun-off bundle carries
  // `s.nodeId + '::plat' + N`). Populated below, AFTER every slide/eviction
  // pass has finished mutating gathered[*].marks[*].pos — so the connectors
  // wired in paintRibbons read final dot positions, never pre-slide ones.
  const splitGroups = new Map<string, string[]>();
  // Precomputed rectangle placement for the full Tokyu stop set, filled after the
  // placement queue exhausts (marks' home/axis/pos final) so the seating and the
  // cross-station rescue run once here rather than on every repaint. Empty when
  // there are no station groups; always present on the returned geometry.
  let rectByNode = new Map<string, RectCapsule>();
  let tokyuStopPos = new Map<string, [number, number]>();
  // London bubble-chain interchange geometry, computed from the final marks (so
  // it is design-agnostic); consumed both by the London design and by its lane
  // crop below. Empty for non-station renders.
  let bubbleByNode = new Map<string, LondonCapsule>();
  // Toronto direct-intersection centers, from the final marks (design-agnostic);
  // consumed by the Toronto design to collapse a perfect crossing to one dot.
  let torontoByNode = new Map<string, TorontoCross>();
  // Per-capsule-regime lane crops: for each design regime that paints an opaque
  // interchange footprint (rectRows boxes, londonBubbles discs), the per-line 'd'
  // command arrays from a lane bundle cropped to that footprint, filled at emit
  // time. The node-connector pass appends to these arrays alongside dByLine, and
  // they are joined into croppedLaneByLine strings at the end. A design whose
  // regime is absent here reads dByLine, so it stays identical.
  const cropDPartsByRegime = new Map<string, Map<string, string[]>>();
  // The lane-crop targets per regime, gathered inside the station block (where the
  // marks and the shared-anchor guard live) and consumed after the draw-fillet
  // finalizes segPath. Empty for non-station renders.
  const cropTargetsByRegime = new Map<string, LaneCropTarget[]>();
  const stopSeen = new Set<string>();
  const segments: Segment[] = [];
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const lineById = new Map<string, { id: string; label?: string; color: string; textColor?: string }>();
  for (const e of layout.edges) for (const l of e.lines) if (!lineById.has(l.id)) lineById.set(l.id, l);

  // --- per-edge bundle drawing (LOOM transitmap model) -----------------------
  // Each edge draws its own bundle from its own lineOrder: slots are distinct
  // within one edge by construction, and imageMerge guarantees two distinct
  // edges never share drawn geometry — so same-coordinate overdraw (one line
  // invisible under another) is structurally impossible. The previous model
  // offset whole traversal runs by a global per-line constant, which flips
  // sides on winding runs and collided opposite-direction corridor sharers.
  // Retraced corridors are also free: an edge draws once per line no matter
  // how often the traversal passes over it.
  const spacing = LINE_WIDTH + LINE_GAP;
  const CHAIN_ARC_LIMIT = 24; // ±arc window per lane curve (~one grid cell)
  // Capsule-placement search-area expansion. When the base solve (±CHAIN_ARC_LIMIT)
  // fails to seat a station, the escalation retries at ±CHAIN_ARC_LIMIT·WIDE_MULT
  // (a wider slide window AND a longer lane curve to find a row-line crossing).
  // Default 2 = shipped behaviour. OCTI_WIDE_MULT lets us probe whether a
  // still-wider search recovers a seat (coincident- vs divergent-lane cases).
  const WIDE_MULT = (() => {
    const v = envNum('OCTI_WIDE_MULT');
    return Number.isFinite(v) && v >= 1 ? v : 2;
  })();
  const WIDE_ARC = CHAIN_ARC_LIMIT * WIDE_MULT;
  // Far-attach corridor tier (escalation stage 2 of the rewritten ladder):
  // when the PRIMARY solve fails and a multi-bundle station's bundles spread
  // beyond the primary window (far-apart platforms of one station group,
  // possible since per-station graph nodes), each bundle's row may slide
  // along its own corridor — coarse grid, half-corridor bounds — and the
  // chain DP joins the aligned rows into ONE capsule. OCTI_FAR_SLIDE=0
  // disables the tier (A/B: platform-split fallback only). OCTI_FAR_STEP =
  // coarse slide grid px (default 4); OCTI_FAR_CAP = lane-curve window cap px
  // (default 400) — bounds both the search and its cost.
  const farSlideOn =
    (envStr('OCTI_FAR_SLIDE')) !== '0';
  const FAR_STEP = (() => {
    const v = envNum('OCTI_FAR_STEP');
    return Number.isFinite(v) && v >= 1 ? v : 4;
  })();
  const FAR_CAP = (() => {
    const v = envNum('OCTI_FAR_CAP');
    return Number.isFinite(v) && v > 0 ? v : 400;
  })();
  // Max lateral lane-jog (in slot-widths) the node join pass will bridge with a
  // taper before giving up and leaving a raw diagonal. 8 = legacy; raised to 16
  // so a line sweeping most of the bundle (B's out-and-back at Montgomery) draws
  // contiguously. OCTI_GAP_MULT overrides.
  const bigGapMult = (() => {
    const v = envNum('OCTI_GAP_MULT');
    return Number.isFinite(v) && v > 0 ? v : 16;
  })();
  // Max corner extension per row, as a multiple of `spacing`. The ext1+ext2 cost
  // term in pairEval now keeps elbows short on its own (SOFT elbow), so extCap is
  // a large safety bound rather than a hard divergent-bundle reject. Raised 6→12
  // so the divergent NO-PAIRING hubs (Beach & Mason ms15, Columbus ms17) seat.
  const extCapMult = (() => {
    const v = envNum('OCTI_EXTCAP_MULT');
    return Number.isFinite(v) && v > 0 ? v : 12;
  })();
  const segPath = new Map<string, Pixel[]>(); // edge.id|lineId -> offset polyline
  // Per-line 'd' command arrays. Populated by emitLanes (via buildDByLine) and
  // then appended to by the node-connector pass; reassigned once by emitLanes,
  // hence `let`.
  let dByLine = new Map<string, string[]>();
  // Corner fillets: every interior bend of a lane polyline is rounded with a
  // small quadratic (control point = the original vertex), so 90° bundle
  // exits and 45° course bends read as smooth turns instead of hard elbows
  // (LOOM transitmap renders its lines smoothed the same way). Endpoints are
  // untouched — miter joins and connectors attach exactly as before.
  // One smoothing radius everywhere (interior fillets + node join curves):
  // large enough to read as a sweep next to a multi-lane bundle, clamped per
  // corner to the available segment length.
  const SMOOTH_R = LINE_WIDTH * 5;
  const FILLET_R = SMOOTH_R;

  // A line draws on an edge only if its traversal actually uses that edge —
  // edge.lineIds alone over-draws: merge walks and anchor splits leave line
  // ids painted on corridor remnants no service runs over (bare tails past a
  // terminus, stub "fingers" at hubs). Lines with NO traversal at all fall
  // back to drawing every edge that carries them (existence beats tails).
  const usesEdge = new Map<string, Set<string>>(); // lineId -> edgeIds
  for (const [lineId, traversal] of layout.lineTraversals) {
    const s = new Set<string>();
    for (const step of traversal) s.add(step.edgeId);
    if (s.size > 0) usesEdge.set(lineId, s);
  }
  const drawsOn = (lineId: string, edgeId: string): boolean => {
    const s = usesEdge.get(lineId);
    return s ? s.has(edgeId) : true;
  };

  // Drawn lane order per edge (lineOrder filtered to actually-drawn lines)
  // and centered slot offsets.
  const orderOf = new Map<string, string[]>();
  const slotOf = new Map<string, number>(); // edgeId|lineId -> centered offset px
  for (const edge of layout.edges) {
    const order = (edge.lineOrder.length > 0 ? edge.lineOrder : edge.lines.map((l) => l.id)).filter(
      (lineId) => lineById.has(lineId) && drawsOn(lineId, edge.id),
    );
    orderOf.set(edge.id, order);
    const center = (order.length - 1) / 2;
    order.forEach((lineId, i) => slotOf.set(edge.id + '|' + lineId, (i - center) * spacing));
  }

  // Lane-continuity bias: a join/leave changes the bundle's cardinality and
  // RECENTERS it, wobbling every continuing line by half a slot — packed
  // junction runs (downtown trunk: six nodes in ~70px) read as a braid even
  // with zero ordering changes. Give each edge one scalar lateral bias so
  // continuing lines keep their lateral position across nodes; the bundle
  // rides slightly off the corridor centerline instead of recentering at
  // every composition change.
  // Clamp rule: an edge may shift one slot freely, plus however far its
  // constraint mates already legitimately reach (their bias plus their half
  // width, recomputed each pass so an inherited shift can propagate and then
  // decay). A fixed one-slot clamp fails the thin continuation of a WIDE
  // bundle: its lines sit far out on the flank, the centered corridor forces
  // a multi-slot taper right where the turning lines' corner sweeps fan out,
  // and the two cross at shallow angles (painted clips). With the scaled
  // clamp the continuation exits at its seats and passes clear of the fan.
  // Sign care: lateral offsets apply along the from→to normal; traversing an
  // edge reversed flips the travel-frame sign.
  const biasOf = new Map<string, number>();
  {
    interface Cnstr { eA: string; sA: number; slotA: number; eB: string; sB: number; slotB: number }
    const constraints: Cnstr[] = [];
    for (const [lineId, traversal] of layout.lineTraversals) {
      if (!lineById.has(lineId)) continue;
      for (let i = 1; i < traversal.length; i++) {
        const a = traversal[i - 1];
        const b = traversal[i];
        if (a.edgeId === b.edgeId) continue;
        const ea = edgeById.get(a.edgeId);
        const eb = edgeById.get(b.edgeId);
        if (!ea || !eb) continue;
        const endA = a.reversed ? ea.from : ea.to;
        const startB = b.reversed ? eb.to : eb.from;
        if (endA !== startB) continue;
        const slotA = slotOf.get(a.edgeId + '|' + lineId);
        const slotB = slotOf.get(b.edgeId + '|' + lineId);
        if (slotA === undefined || slotB === undefined) continue;
        constraints.push({
          eA: a.edgeId,
          sA: a.reversed ? -1 : 1,
          slotA,
          eB: b.edgeId,
          sB: b.reversed ? -1 : 1,
          slotB,
        });
      }
    }
    const byEdge = new Map<string, Cnstr[]>();
    for (const c of constraints) {
      if (!byEdge.has(c.eA)) byEdge.set(c.eA, []);
      if (!byEdge.has(c.eB)) byEdge.set(c.eB, []);
      byEdge.get(c.eA)!.push(c);
      byEdge.get(c.eB)!.push(c);
    }
    const maxBias = spacing;
    // Widest lane offset each edge holds (its painted half width).
    const halfWidthOf = new Map<string, number>();
    for (const [eid, order] of orderOf) {
      halfWidthOf.set(eid, ((order.length - 1) / 2) * spacing);
    }
    const edgeIds = [...byEdge.keys()].sort();
    for (let pass = 0; pass < 12; pass++) {
      let moved = 0;
      for (const eid of edgeIds) {
        let sum = 0;
        let n = 0;
        let cap = maxBias;
        for (const c of byEdge.get(eid)!) {
          const mate = c.eA === eid ? c.eB : c.eA;
          const reach = Math.abs(biasOf.get(mate) ?? 0) + (halfWidthOf.get(mate) ?? 0);
          if (reach > cap) cap = reach;
          if (c.eA === eid) {
            // sA*(slotA + bA) = sB*(slotB + bB)  =>  bA = sA*K - slotA
            const k = c.sB * (c.slotB + (biasOf.get(c.eB) ?? 0));
            sum += c.sA * k - c.slotA;
            n++;
          } else {
            const k = c.sA * (c.slotA + (biasOf.get(c.eA) ?? 0));
            sum += c.sB * k - c.slotB;
            n++;
          }
        }
        if (n === 0) continue;
        const target = Math.max(-cap, Math.min(cap, sum / n));
        const cur = biasOf.get(eid) ?? 0;
        if (Math.abs(target - cur) > 0.05) moved++;
        biasOf.set(eid, target);
      }
      if (moved === 0) break;
    }
  }

  const chains = detectChains({
    edges: layout.edges,
    basePoly: (id) => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    },
    laneCount: (id) => orderOf.get(id)?.length ?? 0,
    spacing,
  });
  reportChains({ chains, nodePx, edgeById });
  // Chain seat policy (invariant I3, chains spec; default ON, OCTI_CHAIN=0
  // is the escape hatch to the pre-chain slot+bias seating): interior
  // edges of a chain take their lane offsets from the chain's shared seat
  // ladder instead of slot+bias, so interior bias seams vanish and the
  // seams at the chain ends are ordinary jogs the fan already closes.
  const chainSeatRes = envStr('OCTI_CHAIN') !== '0'
    ? computeChainSeats({
      chains,
      edgeById,
      basePoly: (id) => {
        const e = edgeById.get(id);
        return e ? edgePolyline(e) : undefined;
      },
      laneOffsetOf: (edgeId, lineId) => {
        const slot = slotOf.get(edgeId + '|' + lineId);
        if (slot === undefined) return undefined;
        return slot + (biasOf.get(edgeId) ?? 0);
      },
      lineTraversals: layout.lineTraversals,
      spacing,
      halfWidthOf: (id) => Math.max(0, (((orderOf.get(id)?.length ?? 1) - 1) / 2) * spacing),
      drawnEdgeIds: layout.edges.filter((e) => (orderOf.get(e.id)?.length ?? 0) > 0).map((e) => e.id),
    })
    : null;
  const chainSeatOf = chainSeatRes?.seats ?? new Map<string, number>();
  reportChainSeats({
    report: chainSeatRes?.report ?? [],
    nodePx,
    edgeById,
    pairs: chainSeatRes?.pairs,
    basePoly: (id) => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    },
    halfWidthOf: (id) => Math.max(0, (((orderOf.get(id)?.length ?? 1) - 1) / 2) * spacing),
    spacing,
  });

  for (const edge of layout.edges) {
    const base = edgePolyline(edge);
    if (base.length < 2) continue;
    const order = orderOf.get(edge.id) ?? [];
    const bias = biasOf.get(edge.id) ?? 0;
    for (let i = 0; i < order.length; i++) {
      const lineId = order[i];
      const o = chainSeatOf.get(edge.id + '|' + lineId) ?? ((slotOf.get(edge.id + '|' + lineId) ?? 0) + bias);
      const poly =
        Math.abs(o) < 1e-9
          ? base.map((p) => p.slice() as Pixel)
          : offsetPolyline(base, o, /*simplify*/ false);
      segPath.set(edge.id + '|' + lineId, poly);
    }
  }
  reportLaneSeats({ orderOf, slotOf, biasOf, segPath });

  // Jog-dominated sliver suppression: merge can leave a line a tiny edge
  // (one grid sliver) sandwiched between two corridors — the 9's 9px hop
  // from the red trunk to its Butler St anchor. The lane piece on such an
  // edge sits laterally offset from BOTH neighbours' lane endpoints, and
  // the two connectors needed to reach it cost more ink than the piece
  // itself (the dangling-stub artifact). Don't draw a short piece whose
  // end jogs sum to more than its own length — the node connectors bridge
  // the neighbours directly. Micro edges of a dense corridor keep their
  // pieces: their lanes continue at the same slots, so the jogs are ~0.
  const suppressed = new Set<string>(); // edgeId|lineId
  {
    const arcOf = (poly: Pixel[]): number => {
      let acc = 0;
      for (let i = 1; i < poly.length; i++) {
        acc += hyp(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      }
      return acc;
    };
    // Phase 1: detect candidates against the PRISTINE segPath. (Two-phase so
    // the sibling test below sees the full picture, and jog measurements are
    // order-independent — the old in-loop delete let an earlier suppression
    // hide a later line's neighbour endpoint.)
    const candidates: Array<{ key: string; edgeId: string }> = [];
    const candidateKeys = new Set<string>();
    for (const [lineId, traversal] of layout.lineTraversals) {
      if (!lineById.has(lineId)) continue;
      const endAt = (eid: string, nd: string): Pixel | null => {
        const p = segPath.get(eid + '|' + lineId);
        const ee = edgeById.get(eid);
        if (!p || !ee) return null;
        return ee.from === nd ? p[0] : ee.to === nd ? p[p.length - 1] : null;
      };
      for (let i = 0; i < traversal.length; i++) {
        const step = traversal[i];
        const e = edgeById.get(step.edgeId);
        if (!e) continue;
        const key = e.id + '|' + lineId;
        if (candidateKeys.has(key)) continue;
        const poly = segPath.get(key);
        if (!poly) continue;
        const arc = arcOf(poly);
        if (arc >= spacing * 2.5) continue;
        const nodeA = step.reversed ? e.to : e.from;
        const nodeB = step.reversed ? e.from : e.to;
        let jog = 0;
        for (const [k, nd] of [[i - 1, nodeA], [i + 1, nodeB]] as Array<[number, string]>) {
          if (k < 0 || k >= traversal.length) continue;
          const ee = edgeById.get(traversal[k].edgeId);
          if (!ee || ee.id === e.id) continue;
          const mine = endAt(e.id, nd);
          const theirs = endAt(ee.id, nd);
          if (mine && theirs) jog += hyp(mine[0] - theirs[0], mine[1] - theirs[1]);
        }
        if (jog <= arc * 0.6) continue;
        candidates.push({ key, edgeId: e.id });
        candidateKeys.add(key);
      }
    }
    // Phase 2: delete a candidate ONLY when no co-drawn sibling on the same
    // edge survives. The heuristic targets a LONE dangling sliver (the 9's 9px
    // Butler St hop); an interlined bundle member whose sibling keeps its
    // piece is NOT a stub — deleting just one lane of the pair cuts that line
    // visibly in half, and at the adjacent interchange its marker loses the
    // suppressed direction's lane tangent, flipping the grouping axis and
    // bending the capsule into its neighbour's seat space (LON Coombe
    // Gardens/Arterberry Rd: the 2-line's 11px piece on me466 jogged 11.19 >
    // 6.93 while the interlined 1-line's piece survived → cut line → bent
    // 19px capsule → capsule cross → unseatable retry). The surviving sibling
    // proves the corridor is genuinely drawn there.
    for (const { key, edgeId } of candidates) {
      const e = edgeById.get(edgeId);
      let siblingSurvives = false;
      if (e) {
        for (const l of e.lines) {
          const k2 = edgeId + '|' + l.id;
          if (k2 !== key && segPath.has(k2) && !candidateKeys.has(k2)) { siblingSurvives = true; break; }
        }
      }
      if (siblingSurvives) continue;
      suppressed.add(key);
      segPath.delete(key);
    }
  }

  // The drawn-lane order map was built from drawsOn, BEFORE jog-sliver
  // suppression removed lane ends from segPath. Re-filter it to the lanes that
  // actually survived so every later consumer (node lane-degree counts and the
  // node-connector bundle-span cap) measures drawn lanes only, not slivers that
  // were dropped. Only touches edges that lost a lane, so untouched hubs are
  // unchanged.
  if (suppressed.size > 0) {
    for (const [edgeId, order] of orderOf) {
      const kept = order.filter((lineId) => segPath.has(edgeId + '|' + lineId));
      if (kept.length !== order.length) orderOf.set(edgeId, kept);
    }
  }

  // Joint seating over overlapped parallel corridor spans (invariant I4):
  // where a warp compressed two hub-rooted corridors to near-parallel
  // inside each other's painted reach, their lanes re-seat as ONE combined
  // bundle along the shared stretch, fading back to their own frames where
  // the corridors genuinely part. Whole-edge bias separation was falsified
  // for this family; the re-seat is per-span and lane-local. OCTI_JOINT=0
  // disables.
  if (envStr('OCTI_JOINT') !== '0') {
    const polyOfEdge = (id: string): Pixel[] | undefined => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    };
    const sepPairs = findParallelPairs(
      layout.edges.filter((e) => (orderOf.get(e.id)?.length ?? 0) > 0).map((e) => e.id),
      polyOfEdge,
      (id) => Math.max(0, (((orderOf.get(id)?.length ?? 1) - 1) / 2) * spacing),
      spacing,
      (id) => {
        const e = edgeById.get(id);
        return e ? [e.from, e.to] : undefined;
      },
    );
    // OCTI_JOINT=trace prints the pairs (expected: a handful per map; a
    // large count means the detector regressed into legitimate geometry).
    if (envStr('OCTI_JOINT') === 'trace') {
      console.error(`[joint] ${sepPairs.length} pairs`, sepPairs.map((p) => `${p.eA}x${p.eB} d0=${p.d0.toFixed(1)} need=${p.needed.toFixed(1)}`).join('; '));
    }
    applyJointSeating({ pairs: sepPairs, polyOf: polyOfEdge, orderOf, segPath, spacing });
  }

  // Join pass: where a line continues across a node, trim the two lane ends
  // back from the intersection of their end segments and bridge them with a
  // quadratic through the corner apex — the lane sweeps around the node like
  // an interior fillet instead of snapping to a sharp miter point (the user's
  // "90 degree bends at bundle ends"). Near-parallel ends (a genuine lateral
  // lane jog) and over-limit corners keep the S connector below. Endpoints
  // move at most once. Stops at join nodes draw at the curve's midpoint (on
  // the line), not the trimmed endpoint.
  const mitered = new Set<string>(); // lineId|node|pairKey
  const endMoved = new Set<string>(); // edgeId|lineId|end
  const joinCurves: Array<{ lineId: string; node: string; a: Pixel; apex: Pixel; b: Pixel; edgeA?: string; edgeB?: string }> = [];
  const joinStopPos = new Map<string, Pixel>(); // nodeId|lineId -> on-curve position
  // Proper-crossing intersection point of segments p1p2 and p3p4, else null.
  // Strict opposite orientations both sides → collinear/touching pairs reject.
  // Cross-products + one divide only (correctly-rounded, cross-V8 stable).
  const segCross = (p1: Pixel, p2: Pixel, p3: Pixel, p4: Pixel): Pixel | null => {
    const o = (a: Pixel, b: Pixel, c: Pixel): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    if (!(((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))) return null;
    const den = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / den;
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  };
  // Infinite-line intersection of the line through `pa` along `da` and the line
  // through `pb` along `db` (unit dirs). Returns the meet point, or null when the
  // lines are (near-)parallel. Used to MITER an out-and-back/sharp lane TURN at a
  // 45/90-degree octilinear corner: each lane runs octilinear up to its end, so
  // pinning both ends to the shared meet point keeps both legs octilinear while
  // removing the overshoot spike and the chord that crossed the outgoing lane.
  const lineMeet = (pa: Pixel, da: Pixel, pb: Pixel, db: Pixel): Pixel | null => {
    const den = da[0] * db[1] - da[1] * db[0]; // cross(da, db)
    if (Math.abs(den) < 1e-6) return null;
    const t = ((pb[0] - pa[0]) * db[1] - (pb[1] - pa[1]) * db[0]) / den;
    return [pa[0] + da[0] * t, pa[1] + da[1] * t];
  };
  // The eight octilinear unit directions (E/W/N/S + the four 45-degree
  // diagonals). SQRT1_2 keeps the diagonals exactly unit-length so a snapped
  // direction stays octilinear under the dot/length tests below. Deterministic:
  // a literal, no hypot.
  const SQ = Math.SQRT1_2;
  const OCTI8: Pixel[] = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [SQ, SQ], [SQ, -SQ], [-SQ, SQ], [-SQ, -SQ],
  ];
  // Snap an arbitrary unit dir to the nearest of the 8 octilinear dirs (the lane
  // ends already run octilinear, so this just removes sub-pixel rounding drift).
  const snapOcti = (d: Pixel): Pixel => {
    let best = OCTI8[0];
    let bd = -Infinity;
    for (const o of OCTI8) {
      const dot = d[0] * o[0] + d[1] * o[1];
      if (dot > bd) { bd = dot; best = o; }
    }
    return best;
  };
  // FORWARD-turn dogleg: a turn where the inbound lane (heading dirA) and the
  // outbound lane (heading dirB) make a ~45-degree forward bend (dirA.dirB>0) but
  // sit at DIFFERENT lateral slots, so a single octilinear corner cannot bridge
  // them without reversing a leg (the turn-miter declines: its meet lands forward
  // of the inbound end or behind the outbound end). The octilinear answer routes a
  // diagonal D from the inbound end to a bend B2 on the outbound line, then
  // continues along dirB. We pick the octi direction D whose two bends (dirA->D and
  // D->dirB) are both multiples of 45 degrees, preferring the FEWEST bends — a
  // `collinearIn` D extends the inbound straight into a SINGLE clean corner (no
  // stub), versus a genuine two-bend dogleg whose perpendicular stub protrudes from
  // the parallel bundle. Returns B2, the chosen D, and whether the inbound leg is
  // collinear (so the caller can apply only the clean single-corner variant), or
  // null when no octi route exists (then the caller declines and the S stands).
  const findDogleg = (
    qa: Pixel, dirA: Pixel, qb: Pixel, dirB: Pixel, cap: number,
  ): { B2: Pixel; D: Pixel; collinearIn: boolean } | null => {
    let best: { B2: Pixel; D: Pixel; collinearIn: boolean; bends: number; len: number } | null = null;
    for (const D of OCTI8) {
      // B2 = ray(qa, D) intersect line(qb, dirB).  t = distance along D from qa,
      // s = signed distance along dirB from qb.
      const den = D[0] * dirB[1] - D[1] * dirB[0];
      if (Math.abs(den) < 1e-6) continue; // D parallel to outbound: no unique bend
      const t = ((qb[0] - qa[0]) * dirB[1] - (qb[1] - qa[1]) * dirB[0]) / den;
      if (t < 0.5) continue; // B2 must lie strictly forward of qa along D
      const s = ((qb[0] - qa[0]) * D[1] - (qb[1] - qa[1]) * D[0]) / den;
      const bendIn = dirA[0] * D[0] + dirA[1] * D[1];   // cos(turn at qa)
      const bendOut = D[0] * dirB[0] + D[1] * dirB[1];  // cos(turn at B2)
      // Reject reversals (180) and sharper-than-135 kinks at either bend.
      if (bendIn < -0.5 || bendOut < -0.5) continue;
      const B2: Pixel = [qa[0] + D[0] * t, qa[1] + D[1] * t];
      // Cap both legs so a near-parallel / runaway pair declines (keeps the S).
      if (t > cap || Math.abs(s) > cap) continue;
      const collinearIn = bendIn > 0.99;
      // Prefer the route with the FEWEST real bends: a collinear-in D extends the
      // inbound straight into a SINGLE clean corner (no vertical/lateral stub poking
      // out of the bend); only when no such route exists do we take the genuine
      // two-bend dogleg. Break ties by least added length.
      const bends = (collinearIn ? 0 : 1) + (bendOut > 0.99 ? 0 : 1);
      const len = t + Math.abs(s);
      if (!best || bends < best.bends || (bends === best.bends && len < best.len)) {
        best = { B2, D, collinearIn, bends, len };
      }
    }
    return best ? { B2: best.B2, D: best.D, collinearIn: best.collinearIn } : null;
  };
  // OCTI_NO_TURNMITER=1 A/B-disables the octilinear turn miter (default ON).
  const noTurnMiter =
    envStr('OCTI_NO_TURNMITER') === '1';
  // OCTI_NO_DOGLEG=1 A/B-disables the forward-turn two-bend dogleg (default ON),
  // independently of the turn miter.
  const noDogleg =
    envStr('OCTI_NO_DOGLEG') === '1';
  const JOIN_TRACE = joinTraceTarget();
  // Fan builder (default): every corner computed once per (junction, turn
  // group) with a shared trim and fan-reach gates, so bundle-mates get
  // nested sweeps by construction (see src/render/fanJoin.ts and
  // docs/draw-geometry-invariants.md). OCTI_FAN=0 runs the legacy per-line
  // join ladder below instead, kept for A/B until the rebuild is signed off.
  const useFanJoins = envStr('OCTI_FAN') !== '0';
  let fanZones: Array<{ node: string; edgeA: string; edgeB: string; reach: number }> = [];
  if (useFanJoins) {
    const fan = buildFanJoins({
      lineTraversals: layout.lineTraversals,
      lineIds: new Set(lineById.keys()),
      edgeById, segPath, suppressed, orderOf, biasOf, nodePx,
      spacing, smoothR: SMOOTH_R, bigGapMult,
      baseEndDir: (edgeId, node) => {
        const e = edgeById.get(edgeId);
        if (!e) return null;
        const base = edgePolyline(e);
        if (base.length < 2) return null;
        const atStart = e.from === node;
        if (!atStart && e.to !== node) return null;
        const a = atStart ? base[0] : base[base.length - 1];
        const b = atStart ? base[1] : base[base.length - 2];
        const l = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
        return l > 1e-6 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
      },
    });
    for (const c of fan.joinCurves) joinCurves.push(c);
    for (const [k, v] of fan.joinStopPos) joinStopPos.set(k, v);
    for (const k of fan.endMoved) endMoved.add(k);
    for (const k of fan.mitered) mitered.add(k);
    fanZones = fan.zones;
    reportFanZones({
      zones: fan.zones,
      tapers: fan.tapers,
      edgeById,
      arcOf: (edgeId) => {
        const e = edgeById.get(edgeId);
        if (!e) return 0;
        const base = edgePolyline(e);
        let arc = 0;
        for (let i = 1; i < base.length; i++) {
          arc += Math.sqrt((base[i][0] - base[i - 1][0]) ** 2 + (base[i][1] - base[i - 1][1]) ** 2);
        }
        return arc;
      },
      nodePx,
    });
    // Multi-edge corner absorption erases consumed micro lanes from segPath;
    // re-filter the drawn order so every later consumer (marker lane counts,
    // connector spans, paint groups) measures surviving lanes only, exactly
    // as after jog-sliver suppression above.
    for (const [edgeId, order] of orderOf) {
      const kept = order.filter((lineId) => segPath.has(edgeId + '|' + lineId));
      if (kept.length !== order.length) orderOf.set(edgeId, kept);
    }
  }
  if (!useFanJoins) for (const [lineId, traversal] of layout.lineTraversals) {
    if (!lineById.has(lineId)) continue;
    const jlog = makeJoinLog(JOIN_TRACE, lineId);
    // A CLOSED circular course meets itself at its seam node: the pair
    // (last step, first step) is a real corner there, but consecutive-pair
    // iteration never visits it and the two lane ends stop short of each
    // other unjoined. Append the wrap pair for circular traversals; an
    // out-and-back course also ends where it starts but its seam pair
    // retraces ONE edge, which the same-edge guard below already skips.
    let wrap = 0;
    if (traversal.length > 1) {
      const f = traversal[0];
      const l = traversal[traversal.length - 1];
      const ef = edgeById.get(f.edgeId);
      const el = edgeById.get(l.edgeId);
      const firstStart = f.reversed ? ef?.to : ef?.from;
      const lastEnd = l.reversed ? el?.from : el?.to;
      if (firstStart !== undefined && firstStart === lastEnd) wrap = 1;
    }
    for (let i = 1; i < traversal.length + wrap; i++) {
      const a = traversal[i - 1];
      const b = traversal[i % traversal.length];
      if (a.edgeId === b.edgeId) continue;
      const ea = edgeById.get(a.edgeId);
      const eb = edgeById.get(b.edgeId);
      if (!ea || !eb) continue;
      const endA = a.reversed ? ea.from : ea.to;
      const startB = b.reversed ? eb.to : eb.from;
      if (endA !== startB) continue;
      const pA = segPath.get(a.edgeId + '|' + lineId);
      const pB = segPath.get(b.edgeId + '|' + lineId);
      if (!pA || !pB) continue;
      const aAtStart = ea.from === endA;
      const bAtStart = eb.from === endA;
      const keyA = a.edgeId + '|' + lineId + '|' + (aAtStart ? 's' : 'e');
      const keyB = b.edgeId + '|' + lineId + '|' + (bAtStart ? 's' : 'e');
      if (endMoved.has(keyA) || endMoved.has(keyB)) continue;
      const join = curveLaneJoin(pA, aAtStart, pB, bAtStart, SMOOTH_R, spacing * 4);
      if (JOIN_TRACE === lineId) {
        const qaT = aAtStart ? pA[0] : pA[pA.length - 1];
        const qbT = bAtStart ? pB[0] : pB[pB.length - 1];
        jlog(`${endA} gap=${hyp(qbT[0] - qaT[0], qbT[1] - qaT[1]).toFixed(1)} join=${join ? 'CURVE' : 'null'} nA=${pA.length} nB=${pB.length}`);
      }
      if (join) {
        endMoved.add(keyA);
        endMoved.add(keyB);
        const pairKey = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
        mitered.add(lineId + '|' + endA + '|' + pairKey);
        joinCurves.push({ lineId, node: endA, a: join.a, apex: join.apex, b: join.b });
        const stopKey = endA + '|' + lineId;
        if (!joinStopPos.has(stopKey)) {
          // quadratic midpoint Q(0.5) = (a + 2*apex + b) / 4 — on the curve
          joinStopPos.set(stopKey, [
            (join.a[0] + 2 * join.apex[0] + join.b[0]) / 4,
            (join.a[1] + 2 * join.apex[1] + join.b[1]) / 4,
          ]);
        }
        continue;
      }
      // Near-parallel continuation with a lateral lane jog (bundle
      // composition changes across the node): absorb the jog into a long
      // drift along both edges instead of an S-wiggle at the node — both
      // lane ends taper to the shared midpoint.
      const qa = aAtStart ? pA[0] : pA[pA.length - 1];
      const qa1 = aAtStart ? pA[1] : pA[pA.length - 2];
      const qb = bAtStart ? pB[0] : pB[pB.length - 1];
      const qb1 = bAtStart ? pB[1] : pB[pB.length - 2];
      const gap = hyp(qb[0] - qa[0], qb[1] - qa[1]);
      // Upper bound raised spacing*8 → spacing*16: a large lateral jog (a line
      // sweeping most of the bundle width across a node, e.g. B's out-and-back at
      // Montgomery, gap≈44px=8 slots) used to fall past spacing*8 and get NO
      // connector — drawn as a raw diagonal hidden under the trunk lanes (the
      // non-contiguity). Allow it through to the taper branch so it draws as a
      // contiguous slant. The absolute cap still rejects pathological cross-canvas
      // jumps. OCTI_GAP_MULT overrides the multiple (8 = legacy/off).
      if (gap < 0.5 || gap > spacing * bigGapMult) { jlog(`  ${endA} CONTINUE gap=${gap.toFixed(1)} (out of [0.5, ${(spacing * bigGapMult).toFixed(0)}])`); continue; }
      const lenA = hyp(qa[0] - qa1[0], qa[1] - qa1[1]);
      const lenB = hyp(qb[0] - qb1[0], qb[1] - qb1[1]);
      if (lenA < 1e-6 || lenB < 1e-6) continue;
      // directions: A pointing INTO the node, B pointing OUT
      const dirA: Pixel = [(qa[0] - qa1[0]) / lenA, (qa[1] - qa1[1]) / lenA];
      const dirB: Pixel = [(qb1[0] - qb[0]) / lenB, (qb1[1] - qb[1]) / lenB];
      const dot = dirA[0] * dirB[0] + dirA[1] * dirB[1];
      jlog(`  ${endA} gap=${gap.toFixed(1)} dot=${dot.toFixed(2)} ${dot < 0.85 ? 'SHARP(uncross/S)' : 'taper-branch'}`);
      if (dot < 0.85) {
        // Genuine sharp corner the join rejected. If the two lane end-segments
        // CROSS — the inside of the turn, where the line's slot jogs across the
        // bend and the lanes sweep over each other into a self-loop (a
        // fused-station hook: Chicago Blue A at Chestnut St, Harvey Rd) — clip
        // both ends to the crossing point so the lanes MEET there instead of
        // overshooting. The shared meet point needs no connector (mark mitered).
        // Non-crossing sharp corners fall through to the S connector unchanged.
        // (Filleting these bends instead — a curveLaneJoin with/without the
        // multi-segment cut-back — was tried twice and reverted: the bend sits
        // AT a fused-station node, so the fillet's lane trim + relocated stop
        // break the rigid-row marker. Only this minimal end-move is safe.)
        // Browser-safe env guard: `process` is undefined in the game renderer.
        const noUncross =
          envStr('OCTI_NO_UNCROSS') === '1';
        const X = noUncross ? null : segCross(qa1, qa, qb1, qb);
        if (X && !endMoved.has(keyA) && !endMoved.has(keyB)) {
          if (aAtStart) pA[0] = X; else pA[pA.length - 1] = X;
          if (bAtStart) pB[0] = X; else pB[pB.length - 1] = X;
          endMoved.add(keyA);
          endMoved.add(keyB);
          const pk = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
          mitered.add(lineId + '|' + endA + '|' + pk);
          continue;
        }
        // Non-crossing sharp TURN where the two lane ends sit at DIFFERENT
        // lateral slots (the out-and-back fold: F at Ferry comes in heading east
        // on the Embarcadero bundle, leaves heading NW on the Market diagonal,
        // its two lanes ~18px apart on opposite sides of the node). The old S
        // connector bridged that lateral gap with a near-vertical chord — a
        // regressive dart to a spike tip that then CROSSED the outgoing lane (the
        // teardrop loop). Miter it instead: each lane is octilinear right up to
        // its end, so the line through each end along its own octi direction meets
        // its partner at a clean 45/90-degree corner. Pin both ends to that meet
        // point: the overshoot (spike) and the crossing chord (loop) both vanish,
        // and both legs stay octilinear. Guarded to a real turn (dirs not
        // collinear) with a bounded, forward-sensible corner so it never balloons.
        if (!noTurnMiter && !endMoved.has(keyA) && !endMoved.has(keyB)) {
          const C = lineMeet(qa, dirA, qb, dirB);
          if (C) {
            const dispA = hyp(C[0] - qa[0], C[1] - qa[1]);
            const dispB = hyp(C[0] - qb[0], C[1] - qb[1]);
            // The meet must land inside the corner's own fan so a
            // near-parallel pair (intersection far away) keeps the S
            // connector. The fan's reach is set by the REAL geometry: the
            // meet of two offset lanes sits within the two bundles' combined
            // half widths divided by the sine of the turn angle (an obtuse
            // hairpin turn slides the meet much further out than a right
            // angle, cot of the half angle, which the sine bound covers with
            // margin). Fixed caps, and per-line slot caps with a fixed
            // obliquity factor, both failed real corners: the outermost line
            // of a wide bundle at a right angle, then any line of a wide
            // trunk at a hairpin; each declined miter leaves raw lane pieces
            // that cross each other as a painted mini-loop or triangle.
            const halfWidthOf = (edgeId: string): number => {
              const n = orderOf.get(edgeId)?.length ?? 1;
              return ((n - 1) / 2) * spacing + Math.abs(biasOf.get(edgeId) ?? 0);
            };
            const den = Math.abs(dirA[0] * dirB[1] - dirA[1] * dirB[0]);
            const fanReach =
              (halfWidthOf(a.edgeId) + halfWidthOf(b.edgeId) + 2 * spacing) / Math.max(den, 0.5);
            const capA = Math.max(spacing * 6, lenA, fanReach);
            const capB = Math.max(spacing * 6, lenB, fanReach);
            // the corner must lie BEHIND the inbound end (clip/retract, not extend
            // past it forward) and AHEAD of the outbound end — i.e. on the turn's
            // inside — so the legs shorten into the bend rather than overshoot it
            const behindA = (C[0] - qa[0]) * dirA[0] + (C[1] - qa[1]) * dirA[1] <= 0.01 * lenA;
            const aheadB = (C[0] - qb[0]) * dirB[0] + (C[1] - qb[1]) * dirB[1] >= -0.01 * lenB;
            if (dispA <= capA && dispB <= capB && behindA && aheadB) {
              // Pin each lane's node end to C, but first pop any trailing
              // (near-)collinear vertices that C retracts PAST — otherwise the
              // last segment folds back on itself (a 3-6px nub poking out of the
              // corner: F's inbound run is straight horizontal, so its
              // penultimate point sits east of C). Stop popping at a genuine bend
              // (the leg's straight run ended) or when only the corner remains.
              const setEnd = (poly: Pixel[], atStart: boolean, dir: Pixel, pt: Pixel) => {
                if (atStart) {
                  while (poly.length > 2 && (pt[0] - poly[1][0]) * dir[0] + (pt[1] - poly[1][1]) * dir[1] <= 0) poly.shift();
                  poly[0] = pt;
                } else {
                  while (poly.length > 2 && (pt[0] - poly[poly.length - 2][0]) * dir[0] + (pt[1] - poly[poly.length - 2][1]) * dir[1] <= 0) poly.pop();
                  poly[poly.length - 1] = pt;
                }
              };
              // inbound retracts along -dirA (dirA points INTO the node), so the
              // surviving penultimate must lie BEFORE C along dirA; outbound
              // extends/retracts along dirB (points OUT of the node)
              setEnd(pA, aAtStart, dirA, C);
              setEnd(pB, bAtStart, [-dirB[0], -dirB[1]], C);
              endMoved.add(keyA);
              endMoved.add(keyB);
              const pk = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
              mitered.add(lineId + '|' + endA + '|' + pk);
              jlog(`  ${endA} TURN-MITER C=(${C[0].toFixed(1)},${C[1].toFixed(1)}) dispA=${dispA.toFixed(1)} dispB=${dispB.toFixed(1)}`);
              continue;
            }
          }
        }
        // FORWARD-turn dogleg (the single-corner miter declined above): the two
        // lane ends make a forward ~45-degree bend at different lateral slots, so
        // we route an octilinear dogleg through a bend point B2 on the outbound
        // line instead of letting the pair fall to the darting S chord. Only fires
        // for a genuinely forward turn (dot>0) — the regressive case is the miter's
        // job and must stay there.
        //
        // We APPLY only the single-corner (collinear-in) variant: the inbound run
        // extends straight into ONE clean 45/90-degree corner on the outbound line
        // (B at Montgomery mn130). That is provably clean — no stub pokes out of
        // the bend. The genuine TWO-bend variant (no collinear D exists: H at
        // Embarcadero mn4, E at 4th&King mn132) routes a perpendicular stub whose
        // length protrudes from the parallel through-bundle — it trades the lateral
        // S-dart for a stub spike (E mn132) or, worse, a self-loop where the stub
        // re-crosses the line's return pass at the stacked neighbouring turn. So we
        // DECLINE the two-bend case (keep the prior S connector) per the
        // "decline gracefully when no clean octilinear route exists" rule, rather
        // than emit a fresh spike/loop. (findDogleg still reports it for the trace.)
        if (!noDogleg && dot > 0 && !endMoved.has(keyA) && !endMoved.has(keyB)) {
          const sdirA = snapOcti(dirA);
          const sdirB = snapOcti(dirB);
          const cap = Math.max(spacing * 6, lenA, lenB);
          const dl = findDogleg(qa, sdirA, qb, sdirB, cap);
          if (dl && !dl.collinearIn) {
            jlog(`  ${endA} DOGLEG-DECLINE (two-bend, would stub) B2=(${dl.B2[0].toFixed(1)},${dl.B2[1].toFixed(1)})`);
          }
          // Corridor-aware clamp: the bend corner B2 sits ON the outbound line, so
          // it must fall strictly BETWEEN this node and the outbound edge's FAR
          // node — never past the far end. A B2 that overshoots the far node pins
          // the outbound lane's start beyond where the lane can go, forcing the
          // short outbound micro-edge to run AGAINST its own corridor direction to
          // reach its far node; the next edge then returns, and the far-node
          // connector closes an out-and-back self-loop (SEA route X at Pacific Av
          // mn226: B2 x=651.8 overshot me204's far node mn224 x=662.8 across a 9px
          // edge, an antiparallel-chord loop). Decline the dogleg in that case →
          // fall through to the S connector, which draws the pair straight.
          let doglegOvershoots = false;
          if (dl && dl.collinearIn) {
            const farNodeId = eb.from === startB ? eb.to : eb.from;
            const farPx = nodePx.get(farNodeId);
            if (farPx) {
              // project along the outbound direction from the shared node (qb)
              const projB2 = (dl.B2[0] - qb[0]) * sdirB[0] + (dl.B2[1] - qb[1]) * sdirB[1];
              const projFar = (farPx[0] - qb[0]) * sdirB[0] + (farPx[1] - qb[1]) * sdirB[1];
              if (projB2 > projFar - spacing / 2) {
                doglegOvershoots = true;
                jlog(`  ${endA} DOGLEG-DECLINE (B2 overshoots outbound far node ${farNodeId}) projB2=${projB2.toFixed(1)} projFar=${projFar.toFixed(1)} B2=(${dl.B2[0].toFixed(1)},${dl.B2[1].toFixed(1)})`);
              }
            }
          }
          if (dl && dl.collinearIn && !doglegOvershoots) {
            const { B2, D } = dl;
            // Inbound side (collinear: D continues the inbound run straight into the
            // corner): move the node-end forward to B2, popping any inbound vertices
            // the extension passes so the leg never folds back on itself.
            const extendInbound = (poly: Pixel[], atStart: boolean) => {
              if (atStart) {
                while (poly.length > 2 && (B2[0] - poly[1][0]) * sdirA[0] + (B2[1] - poly[1][1]) * sdirA[1] <= 0) poly.shift();
                poly[0] = B2;
              } else {
                while (poly.length > 2 && (B2[0] - poly[poly.length - 2][0]) * sdirA[0] + (B2[1] - poly[poly.length - 2][1]) * sdirA[1] <= 0) poly.pop();
                poly[poly.length - 1] = B2;
              }
            };
            // Outbound side: drop any leading vertices that sit BEHIND B2 along
            // dirB (the overshoot stub east of the bend), then ensure the lane
            // STARTS at B2. If B2 is behind the current start (we extend the lane
            // back toward the node) we insert B2; otherwise we overwrite the
            // trimmed start with B2.
            const startOutbound = (poly: Pixel[], atStart: boolean) => {
              if (atStart) {
                while (poly.length > 2 && (poly[1][0] - B2[0]) * sdirB[0] + (poly[1][1] - B2[1]) * sdirB[1] <= 0) poly.shift();
                const ahead = (poly[0][0] - B2[0]) * sdirB[0] + (poly[0][1] - B2[1]) * sdirB[1];
                if (ahead > 0.01) poly.unshift(B2); else poly[0] = B2;
              } else {
                while (poly.length > 2 && (poly[poly.length - 2][0] - B2[0]) * sdirB[0] + (poly[poly.length - 2][1] - B2[1]) * sdirB[1] <= 0) poly.pop();
                const ahead = (poly[poly.length - 1][0] - B2[0]) * sdirB[0] + (poly[poly.length - 1][1] - B2[1]) * sdirB[1];
                if (ahead > 0.01) poly.push(B2); else poly[poly.length - 1] = B2;
              }
            };
            extendInbound(pA, aAtStart);
            startOutbound(pB, bAtStart);
            endMoved.add(keyA);
            endMoved.add(keyB);
            const pk = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
            mitered.add(lineId + '|' + endA + '|' + pk);
            jlog(`  ${endA} DOGLEG (single corner) B2=(${B2[0].toFixed(1)},${B2[1].toFixed(1)}) D=(${D[0].toFixed(2)},${D[1].toFixed(2)})`);
            continue;
          }
        }
        continue; // S connector for non-crossing sharp corners
      }
      const polyLenOf = (poly: Pixel[]): number => {
        let L = 0;
        for (let i = 1; i < poly.length; i++) L += hyp(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        return L;
      };
      // Localize small swaps AT the node: the drift length scales with the
      // LATERAL gap (≈40° crossing) instead of the fixed 8-slot window, so a
      // one-slot lane swap pivots within ~1.5 slots of the node and reads as
      // part of the corner/junction it belongs to (user rule 2026-07-04: a
      // reorder draws at the split, not smeared along the open run — the N/R
      // X at 36 St, the 2/3-4 swap at Franklin Av). Wide band exchanges
      // (Flatbush class) still spread: the 8-slot cap and the short-edge
      // guard below are unchanged, so gap≈8 slots keeps the long shallow X.
      const drift = Math.max(spacing * 1.5, gap * 1.2);
      const taperA = Math.min(drift, spacing * 8, polyLenOf(pA) * 0.45);
      const taperB = Math.min(drift, spacing * 8, polyLenOf(pB) * 0.45);
      jlog(`  ${endA} taperA=${taperA.toFixed(1)} taperB=${taperB.toFixed(1)} gap=${gap.toFixed(1)} lenA=${polyLenOf(pA).toFixed(0)} lenB=${polyLenOf(pB).toFixed(0)} ${(taperA < gap || taperB < gap) ? ((taperA < spacing * 1.5 || taperB < spacing * 1.5) ? 'CONTINUE(short)' : 'taper-anyway') : 'taper-mid'}`);
      if (taperA < gap || taperB < gap) {
        // A big band-on-band exchange — the WHOLE bundle reorders at one straight
        // node (Flatbush mn59: grays/greens swap sides) — would otherwise draw as
        // a steep ~90° perpendicular S chord (lon≈0 at the node collapses the
        // connector cubic to a lateral chord). Spread it over the available edge
        // length instead: both lane ends drift to the shared midpoint, so the
        // band-cross becomes a long shallow X. Keep the S connector only when an
        // edge is too short (<1.5 slots) to tilt without a near-zero stub.
        // Scoped by construction to nodes where the lineOrder changes between
        // incident edges (a bundle exchange) — plain corridor turns keep their
        // order and never reach this lateral-jog branch.
        if (taperA < spacing * 1.5 || taperB < spacing * 1.5) continue;
      }
      const mid: Pixel = [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2];
      taperLaneEnd(pA, aAtStart, mid, taperA);
      taperLaneEnd(pB, bAtStart, mid, taperB);
      endMoved.add(keyA);
      endMoved.add(keyB);
      const pairKey2 = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
      mitered.add(lineId + '|' + endA + '|' + pairKey2);
    }
  }

  // NOTE: path emission (fillet builder + join curves) happens AFTER the station
  // marker pass below — sliding a terminus marker clear of a neighbour must
  // also trim the terminating lanes back to the slid marker. The per-line 'd'
  // arrays and the straight-segment collision set both come from buildDByLine
  // over the real segPath, so the drawn lanes are byte-identical to before.
  // Path assembler (default): per-line continuous emission with in-path
  // joints, replacing the fragment emission plus the standalone connector
  // pass below. OCTI_ASSEMBLE=0 keeps the legacy pair for A/B.
  const useAssembler = envStr('OCTI_ASSEMBLE') !== '0';
  const assembleOver = (seg: Map<string, Pixel[]>, sink?: Segment[]) =>
    assembleDByLine({
      segPath: seg, joinCurves, filletR: FILLET_R,
      lineTraversals: layout.lineTraversals, lineIds: new Set(lineById.keys()),
      edgeById, orderOf, suppressed, spacing, segmentsOut: sink,
      nodeCellOf: (nid) => layout.nodes.get(nid)?.cell,
    });
  const emitLanes = () => {
    dByLine = useAssembler
      ? assembleOver(segPath, segments)
      : buildDByLine(segPath, joinCurves, FILLET_R, segments);
  };

  /** A line's drawn endpoint at a node (offset polylines run from→to). */
  const lineEndAt = (edgeId: string, lineId: string, nodeId: string): Pixel | null => {
    const poly = segPath.get(edgeId + '|' + lineId);
    const edge = edgeById.get(edgeId);
    if (!poly || !edge) return null;
    if (edge.from === nodeId) return poly[0];
    if (edge.to === nodeId) return poly[poly.length - 1];
    return null;
  };

  // Bundle-coherent paint layers (invariant I8), computed BEFORE marker
  // placement: the seat-ink oracle prices occlusion with the SAME stroke
  // order the paint emits, so the seat solve can never disagree with what
  // the viewer sees. All drawn-order mutations (slot synthesis, sliver
  // suppression, fan absorption re-filter) sit above this point.
  const arcOfEdge = new Map<string, number>();
  for (const edge of layout.edges) {
    const base = edgePolyline(edge);
    let arc = 0;
    for (let i = 1; i < base.length; i++) arc += hyp(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]);
    arcOfEdge.set(edge.id, arc);
  }
  const paintGroups = computePaintGroups(orderOf, arcOfEdge, [...lineById.keys()]);
  // Global stroke rank = paint position (group index major, in-group index
  // minor). A higher-ranked line's stroke paints later, i.e. on top.
  const strokeRank = new Map<string, number>();
  {
    let r = 0;
    for (const g of paintGroups) for (const id of g) strokeRank.set(id, r++);
  }

  // Stops come straight from edge.stops — no traversal dependency, so lines
  // whose traversal reconstruction failed still get their station marks. The
  // POSITION resolves from any DRAWN edge of the line at that node: the flag
  // itself may sit on a filtered-out remnant edge (tail past a terminus).
  const drawnEndAt = new Map<string, Pixel>(); // nodeId|lineId -> ribbon endpoint
  for (const [key, p] of joinStopPos) drawnEndAt.set(key, p);
  for (const edge of layout.edges) {
    for (const l of edge.lines) {
      for (const nodeId of [edge.from, edge.to]) {
        const key = nodeId + '|' + l.id;
        if (drawnEndAt.has(key)) continue;
        const p = lineEndAt(edge.id, l.id, nodeId);
        if (p) drawnEndAt.set(key, p);
      }
    }
  }
  const addStop = (
    lineId: string,
    color: string,
    nodeId: string,
    pos: Pixel,
    chain?: number,
    cornerAfter?: Pixel,
    home?: Pixel,
    axis?: number,
    dir?: Pixel,
    terminus?: boolean,
    outward?: Pixel,
    seatDirt?: number,
  ) => {
    const key = nodeId + '|' + lineId;
    if (stopSeen.has(key)) return;
    stopSeen.add(key);
    if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
    stopsByNode.get(nodeId)!.push({
      lineId, color, pos, name: lineById.get(lineId)?.label, textColor: lineById.get(lineId)?.textColor, seq: layout.nodeSeq?.get(lineId + '|' + nodeId) ?? layout.nodeSeq?.get(lineId + '|' + nodeId.split('::')[0]), chain, cornerAfter, home, axis, dir, terminus, outward, seatDirt,
    });
  };
  const membersByNode = args.stations ? new Map<string, number>() : undefined;
  if (args.stations) {
    // ROUTE-TRUTH line ends: the first node of a route's first traversal edge,
    // the last node of its last, plus any node where the route reverses onto the
    // same edge (an out-and-back turnaround). Both the marker terminus flag and
    // the lane-crop targets read this. Drawn-lane COUNT is not the truth: a
    // mid-route stop whose sibling lane was suppressed or trimmed also has a
    // single incident lane, which would read as a false line end.
    const routeEndNodes = new Map<string, Set<string>>();
    for (const [lid, trav] of layout.lineTraversals) {
      if (trav.length === 0) continue;
      const ends = new Set<string>();
      const eF = edgeById.get(trav[0].edgeId);
      const eL = edgeById.get(trav[trav.length - 1].edgeId);
      if (eF) ends.add(trav[0].reversed ? eF.to : eF.from);
      if (eL) ends.add(trav[trav.length - 1].reversed ? eL.from : eL.to);
      for (let i = 1; i < trav.length; i++) {
        if (trav[i].edgeId === trav[i - 1].edgeId && trav[i].reversed !== trav[i - 1].reversed) {
          const e = edgeById.get(trav[i].edgeId);
          if (e) ends.add(trav[i].reversed ? e.to : e.from);
        }
      }
      routeEndNodes.set(lid, ends);
    }
    const isRouteTerminus = (lineId: string, flagNode: string): boolean =>
      routeEndNodes.get(lineId)?.has(flagNode) ?? false;
    // Group-keyed markers: ONE bucket per station group at its node, marks
    // gathered from each line's own stop-flag node (per-line flags can sit
    // on diverged corridors — 307 Pl's cyan terminus vs its green column).
    // drawn join-curve geometry per node|line: lane curves must bridge the
    // node ON the drawn quadratic (spec §2.1) — chording the trim gap reads
    // up to half the join sagitta off the ink (dots float in the corner)
    const joinsAt = new Map<string, Array<{ a: Pixel; apex: Pixel; b: Pixel }>>();
    for (const jc of joinCurves) {
      const k = jc.node + '|' + jc.lineId;
      let arr = joinsAt.get(k);
      if (!arr) { arr = []; joinsAt.set(k, arr); }
      arr.push(jc);
    }
    const qPoint = (jc: { a: Pixel; apex: Pixel; b: Pixel }, u: number): Pixel => [
      (1 - u) * (1 - u) * jc.a[0] + 2 * (1 - u) * u * jc.apex[0] + u * u * jc.b[0],
      (1 - u) * (1 - u) * jc.a[1] + 2 * (1 - u) * u * jc.apex[1] + u * u * jc.b[1],
    ];
    // incident lane polylines of a line at a node, oriented AWAY from it;
    // a lane end trimmed for a join curve is extended with its half of the
    // sampled curve, so both halves meet at the curve midpoint Q(0.5)
    const lanePolysAt = (lineId: string, nodeId: string): Pixel[][] => {
      const out: Pixel[][] = [];
      const joins = joinsAt.get(nodeId + '|' + lineId);
      for (const edge of layout.edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue;
        const poly = segPath.get(edge.id + '|' + lineId);
        if (!poly || poly.length < 2) continue;
        const pts = edge.from === nodeId ? poly : [...poly].reverse();
        let bridged = pts;
        if (joins) {
          for (const jc of joins) {
            const da = hyp(pts[0][0] - jc.a[0], pts[0][1] - jc.a[1]);
            const db = hyp(pts[0][0] - jc.b[0], pts[0][1] - jc.b[1]);
            // 0.5px: curveLaneJoin's trim leaves the lane end within float
            // rounding of jc.a/jc.b — a sub-pixel bound, not a tunable
            if (Math.min(da, db) > 0.5) continue;
            const half: Pixel[] = [];
            for (let k2 = 6; k2 >= 1; k2--) {
              const u = da <= db ? 0.5 * (k2 / 6) : 1 - 0.5 * (k2 / 6);
              half.push(qPoint(jc, u));
            }
            bridged = [...half, ...pts];
            break;
          }
        }
        out.push(bridged);
      }
      return out;
    };
    interface StMarks {
      nodeId: string;
      members: number;
      /** set on platform-split units (and the shrunken primary): the original
       *  group nodeId — enables best-effort seating and taxicab connectors */
      splitBase?: string;
      marks: Array<{
        lineId: string;
        color: string;
        flagNode: string;
        pos: Pixel;
        chain?: number;
        cornerAfter?: Pixel;
        home?: Pixel;
        axis?: number;
        dir?: Pixel;
        terminus?: boolean;
        /** Seat-ink occlusion depth at the committed dot (I10). */
        seatDirt?: number;
      }>;
    }
    const gathered: StMarks[] = [];
    for (const st of args.stations) {
      membersByNode!.set(st.nodeId, st.members);
      const marks: StMarks['marks'] = [];
      for (const [lineId, flagNode] of st.stopNodes) {
        const line = lineById.get(lineId);
        if (!line) continue;
        let p = drawnEndAt.get(flagNode + '|' + lineId);
        let anchorNode = flagNode;
        if (!p) {
          // The flag node has no drawn lane for this line: its lane there was a
          // terminus-retrace sliver that suppression correctly removed (the
          // line only doubles back into a foreign corridor it doesn't really
          // travel — Court's grays touch the cyan me75 but actually run on
          // me575). Anchor the dot to the line's NEAREST genuine drawn lane
          // endpoint instead, and move the lane node with it so the rigid
          // solver builds the curve from that real lane. This keeps the dot on
          // the line's true corridor (the grays bundle ~minGap apart on me575,
          // not 6 lanes apart across the cyan bundle) — a compact capsule.
          const ref = nodePx.get(flagNode);
          if (ref) {
            let bestD = Infinity;
            for (const e of layout.edges) {
              const poly = segPath.get(e.id + '|' + lineId);
              if (!poly || poly.length === 0) continue;
              const cand: Array<[Pixel, string]> = [[poly[0], e.from], [poly[poly.length - 1], e.to]];
              for (const [pt, nd] of cand) {
                const dd = hyp(pt[0] - ref[0], pt[1] - ref[1]);
                if (dd < bestD) { bestD = dd; p = pt; anchorNode = nd; }
              }
            }
          }
          if (!p) continue;
        }
        marks.push({ lineId, color: line.color, flagNode: anchorNode, pos: [p[0], p[1]] });
      }
      gathered.push({ nodeId: st.nodeId, members: st.members, marks });
    }

    // ---- VANISHED-station diagnostic (OCTI_DEBUG) -------------------------
    // A station whose marks ALL fail to resolve renders nothing — renderStops
    // skips zero-mark nodes (`if (marks.length === 0) continue`) — yet its
    // line edges still draw, leaving a line passing through empty space where
    // a station should be (symptom: "Court" gone — no capsule, no dots). The
    // per-line trace pins the cause:
    //   =!pos  the line's drawn endpoint (flagNode|line) was never produced —
    //          ribbon/join geometry missing at that support node
    //   =!line the stop references a line id absent from this render
    //   (no stopNodes) — the station was stripped upstream (its node did not
    //          survive imageMerge's node remap), so it never had marks to lose
    reportVanishedStations({ stations: args.stations, gathered, layout, lineById, drawnEndAt });

    // ---- marker collision backup ------------------------------------------
    // Neighbouring station markers must not overlap. Detect overlaps and SLIDE
    // the smaller station's marks along their own lanes, away from the
    // neighbour, until its marker sits clear.
    const r = MARK_R0;
    // Intra-capsule dot floor. Markers shrink to MARKER_SCALE inside a capsule
    // (stops.ts), so two adjacent dots' rings clear once their centers are one
    // SCALED ring-diameter (2·r·MARKER_SCALE ≈ 3.19px) apart. The old floor used
    // the FULL 2r (≈4.9px) — stale since the 0.65× shrink (commit 8f1a5e5) — and
    // boxed interchanges whose scaled rings actually clear (the nyc/chi false-
    // negatives, gaps 3.7–3.9px). minGapSlack shaves an extra sub-pixel margin
    // for octi's cross-engine seating jitter (imperceptible ring overlap inside
    // the capsule); default 0 = floor exactly at the touching diameter, zero
    // overlap. Cross-station separation (the §6 mask below) stays strict at the
    // full 2r so two distinct stations never merge visually. OCTI_MINGAP_SLACK
    // overrides (raise it to clear more genuine pinches at the cost of overlap).
    const minGapSlack = (() => {
      const env =
        envNum('OCTI_MINGAP_SLACK');
      return Number.isFinite(env) && env >= 0 ? env : 0;
    })();
    const intraGap = Math.max(2, 2 * r * MARKER_SCALE - minGapSlack);
    // Soft sub-floor band width (px) fed to solveRows.softBand — see the ladder
    // comment at the placement loop. OCTI_BOX_RESCUE keeps its historic name;
    // 0 = hard floor.
    const boxRescueMax = (() => {
      const env =
        envNum('OCTI_BOX_RESCUE');
      return Number.isFinite(env) && env >= 0 ? env : 1.5;
    })();
    // Cross-station §6 mask strictness (OCTI_XMASK): a candidate dot is vetoed
    // within 2·r·factor of an already-placed dot. Default = MARKER_SCALE so the
    // veto matches the DRAWN ring touching distance 2·r·MARKER_SCALE (~3.18px) —
    // distinct stations seat once their drawn rings just clear. The legacy 2r
    // (~4.9px, factor 1) was stale since markers shrank to MARKER_SCALE (commit
    // 8f1a5e5): it boxed near-coincident DISTINCT stations in dense clusters (SF,
    // 28→18 drawn boxes recovered) whose rings actually fit, with NO overlap.
    // OCTI_XMASK=1 restores the legacy strict 2r; higher widens the gap.
    const xMaskFactor = (() => {
      const v = envNum('OCTI_XMASK');
      return Number.isFinite(v) && v > 0 ? v : MARKER_SCALE;
    })();
    // SOFT cross-station mask parameters (replace the hard veto). comfort radius
    // = the drawn casing-touch distance (2r·factor) so the penalty spans exactly
    // the zone where distinct rings would overlap; stack floor = the true
    // dot-coincidence guard (a small fraction of comfort) kept as the ONLY hard
    // veto so placement never stacks two distinct stations' bullets exactly.
    // weight is tuned (OCTI_XMASK_W) to bias spacing without dominating the
    // slide (W_S·s) / rotation (W_ROT·rot) state costs — a full-contact dot
    // costs ~one extra 45° rotation step.
    const xMaskComfort = 2 * r * xMaskFactor - 0.05;
    const xMaskStack = Math.max(1.5, 0.4 * xMaskComfort);
    const xMaskWeight = (() => {
      const v = envNum('OCTI_XMASK_W');
      return Number.isFinite(v) && v >= 0 ? v : 40;
    })();
    const boxOf = (s: StMarks): { x0: number; y0: number; x1: number; y1: number } => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of s.marks) {
        x0 = Math.min(x0, m.pos[0]); y0 = Math.min(y0, m.pos[1]);
        x1 = Math.max(x1, m.pos[0]); y1 = Math.max(y1, m.pos[1]);
      }
      const pad = r + 3;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      return { x0, y0, x1, y1 };
    };
    const lanePointAt = (
      lineId: string,
      nodeId: string,
      awayFrom: Pixel,
      d: number,
    ): { p: Pixel; edgeId: string } | null => {
      let best: { p: Pixel; edgeId: string } | null = null;
      let bestD = -Infinity;
      for (const edge of layout.edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue;
        const poly = segPath.get(edge.id + '|' + lineId);
        if (!poly || poly.length < 2) continue;
        const pts = edge.from === nodeId ? poly : [...poly].reverse();
        let acc = 0;
        let p: Pixel = pts[pts.length - 1];
        for (let i = 1; i < pts.length; i++) {
          const seg = hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (acc + seg >= d) {
            const t = seg > 1e-9 ? (d - acc) / seg : 0;
            p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
            break;
          }
          acc += seg;
        }
        const dd = hyp(p[0] - awayFrom[0], p[1] - awayFrom[1]);
        if (dd > bestD) { bestD = dd; best = { p, edgeId: edge.id }; }
      }
      return best;
    };
    /** Trim arc `d` off a lane's end at `nodeId` (terminating lines follow
     *  their slid marker instead of poking past it). */
    const trimLaneAt = (edgeId: string, lineId: string, nodeId: string, d: number) => {
      const key = edgeId + '|' + lineId;
      const poly = segPath.get(key);
      const edge = edgeById.get(edgeId);
      if (!poly || !edge || poly.length < 2) return;
      const atStart = edge.from === nodeId;
      const pts = atStart ? poly : [...poly].reverse();
      let acc = 0;
      let out: Pixel[] | null = null;
      for (let i = 1; i < pts.length; i++) {
        const seg = hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + seg >= d) {
          const t = seg > 1e-9 ? (d - acc) / seg : 0;
          const cut: Pixel = [
            pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
          ];
          out = [cut, ...pts.slice(i).map((q) => [q[0], q[1]] as Pixel)];
          break;
        }
        acc += seg;
      }
      if (out && out.length >= 2) segPath.set(key, atStart ? out : out.reverse());
    };
    // ---- rigid-row marker placement (spec v2 2026-06-12) -------------
    // Each bundle places a straight octilinear ROW; dots are intersections
    // of the row line with their own lane curves (rowPlace.ts). Shape holds
    // by construction (R1/R2) — the only fallback is the relaxed seat, never a
    // partially-degraded chain.
    // Seat-ink oracle (I10): snapshots the post-fan lane pieces and join
    // curves BEFORE any marker pass mutates them, with the hoisted stroke
    // ranks, so the seat solve prices occlusion by the same paint order the
    // emission uses. Seat costs and the census classification both read it.
    const seatInk = buildSeatInkOracle({
      segments: [...segPath.keys()].sort().map((k) => ({
        lineId: k.slice(k.indexOf('|') + 1),
        pts: segPath.get(k)!,
      })),
      joinCurves,
      strokeRank,
      colorOf: new Map([...lineById].map(([id, l]) => [id, l.color])),
      spacing,
    });
    seatInkOracle = seatInk;
    // Occlusion weight (px of dirt -> cost): above the comfort scale (~40),
    // below the hull-penetration (1000/px) and gap-deficit (5000/px) scales,
    // so a capsule pays slide/extension for visible ink but never trades
    // marker overlap or capsule collision for it. 0 disables (A/B).
    const seatInkW = (() => {
      const v = envNum('OCTI_SEATINK_W');
      return Number.isFinite(v) && v >= 0 ? v : 300;
    })();
    const placedDots: Pixel[] = []; // spec §6: earlier stations mask later DPs
    // Capsule overlap enforcement (spec 2026-07-02) — ON BY DEFAULT.
    // Seat-time: a solution whose spine hull crosses a placed capsule gets ONE
    // hull-masked re-solve (blocked = dot-ring-inside-hull veto, proximity =
    // comfort ramp); a still-crossing retry — and any SELF-crossing chain
    // (per-dot masks can't express "don't cross yourself") — falls to the
    // relaxed seat. The upstream capsule-demand oracle (densityBoxWarp) buys the
    // room that makes violations rare; this pass makes them impossible.
    // OCTI_CAPSULE_NOOVL=0 disables the seat-time check+retry (legacy);
    // OCTI_CAPSULE_GUARD=0 disables the move-commit hull guard (diagnostic).
    // Counters/audits print under OCTI_PLACE_DEBUG=1.
    const capEnv = typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env : undefined;
    const capNoOvlOn = capEnv?.OCTI_CAPSULE_NOOVL !== '0';
    const capGuardOn = capEnv?.OCTI_CAPSULE_GUARD !== '0';
    const capPlaceDebug = capEnv?.OCTI_PLACE_DEBUG === '1';
    const capOvlOn = capNoOvlOn || capPlaceDebug;
    const placedHulls: Array<{ nodeId: string; hull: Hull }> = [];
    const capOvlStats = { capsules: 0, self: 0, cross: 0, rejected: 0 };
    // Placement order (spec §6): an earlier station's dots mask a later one's
    // row states, so a station boxed ONLY because a flexible neighbor claimed
    // its space first (the MASKED class) is freed by visiting the more-
    // constrained station first. Default = most-marks-first (the biggest
    // interchanges have the least placement freedom, so they claim space before
    // single-line stops slide around them); tie-break by nodeId (code-unit, not
    // localeCompare — cross-V8 stable). This reorders the SAME deterministic
    // placement — no geometry changes — so offline==in-game still holds.
    // OCTI_PLACE_ORDER=input restores the legacy id-order (debugging).
    const placeOrderKey =
      typeof process !== 'undefined'
        ? envStr('OCTI_PLACE_ORDER')
        : undefined;
    const byId = (a: number, b: number) =>
      gathered[a].nodeId < gathered[b].nodeId ? -1 : gathered[a].nodeId > gathered[b].nodeId ? 1 : 0;
    const placeSeq = gathered.map((_, i) => i);
    if (placeOrderKey !== 'input') {
      placeSeq.sort((a, b) => (gathered[b].marks.length - gathered[a].marks.length) || byId(a, b));
    }
    // Placement runs off a QUEUE: a station whose row solve fails and whose
    // bundles form DISTANT spatial clusters (per-station graph nodes put one
    // group's platforms on corridors far apart) is split into one placement
    // unit per cluster and re-queued, so each platform seats on its own row.
    // Outward side of a lone stop's tick: the unit direction from the bundle's
    // drawn centerline to this line's lane, summed over the incident drawn
    // edges. offsetPolyline shifts a +slot lane by +perp(from->to tangent), so a
    // lane's outward direction is sign(slot) * that perp at the node end. A lane
    // centered on every incident bundle (or one running alone) sums to ~0 and
    // leaves the tick on its canonical side.
    const bundleOutward = (lineId: string, nodeId: string): Pixel | undefined => {
      let ox = 0, oy = 0;
      for (const edge of layout.edges) {
        const atFrom = edge.from === nodeId;
        const atTo = edge.to === nodeId;
        if (!atFrom && !atTo) continue;
        const slot = slotOf.get(edge.id + '|' + lineId);
        if (slot === undefined || slot === 0) continue; // centered/alone: no side
        const base = edgePolyline(edge);
        if (base.length < 2) continue;
        const p0 = atFrom ? base[0] : base[base.length - 2];
        const p1 = atFrom ? base[1] : base[base.length - 1];
        let tx = p1[0] - p0[0], ty = p1[1] - p0[1]; // from->to tangent at this node
        const len = Math.sqrt(tx * tx + ty * ty);
        if (len < 1e-9) continue;
        tx /= len; ty /= len;
        const sgn = slot > 0 ? 1 : -1;
        ox += sgn * -ty; // sign(slot) * perp(from->to tangent)
        oy += sgn * tx;
      }
      const l = Math.sqrt(ox * ox + oy * oy);
      return l > 1e-9 ? [ox / l, oy / l] : undefined;
    };
    let platSeq = 0;
    const placeQueue: StMarks[] = placeSeq.map((i) => gathered[i]);
    for (let qi = 0; qi < placeQueue.length; qi++) {
      const s = placeQueue[qi];
      if (s.marks.length === 1) {
        const mk = s.marks[0];
        mk.chain = 0;
        // Octilinear run-axis of the lone stop's lane, so the cross-station
        // rescue can slide its box ALONG the line (keeping it on the line) rather
        // than perpendicular into empty space. Same quantized-atan2 method the
        // multi-line block uses, for cross-V8 determinism.
        if (mk.axis === undefined) {
          const polys = lanePolysAt(mk.lineId, mk.flagNode);
          const curve = buildLaneCurve(polys, mk.pos, CHAIN_ARC_LIMIT);
          const tg = curveTangent(curve, curve.anchorT);
          mk.axis = (((Math.round((Math.round(Math.atan2(tg[1], tg[0]) * 1e6) / 1e6) / (Math.PI / 4)) % 4) + 4) % 4);
          mk.dir = unitTangent(tg);
          // Terminus: the ROUTE ends at this stop AND its single drawn lane ends
          // here, so the cap has something to cap. Route truth is what makes it a
          // line end; the lane count alone would also fire on a mid-route stop
          // whose sibling lane was suppressed or trimmed (a false two-sided cap in
          // the middle of a line). A loop has two lanes at every stop, so none of
          // its stops are termini. Tick markers cap a terminus with a full
          // (two-sided) tick.
          mk.terminus = polys.length === 1 && isRouteTerminus(mk.lineId, mk.flagNode);
          // Which side of its bundle the lane sits on, so the one-sided tick
          // prefers the bundle's outer edge instead of striking across co-runners.
          mk.outward = bundleOutward(mk.lineId, mk.flagNode);
        }
      } else if (s.marks.length > 1) {
        // pre-solve home (lane position where the line passes the node), a
        // geometric fact consumed by the rectangle capsule seating. The guard
        // keeps the ORIGINAL position when a split unit is re-queued.
        for (const mk of s.marks) if (mk.home === undefined) mk.home = [mk.pos[0], mk.pos[1]];
        const polysByMark = s.marks.map((mk) => lanePolysAt(mk.lineId, mk.flagNode));
        const curves = polysByMark.map((polys, i) =>
          buildLaneCurve(polys, s.marks[i].pos, CHAIN_ARC_LIMIT),
        );
        // groups: marks sharing an incident drawn edge ride one corridor
        const sets = s.marks.map((mk) => {
          const set = new Set<string>();
          for (const edge of layout.edges) {
            if (edge.from !== mk.flagNode && edge.to !== mk.flagNode) continue;
            if (segPath.has(edge.id + '|' + mk.lineId)) set.add(edge.id);
          }
          return set;
        });
        // Octilinear run-axis (0..3, mod 180° — a row's line direction) per
        // mark, from its lane tangent. Lanes that share a drawn edge but run
        // in DIFFERENT directions are different bundles (a multi-arm junction:
        // Park Av's F/G horizontal + A/B 135° + H/E 45°), each its own row
        // that pairs with a corner — grouping them into one row asks for a
        // straight line across diverging lanes, which has no solution → box.
        const markTg = s.marks.map((_, i) => curveTangent(curves[i], curves[i].anchorT));
        const markAxis = markTg.map((tg) =>
          // quantize atan2 (cross-V8) before the axis-index round so a 1-ULP
          // diff can't flip the grouping axis at a 22.5° boundary.
          (((Math.round((Math.round(Math.atan2(tg[1], tg[0]) * 1e6) / 1e6) / (Math.PI / 4)) % 4) + 4) % 4),
        );
        // octilinear run-axis per mark, a geometric fact for the rectangle
        // capsule seating; the exact tangent (dir) is kept for tick markers. The
        // guard keeps the first axis a re-queued unit saw.
        s.marks.forEach((mk, i) => { if (mk.axis === undefined) { mk.axis = markAxis[i]; mk.dir = unitTangent(markTg[i]); mk.terminus = polysByMark[i].length === 1 && isRouteTerminus(mk.lineId, mk.flagNode); } });
        const parent = s.marks.map((_, i) => i);
        const find = (x: number): number =>
          parent[x] === x ? x : (parent[x] = find(parent[x]));
        for (let i = 0; i < sets.length; i++) {
          for (let j = i + 1; j < sets.length; j++) {
            if (markAxis[i] !== markAxis[j]) continue; // same corridor AND same run-axis
            for (const id of sets[i]) {
              if (sets[j].has(id)) { parent[find(i)] = find(j); break; }
            }
          }
        }
        const byRoot = new Map<number, number[]>();
        s.marks.forEach((_, i) => {
          const rt = find(i);
          let arr = byRoot.get(rt);
          if (!arr) { arr = []; byRoot.set(rt, arr); }
          arr.push(i);
        });
        // within-group order = lateral order across the corridor
        const groups = [...byRoot.values()].map((idx) => {
          if (idx.length === 1) return idx;
          const t0 = curveTangent(curves[idx[0]], curves[idx[0]].anchorT);
          let mx = 0;
          let my = 0;
          for (const i of idx) {
            const tg = curveTangent(curves[i], curves[i].anchorT);
            const sgn = tg[0] * t0[0] + tg[1] * t0[1] < 0 ? -1 : 1;
            mx += tg[0] * sgn;
            my += tg[1] * sgn;
          }
          const len = hyp(mx, my) || 1;
          const nx = -my / len;
          const ny = mx / len;
          return [...idx].sort((a, b) => {
            const da = s.marks[a].pos[0] * nx + s.marks[a].pos[1] * ny;
            const db = s.marks[b].pos[0] * nx + s.marks[b].pos[1] * ny;
            if (da !== db) return da - db;
            // Two lanes at the SAME lateral projection (coincident at a pinched
            // bundle) → diff is 0; tie-break by line id (raw code-unit, cross-V8
            // stable), else the bundle's dot order — and the box-vs-capsule
            // decision solveRows derives from it — flips on the engine's sort tie.
            const la = s.marks[a].lineId;
            const lb = s.marks[b].lineId;
            return la < lb ? -1 : la > lb ? 1 : 0;
          });
        });
        // ---- escalation ladder (rewritten 2026-07-04, spec: escalation-
        // ladder-rewrite): TWO solve stages instead of four.
        //  1. PRIMARY — one wide-window solve with the placed-hull masks baked
        //     in (was: separate overlap retry) and a soft sub-floor gap band
        //     (was: the box-rescue slack walk of up to 6 re-solves).
        //  2. FAR-ATTACH — corridor-bounded coarse solve + fine polish, only
        //     when PRIMARY fails and the bundles spread beyond the window:
        //     slides each platform's row along its own corridor until the
        //     rows align, then joins them into ONE capsule (long parallel
        //     bridges are paid for in cost, not vetoed).
        //  3. VERIFY — seat-time hull-overlap check (masked retry deleted;
        //     the masks are in the solve now).  Then: platform split → relaxed seat.
        let cx0 = 0, cy0 = 0;
        for (const mk of s.marks) { cx0 += mk.pos[0]; cy0 += mk.pos[1]; }
        cx0 /= s.marks.length; cy0 /= s.marks.length;
        // max cross-bundle anchor spread: far-tier trigger + mask/ext radius
        let spread = 0;
        for (let bi = 0; bi < groups.length; bi++) {
          for (let bj = bi + 1; bj < groups.length; bj++) {
            for (const i of groups[bi]) {
              for (const j of groups[bj]) {
                const d = hyp(s.marks[i].pos[0] - s.marks[j].pos[0], s.marks[i].pos[1] - s.marks[j].pos[1]);
                if (d > spread) spread = d;
              }
            }
          }
        }
        // placed-hull masks (hoisted from the deleted overlap retry): veto a
        // dot whose ring would sit inside a placed capsule hull; comfort ramp
        // outside. Prefiltered to the station's vicinity + spread.
        const nearHulls: Hull = [];
        for (const ph of placedHulls) {
          for (const sg of ph.hull) {
            if (segSegDist([cx0, cy0], [cx0, cy0], sg.a, sg.b) < 400 + spread) nearHulls.push(sg);
          }
        }
        const hullClearance = (p: Pixel): number => {
          let md = Infinity;
          for (const sg of nearHulls) {
            const d = segSegDist(p, p, sg.a, sg.b) - (sg.half + r);
            if (d < md) md = d;
          }
          return md;
        };
        const ropts = {
          minGap: intraGap,
          arcLimit: WIDE_ARC,
          extCap: extCapMult * spacing,
          // Parallel end-to-end joins are for two rows that are genuinely the
          // same line; on the fine grid a truly-collinear pair is sub-pixel
          // aligned. Keep this well under a lane offset so a cross-axis bundle
          // that merely grazes another row's line (e.g. a diagonal 0.7px off a
          // vertical pair's row) is NOT fused flat but joined by an octilinear
          // V-corner instead.
          latTol: 0.5,
          // soft sub-floor band: gaps down to (minGap − boxRescueMax) seat
          // with a heavy per-px deficit penalty instead of re-solving at
          // walked-down floors. OCTI_BOX_RESCUE keeps its name/default (1.5;
          // 0 restores the hard floor everywhere).
          softBand: boxRescueMax,
          dbgLabel: s.nodeId, // OCTI_PLACE_DEBUG: per-box root-cause classifier
          blocked: (p: Pixel) => {
            for (const q of placedDots) {
              if (hyp(p[0] - q[0], p[1] - q[1]) < xMaskStack) return true; // true-stacking veto
            }
            return hullClearance(p) < 0; // ring inside a placed capsule hull
          },
          proximity: (p: Pixel, memberIdx?: number) => {
            let pen = 0;
            for (const q of placedDots) {
              const d = hyp(p[0] - q[0], p[1] - q[1]);
              if (d < xMaskComfort) pen += xMaskWeight * (xMaskComfort - d) / xMaskComfort;
            }
            const hd = hullClearance(p);
            if (hd >= 0 && hd < xMaskComfort) pen += xMaskWeight * (xMaskComfort - hd) / xMaskComfort;
            // seat-ink occlusion (I10): dominant over comfort, soft under the
            // gap floor and hull scales; per-line, so only priced where the
            // solve tells us whose dot this is (buildStates does; corner-
            // clearance style calls omit the index and skip the term).
            if (memberIdx !== undefined && seatInkW > 0) {
              pen += seatInkW * seatInk.dirtAt(p, s.marks[memberIdx].lineId);
            }
            return pen;
          },
        };
        // PRIMARY: one wide-window fine-grid solve
        const solveCurves = s.marks.map((mk) =>
          buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, WIDE_ARC),
        );
        let sol = solveRows(solveCurves, groups, ropts);
        // FAR-ATTACH: corridor-bounded align + join (one coarse + one polish)
        if (!sol && farSlideOn && groups.length >= 2 && spread > WIDE_ARC) {
          const farCurves = s.marks.map((mk) =>
            buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, FAR_CAP),
          );
          // each bundle may slide to the MIDPOINT of its incident corridor on
          // either side (half the windowed carrier extent, floored at the
          // primary window), never off the lane geometry
          const slideRange = groups.map((grp) => {
            const carrier = farCurves[grp[0]];
            const total = carrier.cum[carrier.cum.length - 1];
            const lo = Math.max(-carrier.anchorT, -Math.max(WIDE_ARC, carrier.anchorT / 2));
            const hi = Math.min(total - carrier.anchorT, Math.max(WIDE_ARC, (total - carrier.anchorT) / 2));
            return [lo, hi] as [number, number];
          });
          const farOpts = {
            ...ropts,
            arcLimit: FAR_CAP,
            step: FAR_STEP,
            slideRange,
            // coarse grid can't hit the strict 0.75px collinearity — relax to
            // ~3/4 step (≥ the grid's worst-case residual); polish restores it
            latTol: Math.max(0.75, FAR_STEP * 0.75),
            // long bridges are payable: extension bound covers the spread
            extCap: Math.max(extCapMult * spacing, spread + 2 * spacing),
          };
          sol = solveRows(farCurves, groups, farOpts);
          if (sol) {
            // fine polish: re-anchor every lane curve at its coarse dot and
            // re-solve locally at the strict tolerances — drives parallel
            // joins to sub-pixel collinearity (lat moves ≤1px per px of
            // slide, so the ±2·FAR_STEP window brackets exact alignment).
            const coarse = sol;
            const fineCurves = s.marks.map((mk, i) =>
              buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), coarse.pos[i], 2 * FAR_STEP),
            );
            const { slideRange: _sr, latTol: _lt, ...fineBase } = farOpts;
            sol = solveRows(fineCurves, groups, {
              ...fineBase,
              arcLimit: 2 * FAR_STEP,
              step: 0.5,
            });
          }
          reportFarAttach(s.nodeId, spread, groups.length, !!sol);
        }
        // BEST-EFFORT (split units only): a re-queued platform unit that
        // still has no seat is almost always OVERLAP-vetoed — every candidate
        // row sits inside a placed capsule hull or stacked on placed dots.
        // Take the least-bad seat: the hull veto becomes a heavy proximity
        // penalty (least penetration wins), the true-stacking veto stays
        // hard, and the verify stage below records instead of rejecting.
        // Structural failures (coincident interlined lanes → pinch, or
        // no-crossing) still return null here and fall to the relaxed seat.
        let bestEffort = false;
        if (!sol && s.splitBase) {
          bestEffort = true;
          sol = solveRows(solveCurves, groups, {
            ...ropts,
            blocked: (p: Pixel) => {
              for (const q of placedDots) {
                if (hyp(p[0] - q[0], p[1] - q[1]) < xMaskStack) return true;
              }
              return false; // hull veto lifted — priced below instead
            },
            proximity: (p: Pixel, memberIdx?: number) => {
              let pen = ropts.proximity(p, memberIdx);
              const hd = hullClearance(p);
              if (hd < 0) pen += 1000 * -hd; // inside a placed hull: heavy, not fatal
              return pen;
            },
          });
          reportSplitFit(s.nodeId, !!sol);
        }
        // Seat-time hull overlap check (spec 2026-07-02; on by default, see
        // capNoOvlOn above). Runs AFTER both solve stages so it judges the
        // solution that would actually be committed. The placed-hull masks are
        // already baked into the solve above, so a violation here falls
        // straight to the platform-split / relaxed-seat branch (no masked retry).
        if (sol && capOvlOn && s.marks.length >= 2) {
          const near = (p: Pixel, q: Pixel): boolean => hyp(p[0] - q[0], p[1] - q[1]) < 0.01;
          const evalSol = (so: NonNullable<typeof sol>): { hull: Hull; verts: Pixel[]; selfOvl: boolean; crossOvl: string | null } => {
            const verts: Pixel[] = [];
            for (let k = 0; k < so.order.length; k++) {
              verts.push(so.pos[so.order[k]]);
              const c = so.cornerAfter.get(k);
              if (c) verts.push(c);
            }
            const hull: Hull = [];
            for (let k = 1; k < verts.length; k++) hull.push({ a: verts[k - 1], b: verts[k], half: r + 3 });
            if (hull.length === 0) hull.push({ a: verts[0], b: verts[0], half: r + 3 });
            let selfOvl = false;
            for (let i = 0; i < hull.length && !selfOvl; i++) {
              for (let j = i + 2; j < hull.length; j++) {
                // non-adjacent legs only; skip pairs meeting at a shared vertex
                // (zero-length corner stubs make i+2 segments touch legitimately)
                if (near(hull[i].b, hull[j].a) || near(hull[i].a, hull[j].b) || near(hull[i].a, hull[j].a) || near(hull[i].b, hull[j].b)) continue;
                // TRUE centerline crossing only (the Z-fold). Hull-width proximity
                // between non-adjacent legs is NORMAL at an elbow — legs joined
                // through a short bridge segment pass within capsule width of each
                // other at every corner — so a width-based test flags every bent
                // capsule (17/63 on SEA) and is useless as a feasibility predicate.
                if (segSegDist(hull[i].a, hull[i].b, hull[j].a, hull[j].b) < 0.5) { selfOvl = true; break; }
              }
            }
            let crossOvl: string | null = null;
            for (const ph of placedHulls) {
              if (penBetween(hull, ph.hull) > 0.5) { crossOvl = ph.nodeId; break; }
            }
            return { hull, verts, selfOvl, crossOvl };
          };
          const ev = evalSol(sol);
          capOvlStats.capsules++;
          if (ev.selfOvl) capOvlStats.self++;
          if (ev.crossOvl) capOvlStats.cross++;
          const reject = capNoOvlOn && !bestEffort && (ev.selfOvl || ev.crossOvl !== null);
          if (ev.selfOvl || ev.crossOvl) reportCapsOverlap({
            reject, nodeId: s.nodeId, markCount: s.marks.length, bestEffort,
            verts: ev.verts, selfOvl: ev.selfOvl, crossOvl: ev.crossOvl,
          });
          if (reject) { capOvlStats.rejected++; sol = null; }
          else placedHulls.push({ nodeId: s.nodeId, hull: ev.hull });
        }
        if (sol) {
          for (let k = 0; k < sol.order.length; k++) {
            const i = sol.order[k];
            s.marks[i].pos = sol.pos[i];
            s.marks[i].chain = k;
            const corner = sol.cornerAfter.get(k);
            if (corner) s.marks[i].cornerAfter = corner;
          }
        } else {
          // Per-bundle capsule split: per-station graph nodes let ONE station
          // group legitimately stop on several distinct corridors (Fulton St's
          // four platforms, Times Sq's de-welded trunks). A multi-bundle
          // NO-PAIRING failure means no single capsule chain can connect those
          // corridors — so give each corridor BUNDLE its own placement unit
          // (one small row-capsule per platform). Only reached AFTER every solve
          // attempt failed, so any station that seats today is untouched.
          const clusters = groups;
          if (clusters.length >= 2) {
            const anchor = nodePx.get(s.nodeId) ?? s.marks[0].pos;
            let keep = 0;
            let keepD = Infinity;
            for (let c = 0; c < clusters.length; c++) {
              for (const i of clusters[c]) {
                const d = hyp(s.marks[i].pos[0] - anchor[0], s.marks[i].pos[1] - anchor[1]);
                if (d < keepD) { keepD = d; keep = c; }
              }
            }
            for (let c = 0; c < clusters.length; c++) {
              if (c === keep) continue;
              const unit: StMarks = {
                nodeId: s.nodeId + '::plat' + platSeq++,
                members: s.members,
                splitBase: s.nodeId,
                marks: clusters[c].map((i) => s.marks[i]),
              };
              gathered.push(unit);
              placeQueue.push(unit);
              membersByNode!.set(unit.nodeId, unit.members);
            }
            s.marks = clusters[keep].map((i) => s.marks[i]);
            s.splitBase = s.nodeId;
            placeQueue.push(s); // re-solve the shrunken primary cluster
            reportPlatformSplit({ layout, nodeId: s.nodeId, clusters });
            continue; // marks re-place per cluster; no dots committed yet
          }
          // Relaxed final seat (never null): the octilinear ladder exhausted, so
          // take a guaranteed non-octilinear, overlap-allowed seat. Hull
          // penetration and true-stacking become heavy proximity (never a veto),
          // so the solve seats with least overlap and the ultimate fallback is
          // only a backstop.
          const relaxedSol = solveRows(solveCurves, groups, {
            ...ropts,
            relaxed: true,
            blocked: undefined,
            proximity: (p: Pixel, memberIdx?: number) => {
              let pen = ropts.proximity(p, memberIdx);
              const hd = hullClearance(p);
              if (hd < 0) pen += 1000 * -hd;
              for (const q of placedDots) {
                const dd = hyp(p[0] - q[0], p[1] - q[1]);
                if (dd < xMaskStack) pen += 1000 * (xMaskStack - dd);
              }
              return pen;
            },
          })!; // relaxed mode is guaranteed non-null
          for (let k = 0; k < relaxedSol.order.length; k++) {
            const i = relaxedSol.order[k];
            s.marks[i].pos = relaxedSol.pos[i];
            s.marks[i].chain = k;
            const corner = relaxedSol.cornerAfter.get(k);
            if (corner) s.marks[i].cornerAfter = corner;
          }
          // Hull bookkeeping so later stations mask against this seat (mirrors the
          // verify block's push; capsHullOf is declared after this loop).
          const rvVerts: Pixel[] = [];
          for (let k = 0; k < relaxedSol.order.length; k++) {
            rvVerts.push(relaxedSol.pos[relaxedSol.order[k]]);
            const c = relaxedSol.cornerAfter.get(k);
            if (c) rvVerts.push(c);
          }
          const rvHull: Hull = [];
          for (let k = 1; k < rvVerts.length; k++) rvHull.push({ a: rvVerts[k - 1], b: rvVerts[k], half: r + 3 });
          if (rvHull.length === 0) rvHull.push({ a: rvVerts[0], b: rvVerts[0], half: r + 3 });
          placedHulls.push({ nodeId: s.nodeId, hull: rvHull });
        }
      }
      for (const mk of s.marks) {
        // Record the seat-time occlusion depth (I10): with the dominant
        // weight, a dirty committed dot certifies that no clean feasible
        // seat existed in the searched space. The census reads this to
        // split intrusions into certified vs avoidable.
        mk.seatDirt = seatInk.dirtAt(mk.pos, mk.lineId);
        placedDots.push(mk.pos);
      }
    }
    reportCapsOvlStats({ capPlaceDebug, stats: capOvlStats, guardOn: capGuardOn, noOvlOn: capNoOvlOn });
    // Shared-anchor guard (Burke Court): a terminus sliver SHARED by two split
    // image-merge stations (ms3/ms4) carries stop flags for BOTH — e.g. the
    // W-only me365_a4 (~13px) and the V-only me251_b3 anchor at the same node.
    // applySlide's incident<=1 trim (d≈12) would erase the WHOLE short lane and
    // orphan the OTHER station's marker (Burke Court's capsule floated 12px off
    // ink). Map each (lineId|flagNode) lane end to the set of station nodeIds
    // whose marks anchor there; a slid mark whose lane end is ALSO anchored by a
    // foreign station's mark skips the trim (leave the lane drawn to its tip —
    // the short overhang hides under the markers).
    const anchorStations = new Map<string, Set<string>>();
    for (const s of gathered) {
      for (const m of s.marks) {
        const k = m.lineId + '|' + m.flagNode;
        let set = anchorStations.get(k);
        if (!set) anchorStations.set(k, (set = new Set()));
        set.add(s.nodeId);
      }
    }
    // Shared spine-hull builder — chain-ordered marks INCLUDING corner vertices
    // (the drawn outline), slide-pass half-width.
    const capsHullOf = (marks: StMarks['marks']): Hull => {
      const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
      const verts: Pixel[] = [];
      for (const mk of ordered) { verts.push(mk.pos); if (mk.cornerAfter) verts.push(mk.cornerAfter); }
      const hull: Hull = [];
      for (let k = 1; k < verts.length; k++) hull.push({ a: verts[k - 1], b: verts[k], half: r + 3 });
      return hull;
    };
    // Move-commit hull guard (on by default, OCTI_CAPSULE_GUARD=0 disables):
    // would `marks-as-moved` penetrate any OTHER drawn capsule's hull? The
    // post-placement passes fix dot distances but were hull-blind to third
    // parties — the SEA audit shows them CREATING spine crossings (4 seat-time
    // → 6 final). Same veto style as applySlide's octilinearity + dot-floor
    // guards.
    const capsHullClash = (self: StMarks, hull: Hull): string | null => {
      for (const T of gathered) {
        if (T === self || T.marks.length < 2) continue;
        if (penBetween(hull, capsHullOf(T.marks)) > 0.5) return T.nodeId;
      }
      return null;
    };
    // TRUE centerline self-crossing of one capsule's hull (the Z-fold) — the
    // same non-adjacent-leg intersection test the seat check applies to a
    // fresh solution. The move guards below also run it on the SLID clone:
    // a slide can bend a clean chain into a self-cross (NYC mn216 — seat
    // clean, folded by a later pass), which capsHullClash cannot see because
    // it only measures against OTHER capsules.
    const capsHullSelfCrosses = (hull: Hull): boolean => {
      const near = (p: Pixel, q: Pixel): boolean => hyp(p[0] - q[0], p[1] - q[1]) < 0.01;
      for (let i = 0; i < hull.length; i++)
        for (let j = i + 2; j < hull.length; j++) {
          // non-adjacent legs only; skip pairs meeting at a shared vertex
          // (zero-length corner stubs make i+2 segments touch legitimately)
          if (near(hull[i].b, hull[j].a) || near(hull[i].a, hull[j].b) || near(hull[i].a, hull[j].a) || near(hull[i].b, hull[j].b)) continue;
          if (segSegDist(hull[i].a, hull[i].b, hull[j].a, hull[j].b) < 0.5) return true;
        }
      return false;
    };
    // Diagnostic audit (OCTI_PLACE_DEBUG=1): hull cross/self counts over the
    // CURRENT mark positions of drawn (non-boxed) capsules, called after each
    // post-placement pass — so overlap BORN by a pass (not just at seat time)
    // is attributable. Pure diagnostics; the enforcement no longer needs it.
    const capsAudit = (label: string): void => {
      if (!capPlaceDebug) return;
      const items: Array<{ nodeId: string; hull: Hull }> = [];
      for (const s of gathered) {
        if (s.marks.length < 2) continue;
        const hull = capsHullOf(s.marks);
        if (hull.length) items.push({ nodeId: s.nodeId, hull });
      }
      const crossPairs: string[] = [];
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++)
          if (penBetween(items[i].hull, items[j].hull) > 0.5) crossPairs.push(items[i].nodeId + '×' + items[j].nodeId);
      const selfs: string[] = [];
      for (const it of items) if (capsHullSelfCrosses(it.hull)) selfs.push(it.nodeId);
      reportCapsAudit({ label, crossPairs, selfs });
    };
    capsAudit('post-place');
    const slid: Array<{ nodeId: string; at: Pixel }> = [];
    // When a collision-slide moves a station, its derived corners (spec R1)
    // move WITH it: a corner is the meeting of two row legs, so the new
    // corner is the intersection of lines through the SLID boundary dots
    // along the OLD leg directions (solver axes — octilinear by
    // construction). Capture leg dirs from the old positions BEFORE the
    // slide; recompute AFTER. Near-parallel legs degenerate → clear (a
    // straight row has no corner). Clearing alone is unsound for bent
    // markers on non-parallel lanes (SEA mn177: the plain chord's off-axis
    // residual is invariant under the equal-arc slide).
    type CornerCap = Array<{ mk: StMarks['marks'][number]; next: StMarks['marks'][number]; dirA: Pixel; dirB: Pixel }>;
    const captureCorners = (marks: StMarks['marks']): CornerCap => {
      const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
      const cap: CornerCap = [];
      for (let k = 0; k + 1 < ordered.length; k++) {
        const mk = ordered[k];
        const corner = mk.cornerAfter;
        if (!corner) continue;
        const next = ordered[k + 1];
        const ax = corner[0] - mk.pos[0];
        const ay = corner[1] - mk.pos[1];
        const bx = next.pos[0] - corner[0];
        const by = next.pos[1] - corner[1];
        const la = hyp(ax, ay) || 1;
        const lb = hyp(bx, by) || 1;
        cap.push({ mk, next, dirA: [ax / la, ay / la], dirB: [bx / lb, by / lb] });
      }
      return cap;
    };
    const applyCorners = (cap: CornerCap) => {
      for (const { mk, next, dirA, dirB } of cap) {
        const cross = dirA[0] * dirB[1] - dirA[1] * dirB[0];
        if (Math.abs(cross) < 0.05) { mk.cornerAfter = undefined; continue; }
        const wx = next.pos[0] - mk.pos[0];
        const wy = next.pos[1] - mk.pos[1];
        const t = (wx * dirB[1] - wy * dirB[0]) / cross;
        mk.cornerAfter = [mk.pos[0] + dirA[0] * t, mk.pos[1] + dirA[1] * t];
      }
    };
    // Is a slid marker's spine still octilinear? A slide moves each dot along
    // its OWN lane, so a straight row whose dots ride non-parallel lanes bends.
    // Corner recompute only salvages markers that already had a real bend; a
    // broken straight row has no corner to recover. The corridor-spread dry-runs
    // reject any candidate that fails this gate (matches the octi gate's
    // length-aware bar), so a slide never bends a spine off octilinear.
    const spineOctilinear = (marks: StMarks['marks']): boolean => {
      const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
      const vs: Pixel[] = [];
      for (const mk of ordered) { vs.push(mk.pos); if (mk.cornerAfter) vs.push(mk.cornerAfter); }
      for (let i = 1; i < vs.length; i++) {
        const dx = vs[i][0] - vs[i - 1][0];
        const dy = vs[i][1] - vs[i - 1][1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;
        // Perpendicular deviation from the nearest octilinear axis = |(dx,dy) × u|.
        // off > bar ⟺ sin(off) > sin(bar) ⟺ |cross| > max(sin1°·len, 0.85). The
        // atan2+asin form is not correctly-rounded cross-V8; this cross-product is.
        const u = snapAxis(dx, dy);
        if (Math.abs(dx * u[1] - dy * u[0]) > Math.max(SIN1DEG * len, 0.85)) return false;
      }
      return true;
    };
    capsAudit('post-slide');
    // Small-vs-small collisions: neighbouring stations' markers must not
    // overlap (user rule). Penetration is measured between the markers' actual
    // SPINE HULLS (chain-pair stadium segments — bbox tests miss/false-flag
    // multi-angle capsules). Resolution ESCALATES (spec 2026-06-15-capsule-
    // mutual-slide): first slide ONE capsule away (the fewer-marks one); if its
    // own slide window can't clear the pair, slide BOTH apart along their own
    // lanes (chooseMutualSlide picks the least-total-slide offsets that clear,
    // best-effort when none fully does). A bounded relaxation loop re-checks so
    // ripples (a moved capsule touching a third) settle; each capsule slides at
    // most once, so total displacement stays within the per-capsule 32px cap.
    // OCTI_MUTUAL_SLIDE=0 disables the escalation (one-sided, single pass).
    {
      const hullsOf = (marks: StMarks['marks'], posOf?: (i: number) => Pixel): Hull => {
        // capsule = spine through chain-ordered dots; hull = its consecutive
        // pair segments at half-width fill half + border = r + 3
        const p = (i: number): Pixel => (posOf ? posOf(i) : marks[i].pos);
        const ordered = marks
          .map((m, i) => ({ i, chain: m.chain ?? 0 }))
          .sort((m1, m2) => m1.chain - m2.chain);
        const out: Hull = [];
        for (let k = 1; k < ordered.length; k++) {
          out.push({ a: p(ordered[k - 1].i), b: p(ordered[k].i), half: r + 3 });
        }
        if (out.length === 0) out.push({ a: p(ordered[0].i), b: p(ordered[0].i), half: r + 3 });
        return out;
      };
      const centerOf = (s: StMarks): Pixel => {
        const b = boxOf(s);
        return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
      };
      // ---- rigid-row collision slide (spec 2026-06-16-rigid-slide) --------
      // The OLD slide walked each dot independently along its OWN lane by equal
      // arc-length (lanePointAt). On NON-parallel lanes each dot moves by a
      // different vector, so a straight row bends off octilinear and the
      // station was boxed (SEA mn185). The fix moves the whole rigid row by ONE
      // shared translation and re-seats every dot as the intersection of its
      // (unchanged-direction) row LINE with its own lane — reusing rowPlace's
      // lineCrossNearest, the exact primitive that seated the dots at placement.
      // Every dot of a leg then lies on one straight octilinear line, so the
      // spine is octilinear BY CONSTRUCTION; the box class is gone.
      // Reconstruct the straight legs of a placed spine from the live marks:
      // chain order, split at each cornerAfter. Each leg's octilinear direction
      // is snapped from its end-to-end chord (already collinear by placement),
      // or from the lane tangent for a single-dot leg.
      const rowsOf = (marks: StMarks['marks']): Array<{ idx: number[]; u: Pixel }> => {
        const order = marks.map((_, i) => i).sort((a, b) => (marks[a].chain ?? 0) - (marks[b].chain ?? 0));
        const legs: number[][] = [];
        let cur: number[] = [];
        for (let k = 0; k < order.length; k++) {
          cur.push(order[k]);
          if (marks[order[k]].cornerAfter && k + 1 < order.length) { legs.push(cur); cur = []; }
        }
        if (cur.length) legs.push(cur);
        return legs.map((idx) => {
          let u: Pixel;
          if (idx.length >= 2) {
            const a = marks[idx[0]].pos, b = marks[idx[idx.length - 1]].pos;
            u = snapAxis(b[0] - a[0], b[1] - a[1]);
          } else {
            const mk = marks[idx[0]];
            const c = buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT);
            const tg = curveTangent(c, c.anchorT);
            u = snapAxis(tg[0], tg[1]);
          }
          return { idx, u };
        });
      };
      // Which incident DRAWN edge's lane does the re-seated dot ride, and how
      // far (arc from the lane's node-end to the dot) — both for trimLaneAt so a
      // terminating line's ink still ends at the slid dot. Nearest by squared
      // distance (no hypot in the selection). Unique for terminating dots.
      const laneEdgeArc = (mk: StMarks['marks'][number], p: Pixel): { edgeId: string; arc: number } => {
        let edgeId = '', bestD2 = Infinity, arc = 0;
        for (const e of layout.edges) {
          if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
          const poly = segPath.get(e.id + '|' + mk.lineId);
          if (!poly || poly.length < 2) continue;
          if (!drawsOn(mk.lineId, e.id)) continue;
          const pts = e.from === mk.flagNode ? poly : [...poly].reverse();
          let acc = 0;
          for (let i = 1; i < pts.length; i++) {
            const ax = pts[i - 1][0], ay = pts[i - 1][1];
            const vx = pts[i][0] - ax, vy = pts[i][1] - ay;
            const l2 = vx * vx + vy * vy;
            const seg = Math.sqrt(l2);
            const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / l2)) : 0;
            const qx = ax + vx * t, qy = ay + vy * t;
            const d2 = (p[0] - qx) * (p[0] - qx) + (p[1] - qy) * (p[1] - qy);
            if (d2 < bestD2) { bestD2 = d2; edgeId = e.id; arc = acc + seg * t; }
            acc += seg;
          }
        }
        return { edgeId, arc };
      };
      // Trial positions for a rigid translation of the whole spine away from
      // `away` by d px. Returns one {p,edgeId,arc} per mark, or null if the
      // translated line misses a windowed lane (infeasible at this d → caller
      // stops the sweep and degrades gracefully — never a box).
      const rigidSlide = (
        st: StMarks,
        away: Pixel,
        d: number,
      ): Array<{ p: Pixel; edgeId: string; arc: number }> | null => {
        const legs = rowsOf(st.marks);
        // Rigid translation applies when EVERY leg is a ≥2-dot straight row —
        // a single straight row OR a multi-arm junction (SEA mn185: legs=2+2+2).
        // Each leg's dots sit on an exact AXES line at placement, so re-seating
        // them on the translated same-axis line keeps every leg octilinear and
        // each corner = the exact intersection of two translated exact-axis
        // lines (applyCorners reproduces it with zero deviation). Per-leg legs
        // with a SINGLE dot (1-mark stations, corner stations whose arms are
        // one dot) are excluded — their "axis" is the lane direction, so a
        // perpendicular shift would miss the lane; those use the fallback.
        if (legs.length >= 1 && legs.every((l) => l.idx.length >= 2)) {
          let cx = 0, cy = 0;
          for (const mk of st.marks) { cx += mk.pos[0]; cy += mk.pos[1]; }
          cx /= st.marks.length; cy /= st.marks.length;
          let vx: number, vy: number;
          if (legs.length === 1) {
            // single straight row: translate PERPENDICULAR to its axis by d
            // (only the perpendicular component moves the line → full d of
            // lateral separation per step), on the side away from `away`.
            const u = legs[0].u;
            let nx = -u[1], ny = u[0];
            if ((cx - away[0]) * nx + (cy - away[1]) * ny < 0) { nx = -nx; ny = -ny; }
            vx = d * nx; vy = d * ny;
          } else {
            // multi-arm junction: translate the whole rigid spider by d along
            // the away direction; corners move by exactly v, each arm re-seats
            // on its own translated axis line (octilinear by construction).
            let dx = cx - away[0], dy = cy - away[1];
            const dl = Math.sqrt(dx * dx + dy * dy) || 1;
            vx = d * dx / dl; vy = d * dy / dl;
          }
          const out = new Array<{ p: Pixel; edgeId: string; arc: number }>(st.marks.length);
          let ok = true;
          for (const { idx, u } of legs) {
            const a0 = st.marks[idx[0]].pos;
            const A: Pixel = [a0[0] + vx, a0[1] + vy];
            for (const i of idx) {
              const mk = st.marks[i];
              let p = lineCrossNearest(buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT), A, u, mk.pos);
              if (!p) {
                // wide-window retry (mirrors placement escalation at solveRows)
                p = lineCrossNearest(buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, WIDE_ARC), A, u, mk.pos);
              }
              if (!p) { ok = false; break; }
              const ea = laneEdgeArc(mk, p);
              out[i] = { p, edgeId: ea.edgeId, arc: ea.arc };
            }
            if (!ok) break;
          }
          if (ok) return out;
        }
        // Fallback for 1-mark stations (no spine to bend), corner stations with
        // single-dot arms (applyCorners salvages the bend), and rows whose lanes
        // run parallel to the row (perpendicular translation can't re-cross):
        // the proven per-dot along-lane slide. applySlide's octilinearity guard
        // DECLINES any candidate that bends, so this can never box.
        const lp = st.marks.map((mk) => lanePointAt(mk.lineId, mk.flagNode, away, d));
        if (lp.some((q) => !q)) return null;
        return lp.map((q) => ({ p: q!.p, edgeId: q!.edgeId, arc: d }));
      };
      // commit a slide: move the dots, trim terminating lanes, recompute the
      // derived corners on the slid dots. A DRY-RUN octilinearity guard runs
      // first on a clone; rigid candidates pass by construction, so on a
      // (should-be-impossible) bent result we DECLINE — leave the station at
      // rest, NO box — and return false. Returns true when committed.
      const applySlide = (
        st: StMarks,
        moved: Array<{ p: Pixel; edgeId: string; arc?: number }>,
        d: number,
      ): boolean => {
        // dry-run: predict the slid spine on a clone without mutating anything
        const clone = st.marks.map((m) => ({
          ...m,
          pos: [m.pos[0], m.pos[1]] as Pixel,
          cornerAfter: m.cornerAfter ? ([m.cornerAfter[0], m.cornerAfter[1]] as Pixel) : undefined,
        }));
        const dcap = captureCorners(clone);
        for (let i = 0; i < clone.length; i++) clone[i].pos = moved[i].p;
        applyCorners(dcap);
        if (!spineOctilinear(clone)) {
          // dump leg structure + the worst off-axis segment so we can see WHY the
          // candidate bent in-engine (rigid vs fallback path).
          const lg = rowsOf(st.marks).map((l) => l.idx.length).join('+');
          reportRigidSlideDeclined({ nodeId: st.nodeId, legs: lg, marks: st.marks, clone });
          return false;
        }
        // Intra-station dot floor: re-seating dots on the translated line can
        // bring two dots below minGap (stacked bullets) — invisible while the
        // station boxed (the box hid them), visible now. Enforce the SAME floor
        // rowPlace uses at placement; decline a stacking candidate so the sweep
        // picks a non-stacking d (or the station stays at its spaced rest pose).
        const dotFloor = intraGap;
        for (let i = 0; i < clone.length; i++) {
          for (let j = i + 1; j < clone.length; j++) {
            const dx = clone[i].pos[0] - clone[j].pos[0];
            const dy = clone[i].pos[1] - clone[j].pos[1];
            if (dx * dx + dy * dy < dotFloor * dotFloor - 1e-6) {
              reportSlideStackDeclined(st.nodeId, Math.sqrt(dx * dx + dy * dy), dotFloor);
              return false;
            }
          }
        }
        // Hull guard (OCTI_CAPSULE_GUARD=0 disables): decline a slide whose
        // resulting hull would cross another drawn capsule OR ITSELF (the
        // clone already carries the slid corners).
        if (capGuardOn && st.marks.length >= 2) {
          const slidHull = capsHullOf(clone);
          if (capsHullSelfCrosses(slidHull)) {
            reportSlideSelfCross(capPlaceDebug, st.nodeId);
            return false;
          }
          const clash = capsHullClash(st, slidHull);
          if (clash) {
            reportSlideClashDeclined(capPlaceDebug, st.nodeId, clash);
            return false;
          }
        }
        const cap = captureCorners(st.marks); // old leg dirs before the slide
        for (let i = 0; i < st.marks.length; i++) {
          const mk = st.marks[i];
          mk.pos = moved[i].p;
          let incident = 0;
          for (const e of layout.edges) {
            if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
            const k = e.id + '|' + mk.lineId;
            // A suppressed incident lane (jog-sliver or corner absorption)
            // still carries the line onward across this node, so the line
            // does NOT terminate here. Counting only drawn lanes misreads a
            // through corner as a terminus and cuts the lane end its join
            // curve bridges to, leaving a hole in the route ink.
            if (segPath.has(k)) { if (drawsOn(mk.lineId, e.id)) incident++; }
            else if (suppressed.has(k)) incident++;
          }
          // Shared-anchor guard (Burke Court): if ANOTHER station's mark also
          // anchors this exact (lineId, flagNode) lane end, trimming it back to
          // THIS station's slid marker would strand the foreign station's marker
          // off the (now-shortened) ink. Leave the lane drawn to its tip instead.
          const anchoredBy = anchorStations.get(mk.lineId + '|' + mk.flagNode);
          const sharedWithOther = !!anchoredBy && (anchoredBy.size > 1 || !anchoredBy.has(st.nodeId));
          if (incident <= 1 && moved[i].edgeId && !sharedWithOther) trimLaneAt(moved[i].edgeId, mk.lineId, mk.flagNode, moved[i].arc ?? d);
        }
        applyCorners(cap); // recompute corners on the slid dots (spec R1)
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const mk of st.marks) {
          x0 = Math.min(x0, mk.pos[0]); y0 = Math.min(y0, mk.pos[1]);
          x1 = Math.max(x1, mk.pos[0]); y1 = Math.max(y1, mk.pos[1]);
        }
        slid.push({ nodeId: st.nodeId, at: [(x0 + x1) / 2, (y0 + y1) / 2] });
        return true;
      };
      // reachable lane offsets for a capsule sliding away from `away`: index 0 =
      // rest (current dots), 1.. = slid by 4,8,… up to `cap`, stopping at the
      // first offset that runs off a lane. A pinned capsule (already slid this
      // resolution) contributes only its rest offset.
      type Cand = { moved: Array<{ p: Pixel; edgeId: string; arc?: number }>; d: number; hull: Hull };
      const buildCands = (st: StMarks, away: Pixel, cap: number, pinned: boolean): Cand[] => {
        const rest: Cand = {
          moved: st.marks.map((mk) => ({ p: mk.pos, edgeId: '' })),
          d: 0,
          hull: hullsOf(st.marks),
        };
        if (pinned) return [rest];
        const out: Cand[] = [rest];
        for (let d = 4; d <= cap; d += 4) {
          const mv = rigidSlide(st, away, d); // rigid: collinear/octilinear by construction
          if (!mv) break;
          out.push({ moved: mv, d, hull: hullsOf(st.marks, (i) => mv[i].p) });
        }
        return out;
      };
      const mutualEnabled = !(
        envStr('OCTI_MUTUAL_SLIDE') === '0'
      );
      const smalls = gathered.filter((s) => s.marks.length > 0);
      const slidNodes = new Set<string>(); // pinned after one slide (mutual mode)
      const MAX_SWEEPS = mutualEnabled ? 3 : 1;
      for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let movedAny = false;
        for (let ai = 0; ai < smalls.length; ai++) {
          for (let bi = ai + 1; bi < smalls.length; bi++) {
            const A = smalls[ai];
            const B = smalls[bi];
            if (penBetween(hullsOf(A.marks), hullsOf(B.marks)) <= 0.5) continue;
            const pinnedA = mutualEnabled && slidNodes.has(A.nodeId);
            const pinnedB = mutualEnabled && slidNodes.has(B.nodeId);
            if (pinnedA && pinnedB) continue; // neither can move
            // --- stage 1: slide ONE capsule (the fewer-marks movable one) ---
            const S = pinnedA ? B : pinnedB ? A : A.marks.length <= B.marks.length ? A : B;
            const O = S === A ? B : A;
            const oHull = hullsOf(O.marks);
            const center = centerOf(O);
            let resolved = false;
            for (let d = 4; d <= 32; d += 4) {
              const moved = rigidSlide(S, center, d);
              if (!moved) break;
              const trialHull = hullsOf(S.marks, (i) => moved[i].p);
              if (penBetween(trialHull, oHull) > -1) continue;
              if (applySlide(S, moved, d)) {
                if (mutualEnabled) slidNodes.add(S.nodeId);
                movedAny = true;
                resolved = true;
                break;
              }
            }
            if (resolved || !mutualEnabled) continue;
            // --- stage 2: escalate — slide BOTH apart (best-effort) ---
            const candsA = buildCands(A, centerOf(B), 32, pinnedA);
            const candsB = buildCands(B, centerOf(A), 32, pinnedB);
            const { ka, kb } = chooseMutualSlide(candsA.map((c) => c.hull), candsB.map((c) => c.hull));
            if (ka > 0 || kb > 0) {
              let did = false;
              if (ka > 0 && applySlide(A, candsA[ka].moved, candsA[ka].d)) { slidNodes.add(A.nodeId); did = true; }
              if (kb > 0 && applySlide(B, candsB[kb].moved, candsB[kb].d)) { slidNodes.add(B.nodeId); did = true; }
              if (did) movedAny = true;
            }
          }
        }
        if (!movedAny) break;
      }
      capsAudit('post-mutual-slide');
      // ---- POST-SLIDE NO-OVERLAP FLOOR (marker-level GUARANTEE) -------------
      // The mutual-slide pass above thresholds on SPINE-HULL penetration, not on
      // the drawn casing rings: a capsule whose spine clears can still have an
      // end-dot ring overlapping a neighbour's ring in a dense residual cluster.
      // This final pass measures the actual nearest MARKER
      // (dot-to-dot) distance between every pair of distinct stations
      // and, where it is below casing-touch (2r+1.5), slides them apart ALONG
      // their own lanes (reusing rigidSlide → applySlide, so the spine stays
      // octilinear by construction). It iterates to convergence; any pair STILL
      // overlapping after the cap is left seated on its lanes and logged (a rare
      // residual the corridor-spread could not separate; accepted, not boxed).
      // OCTI_NOOVL_FLOOR=0 disables it (diagnostic).
      const noOvlEnabled = !(
        envStr('OCTI_NOOVL_FLOOR') === '0'
      );
      if (noOvlEnabled) {
        const touch = 2 * r + 1.5; // casing rings just clear at this center gap
        // Last-resort BOX threshold: slides aim to fully separate to `touch`. A
        // residual is only boxed when distinct bullets visibly MERGE, with centers
        // closer than the bullet-FILL touch distance 2r (two r-radius fills just
        // touch). Residuals in the casing-only band [2r, touch) are two distinct
        // bullets whose outer rings graze but whose fills are clear, such as
        // adjacent consecutive stops. Those are left as-is (and reported) rather
        // than boxed.
        // DEFAULT OFF (boxFloor 0): boxing a residual overlap trades it for a
        // <rect>, and in a genuinely-crowded core that balloons the box count,
        // worse than the overlap it removes. The residual crowded-core
        // overlaps are an UPSTREAM octi grid-quantization symptom (consecutive stops
        // collapsed below marker resolution), to be fixed there, not by boxing here.
        // The slide + along-corridor spread above still run (they cleanly separate
        // the slidable/straight-corridor cases). OCTI_NOOVL_BOX=<px> re-enables the
        // last-resort box (e.g. =2r to box fill-merges, =touch to box every graze).
        const boxFloor = (() => {
          const v = envNum('OCTI_NOOVL_BOX');
          return Number.isFinite(v) && v >= 0 ? v : 0;
        })();
        // nearest dot-pair between two stations (correctly-rounded hyp), plus the
        // midpoint push-apart pivot. Returns dist=Infinity for an empty side.
        const nearestMarks = (
          A: StMarks,
          B: StMarks,
        ): { dist: number; mid: Pixel } => {
          let md = Infinity;
          let mx = 0;
          let my = 0;
          for (const p of A.marks) {
            for (const q of B.marks) {
              const dd = hyp(p.pos[0] - q.pos[0], p.pos[1] - q.pos[1]);
              if (dd < md) { md = dd; mx = (p.pos[0] + q.pos[0]) / 2; my = (p.pos[1] + q.pos[1]) / 2; }
            }
          }
          return { dist: md, mid: [mx, my] };
        };
        // min dist from a proposed S placement to every OTHER non-boxed station
        // (so we can tell a globally-clearing slide from one that merely shifts
        // the overlap onto a third station; used for the FULL-clear preference).
        const minToOthers = (S: StMarks, pts: Pixel[]): number => {
          let md = Infinity;
          for (const T of smalls) {
            if (T === S) continue;
            for (let i = 0; i < pts.length; i++) for (const q of T.marks) {
              const dd = hyp(pts[i][0] - q.pos[0], pts[i][1] - q.pos[1]);
              if (dd < md) md = dd;
            }
          }
          return md;
        };
        const minToO = (pts: Pixel[], O: StMarks): number => {
          let md = Infinity;
          for (let i = 0; i < pts.length; i++) for (const q of O.marks) {
            const dd = hyp(pts[i][0] - q.pos[0], pts[i][1] - q.pos[1]);
            if (dd < md) md = dd;
          }
          return md;
        };
        // Slide station S away from `pivot`. Prefer the smallest d that FULLY
        // clears S of EVERY other station (ends the pair without spawning a new
        // one). Failing that, take the smallest d that clears the IMMEDIATE pair
        // (S↔O ≥ touch) — partial progress the sweeps then build on as the
        // cluster relaxes outward. Rigid → applySlide keeps the spine octilinear
        // (it declines any bent candidate, so this can never break octilinearity).
        const slideClear = (S: StMarks, O: StMarks, pivot: Pixel): boolean => {
          for (let d = 4; d <= 64; d += 4) {
            const moved = rigidSlide(S, pivot, d);
            if (!moved) break;
            const pts = moved.map((m) => m.p);
            if (minToOthers(S, pts) < touch) continue;
            if (applySlide(S, moved, d)) return true;
          }
          for (let d = 4; d <= 64; d += 4) {
            const moved = rigidSlide(S, pivot, d);
            if (!moved) break;
            const pts = moved.map((m) => m.p);
            if (minToO(pts, O) < touch) continue;
            if (applySlide(S, moved, d)) return true;
          }
          return false;
        };
        const NOOVL_SWEEPS = 8;
        for (let sweep = 0; sweep < NOOVL_SWEEPS; sweep++) {
          let movedAny = false;
          for (let ai = 0; ai < smalls.length; ai++) {
            const A = smalls[ai];
            for (let bi = ai + 1; bi < smalls.length; bi++) {
              const B = smalls[bi];
              const nm = nearestMarks(A, B);
              if (nm.dist >= touch) continue;
              // slide the more-flexible (fewer-marks) station away from the
              // overlap midpoint; if it can't clear, try the other one.
              const S = A.marks.length <= B.marks.length ? A : B;
              const O = S === A ? B : A;
              if (slideClear(S, O, nm.mid)) { movedAny = true; continue; }
              if (slideClear(O, S, nm.mid)) { movedAny = true; continue; }
            }
          }
          if (!movedAny) break;
        }
        // ---- ALONG-CORRIDOR SPREAD (bucket-C: coincident consecutive stops) --
        // The octi grid (~431m cell) contracts a run of consecutive same-line
        // single-bullet stops that are spaced <~216m on the ground until their
        // markers fall coincident (e.g. the 20th/18th/16th-St chain, the Hyde
        // cable corridor, the Embarcadero Stockton/Sansome/Bay run). Boxing such
        // a single-bullet stop is WRONG — it should be SPREAD along its own lane.
        // This pass, run BEFORE the last-resort box, finds single-bullet pairs
        // that (a) sit near each other, (b) are NOT boxed, and (c) are GRAPH-
        // ADJACENT on a shared drawn line (an edge whose {from,to} are the two
        // marks' flagNodes), unions them into chains, derives ONE octilinear
        // spread axis per chain (snapped from the longest corridor poly, else a
        // member's lane tangent), and re-seats each member at a `touch`-spaced
        // slot along a STRAIGHT line in that axis through the chain centroid —
        // octilinear by construction (a single bullet on an AXES direction). The
        // commit is ATOMIC per chain (octilinearity + outside-station floor +
        // intra-chain marker floor all checked first; any failure abandons the
        // WHOLE chain so a partial spread can't nudge a neighbour into a box).
        // Overlapping (< touch) corridor pairs are recorded so the last-resort
        // box SKIPS them. Determinism: hyp(), projection + nodeId tie-breaks.
        // Gated under OCTI_NOOVL_FLOOR (default on); OCTI_CORRIDOR_SPREAD=0
        // disables only this spread (diagnostic — falls back to box-everything).
        const spreadEnabled = !(envStr('OCTI_CORRIDOR_SPREAD') === '0');
        const corridorPairs = new Set<string>(); // "ai|bi" (ai<bi) seen adjacent
        const pairKey = (i: number, j: number) => (i < j ? i + '|' + j : j + '|' + i);
        // Shared drawn corridor between two stations: a lineId carried by a mark
        // in each whose flagNodes are joined by one drawn edge. Returns the edge
        // lane polyline (the actual offset ribbon centreline) + the two marks, or
        // null. Deterministic: scans layout.edges / marks in array order.
        const sharedCorridor = (A: StMarks, B: StMarks): Pixel[] | null => {
          for (const ma of A.marks) {
            for (const mb of B.marks) {
              if (ma.lineId !== mb.lineId) continue;
              if (ma.flagNode === mb.flagNode) continue;
              for (const e of layout.edges) {
                const joins =
                  (e.from === ma.flagNode && e.to === mb.flagNode) ||
                  (e.from === mb.flagNode && e.to === ma.flagNode);
                if (!joins) continue;
                const poly = segPath.get(e.id + '|' + ma.lineId);
                if (!poly || poly.length < 2) continue;
                return poly;
              }
            }
          }
          return null;
        };
        // Translate a whole station's capsule rigidly by (dx,dy), re-deriving its
        // corners on a clone first; commit only if the clone stays octilinear (a
        // single-mark capsule trivially passes — no spine). Returns committed.
        const rigidShift = (st: StMarks, dx: number, dy: number): boolean => {
          if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return true;
          const clone = st.marks.map((m) => ({
            ...m,
            pos: [m.pos[0] + dx, m.pos[1] + dy] as Pixel,
            cornerAfter: m.cornerAfter ? ([m.cornerAfter[0] + dx, m.cornerAfter[1] + dy] as Pixel) : undefined,
          }));
          if (!spineOctilinear(clone)) return false;
          // Hull guard (OCTI_CAPSULE_GUARD=0 disables): a corridor-spread shift
          // must not drag this capsule across another drawn capsule's hull —
          // or fold it across itself (same vetoes as applySlide's).
          if (capGuardOn && st.marks.length >= 2) {
            const shiftedHull = capsHullOf(clone);
            if (capsHullSelfCrosses(shiftedHull) || capsHullClash(st, shiftedHull)) return false;
          }
          for (const mk of st.marks) {
            mk.pos = [mk.pos[0] + dx, mk.pos[1] + dy];
            if (mk.cornerAfter) mk.cornerAfter = [mk.cornerAfter[0] + dx, mk.cornerAfter[1] + dy];
          }
          return true;
        };
        // Build the coincident-corridor graph over non-boxed stations, union into
        // chains, then spread each chain along its shared lane.
        const parent = smalls.map((_, i) => i);
        const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const union = (i: number, j: number) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj); };
        const centre = (st: StMarks): Pixel => {
          let cx = 0, cy = 0;
          for (const mk of st.marks) { cx += mk.pos[0]; cy += mk.pos[1]; }
          return [cx / st.marks.length, cy / st.marks.length];
        };
        // adjacency over station indices: each undirected edge carries the shared
        // corridor poly. Only STILL-overlapping (< touch), non-boxed, distinct-
        // nodeId pairs that share ONE drawn line edge between their flagNodes.
        const adj = new Map<number, Array<{ to: number; poly: Pixel[] }>>();
        const link = (i: number, to: number, poly: Pixel[]) => (adj.get(i) ?? adj.set(i, []).get(i)!).push({ to, poly });
        // Only SINGLE-BULLET stops take part: the bucket-C problem is consecutive
        // single-line stops octi-squished coincident (20th/18th/16th St, the Hyde
        // cable corridor, Embarcadero Stockton/Sansome/Bay). Multi-mark stations
        // are interchanges (Salesforce/Montgomery/12th-St) whose capsule centroid
        // ≠ its nearest marker, so a centroid-delta translation can't guarantee
        // marker separation and risks dragging a junction onto a branch — those
        // genuinely-stuck piles are left to the last-resort box.
        const singleBullet = (st: StMarks) => st.marks.length === 1;
        // A pair JOINS a corridor chain when both are single-bullet, graph-
        // adjacent on a shared drawn line, and their markers sit within LINK_NEAR.
        // LINK_NEAR is a touch over `touch` so a run the slide pass already pried
        // to just past `touch` still joins ONE chain (otherwise a tight corridor
        // can split into fragments that collide when each spreads independently),
        // but stays tight enough not to rope in well-separated neighbours. Only
        // pairs actually OVERLAPPING (< touch) flag corridorPairs (the box-skip
        // set); a wider graph-adjacent link only stitches the chain together.
        const LINK_NEAR = touch + 2 * r; // ≈ casing-touch + one fill diameter
        // Restrict to SINGLE-BULLET stops by default: a single-mark member's
        // marker IS its centroid, so the centroid-spaced spread guarantees marker
        // separation and never drags a capsule onto a junction. Multi-mark
        // capsules link junction hubs into large messy chains that (even with the
        // atomic guard) can leave a residual severe overlap, so they stay off
        // unless OCTI_CORRIDOR_MULTI=1 opts them in (the atomic plan still guards).
        const allowMulti = envStr('OCTI_CORRIDOR_MULTI') === '1';
        const eligible = (st: StMarks) => allowMulti || singleBullet(st);
        const singles: number[] = [];
        if (spreadEnabled) for (let i = 0; i < smalls.length; i++) if (eligible(smalls[i])) singles.push(i);
        for (const ai of singles) {
          for (const bi of singles) {
            if (bi <= ai) continue;
            if (smalls[ai].nodeId === smalls[bi].nodeId) continue; // not a corridor pair
            const d = nearestMarks(smalls[ai], smalls[bi]).dist;
            if (d >= LINK_NEAR) continue;
            const sc = sharedCorridor(smalls[ai], smalls[bi]);
            if (!sc) continue;
            if (d < touch) corridorPairs.add(pairKey(ai, bi)); // overlapping → box-skip
            union(ai, bi);
            link(ai, bi, sc);
            link(bi, ai, sc);
          }
        }
        // group members by chain root (only nodes that have a corridor link)
        const chains = new Map<number, number[]>();
        for (let i = 0; i < smalls.length; i++) {
          if (!adj.has(i)) continue;
          const root = find(i);
          (chains.get(root) ?? chains.set(root, []).get(root)!).push(i);
        }
        // nearest dist from a candidate point set to every NON-chain non-boxed
        // station (the chain members spread among themselves; they must not crash
        // into an outsider). Returns Infinity if none nearby.
        const minToOutside = (pts: Pixel[], chainSet: Set<number>): number => {
          let md = Infinity;
          for (let t = 0; t < smalls.length; t++) {
            if (chainSet.has(t)) continue;
            for (const p of pts) for (const q of smalls[t].marks) {
              const dd = hyp(p[0] - q.pos[0], p[1] - q.pos[1]);
              if (dd < md) md = dd;
            }
          }
          return md;
        };
        let spreadChains = 0;
        let spreadMembers = 0;
        const SPREAD_DBG = corridorSpreadDebug();
        for (const members of chains.values()) {
          if (members.length < 2) continue;
          // only spread chains that actually contain an OVERLAPPING (< touch)
          // pair — a chain stitched only from > touch graph-adjacent links is
          // already separated and must not be disturbed.
          let hasOverlap = false;
          for (let x = 0; x < members.length && !hasOverlap; x++) for (let y = x + 1; y < members.length; y++) if (corridorPairs.has(pairKey(members[x], members[y]))) { hasOverlap = true; break; }
          if (!hasOverlap) continue;
          const chainSet = new Set(members);
          // ---- order the chain (walk the adjacency from an endpoint) ----------
          // pick a deterministic endpoint: the member with the fewest in-chain
          // links (a path end), tie-broken by nodeId. Walk to the far end.
          const deg = (i: number) => (adj.get(i) ?? []).filter((e) => chainSet.has(e.to)).length;
          let startNode = members[0];
          for (const i of members) {
            const di = deg(i), ds = deg(startNode);
            if (di < ds || (di === ds && smalls[i].nodeId < smalls[startNode].nodeId)) startNode = i;
          }
          const order: number[] = [];
          const seen = new Set<number>();
          let curN = startNode;
          while (curN !== undefined && !seen.has(curN)) {
            order.push(curN); seen.add(curN);
            // next = unseen neighbour, deterministic by nodeId
            let nxt: number | undefined;
            for (const e of (adj.get(curN) ?? [])) {
              if (!chainSet.has(e.to) || seen.has(e.to)) continue;
              if (nxt === undefined || smalls[e.to].nodeId < smalls[nxt].nodeId) nxt = e.to;
            }
            curN = nxt as number;
          }
          // any members not reached by the walk (branchy cluster) → append by
          // nodeId so they still get a slot rather than colliding.
          for (const i of members) if (!seen.has(i)) order.push(i);
          // collapse duplicate-nodeId members (a station rendered twice via a
          // stationGroup): keep the first occurrence so the chain has ONE slot
          // per physical station — never splits one station across two slots.
          const seenNode = new Set<string>();
          const orderU = order.filter((i) => { const nid = smalls[i].nodeId; if (seenNode.has(nid)) return false; seenNode.add(nid); return true; });
          order.length = 0; order.push(...orderU);
          if (order.length < 2) continue;
          // ---- spread axis (a single octilinear direction) --------------------
          // The shared lanes between coincident stops are octi-CONTRACTED, often
          // to sub-pixel length — too short to give a reliable direction. Derive
          // the corridor axis as a snapped octilinear unit vector, preferring (in
          // order): the longest shared-corridor poly's end-to-end direction; else
          // a representative member's drawn-lane TANGENT (buildLaneCurve). Spread
          // members along a STRAIGHT line in that axis through the chain centroid
          // — the axis is snapped to an AXES direction, so every placed marker is
          // octilinear by construction (a single bullet on an octi axis).
          let axis: Pixel | null = null;
          let axisLen = -1;
          for (const i of order) for (const { poly } of adj.get(i) ?? []) {
            const dx = poly[poly.length - 1][0] - poly[0][0], dy = poly[poly.length - 1][1] - poly[0][1];
            const len = hyp(dx, dy);
            if (len > axisLen + 1e-6 && len > 0.5) { axisLen = len; axis = snapAxis(dx, dy); }
          }
          if (!axis) {
            // all corridor polys degenerate: use the run-axis of the chain's own
            // member positions if they are spread; else a member's lane tangent.
            const a0 = centre(smalls[order[0]]), aN = centre(smalls[order[order.length - 1]]);
            if (hyp(aN[0] - a0[0], aN[1] - a0[1]) > 0.5) axis = snapAxis(aN[0] - a0[0], aN[1] - a0[1]);
            else for (const i of order) {
              const mk = smalls[i].marks[0];
              if (!mk) continue;
              const c = buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT);
              const tg = curveTangent(c, c.anchorT);
              if (hyp(tg[0], tg[1]) > 1e-6) { axis = snapAxis(tg[0], tg[1]); break; }
            }
          }
          if (!axis) continue; // no derivable direction → leave for the box pass
          // signed position of each member along the axis (projection of centre),
          // then ORDER by it (tie-break nodeId) and re-space at `touch` intervals
          // recentred on the chain centroid. Straight-line, so no extrapolation
          // edge cases; a chain whose lane is sub-pixel still separates cleanly.
          const cen = (i: number) => centre(smalls[i]);
          let gx = 0, gy = 0;
          for (const i of order) { const c = cen(i); gx += c[0]; gy += c[1]; }
          gx /= order.length; gy /= order.length;
          const proj = (i: number) => { const c = cen(i); return (c[0] - gx) * axis![0] + (c[1] - gy) * axis![1]; };
          const seq2 = [...order].sort((a, b) => (proj(a) - proj(b)) || (smalls[a].nodeId < smalls[b].nodeId ? -1 : 1));
          const step = touch;
          const mid = (seq2.length - 1) / 2;
          // ATOMIC commit: compute every member's slot translation, and verify
          // ALL of them stay octilinear AND keep every marker ≥ `outsideFloor`
          // from any NON-chain station. `outsideFloor` is the DRAWN ring-touch
          // distance (scaled marker fill 2·r·MARKER_SCALE ≈ the diag's "severe"
          // floor) — a spread member may GRAZE a crossing corridor's stop (the
          // Hyde cable line is crossed by Lombard etc. in a dense district) but
          // never MERGE drawn fills. If ANY member fails, the WHOLE chain is
          // abandoned (no partial spread — a partial leaves the failing member
          // boxed AND nudges its neighbours into NEW boxes) and ALL its corridor
          // pairs are dropped so the last-resort box reproduces the un-spread
          // baseline for that cluster.
          const outsideFloor = Math.min(boxFloor, 2 * r * MARKER_SCALE);
          const plan: Array<{ i: number; dx: number; dy: number; pts: Pixel[] }> = [];
          let ok = true;
          let failNid = '';
          for (let k = 0; k < seq2.length && ok; k++) {
            const i = seq2[k];
            const st = smalls[i];
            const off = (k - mid) * step;
            const c = cen(i);
            const dx = gx + axis[0] * off - c[0], dy = gy + axis[1] * off - c[1];
            const pts = st.marks.map((m) => [m.pos[0] + dx, m.pos[1] + dy] as Pixel);
            if (minToOutside(pts, chainSet) < outsideFloor) { ok = false; failNid = `${smalls[i].nodeId}/outside`; break; }
            // octilinearity dry-run (rigidShift's guard, without mutating)
            const clone = st.marks.map((m) => ({ ...m, pos: [m.pos[0] + dx, m.pos[1] + dy] as Pixel, cornerAfter: m.cornerAfter ? ([m.cornerAfter[0] + dx, m.cornerAfter[1] + dy] as Pixel) : undefined }));
            if (!spineOctilinear(clone)) { ok = false; failNid = `${smalls[i].nodeId}/octi`; break; }
            plan.push({ i, dx, dy, pts });
          }
          // intra-chain marker floor: planned markers (in slot order) must stay
          // ≥ touch from EVERY other planned member, not just the slot neighbour.
          // For a curved corridor or a multi-mark member the centroid spacing can
          // still leave two nearest markers tight. Abandon the chain if so.
          for (let x = 0; ok && x < plan.length; x++) for (let y = x + 1; y < plan.length; y++) {
            let md = Infinity;
            for (const p of plan[x].pts) for (const q of plan[y].pts) { const dd = hyp(p[0] - q[0], p[1] - q[1]); if (dd < md) md = dd; }
            if (md < touch - 1e-6) { ok = false; failNid = `${smalls[plan[x].i].nodeId}~${smalls[plan[y].i].nodeId}/intra`; }
          }
          if (!ok) {
            for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) corridorPairs.delete(pairKey(members[x], members[y]));
            reportCorridorAbandon(SPREAD_DBG, failNid, seq2.map((i) => smalls[i].nodeId));
            continue;
          }
          for (const p of plan) if (rigidShift(smalls[p.i], p.dx, p.dy)) spreadMembers++;
          spreadChains++;
          reportCorridorSpread(SPREAD_DBG, seq2.length, axis, seq2.map((i) => smalls[i].nodeId));
        }
        reportCorridorSpreadSummary(spreadChains, spreadMembers);
        // last-resort: any pair whose bullet FILLS still merge (< boxFloor)
        // boxes the fewer-marks station. Casing-only grazes (boxFloor ≤ d < touch)
        // are left as drawn-but-clear-fill adjacent bullets and reported below.
        // Corridor-adjacent pairs (spread above) are SKIPPED. A consecutive
        // single-bullet stop is spread along its lane, never boxed.
        for (let ai = 0; ai < smalls.length; ai++) {
          const A = smalls[ai];
          for (let bi = ai + 1; bi < smalls.length; bi++) {
            const B = smalls[bi];
            if (corridorPairs.has(pairKey(ai, bi))) continue; // spread, not boxed
            if (nearestMarks(A, B).dist >= boxFloor) continue;
            // Accept + log: the corridor-spread could not separate this pair
            // (moving either would collide with a third station). Leave both
            // seated on their lanes rather than boxing; the diagnostic surfaces a
            // real case if one ever appears (none on the current corpus).
            reportNoOverlapFloorResidual({ layout, aNodeId: A.nodeId, bNodeId: B.nodeId });
          }
        }
      }
      capsAudit('final');
      // OCTI_DEBUG overlap diagnostic: EGREGIOUS ring overlaps. Bullet rings
      // (radius r+0.75, diameter 2r+1.5) crossing where they shouldn't. XSTN =
      // two DIFFERENT stations' bullets overlap; INSTN = two bullets of ONE
      // station that are NOT same-row-adjacent (a folded spine / piled junction).
      // Normal adjacent row bullets (≈minGap apart) are excluded. Reports coords
      // and node ids so the spot can be located.
      reportEgregiousOverlaps({ layout, r, smalls, gathered });
    }
    reportSlidStations({ layout, slid });

    // Terminus trim: a line that ENDS at this station has exactly one drawn
    // incident lane, and its ribbon runs all the way to the NODE. The
    // rigid-row solve (and the collision slides) move the marker DOT off the
    // node along that lane, so the terminating ink pokes straight THROUGH the
    // capsule and out the far side. Trim the node-end
    // of the lane back to the dot so the ink stops at its stop.
    const arcToPoint = (pts: Pixel[], target: Pixel): number => {
      let acc = 0;
      let best = 0;
      let bestD = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0];
        const ay = pts[i - 1][1];
        const vx = pts[i][0] - ax;
        const vy = pts[i][1] - ay;
        const L2 = vx * vx + vy * vy;
        const seg = Math.sqrt(L2);
        const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((target[0] - ax) * vx + (target[1] - ay) * vy) / L2));
        const d = hyp(target[0] - (ax + vx * t), target[1] - (ay + vy * t));
        if (d < bestD) { bestD = d; best = acc + seg * t; }
        acc += seg;
      }
      return best;
    };
    for (const s of gathered) {
      for (const mk of s.marks) {
        let incEdge: string | null = null;
        let nInc = 0;
        for (const e of layout.edges) {
          if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
          const k = e.id + '|' + mk.lineId;
          if (segPath.has(k)) { nInc++; incEdge = e.id; }
          // A jog-sliver-SUPPRESSED incident lane still carries the line
          // onward (the connector pass bridges across it), so the line does
          // NOT terminate here. Counting only drawn lanes would misread a
          // through corridor as a terminus and trim it back to its seat.
          else if (suppressed.has(k)) nInc++;
        }
        if (nInc !== 1 || !incEdge) continue; // terminus = one drawn incident lane
        const poly = segPath.get(incEdge + '|' + mk.lineId);
        const edge = edgeById.get(incEdge);
        if (!poly || !edge || poly.length < 2) continue;
        const pts = edge.from === mk.flagNode ? poly : [...poly].reverse();
        const d = arcToPoint(pts, mk.pos);
        // A CAPSULE terminus draws a pill around the seated dot row; a lane that
        // runs even slightly past its dot pokes its round cap out the far side of
        // the pill (the "nub", worst on a slanted terminal edge, where the row is
        // re-seated square but the lanes still end along the slant). Trim capsule
        // termini flush to the stop. A lone terminal dot has no pill, so a small
        // overhang past it reads as a normal line end, so keep the looser threshold.
        const isCapsule = s.marks.length >= 2 || (membersByNode?.get(s.nodeId) ?? 0) > 1;
        // Shared-anchor guard: a terminus sliver shared by two split
        // stations anchors both their marks; trimming it flush to THIS station's
        // dot would cut the lane back past the foreign station's dot and orphan
        // that marker off the ink. Leave the shared lane at its tip.
        const anchoredBy = anchorStations.get(mk.lineId + '|' + mk.flagNode);
        const sharedWithOther = !!anchoredBy && (anchoredBy.size > 1 || !anchoredBy.has(s.nodeId));
        if (d > (isCapsule ? 0.5 : r + 2) && !sharedWithOther) trimLaneAt(incEdge, mk.lineId, mk.flagNode, d);
      }
    }

    // Station-vs-capsule eviction: a terminus dot can land INSIDE a
    // neighbouring station's capsule when two stops are near-coincident.
    // The dot's only lane runs straight into that capsule, so it cannot
    // slide out ALONG it. Instead ROTATE the terminus stub: redraw it as a
    // single straight octilinear segment leaving the shared capsule-side
    // anchor in the octilinear direction closest to the original, far enough
    // to carry the dot clear of every foreign capsule (octilinearity holds
    // by construction, one axis-aligned leg).
    {
      const ptSegD = (px: number, py: number, a: Pixel, b: Pixel): number => {
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const l2 = vx * vx + vy * vy;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) : 0;
        return hyp(px - (a[0] + vx * t), py - (a[1] + vy * t));
      };
      const spineSegsOf = (st: StMarks): Array<[Pixel, Pixel]> => {
        const ord = [...st.marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
        const vs: Pixel[] = [];
        for (const mk of ord) { vs.push(mk.pos); if (mk.cornerAfter) vs.push(mk.cornerAfter); }
        const out: Array<[Pixel, Pixel]> = [];
        for (let i = 1; i < vs.length; i++) out.push([vs[i - 1], vs[i]]);
        return out;
      };
      const capHalf = r + 3; // a capsule's fill half-width
      const need = capHalf + r; // dot bullet fully clear of a capsule's fill
      const S2 = Math.SQRT1_2;
      const OCT: Pixel[] = [
        [1, 0], [S2, S2], [0, 1], [-S2, S2], [-1, 0], [-S2, -S2], [0, -1], [S2, -S2],
      ];
      const capsules = gathered.filter((o) => o.marks.length >= 2);
      const singleDots = gathered.filter((o) => o.marks.length === 1);
      // candidate dot clear of every FOREIGN capsule (spine segments + member
      // bullets), of every box rect, and of every lone foreign dot? An escape
      // that lands the dot inside a box or on top of a single bullet trades one
      // trap for another the old capsule-only check could not see.
      const dotClear = (p: Pixel, selfNode: string): boolean => {
        for (const o of capsules) {
          if (o.nodeId === selfNode) continue;
          for (const [a, b] of spineSegsOf(o)) if (ptSegD(p[0], p[1], a, b) < need) return false;
          for (const om of o.marks) if (hyp(p[0] - om.pos[0], p[1] - om.pos[1]) < 2 * r) return false;
        }
        for (const o of singleDots) {
          if (o.nodeId === selfNode) continue;
          const q = o.marks[0].pos;
          if (hyp(p[0] - q[0], p[1] - q[1]) < 2 * r) return false;
        }
        return true;
      };
      // the new stub may legitimately lie inside the anchor's capsule for the
      // first ~capHalf (every line leaves a capsule through its fill), but
      // BEYOND that it must run in open space. Otherwise the rotated stub
      // just slices across the foreign capsule. Box rects are NOT sampled
      // here: boxes are opaque covers that lanes legitimately pass beneath,
      // and lone dots sit ON lanes by construction, so only capsule fills
      // veto the stub's course.
      const stubClear = (anchor: Pixel, dir: Pixel, L: number, selfNode: string): boolean => {
        const steps = Math.max(2, Math.ceil(L));
        for (let i = 1; i <= steps; i++) {
          const t = (L * i) / steps;
          if (t < capHalf) continue; // emanation region next to the anchor
          const px = anchor[0] + dir[0] * t;
          const py = anchor[1] + dir[1] * t;
          for (const o of capsules) {
            if (o.nodeId === selfNode) continue;
            for (const [a, b] of spineSegsOf(o)) if (ptSegD(px, py, a, b) < capHalf) return false;
          }
        }
        return true;
      };
      const evicted: Array<{ node: string; to: Pixel }> = [];
      for (const s of gathered) {
        for (const mk of s.marks) {
          if (dotClear(mk.pos, s.nodeId)) continue; // not trapped
          // terminus = exactly one drawn incident lane. A suppressed incident
          // lane (jog-sliver or corner absorption) still carries the line
          // onward across the node, so it counts: re-stubbing a THROUGH lane
          // here would replace its whole polyline with a short stub and cut
          // the route where the corner curve lands.
          let incEdge: string | null = null;
          let nInc = 0;
          for (const e of layout.edges) {
            if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
            const k = e.id + '|' + mk.lineId;
            if (segPath.has(k)) { nInc++; incEdge = e.id; }
            else if (suppressed.has(k)) nInc++;
          }
          if (nInc !== 1 || !incEdge) continue; // only termini can be re-stubbed
          const edge = edgeById.get(incEdge);
          const poly = segPath.get(incEdge + '|' + mk.lineId);
          if (!edge || !poly || poly.length < 2) continue;
          // node-first: pts[0] is the dot (node) end, pts[last] the anchor where
          // the lane meets the neighbouring capsule's member bullet
          const pts = edge.from === mk.flagNode ? poly : [...poly].reverse();
          const anchor = pts[pts.length - 1];
          const ox = pts[pts.length - 2][0] - anchor[0];
          const oy = pts[pts.length - 2][1] - anchor[1];
          const ol = hyp(ox, oy) || 1;
          const odir: Pixel = [ox / ol, oy / ol];
          // octilinear axes ranked by closeness to the original outward dir
          const ranked = [...OCT].sort(
            (d1, d2) => (d2[0] * odir[0] + d2[1] * odir[1]) - (d1[0] * odir[0] + d1[1] * odir[1]),
          );
          let placed: Pixel | null = null;
          for (const dir of ranked) {
            for (let L = need; L <= need + 24; L += 1) {
              const cand: Pixel = [anchor[0] + dir[0] * L, anchor[1] + dir[1] * L];
              if (dotClear(cand, s.nodeId) && stubClear(anchor, dir, L, s.nodeId)) { placed = cand; break; }
            }
            if (placed) break;
          }
          if (!placed) continue; // no clean octilinear escape, leave it
          mk.pos = placed;
          mk.cornerAfter = undefined;
          mk.chain = 0;
          const rebuilt: Pixel[] = [placed, anchor];
          segPath.set(incEdge + '|' + mk.lineId, edge.from === mk.flagNode ? rebuilt : [...rebuilt].reverse());
          evicted.push({ node: s.nodeId, to: placed });
        }
      }
      reportEvictedStations({ layout, evicted });
    }
    // Eviction is the last pass that moves a marker; nothing may audit-drift
    // after it unobserved.
    capsAudit('post-eviction');

    for (const s of gathered) {
      for (const m of s.marks) addStop(m.lineId, m.color, s.nodeId, m.pos, m.chain, m.cornerAfter, m.home, m.axis, m.dir, m.terminus, m.outward, m.seatDirt);
    }

    for (const s of gathered) {
      if (!s.splitBase) continue;
      let arr = splitGroups.get(s.splitBase);
      if (!arr) splitGroups.set(s.splitBase, (arr = []));
      arr.push(s.nodeId);
    }
    for (const [base, arr] of splitGroups) {
      if (arr.length < 2) splitGroups.delete(base);
    }
    // Rectangle placement for the full Tokyu stop set (interchange capsules plus
    // single boxes), seated + deconflicted once here. The placement queue has
    // exhausted, so every mark's pre-solve home/axis and final pos are set.
    // Design-agnostic: built from geometry, never from the active design; inert
    // for non-rect designs. gathered is in the deterministic placement order, so
    // the maps are stable. laneItemFor lets the large-hub path seat boxes by
    // sliding along their real drawn lanes (windowed to the seat-slide arc), so a
    // box stays on its line and cannot slide past a terminus.
    const LANE_SEAT_ARC = 160;
    const laneItemFor: LaneItemFor = (lineId, flagNode, anchor) => {
      const polys = lanePolysAt(lineId, flagNode);
      if (!polys || polys.length === 0) return null;
      const curve = buildLaneCurve(polys, anchor, LANE_SEAT_ARC);
      return { lineId, curve, t0: curve.anchorT };
    };
    ({ rectByNode, tokyuStopPos } = computeRectByNode(gathered, RECT_BOX, laneItemFor));
    // London bubbles, from the final marks; used just below for the London lane
    // crop footprint and returned for the London design to paint from.
    bubbleByNode = computeLondonByNode(stopsByNode, LINE_WIDTH);
    // torontoByNode is computed later, from the FINAL dByLine (below), so the
    // crossing solve sees every join/connector that bridges a node gap.

    // Lane-crop targets: for every mark that resolved to a seated rect box, the
    // exact DRAWN capsule rect its lane should end on. A multi-line mark crops to
    // the GROUP rect (capsule) its box sits inside, so the lane ends precisely on
    // the painted shape rather than a guessed per-line square; a single stop crops
    // to its single-stop box. Marks without a box are skipped. `shared` reuses the
    // terminus-trim shared-anchor guard. Consumed after the draw-fillet finalizes
    // segPath.
    const singleBoxSide = 3 * RECT_R0;
    const boxEps = 1e-6;
    const containingGroup = (groups: RectCapsule['groups'], cx: number, cy: number): Box | undefined => {
      for (const g of groups) {
        if (cx >= g.x - boxEps && cx <= g.x + g.w + boxEps && cy >= g.y - boxEps && cy <= g.y + g.h + boxEps) {
          return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
        }
      }
      return undefined;
    };
    // ROUTE-TERMINUS gate: a target is pushed only where the line's course
    // actually ends. The geometric free-end signals inside
    // computeLaneCrops cannot tell a terminus from a SEAM in the drawn
    // course (a trim or merge can leave a single incident lane with a
    // detached endpoint at a mid-route station, and cropping there amputates
    // a line that continues). The traversal gives the semantic ends: the
    // walk's start and end nodes, plus every turnaround where the walk
    // re-traverses an edge back the way it came (a branch tip on a forked
    // line). A seam never appears in the traversal, so it can never be
    // cropped.
    // Per-regime FOOTPRINT: the drawn marker shape a line's stop sits on. Each
    // capsule regime just maps its geometry to a CropShape; the crop routine is
    // shared, so a new design supplies a footprint and needs no crop code.
    const rectShapeFor = (s: StMarks, mk: StMarks['marks'][number]): CropShape | undefined => {
      const cap = rectByNode.get(s.nodeId);
      if (cap) {
        const c = cap.centers.find((e) => e.lineId === mk.lineId);
        if (!c) return undefined;
        // The capsule the box is drawn inside; fall back to the box itself only
        // if no group rect contains its center.
        const g = containingGroup(cap.groups, c.x, c.y);
        if (g) return { kind: 'rect', x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
        const h = cap.box / 2;
        return { kind: 'rect', x0: c.x - h, x1: c.x + h, y0: c.y - h, y1: c.y + h };
      }
      const sp = tokyuStopPos.get(s.nodeId);
      if (sp && s.marks.length === 1) {
        const h = singleBoxSide / 2;
        return { kind: 'rect', x0: sp[0] - h, x1: sp[0] + h, y0: sp[1] - h, y1: sp[1] + h };
      }
      return undefined;
    };
    const londonShapeFor = (s: StMarks, mk: StMarks['marks'][number]): CropShape | undefined => {
      const cap = bubbleByNode.get(s.nodeId);
      if (!cap || cap.bubbles.length === 0) return undefined;
      const stop = drawnEndAt.get(mk.flagNode + '|' + mk.lineId);
      if (!stop) return undefined;
      // the bubble covering this line's stop (nearest bubble center)
      let best = cap.bubbles[0], bd = Infinity;
      for (const b of cap.bubbles) {
        const dd = (b.x - stop[0]) ** 2 + (b.y - stop[1]) ** 2;
        if (dd < bd) { bd = dd; best = b; }
      }
      return { kind: 'disc', cx: best.x, cy: best.y, r: best.r };
    };
    // Targets are pushed for every TERMINUS mark with a footprint; the ENDINGS-
    // ONLY rule is additionally enforced geometrically inside computeLaneCrops (a
    // lane end is touched only when it is a free end of the line's drawn course),
    // so a through lane can never be cut and the gate agrees with the final
    // drawn geometry.
    const cropRegimes: Array<[string, (s: StMarks, mk: StMarks['marks'][number]) => CropShape | undefined]> = [
      ['rectRows', rectShapeFor],
      ['londonBubbles', londonShapeFor],
    ];
    for (const [regime, shapeFor] of cropRegimes) {
      const targets: LaneCropTarget[] = [];
      for (const s of gathered) {
        for (const mk of s.marks) {
          if (!isRouteTerminus(mk.lineId, mk.flagNode)) continue;
          const shape = shapeFor(s, mk);
          if (!shape) continue;
          const anchoredBy = anchorStations.get(mk.lineId + '|' + mk.flagNode);
          const shared = !!anchoredBy && (anchoredBy.size > 1 || !anchoredBy.has(s.nodeId));
          targets.push({ lineId: mk.lineId, flagNode: mk.flagNode, shape, shared });
        }
      }
      if (targets.length) cropTargetsByRegime.set(regime, targets);
    }
  } else {
    for (const edge of layout.edges) {
      for (const [lineId, stop] of edge.stops) {
        const line = lineById.get(lineId);
        if (!line) continue;
        if (stop.atFrom) {
          const p = drawnEndAt.get(edge.from + '|' + lineId);
          if (p) addStop(lineId, line.color, edge.from, p);
        }
        if (stop.atTo) {
          const p = drawnEndAt.get(edge.to + '|' + lineId);
          if (p) addStop(lineId, line.color, edge.to, p);
        }
      }
    }
  }
  // Draw-only sharp-corner fillet (post-marker): the sharp fused-station bends
  // that the gentle join left raw, kept raw to keep the marker
  // solver's lane input pristine, get filleted HERE, after every marker /
  // slide / eviction read of segPath is done. So this rounds only the DRAWN
  // ribbon and cannot move a marker (the dots are already seated). Reuses the
  // regressive curveLaneJoin; marks the pair mitered so the connector pass
  // skips it. Only touches consecutive pairs no earlier join already handled.
  const noDrawFillet =
    envStr('OCTI_NO_DRAWFILLET') === '1';
  if (!noDrawFillet) {
    for (const [lineId, traversal] of layout.lineTraversals) {
      if (!lineById.has(lineId)) continue;
      for (let i = 1; i < traversal.length; i++) {
        const a = traversal[i - 1];
        const b = traversal[i];
        if (a.edgeId === b.edgeId) continue;
        const ea = edgeById.get(a.edgeId);
        const eb = edgeById.get(b.edgeId);
        if (!ea || !eb) continue;
        const endA = a.reversed ? ea.from : ea.to;
        const startB = b.reversed ? eb.to : eb.from;
        if (endA !== startB) continue;
        const aAtStart = ea.from === endA;
        const bAtStart = eb.from === endA;
        const keyA = a.edgeId + '|' + lineId + '|' + (aAtStart ? 's' : 'e');
        const keyB = b.edgeId + '|' + lineId + '|' + (bAtStart ? 's' : 'e');
        if (endMoved.has(keyA) || endMoved.has(keyB)) continue; // already joined/clipped
        const pA = segPath.get(a.edgeId + '|' + lineId);
        const pB = segPath.get(b.edgeId + '|' + lineId);
        if (!pA || !pB || pA.length < 2 || pB.length < 2) continue;
        const rj = curveLaneJoin(pA, aAtStart, pB, bAtStart, SMOOTH_R, spacing * 4, true);
        if (!rj) continue;
        endMoved.add(keyA);
        endMoved.add(keyB);
        const pk = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
        mitered.add(lineId + '|' + endA + '|' + pk);
        const [eA2, eB2] = a.edgeId < b.edgeId ? [a.edgeId, b.edgeId] : [b.edgeId, a.edgeId];
        joinCurves.push({ lineId, node: endA, a: rj.a, apex: rj.apex, b: rj.b, edgeA: eA2, edgeB: eB2 });
      }
    }
  }

  emitLanes();

  // Per-regime lane crop: for each design regime with a footprint, re-emit a
  // parallel per-line 'd' from a clone of segPath whose incident lane ends were
  // cut back or extended to meet each mark's painted marker shape. segPath is
  // final here (the draw-fillet has run), so the clone reflects the drawn lanes.
  // The real dByLine above is untouched, so a design whose regime is absent stays
  // byte-identical.
  for (const [regime, targets] of cropTargetsByRegime) {
    cropDPartsByRegime.set(regime, computeLaneCrops(
      targets, segPath, layout.edges, joinCurves, FILLET_R, LINE_WIDTH / 2,
      useAssembler ? (seg) => assembleOver(seg) : undefined,
    ));
  }

  // Node connectors: where a line continues across a node between two edges
  // whose lane slots differ, bridge the lateral jog so the line reads as
  // continuous. Driven by traversals (the line's actual edge sequence).
  // Legacy pass: the assembler constructs these joints in-path, so this
  // runs only under OCTI_ASSEMBLE=0.
  const connSeen = new Set<string>();
  if (!useAssembler) for (const [lineId, traversal] of layout.lineTraversals) {
    if (!lineById.has(lineId)) continue;
    // A circular RING course continues across its seam node too: the pair
    // (last drawn lane, first drawn lane) is a real continuation the linear
    // scan never visits. The join pass wraps the same seam, but every one of
    // its decline paths falls through to THIS connector as the last resort,
    // so the seam must be reachable here as well or a ring whose seam join
    // declines is left with a bare gap. One extra iteration revisits the
    // first drawn lane when the course closes on itself. An out-and-back
    // course also ends where it starts, but its seam retraces ONE edge
    // (same edge, opposite directions), which has nothing to bridge.
    let wrap = 0;
    if (traversal.length > 1) {
      const f = traversal[0];
      const l = traversal[traversal.length - 1];
      const sameEdgeSeam = f.edgeId === l.edgeId && f.reversed !== l.reversed;
      const ef = edgeById.get(f.edgeId);
      const el = edgeById.get(l.edgeId);
      const firstStart = f.reversed ? ef?.to : ef?.from;
      const lastEnd = l.reversed ? el?.from : el?.to;
      if (!sameEdgeSeam && firstStart !== undefined && firstStart === lastEnd) wrap = 1;
    }
    let prevIdx = -1;
    let firstIdx = -1;
    for (let i = 0; i < traversal.length + wrap; i++) {
      const wrapped = i >= traversal.length;
      const idx = wrapped ? firstIdx : i;
      if (idx < 0) break; // wrap visit with no drawn lane at all
      if (!wrapped && !segPath.has(traversal[idx].edgeId + '|' + lineId)) continue; // undrawn/suppressed
      if (prevIdx < 0) {
        prevIdx = idx;
        firstIdx = idx;
        continue;
      }
      if (wrapped && prevIdx === idx) break; // single drawn lane, no seam pair
      const a = traversal[prevIdx];
      const b = traversal[idx];
      // a gap of SUPPRESSED slivers between two drawn lanes still bridges:
      // the guest line crosses the host bundle in one stroke. At the seam
      // the gap wraps around: the undrawn tail past the last drawn lane plus
      // the undrawn head before the first drawn lane.
      const between: number[] = [];
      if (wrapped) {
        for (let k = prevIdx + 1; k < traversal.length; k++) between.push(k);
        for (let k = 0; k < idx; k++) between.push(k);
      } else {
        for (let k = prevIdx + 1; k < i; k++) between.push(k);
      }
      let bridging = false;
      if (between.length > 0) {
        bridging = true;
        for (const k of between) {
          if (!suppressed.has(traversal[k].edgeId + '|' + lineId)) {
            bridging = false;
            break;
          }
        }
        if (!bridging) {
          prevIdx = idx;
          continue;
        }
      }
      prevIdx = idx;
      const ea = edgeById.get(a.edgeId);
      const eb = edgeById.get(b.edgeId);
      if (!ea || !eb) continue;
      const endA = a.reversed ? ea.from : ea.to;
      const startB = b.reversed ? eb.to : eb.from;
      if (!bridging && endA !== startB) continue; // discontinuity, nothing to bridge
      const pairKey = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
      const key = lineId + '|' + endA + '>' + startB + '|' + pairKey;
      const miterKey = lineId + '|' + endA + '|' + pairKey;
      if (connSeen.has(key) || mitered.has(miterKey)) continue;
      connSeen.add(key);
      const pa = lineEndAt(a.edgeId, lineId, endA);
      const pb = lineEndAt(b.edgeId, lineId, startB);
      if (!pa || !pb) continue;
      const gap = hyp(pb[0] - pa[0], pb[1] - pa[1]);
      // A graph-contiguous continuation at a shared node is ALWAYS the same line
      // jogging between lane slots. It MUST be bridged or the drawn route breaks.
      // The only non-bridge case is a genuinely coincident pair (gap < 0.5). A
      // fixed upper cap would drop legitimate large slot jogs at dense hubs where
      // a line crosses a wide bundle. The bridge is bounded to the actual incident
      // bundle span instead of refused, so every real slot jog connects while a
      // pathological cross-canvas jump (never produced by a same-node
      // continuation) is still rejected. OCTI_CONN_MAXGAP overrides the cap for
      // dev sweeps.
      const bundleSpan = ((orderOf.get(a.edgeId)?.length ?? 1) + (orderOf.get(b.edgeId)?.length ?? 1)) * spacing;
      const maxGapEnv =
        envNum('OCTI_CONN_MAXGAP');
      const maxGap = Number.isFinite(maxGapEnv) && maxGapEnv > 0 ? maxGapEnv : Math.max(spacing * 8, bundleSpan);
      if (gap < 0.5 || gap > maxGap) continue; // coincident, or pathological jump
      let d = dByLine.get(lineId);
      if (!d) dByLine.set(lineId, (d = []));
      // The connector jog is drawn on both the live dByLine and (when present) the
      // cropped rect-design parts, so a through line keeps its lateral node jog in
      // the Tokyu design too. The bridge attaches at the real lane ends, which sit
      // under the seated boxes, so it reads the same for both.
      const conn: string[] = [];
      // Tangent-matched cubic instead of a straight chord makes a lateral lane
      // jog read as a smooth S through the node, not a crimp (LOOM transitmap's
      // inner node geometries). Control points extend along each lane's end
      // direction; for near-parallel ends this is the classic S-curve.
      const polyA = segPath.get(a.edgeId + '|' + lineId)!;
      const polyB = segPath.get(b.edgeId + '|' + lineId)!;
      const prevA = ea.from === endA ? polyA[1] : polyA[polyA.length - 2];
      const nextB = eb.from === startB ? polyB[1] : polyB[polyB.length - 2];
      const unitTo = (from: Pixel, to: Pixel): Pixel => {
        const len = hyp(to[0] - from[0], to[1] - from[1]) || 1;
        return [(to[0] - from[0]) / len, (to[1] - from[1]) / len];
      };
      // longer tangents spread the S over more of the corridor (sketch-style
      // sweeps instead of tight Z-jogs)
      const dirA = prevA ? unitTo(prevA, pa) : unitTo(pa, pb); // into the node
      const dirB = nextB ? unitTo(pb, nextB) : unitTo(pa, pb); // out of the node
      reportConnTrace({
        lineId, endA, cell: layout.nodes.get(endA)?.cell,
        pa, pb, gap, prevA, nextB, dirA, dirB,
        nA: polyA.length, nB: polyB.length, edgeA: a.edgeId, edgeB: b.edgeId,
      });
      // The S only works when the jog makes forward progress along the
      // travel direction, so cap the tangent extension at the chord's
      // LONGITUDINAL span. A pure lateral jog (lanes of two collinear edges
      // ending at the same station of the corridor) has lon ~ 0; tangent-matched
      // controls would balloon a 180-degree hairpin past the node, so it degrades
      // to a plain crossover chord.
      const tx = dirA[0] + dirB[0];
      const ty = dirA[1] + dirB[1];
      const tLen = hyp(tx, ty) || 1;
      const lon = Math.abs(((pb[0] - pa[0]) * tx + (pb[1] - pa[1]) * ty) / tLen);
      const k = Math.min(Math.min(spacing * 4, Math.max(gap, spacing * 2)), lon);
      // the chord must progress along BOTH tangents, else the bezier loops
      // backward around an endpoint (270-degree balloon)
      const prog = Math.min(
        (pb[0] - pa[0]) * dirA[0] + (pb[1] - pa[1]) * dirA[1],
        (pb[0] - pa[0]) * dirB[0] + (pb[1] - pa[1]) * dirB[1],
      );
      conn.push('M' + pa[0].toFixed(1) + ',' + pa[1].toFixed(1));
      if (dirA[0] * dirB[0] + dirA[1] * dirB[1] < -0.3 || k < 1.5 || prog < 0) {
        // regressive turn (or no forward progress): tangent-matched control
        // points would bulge the bridge outward. A plain chord across the
        // junction reads as the line passing straight through.
        conn.push('L' + pb[0].toFixed(1) + ',' + pb[1].toFixed(1));
      } else {
        const { c1, c2 } = connectorControls(pa, pb, dirA, dirB, k);
        conn.push(
          'C' + c1[0].toFixed(1) + ',' + c1[1].toFixed(1) + ' ' +
          c2[0].toFixed(1) + ',' + c2[1].toFixed(1) + ' ' +
          pb[0].toFixed(1) + ',' + pb[1].toFixed(1),
        );
      }
      for (const cmd of conn) d.push(cmd);
      // Mirror the cross-node jog onto every regime's cropped lane too.
      for (const dParts of cropDPartsByRegime.values()) {
        let td = dParts.get(lineId);
        if (!td) dParts.set(lineId, (td = []));
        for (const cmd of conn) td.push(cmd);
      }
      segments.push({ p1: pa, p2: pb });
    }
  }

  reportRibbonSummary({
    segCount: segPath.size, edgeCount: layout.edges.length,
    miteredCount: mitered.size, connCount: connSeen.size, lineCount: dByLine.size,
  });
  // Final-ink clip census (dByLine is complete here: fillets, joins and node
  // connectors all applied).
  // The clip and step censuses measure the ink a reader SEES: when a
  // capsule regime crops lane ends under its boxes, the cropped lanes are
  // the painted truth and the uncropped ends under the markers must not
  // count. Fall back to dByLine when no crop exists.
  const censusInk = (() => {
    const rect = envStr("OCTI_CONTIG_RAW") === "1" ? undefined : cropDPartsByRegime.get("rectRows");
    if (!rect || rect.size === 0) return dByLine;
    const m = new Map(dByLine);
    for (const [lineId, parts] of rect) m.set(lineId, parts);
    return m;
  })();
  reportBundleClips({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine, spacing,
    stations: args.stations, nodePx,
  });
  // Perpendicular micro-step census (invariant I9), same final ink.
  reportZigzags({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine, spacing,
    stations: args.stations, nodePx,
  });
  reportSpikes({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine, spacing,
    stations: args.stations, nodePx,
  });
  reportStairs({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine, spacing,
    stations: args.stations, nodePx,
  });
  reportContiguity({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine,
    stations: args.stations, nodePx, stopsByNode,
  });
  // Loop diagnostic (OCTI_LOOPS): self-crossings of a route's FINAL DRAWN ink
  // (a fused-station hook, balloon loop, terminal-ring closure, jog taper laid
  // over a corridor). Measured on the drawn 'd' like the contiguity census, so
  // a course that retraces or jumps between non-adjacent steps reports no
  // phantom loop where a traversal-concatenation chord would have cut its ink.
  reportPaintedLoops({
    layout, lineById, dByLine: censusInk, parseInk: drawnSegsByLine,
    stations: args.stations, nodePx,
  });

  // Toronto crossings, from the FINAL drawn ribbons (dByLine is complete here:
  // fillets, joins and node connectors all applied). Each stop reads its own
  // line's drawn segments near its dot; the solver seats a crossing dot only
  // where two ribbons actually cross.
  if (stopsByNode.size) {
    const segsByLine = drawnSegsByLine(dByLine);
    const win2 = ((LINE_WIDTH + LINE_GAP) * 3.5) ** 2;
    const laneByStop = new Map<string, Pixel[][]>();
    for (const [nodeId, marks] of stopsByNode) {
      for (const m of marks) {
        const segs = segsByLine.get(m.lineId);
        if (!segs) continue;
        const near = segs.filter(([a, b]) => (a[0] - m.pos[0]) ** 2 + (a[1] - m.pos[1]) ** 2 <= win2 || (b[0] - m.pos[0]) ** 2 + (b[1] - m.pos[1]) ** 2 <= win2);
        laneByStop.set(nodeId + '|' + m.lineId, near);
      }
    }
    torontoByNode = computeTorontoByNode(stopsByNode, laneByStop);
  }

  // Join each regime's cropped parts (lanes + mirrored connectors) into per-line
  // strings, keyed by capsule regime; serialization-safe on the geometry. A
  // regime absent here means its design falls back to dByLine.
  let croppedLaneByLine: Map<string, Map<string, string>> | undefined;
  if (cropDPartsByRegime.size) {
    croppedLaneByLine = new Map<string, Map<string, string>>();
    for (const [regime, dParts] of cropDPartsByRegime) {
      const m = new Map<string, string>();
      for (const [lineId, parts] of dParts) m.set(lineId, parts.join(' '));
      croppedLaneByLine.set(regime, m);
    }
  }

  // The fallback content frame is pure in the drawn nodes/edges, so scan them
  // once here instead of on every repaint that lacks a geography frame.
  const frameRect = contentFrame(nodePx, layout.edges, edgePolyline, args.width, args.height);

  reportZoneCrossings({
    zones: fanZones,
    dByLine: censusInk,
    parseInk: drawnSegsByLine,
    lineById,
    lineTraversals: layout.lineTraversals,
    edgeById,
    basePoly: (id) => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    },
    halfWidthOf: (id) => (((orderOf.get(id)?.length ?? 1) - 1) / 2) * spacing,
    spacing,
    nodePx,
  });
  reportStopSeating({
    zones: fanZones,
    stopsByNode,
    joinStopPos,
    edgeById,
    basePoly: (id) => {
      const e = edgeById.get(id);
      return e ? edgePolyline(e) : undefined;
    },
    halfWidthOf: (id) => (((orderOf.get(id)?.length ?? 1) - 1) / 2) * spacing,
    spacing,
    nodePx,
    dirtAt: seatInkOracle ? (p, lid) => seatInkOracle!.dirtAt(p, lid) : undefined,
  });

  return { stopsByNode, membersByNode, dByLine, segments, lineById, orderOf, splitGroups, rectByNode, tokyuStopPos, croppedLaneByLine, contentFrame: frameRect, bubbleByNode, torontoByNode, paintGroups };
}

// The cheap, toggle-DEPENDENT half: assemble the SVG string + Scene IR from the
// precomputed geometry. renderStops honors showStations, placeLabels honors
// showLabels; bg/casing are theme (dark). ~tens of ms. See docs/cache-read-perf.md.
export function paintRibbons(args: RenderRibbonsArgs, geom: RibbonGeometry, sceneOut?: SceneOut): string {
  const { layout, nodePx, edgePolyline, width, height, dark, showLabels } = args;
  const bg = args.land ?? (dark ? DARK_THEME.land : '#ffffff');
  const casingWidth = LINE_WIDTH + 3;
  const { membersByNode, dByLine, segments, lineById, orderOf } = geom;
  // pre-splitGroups geometry (older saved maps deserialize without the field);
  // draw with no connectors rather than crash on an undefined iterate
  const splitGroups = geom.splitGroups ?? new Map<string, string[]>();

  // ---- simplified routes -------------------------------------------------
  // Per-route display setting resolved to the LINES it actually affects (routes
  // sharing a bullet and edge set are drawn as one line). Nothing here moves a
  // line: the lane slot keeps its width and position, and a thinner stroke
  // inside it is what reads as separation from its bundle mates.
  const simplified = resolveSimplifiedLines(
    args.simplifiedRoutes,
    layout.canonLineId,
    layout.canonLineId ? [...layout.canonLineId.keys()] : undefined,
  );
  const simpSig = simplifiedSignature(simplified);
  /** Drawn stroke + casing width for a line. One resolver, used by BOTH the SVG
   *  markup and the canvas Prim scene, so the two backends cannot drift. */
  const strokeFor = (lineId: string): { width: number; casing: number | null; dash?: [number, number]; color?: string } => {
    const r = simplified.get(lineId);
    if (!r) return { width: LINE_WIDTH, casing: casingWidth };
    // Scaling a width by a percentage lands on values like 0.17500000000000002,
    // which would print in full into every path. Trim to sub-pixel precision so
    // the markup stays readable and the two backends agree exactly.
    const w = Math.round(LINE_WIDTH * r.widthScale * 1000) / 1000;
    return {
      width: w,
      casing: r.style.casing ? w + 3 : null,
      ...(r.dash ? { dash: r.dash } : {}),
      ...(r.color ? { color: r.color } : {}),
    };
  };
  // Routes recoloured by the grey setting. Their MARKERS follow the line, or a
  // greyed route would keep full-colour dots at the stops it still draws.
  const recolored = new Map<string, string>();
  for (const [id, r] of simplified) if (r.color) recolored.set(id, r.color);
  // Marks surviving one per-style scale ('all' | 'termini' | 'none'), applied to
  // the FULL mark set so the marker and label rules stay independent. Returns the
  // SAME Map when no line is restricted, so the untouched path stays
  // byte-identical and callers can test identity to detect a filter.
  // Nodes whose station is served by more than one line. Measured on the FULL
  // membership, so two simplified routes still count as meeting each other, and
  // unioned across the platform-split units of one station (which sit on separate
  // nodes and would each look single-line). Built at most once per paint.
  let interchangeAt: Set<string> | undefined;
  const interchangeNodes = (): Set<string> => {
    if (interchangeAt) return interchangeAt;
    const baseOf = new Map<string, string>();
    for (const [base, units] of splitGroups) for (const u of units) baseOf.set(u, base);
    const linesAt = new Map<string, Set<string>>();
    for (const [nodeId, marks] of geom.stopsByNode) {
      const key = baseOf.get(nodeId) ?? nodeId;
      let s = linesAt.get(key);
      if (!s) { s = new Set<string>(); linesAt.set(key, s); }
      for (const m of marks) s.add(m.lineId);
    }
    interchangeAt = new Set<string>();
    for (const nodeId of geom.stopsByNode.keys()) {
      if ((linesAt.get(baseOf.get(nodeId) ?? nodeId)?.size ?? 0) > 1) interchangeAt.add(nodeId);
    }
    return interchangeAt;
  };
  const marksUnder = (ruleOf: (s: SimplifiedStyle) => SimplifiedScope): Map<string, StopMark[]> => {
    const rule = new Map<string, SimplifiedScope>();
    for (const [id, res] of simplified) {
      const r = ruleOf(res.style);
      if (r !== 'all') rule.set(id, r);
    }
    if (rule.size === 0 && recolored.size === 0) return geom.stopsByNode;
    // Wider scopes CONTAIN the narrower ones, so the ends survive either way.
    const isect = [...rule.values()].some((r) => r === 'intersection') ? interchangeNodes() : undefined;
    const out = new Map<string, StopMark[]>();
    for (const [nodeId, marks] of geom.stopsByNode) {
      const kept = marks.filter((m) => {
        const r = rule.get(m.lineId);
        if (r === undefined) return true;
        if (r === 'none') return false;
        if (m.terminus === true) return true;
        return r === 'intersection' && isect!.has(nodeId);
      });
      // Copy rather than mutate: these marks belong to the cached geometry.
      const painted = recolored.size === 0
        ? kept
        : kept.map((m) => (recolored.has(m.lineId) ? { ...m, color: recolored.get(m.lineId)! } : m));
      if (painted.length > 0) out.set(nodeId, painted);
    }
    return out;
  };
  // Dropping a mark BEFORE any station geometry is built removes its dot and its
  // interchange capsule membership in one step; a KEPT one (a terminus under the
  // 'termini' rule) seats in its capsule normally.
  const stopsByNode = marksUnder((s) => s.stationMarks);
  const marksFiltered = stopsByNode !== geom.stopsByNode;


  // A design that paints an opaque interchange footprint draws its lanes cropped
  // to it: consult the cached cropped lanes for the active design's capsule
  // regime, falling back to dByLine per line (and when absent). A design whose
  // regime has no cropped lanes reads dByLine only, so its output is identical.
  //
  // For the rectangle design, the cropped lanes and the seated-box geometry
  // (rescued single positions, capsules) are ONE atomic group. They were added
  // to the serialized geometry in separate steps, so a pre serialized in between
  // can carry the capsules WITHOUT the cropped lanes. Gate the box-anchored
  // connector geometry on the SAME predicate (the rect cropped lanes being
  // present) so a partial geometry degrades to the plain fallback, never a mixed
  // state.
  const activeCapsule = getStationDesign(args.stationDesign)?.capsule;
  // Capsule geometry was solved at compute time over the FULL membership. When a
  // simplified route has left a station, that geometry would paint a bead or a
  // seat with no dot behind it, so re-derive the ACTIVE regime from the filtered
  // marks. Untouched membership keeps the precomputed maps, so the normal path is
  // byte-identical and pays nothing. The pill/ring regimes need no entry here:
  // buildScene already derives them live from the marks it is handed.
  const derived = marksFiltered ? deriveCapsules(stopsByNode, activeCapsule, geom, simpSig) : undefined;
  const cachedCropped = activeCapsule ? geom.croppedLaneByLine?.get(activeCapsule) : undefined;
  // A re-derived capsule no longer sits where the cached lanes were cut to, so the
  // two stop being one atomic group. Honour the fallback rather than the mixed
  // state: drop the stale crop and let the lanes run their full length under the
  // (opaque) capsule, instead of cutting them to a footprint that has moved.
  // Re-cutting them here is not possible from the cached geometry alone, which
  // holds the assembled paths but not the per-edge lanes the crop consumes.
  const activeCropped = derived ? undefined : cachedCropped;
  const isRect = activeCapsule === 'rectRows' && (derived ? !!derived.rectByNode : !!cachedCropped);
  const rectByNode = isRect ? (derived?.rectByNode ?? geom.rectByNode) : undefined;
  const rectStopPos = isRect ? (derived?.tokyuStopPos ?? geom.tokyuStopPos) : undefined;
  const bubbleByNode = activeCapsule === 'londonBubbles' ? (derived?.bubbleByNode ?? geom.bubbleByNode) : undefined;
  const torontoByNode = activeCapsule === 'toronto' ? (derived?.torontoByNode ?? geom.torontoByNode) : undefined;
  // Bundle-coherent layers (I8): each paint group draws its casings then its
  // strokes, so a later group's casing separates it cleanly from everything
  // it crosses below. Geometry without the field (older caches) falls back
  // to one flat group, which reproduces the classic all-casings,
  // all-strokes order exactly. Lines missing from the groups (defensive)
  // paint last.
  const grouped = new Set<string>();
  const paintGroups: string[][] = [];
  for (const g of geom.paintGroups ?? [[...lineById.keys()]]) {
    paintGroups.push(g);
    for (const id of g) grouped.add(id);
  }
  const tail = [...lineById.keys()].filter((id) => !grouped.has(id));
  if (tail.length > 0) paintGroups.push(tail);
  const edgeParts: string[] = [];
  for (const group of paintGroups) {
    const gCasings: string[] = [];
    const gStrokes: string[] = [];
    for (const lineId of group) {
      const line = lineById.get(lineId);
      const d = dByLine.get(lineId);
      if (!line || !d || d.length < 2) continue;
      const dStr = activeCropped?.get(lineId) ?? d.join(' ');
      const sw = strokeFor(lineId);
      if (sw.casing !== null) {
        gCasings.push(
          '<path d="' + dStr + '" fill="none" stroke="' + bg + '" stroke-width="' + sw.casing +
            '" stroke-linecap="round" stroke-linejoin="round"/>',
        );
      }
      // A dashed stroke uses butt caps: round caps bleed half a stroke width past
      // each dash end, which closes a short gap back up.
      const dashAttr = sw.dash ? ' stroke-dasharray="' + sw.dash[0] + ' ' + sw.dash[1] + '"' : '';
      gStrokes.push(
        '<path d="' + dStr + '" fill="none" stroke="' + escapeXml(sw.color ?? line.color) + '" stroke-width="' +
          sw.width + '" stroke-linecap="' + (sw.dash ? 'butt' : 'round') + '" stroke-linejoin="round"' + dashAttr +
          ' data-line-id="' + escapeXml(line.id) + '"/>',
      );
    }
    edgeParts.push(...gCasings, ...gStrokes);
  }

  const stopsPrims: Prim[] = [];

  // ---- taxicab connectors between split platform units -------------------
  // Computed from FINAL mark positions (all slide/de-overlap passes done, per
  // splitGroups' doc comment). Drawn under the capsules in the capsule border
  // color: thin transfer bars that reunite a platform-split station group
  // visually.
  const connectorParts: string[] = [];
  if (args.showStations !== false) {
    const connStroke = dark ? '#e4e4e7' : '#111111'; // capsule border colors (stops.ts)
    const connW = +(LINE_WIDTH * 0.45).toFixed(1); // hairline bar
    const f = (n: number) => n.toFixed(1);
    // The rect design re-seats marks into capsules whose boxes can sit away
    // from the classic mark positions; anchor the bars (and the elbow
    // avoidance set) on the SEATED box centers so no bar dangles beside a
    // moved capsule. Every other design keeps the classic mark anchors.
    const rectDots = (nid: string): Pixel[] | undefined => {
      if (!isRect) return undefined;
      const cap = rectByNode?.get(nid);
      if (cap && cap.centers.length > 0) return cap.centers.map((c): Pixel => [c.x, c.y]);
      const sp = rectStopPos?.get(nid);
      return sp ? [[sp[0], sp[1]]] : undefined;
    };
    for (const [base, unitIds] of splitGroups) {
      const memberSet = new Set(unitIds);
      const foreign: Pixel[] = [];
      for (const [nid, marks] of stopsByNode) {
        if (memberSet.has(nid)) continue;
        const seated = rectDots(nid);
        if (seated) { for (const p of seated) foreign.push(p); continue; }
        for (const m of marks) foreign.push(m.pos);
      }
      // Anchor connector endpoints on the units' drawn dots; drop the group if
      // fewer than 2 attachable units remain.
      const units = unitIds
        .map((id) => ({
          id,
          dots: rectDots(id) ?? (stopsByNode.get(id) ?? []).map((m) => m.pos),
        }))
        .filter((u) => u.dots.length > 0);
      if (units.length < 2) continue;
      const conns = planSplitConnectors(units, foreign);
      for (const c of conns) {
        const d = c.corner
          ? 'M ' + f(c.a[0]) + ' ' + f(c.a[1]) + ' L ' + f(c.corner[0]) + ' ' + f(c.corner[1]) + ' L ' + f(c.b[0]) + ' ' + f(c.b[1])
          : 'M ' + f(c.a[0]) + ' ' + f(c.a[1]) + ' L ' + f(c.b[0]) + ' ' + f(c.b[1]);
        connectorParts.push(
          '<path d="' + d + '" fill="none" stroke="' + connStroke + '" stroke-width="' + connW +
          '" stroke-linecap="round" stroke-linejoin="round" data-split-connector="' + escapeXml(base) + '"/>',
        );
        if (sceneOut) {
          stopsPrims.push({
            kind: 'path', d, fill: 'none', stroke: connStroke, strokeWidth: connW,
            lineCap: 'round', lineJoin: 'round', layer: 'stops', worldScale: true,
          });
        }
      }
    }
  }

  const stationOut = renderStations(
    stopsByNode,
    { dark, showBullets: args.showStations !== false, rectByNode, tokyuStopPos: rectStopPos, bubbleByNode, torontoByNode },
    getStationDesign(args.stationDesign),
  );
  const stopParts = stationOut.svg;
  if (sceneOut) for (const p of stationOut.prims) stopsPrims.push(p);
  // Label placement is pure in the cached geometry (marks, segments) and the
  // layout, none of which change between repaints of one precompute, so the
  // greedy collision packer runs once per geometry and every later repaint
  // reuses its placements. Keyed on the geometry object; a deserialized cache
  // has a fresh identity and refills on its first labeled paint.
  let placements: ReturnType<typeof placeLabels>;
  if (!showLabels) placements = new Map();
  else {
    // A stop a simplified route contributes no label for drops out of the packer,
    // so a station served only by such stops frees its space for a neighbour. The
    // signature is part of the memo key: placements computed for a different
    // simplification must never be reused.
    const labelStops = marksUnder((s) => s.labels);
    const hit = labelPlacementsMemo.get(geom);
    if (hit && hit.layout === layout && hit.nodePx === nodePx && hit.simpSig === simpSig) placements = hit.placements;
    else {
      placements = placeLabels(layout, nodePx, labelStops, segments);
      labelPlacementsMemo.set(geom, { layout, nodePx, simpSig, placements });
    }
  }
  const labelParts: string[] = [];
  const labelPrims: Prim[] = [];
  for (const n of layout.nodes.values()) {
    const placement = placements.get(n.id);
    const center = nodePx.get(n.id);
    if (!placement || !center) continue;
    // Anchor to the same closest-dot point placeLabels positioned around, so the
    // label hangs off a real marker (and zoom pivots there) rather than the node
    // centre the single dot's lane, or a capsule's slid dots, may sit off.
    const anchor = labelAnchor(center, stopsByNode.get(n.id));
    labelParts.push(renderLabel(n, placement, anchor, stopsByNode.has(n.id), dark, sceneOut ? labelPrims : undefined, args.labelColor));
  }

  const waterPart = args.water ? waterBackdrop(layout, nodePx, args.water, dark) : '';

  // Area labels: the pre bakes every tier's points; select the tiers visible at
  // the chosen zoom and collision-cull at the padding (bigger tiers win). Shared
  // by both the scene-IR and the SVG-string emission below.
  const shownPlaces = selectPlaces(
    args.placesPx,
    args.placesZoom ?? DEFAULT_LABEL_ZOOM,
    args.placesPad ?? DEFAULT_LABEL_PAD,
    args.placesFontPx ?? PLACE_FONT_SIZE,
  );

  // Geographic-topo/smoothed pass an explicit geography frame; when absent (e.g.
  // no geography, or pure-octi schematic) fall back to the rendered network extent.
  const fr = args.frame ?? geom.contentFrame ?? contentFrame(nodePx, layout.edges, edgePolyline, width, height);
  const frameAttr =
    ' data-frame="' + fr.x.toFixed(1) + ' ' + fr.y.toFixed(1) + ' ' + fr.w.toFixed(1) + ' ' + fr.h.toFixed(1) + '"';

  // --- Scene IR emission (Phase 3) -------------------------------------------
  // Build the canvas display list from the SAME geometry the string above uses,
  // so the panel can paint a canvas without re-parsing the SVG. ADDITIVE: emit
  // nothing unless a sink is passed, and never touch the string-building above.
  // Layers are emitted in the same source order as the markup. The big DYNAMIC
  // layers (edges here; stops/labels below) are emitted directly; the
  // tiny STATIC backdrop/grid fragment reuses the proven parser.
  if (sceneOut) {
    const prims: Prim[] = [];
    // base canvas (void when a data hull bounds the land) + land
    prims.push({ kind: 'rect', x: 0, y: 0, w: width, h: height, rx: 0, fill: bg, stroke: 'none', strokeWidth: 0, layer: 'background', worldScale: false });
    // static water/green backdrop + optional grid overlay (small + static)
    const staticFrag = (waterPart || '') + (args.backdrop || '') + (args.gridOverlay || '');
    if (staticFrag) for (const p of sceneFromSvg(staticFrag).prims) prims.push(p);
    // neighborhood-name area labels: under the network, over the backdrop
    for (const p of placesPrims(shownPlaces, dark, args.placesFontPx, args.placeColor)) prims.push(p);
    // edges: the markup emits per paint GROUP, casings then strokes (I8);
    // match that order exactly.
    for (const group of paintGroups) {
      const casingPrims: Prim[] = [];
      const strokePrims: Prim[] = [];
      for (const lineId of group) {
        const line = lineById.get(lineId);
        const d = dByLine.get(lineId);
        if (!line || !d || d.length < 2) continue;
        // Same cropped-lane source as the SVG markup above; a design with no
        // cropped lanes reads dByLine only, so the scene IR stays identical.
        const dStr = activeCropped?.get(lineId) ?? d.join(' ');
        const sw = strokeFor(lineId);
        if (sw.casing !== null) {
          casingPrims.push({ kind: 'path', d: dStr, fill: 'none', stroke: bg, strokeWidth: sw.casing, lineCap: 'round', lineJoin: 'round', layer: 'edges', worldScale: true });
        }
        strokePrims.push({ kind: 'path', d: dStr, fill: 'none', stroke: sw.color ?? line.color, strokeWidth: sw.width, lineCap: sw.dash ? 'butt' : 'round', lineJoin: 'round', layer: 'edges', worldScale: true, ...(sw.dash ? { dash: [sw.dash[0], sw.dash[1]] } : {}) });
      }
      for (const p of casingPrims) prims.push(p);
      for (const p of strokePrims) prims.push(p);
    }
    // stops: station markers (dots/capsules/rings + bullet text),
    // built alongside the markup by renderStops in source/concatenation order.
    for (const p of stopsPrims) prims.push(p);
    // labels (.stations layer): one TextPrim per label, world-anchored to the dot
    // (ax,ay) with a screen-space offset (x,y); worldScale FALSE, mirroring the
    // <text> renderLabel emits, in the same node-iteration order.
    for (const p of labelPrims) prims.push(p);
    sceneOut.scene = { width, height, frame: { x: fr.x, y: fr.y, w: fr.w, h: fr.h }, background: bg, prims };
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '"' + frameAttr + '>\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
    (waterPart ? waterPart + '\n' : '') +
    (args.backdrop ? args.backdrop + '\n' : '') +
    (args.gridOverlay ? args.gridOverlay + '\n' : '') +
    (shownPlaces.length > 0 ? placesSvg(shownPlaces, dark, args.placesFontPx, args.placeColor) + '\n' : '') +
    '<g class="edges">\n' + edgeParts.join('\n') + '\n</g>\n' +
    '<g class="stops">\n' + [...connectorParts, ...stopParts].join('\n') +
    '\n</g>\n<g class="stations">\n' + labelParts.join('\n') + '\n</g>\n</svg>'
  );
}
