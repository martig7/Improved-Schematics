// Octilinear renderer + reusable ribbon renderer. The ribbon core
// (renderRibbons) takes pre-projected node pixels and is also used by the
// smoothed renderer; renderOctilinear is the grid-cell variant the schematic
// mode uses (ported from dev/reference/renderSvg.js + gridToPx.js).

import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import type { WaterCollection } from './types';
import { CELL_PX, PAD, LINE_WIDTH, LINE_GAP, MEGA_BOXES } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { offsetPolyline, curveLaneJoin, taperLaneEnd } from './layout/offsets';
import { buildLaneCurve, curveTangent } from './layout/chainPlace';
import { solveRows, lineCrossNearest } from './layout/rowPlace';
import { chooseMutualSlide, penBetween, type Hull } from './layout/capsuleSlide';
import { renderStops } from './stops';
import { placeLabels, renderLabel, type Segment } from './labels';
import { escapeXml } from './escape';
import type { TransferPair } from './transfers';
import { renderTransferConnectors, edgeKeysFromGraph } from './transfers';
import { detectPaintedLoops } from './layout/loopMetrics';
import type { FrameRect } from './projection';

// sqrt(a²+b²) — correctly-rounded cross-V8 (Math.hypot is not), so the rendered
// marker/ribbon geometry is bit-identical on any engine. SIN1DEG = sin(1°).
const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const SIN1DEG = 0.017452406437283513;
// nearest octilinear axis (mod 180°) to a direction — trig-free argmax of
// |dir·axis| over the 4 axes (deterministic tie → lowest index), so the axis
// snap is bit-identical cross-V8 (no atan2). Module scope: used by both the
// spineOctilinear gate and the rigid-row collision slide.
const AXES4: Pixel[] = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2]];
const snapAxis = (dx: number, dy: number): Pixel => {
  let best = 0, bv = -1;
  for (let k = 0; k < 4; k++) {
    const v = Math.abs(dx * AXES4[k][0] + dy * AXES4[k][1]);
    if (v > bv) { bv = v; best = k; }
  }
  return AXES4[best];
};

export interface OctiOptions {
  dark?: boolean;
  showLabels?: boolean;
  showStations?: boolean;
  water?: WaterCollection;
  transfers?: TransferPair[];
}

function gridToPx(cell: Cell, maxRow: number): Pixel {
  return [cell[0] * CELL_PX + PAD, (maxRow - cell[1]) * CELL_PX + PAD];
}

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
  water?: WaterCollection;
  transfers?: TransferPair[];
  /** Ids of routing-only ghost nodes. Renderer MUST NOT draw markers or
   *  labels for these — the ghost is invisible by design (lines pass through
   *  it but no circle is drawn). */
  ghostNodeIds?: Set<string>;
  /** Optional pre-rendered SVG snippet (a single `<g>...</g>`) drawn between
   *  the water layer and the route ribbons. Used to overlay the Hanan grid
   *  for diagnostic purposes (showGrid option). */
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

export function renderRibbons(args: RenderRibbonsArgs): string {
  const { layout, nodePx, edgePolyline, width, height, dark, showLabels } = args;
  const bg = dark ? DARK_THEME.land : '#ffffff';
  const casingWidth = LINE_WIDTH + 3;

  const stopsByNode = new Map<string, StopMark[]>();
  const stopSeen = new Set<string>();
  const segments: Segment[] = [];
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const lineById = new Map<string, { id: string; label?: string; color: string }>();
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
  const segPath = new Map<string, Pixel[]>(); // edge.id|lineId -> offset polyline
  const dByLine = new Map<string, string[]>();
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
  const fmt = (p: Pixel) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  const pushSeg = (lineId: string, poly: Pixel[]) => {
    let d = dByLine.get(lineId);
    if (!d) dByLine.set(lineId, (d = []));
    for (let k = 1; k < poly.length; k++) segments.push({ p1: poly[k - 1], p2: poly[k] });
    d.push('M' + fmt(poly[0]));
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
        d.push('L' + fmt(v)); // effectively straight
        continue;
      }
      const f = Math.min(FILLET_R, l1 / 2, l2 / 2);
      d.push(
        'L' + fmt([v[0] - u1[0] * f, v[1] - u1[1] * f]),
        'Q' + fmt(v) + ' ' + fmt([v[0] + u2[0] * f, v[1] + u2[1] * f]),
      );
    }
    d.push('L' + fmt(poly[poly.length - 1]));
  };

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
  // rides slightly off the corridor centerline (clamped to ~one slot), which
  // is invisible, instead of recentering at every composition change.
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
    const edgeIds = [...byEdge.keys()].sort();
    for (let pass = 0; pass < 12; pass++) {
      let moved = 0;
      for (const eid of edgeIds) {
        let sum = 0;
        let n = 0;
        for (const c of byEdge.get(eid)!) {
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
        const target = Math.max(-maxBias, Math.min(maxBias, sum / n));
        const cur = biasOf.get(eid) ?? 0;
        if (Math.abs(target - cur) > 0.05) moved++;
        biasOf.set(eid, target);
      }
      if (moved === 0) break;
    }
  }

  for (const edge of layout.edges) {
    const base = edgePolyline(edge);
    if (base.length < 2) continue;
    const order = orderOf.get(edge.id) ?? [];
    const bias = biasOf.get(edge.id) ?? 0;
    for (let i = 0; i < order.length; i++) {
      const lineId = order[i];
      const o = (slotOf.get(edge.id + '|' + lineId) ?? 0) + bias;
      const poly =
        Math.abs(o) < 1e-9
          ? base.map((p) => p.slice() as Pixel)
          : offsetPolyline(base, o, /*simplify*/ false);
      segPath.set(edge.id + '|' + lineId, poly);
    }
  }

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
        if (suppressed.has(key)) continue;
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
        suppressed.add(key);
        segPath.delete(key);
      }
    }
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
  const joinCurves: Array<{ lineId: string; node: string; a: Pixel; apex: Pixel; b: Pixel }> = [];
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
      const pA = segPath.get(a.edgeId + '|' + lineId);
      const pB = segPath.get(b.edgeId + '|' + lineId);
      if (!pA || !pB) continue;
      const aAtStart = ea.from === endA;
      const bAtStart = eb.from === endA;
      const keyA = a.edgeId + '|' + lineId + '|' + (aAtStart ? 's' : 'e');
      const keyB = b.edgeId + '|' + lineId + '|' + (bAtStart ? 's' : 'e');
      if (endMoved.has(keyA) || endMoved.has(keyB)) continue;
      const join = curveLaneJoin(pA, aAtStart, pB, bAtStart, SMOOTH_R, spacing * 4);
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
      if (gap < 0.5 || gap > spacing * 8) continue;
      const lenA = hyp(qa[0] - qa1[0], qa[1] - qa1[1]);
      const lenB = hyp(qb[0] - qb1[0], qb[1] - qb1[1]);
      if (lenA < 1e-6 || lenB < 1e-6) continue;
      // directions: A pointing INTO the node, B pointing OUT
      const dirA: Pixel = [(qa[0] - qa1[0]) / lenA, (qa[1] - qa1[1]) / lenA];
      const dirB: Pixel = [(qb1[0] - qb[0]) / lenB, (qb1[1] - qb[1]) / lenB];
      const dot = dirA[0] * dirB[0] + dirA[1] * dirB[1];
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
        // mega-box the rigid-row marker. Only this minimal end-move is safe.)
        // Browser-safe env guard: `process` is undefined in the game renderer.
        const noUncross =
          typeof process !== 'undefined' &&
          (process as { env?: Record<string, string> }).env?.OCTI_NO_UNCROSS === '1';
        const X = noUncross ? null : segCross(qa1, qa, qb1, qb);
        if (X && !endMoved.has(keyA) && !endMoved.has(keyB)) {
          if (aAtStart) pA[0] = X; else pA[pA.length - 1] = X;
          if (bAtStart) pB[0] = X; else pB[pB.length - 1] = X;
          endMoved.add(keyA);
          endMoved.add(keyB);
          const pk = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
          mitered.add(lineId + '|' + endA + '|' + pk);
        }
        continue; // S connector for non-crossing sharp corners
      }
      const polyLenOf = (poly: Pixel[]): number => {
        let L = 0;
        for (let i = 1; i < poly.length; i++) L += hyp(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        return L;
      };
      const taperA = Math.min(spacing * 8, polyLenOf(pA) * 0.45);
      const taperB = Math.min(spacing * 8, polyLenOf(pB) * 0.45);
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

  // --- loop diagnostic (OCTI_LOOPS) ------------------------------------------
  // Measure loops in the PAINTED track — where a route's drawn track crosses
  // itself (a fused-station hook, balloon loop, terminal ring). Built on the
  // offset LANES (segPath, now final), not the edge skeleton: an out-and-back
  // route's skeleton is a perfect overlap, so a self-crossing loop at a station
  // group (Chicago Blue A at Chestnut St) is invisible there but plain in the
  // painted lanes. Each loop is anchored to its nearest station group.
  if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_LOOPS) {
    const routesPainted: Array<{ lineId: string; pts: Pixel[] }> = [];
    for (const [lineId, traversal] of layout.lineTraversals) {
      if (!lineById.has(lineId)) continue;
      const pts: Pixel[] = [];
      for (const step of traversal) {
        const lane = segPath.get(step.edgeId + '|' + lineId);
        if (!lane || lane.length < 2) continue;
        const seq = step.reversed ? [...lane].reverse() : lane; // lanes run from→to
        for (const p of seq) {
          const last = pts[pts.length - 1];
          if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) pts.push(p);
        }
      }
      if (pts.length >= 4) routesPainted.push({ lineId, pts });
    }
    // station groups (nodes carrying ≥1 stop) with pixel positions + labels,
    // for anchoring each loop to the place a reader would name it.
    const groups: Array<{ pos: Pixel; label: string }> = [];
    for (const st of args.stations ?? []) {
      const pos = nodePx.get(st.nodeId);
      if (pos) groups.push({ pos, label: layout.nodes.get(st.nodeId)?.label ?? st.nodeId });
    }
    const nearestGroup = (p: Pixel): string => {
      let best = '?';
      let bd = Infinity;
      for (const g of groups) {
        const d = (g.pos[0] - p[0]) ** 2 + (g.pos[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = g.label; }
      }
      return `${best} (${Math.sqrt(bd).toFixed(0)}px)`;
    };
    const loops = detectPaintedLoops(routesPainted);
    for (const l of loops.slice(0, 40)) {
      const ln = lineById.get(l.lineId);
      console.error(
        `[loops] ${l.kind.toUpperCase()} route ${ln?.label ?? l.lineId} (${ln?.color ?? '?'}) ` +
        `at=(${l.at[0].toFixed(0)},${l.at[1].toFixed(0)}) group=${nearestGroup(l.at)} ` +
        `loopArc=${l.loopArc.toFixed(0)} diam=${l.diameter.toFixed(0)}`,
      );
    }
    const arts = loops.filter((l) => l.kind === 'artifact').length;
    console.error(`[loops] ${arts} artifact loops, ${loops.length - arts} bigloops (likely genuine routes)`);
  }

  // NOTE: path emission (pushSeg + join curves) happens AFTER the station
  // marker pass below — sliding a terminus marker clear of a mega box must
  // also trim the terminating lanes back to the slid marker.
  const emitLanes = () => {
    for (const [key, poly] of segPath) {
      pushSeg(key.slice(key.indexOf('|') + 1), poly);
    }
    for (const jc of joinCurves) {
      let d = dByLine.get(jc.lineId);
      if (!d) dByLine.set(jc.lineId, (d = []));
      d.push('M' + fmt(jc.a), 'Q' + fmt(jc.apex) + ' ' + fmt(jc.b));
      segments.push({ p1: jc.a, p2: jc.b });
    }
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
    mega?: boolean,
  ) => {
    const key = nodeId + '|' + lineId;
    if (stopSeen.has(key)) return;
    stopSeen.add(key);
    if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
    stopsByNode.get(nodeId)!.push({
      lineId, color, pos, name: lineById.get(lineId)?.label, chain, cornerAfter, mega,
    });
  };
  const membersByNode = args.stations ? new Map<string, number>() : undefined;
  if (args.stations) {
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
      marks: Array<{
        lineId: string;
        color: string;
        flagNode: string;
        pos: Pixel;
        chain?: number;
        cornerAfter?: Pixel;
        mega?: boolean;
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
    if (
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
    ) {
      let vanished = 0;
      for (let i = 0; i < args.stations.length; i++) {
        if (gathered[i].marks.length > 0) continue;
        const st = args.stations[i];
        const label = layout.nodes.get(st.nodeId)?.label ?? st.nodeId;
        const trace: string[] = [];
        for (const [lineId, flagNode] of st.stopNodes) {
          const why = !lineById.get(lineId)
            ? '!line'
            : drawnEndAt.has(flagNode + '|' + lineId) ? 'ok' : '!pos';
          trace.push(`${lineById.get(lineId)?.label ?? lineId}@${flagNode}=${why}`);
        }
        console.error(
          `[stops] VANISHED "${label}" node=${st.nodeId} members=${st.members} ` +
          `stops=${st.stopNodes.size}: ${trace.join(' ') || '(no stopNodes)'}`,
        );
        vanished++;
      }
      if (vanished > 0) {
        console.error(`[stops] vanished stations (edge drawn, no marker): ${vanished}`);
      }
    }

    // ---- marker collision backup ------------------------------------------
    // A mega box swallows nearby small markers (Court's pill under the
    // Tacoma Av box). Detect overlaps and SLIDE the smaller station's marks
    // along their own lanes, away from the box, until its marker sits clear.
    const ldegOf = (nid: string): number => {
      let n = 0;
      for (const e of layout.edges) {
        if (e.from !== nid && e.to !== nid) continue;
        n += (orderOf.get(e.id) ?? e.lines.map((l) => l.id)).length;
      }
      return n;
    };
    const r = LINE_WIDTH * 0.7;
    // Near-miss tolerance for the rigid-row dot floor. octi's grid placement can
    // seat an interchange bundle a sub-pixel below minGap, boxing the whole
    // station; and because the chaotic greedy local search reaches slightly
    // different optima across runtimes (offline Node vs the game's V8), that
    // sub-pixel margin flips boxes on/off between environments. Slackening the
    // INTRA-station floor by a fraction of a pixel (imperceptible ring overlap
    // inside the capsule) makes box-vs-row robust to that jitter. Cross-station
    // separation (the §6 mask below) stays strict. OCTI_MINGAP_SLACK overrides
    // (0 = strict, the pre-fix behavior).
    const minGapSlack = (() => {
      const env =
        typeof process !== 'undefined'
          ? Number((process as { env?: Record<string, string> }).env?.OCTI_MINGAP_SLACK)
          : NaN;
      return Number.isFinite(env) && env >= 0 ? env : 0.5;
    })();
    const boxOf = (s: StMarks): { x0: number; y0: number; x1: number; y1: number; mega: boolean } => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of s.marks) {
        x0 = Math.min(x0, m.pos[0]); y0 = Math.min(y0, m.pos[1]);
        x1 = Math.max(x1, m.pos[0]); y1 = Math.max(y1, m.pos[1]);
      }
      const mega = MEGA_BOXES && s.members > 1 && s.marks.length > 0 && ldegOf(s.nodeId) >= 12;
      const pad = mega ? r + 7 : r + 3;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      if (mega) {
        const minSide = 2 * r + 3;
        if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
        if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
      }
      return { x0, y0, x1, y1, mega };
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
     *  their slid marker instead of poking into the mega box). */
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
    // by construction (R1/R2) — the only fallback is the per-station mega
    // box (R4), never a partially-degraded chain.
    const placedDots: Pixel[] = []; // spec §6: earlier stations mask later DPs
    let megaFallbacks = 0; // spec v2 §3: stations boxed for infeasibility
    for (const s of gathered) {
      if (s.marks.length === 1) {
        s.marks[0].chain = 0;
      } else if (s.marks.length > 1) {
        const curves = s.marks.map((mk) =>
          buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT),
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
        const markAxis = s.marks.map((_, i) => {
          const tg = curveTangent(curves[i], curves[i].anchorT);
          // quantize atan2 (cross-V8) before the axis-index round so a 1-ULP
          // diff can't flip the grouping axis at a 22.5° boundary.
          return (((Math.round((Math.round(Math.atan2(tg[1], tg[0]) * 1e6) / 1e6) / (Math.PI / 4)) % 4) + 4) % 4);
        });
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
          return [...idx].sort((a, b) =>
            (s.marks[a].pos[0] * nx + s.marks[a].pos[1] * ny) -
            (s.marks[b].pos[0] * nx + s.marks[b].pos[1] * ny));
        });
        const ropts = {
          minGap: Math.max(2, 2 * r - 0.05 - minGapSlack),
          arcLimit: CHAIN_ARC_LIMIT,
          extCap: 6 * spacing,
          dbgLabel: s.nodeId, // OCTI_PLACE_DEBUG: per-box root-cause classifier
          // spec §6 mask: dots of already-placed stations veto row states —
          // never dropped in this model (a masked station boxes instead)
          blocked: (p: Pixel) => {
            for (const q of placedDots) {
              if (hyp(p[0] - q[0], p[1] - q[1]) < 2 * r - 0.05) return true;
            }
            return false;
          },
        };
        let sol = solveRows(curves, groups, ropts);
        if (!sol) {
          // window escalation: rebuild curves at twice the arc window
          const wide = s.marks.map((mk) =>
            buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT * 2),
          );
          sol = solveRows(wide, groups, { ...ropts, arcLimit: CHAIN_ARC_LIMIT * 2 });
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
          // spec v2 §3: total fallback — the mega box covers all bundles.
          // Structural residual: a bundle whose member lanes are coincident
          // (interlined on one drawn line) or pinch below minGap inside the
          // slide window admits zero feasible row states — the row-line ×
          // lane-curve intersection degenerates there — so the station boxes
          // (the mega branch in stops.ts renders it).
          megaFallbacks++;
          for (const mk of s.marks) mk.mega = true;
        }
      }
      for (const mk of s.marks) placedDots.push(mk.pos);
    }
    if (megaFallbacks > 0) console.error('[stops] mega-box fallbacks: ' + megaFallbacks);
    const megas = gathered.filter((s) => boxOf(s).mega);
    const slid: Array<{ nodeId: string; at: Pixel }> = [];
    let slideBoxed = 0; // stations a collision-slide bent past octilinearity
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
    // its OWN lane, so a straight row whose dots ride non-parallel lanes bends
    // (SEA mn177: a horizontal pair slid into a 62° chord). Corner recompute
    // only salvages markers that already had a real bend; a broken straight
    // row has no corner to recover. Such stations fall back to the mega box
    // (spec v2 §3 — the honest fallback for anything that can't read as a
    // clean octilinear marker). Matches the octi gate's length-aware bar.
    const QPI = Math.PI / 4;
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
    for (const s of gathered) {
      const sb = boxOf(s);
      if (sb.mega || s.marks.length === 0) continue;
      for (const m of megas) {
        const mb = boxOf(m);
        const overlaps = sb.x0 < mb.x1 + 2 && sb.x1 > mb.x0 - 2 && sb.y0 < mb.y1 + 2 && sb.y1 > mb.y0 - 2;
        if (!overlaps) continue;
        const center: Pixel = [(mb.x0 + mb.x1) / 2, (mb.y0 + mb.y1) / 2];
        for (let d = 4; d <= 48; d += 4) {
          const moved = s.marks.map((mk) => lanePointAt(mk.lineId, mk.flagNode, center, d));
          if (moved.some((p) => !p)) break;
          const trial = s.marks.map((mk, i) => ({ ...mk, pos: moved[i]!.p }));
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const t of trial) {
            x0 = Math.min(x0, t.pos[0]); y0 = Math.min(y0, t.pos[1]);
            x1 = Math.max(x1, t.pos[0]); y1 = Math.max(y1, t.pos[1]);
          }
          const pad = r + 3;
          if (x0 - pad >= mb.x1 + 2 || x1 + pad <= mb.x0 - 2 || y0 - pad >= mb.y1 + 2 || y1 + pad <= mb.y0 - 2) {
            const cap = captureCorners(s.marks); // old leg dirs before the slide
            for (let i = 0; i < s.marks.length; i++) {
              const mk = s.marks[i];
              mk.pos = moved[i]!.p;
              // Lines TERMINATING at the slid station (one drawn incident
              // lane) must have their ink end at the slid marker, not poke
              // on into the mega box (Court's grays under the Tacoma box).
              let incident = 0;
              for (const e of layout.edges) {
                if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
                if (!segPath.has(e.id + '|' + mk.lineId)) continue;
                if (!drawsOn(mk.lineId, e.id)) continue;
                incident++;
              }
              if (incident <= 1) trimLaneAt(moved[i]!.edgeId, mk.lineId, mk.flagNode, d);
            }
            applyCorners(cap); // recompute corners on the slid dots (spec R1)
            if (!spineOctilinear(s.marks)) { for (const mk of s.marks) mk.mega = true; slideBoxed++; console.error(`[stops TEMP] SLIDE-BOXED ${s.nodeId}: mega-escape slide bent the spine off-octilinear -> boxed`); }
            slid.push({ nodeId: s.nodeId, at: [(x0 + x1) / 2, (y0 + y1) / 2] });
            break;
          }
        }
        break; // resolved (or gave up) against the first overlapping mega
      }
    }

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
                p = lineCrossNearest(buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT * 2), A, u, mk.pos);
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
          // TEMP diag: dump leg structure + the worst off-axis segment so we can
          // see WHY the candidate bent in-engine (rigid vs fallback path).
          const lg = rowsOf(st.marks).map((l) => l.idx.length).join('+');
          const ord = [...clone].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
          const vs: Pixel[] = [];
          for (const mk of ord) { vs.push(mk.pos); if (mk.cornerAfter) vs.push(mk.cornerAfter); }
          let worst = '(none)';
          let worstGap = -Infinity;
          for (let i = 1; i < vs.length; i++) {
            const dx = vs[i][0] - vs[i - 1][0], dy = vs[i][1] - vs[i - 1][1];
            const len = hyp(dx, dy);
            if (len < 1) continue;
            const m = ((Math.atan2(dy, dx) % QPI) + QPI) % QPI;
            const off = Math.min(m, QPI - m);
            const bar = Math.max(Math.PI / 180, Math.asin(Math.min(1, 0.85 / len)));
            if (off - bar > worstGap) {
              worstGap = off - bar;
              worst = `seg${i} len=${len.toFixed(1)} off=${(off * 180 / Math.PI).toFixed(1)}deg bar=${(bar * 180 / Math.PI).toFixed(1)}deg`;
            }
          }
          const corners = st.marks.filter((m) => m.cornerAfter).length;
          console.error(`[stops] rigid slide declined (non-octilinear) ${st.nodeId}: legs=${lg} marks=${st.marks.length} corners=${corners} worst[${worst}]`);
          return false;
        }
        // Intra-station dot floor: re-seating dots on the translated line can
        // bring two dots below minGap (stacked bullets) — invisible while the
        // station boxed (the box hid them), visible now. Enforce the SAME floor
        // rowPlace uses at placement; decline a stacking candidate so the sweep
        // picks a non-stacking d (or the station stays at its spaced rest pose).
        const dotFloor = Math.max(2, 2 * r - 0.05 - minGapSlack);
        for (let i = 0; i < clone.length; i++) {
          for (let j = i + 1; j < clone.length; j++) {
            const dx = clone[i].pos[0] - clone[j].pos[0];
            const dy = clone[i].pos[1] - clone[j].pos[1];
            if (dx * dx + dy * dy < dotFloor * dotFloor - 1e-6) {
              console.error(`[stops] slide declined (would stack dots) ${st.nodeId}: ${Math.sqrt(dx * dx + dy * dy).toFixed(1)}px < floor ${dotFloor.toFixed(1)}`);
              return false;
            }
          }
        }
        const cap = captureCorners(st.marks); // old leg dirs before the slide
        for (let i = 0; i < st.marks.length; i++) {
          const mk = st.marks[i];
          mk.pos = moved[i].p;
          let incident = 0;
          for (const e of layout.edges) {
            if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
            if (!segPath.has(e.id + '|' + mk.lineId)) continue;
            if (!drawsOn(mk.lineId, e.id)) continue;
            incident++;
          }
          if (incident <= 1 && moved[i].edgeId) trimLaneAt(moved[i].edgeId, mk.lineId, mk.flagNode, moved[i].arc ?? d);
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
      // first offset that runs off a lane or fails to clear a mega box. A pinned
      // capsule (already slid this resolution) contributes only its rest offset.
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
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const m of mv) {
            x0 = Math.min(x0, m.p[0]); y0 = Math.min(y0, m.p[1]);
            x1 = Math.max(x1, m.p[0]); y1 = Math.max(y1, m.p[1]);
          }
          const pad = r + 3;
          const clearOf = (box: { x0: number; y0: number; x1: number; y1: number }): boolean =>
            x0 - pad >= box.x1 + 1 || x1 + pad <= box.x0 - 1 || y0 - pad >= box.y1 + 1 || y1 + pad <= box.y0 - 1;
          if (!megas.every((m) => clearOf(boxOf(m)))) break;
          out.push({ moved: mv, d, hull: hullsOf(st.marks, (i) => mv[i].p) });
        }
        return out;
      };
      const mutualEnabled = !(
        typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.OCTI_MUTUAL_SLIDE === '0'
      );
      const smalls = gathered.filter((s) => s.marks.length > 0 && !boxOf(s).mega);
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
              let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
              for (const t of moved) {
                x0 = Math.min(x0, t.p[0]); y0 = Math.min(y0, t.p[1]);
                x1 = Math.max(x1, t.p[0]); y1 = Math.max(y1, t.p[1]);
              }
              const pad = r + 3;
              const clearOf = (box: { x0: number; y0: number; x1: number; y1: number }): boolean =>
                x0 - pad >= box.x1 + 1 || x1 + pad <= box.x0 - 1 || y0 - pad >= box.y1 + 1 || y1 + pad <= box.y0 - 1;
              const trialHull = hullsOf(S.marks, (i) => moved[i].p);
              if (penBetween(trialHull, oHull) > -1 || !megas.every((m) => clearOf(boxOf(m)))) continue;
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
      // OCTI_DEBUG overlap diagnostic: EGREGIOUS ring overlaps — bullet rings
      // (radius r+0.75, diameter 2r+1.5) crossing where they shouldn't. XSTN =
      // two DIFFERENT stations' bullets overlap; INSTN = two bullets of ONE
      // station that are NOT same-row-adjacent (a folded spine / piled junction).
      // Normal adjacent row bullets (≈minGap apart) are excluded. Reports coords
      // + node ids so the spot can be cropped (dev/_raster.ts).
      if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_DEBUG) {
      const ringDia = 2 * r + 1.5;
      const ovls: Array<{ kind: string; a: string; b: string; dist: number; x: number; y: number }> = [];
      for (let ai = 0; ai < smalls.length; ai++) {
        for (let bi = ai + 1; bi < smalls.length; bi++) {
          const A = smalls[ai], B = smalls[bi];
          let md = Infinity, mx = 0, my = 0;
          for (const p of A.marks) for (const q of B.marks) {
            const dx = p.pos[0] - q.pos[0], dy = p.pos[1] - q.pos[1];
            const dd = Math.sqrt(dx * dx + dy * dy);
            if (dd < md) { md = dd; mx = (p.pos[0] + q.pos[0]) / 2; my = (p.pos[1] + q.pos[1]) / 2; }
          }
          if (md < ringDia) ovls.push({ kind: 'XSTN', a: A.nodeId, b: B.nodeId, dist: md, x: mx, y: my });
        }
      }
      for (const s of gathered) {
        if (s.marks.length < 2 || s.marks.some((m) => m.mega)) continue;
        const ord = [...s.marks].sort((a, b) => (a.chain ?? 0) - (b.chain ?? 0));
        for (let i = 0; i < ord.length; i++) {
          for (let j = i + 1; j < ord.length; j++) {
            if (j === i + 1 && !ord[i].cornerAfter) continue; // same-row-adjacent = normal
            const dx = ord[i].pos[0] - ord[j].pos[0], dy = ord[i].pos[1] - ord[j].pos[1];
            const dd = Math.sqrt(dx * dx + dy * dy);
            if (dd < ringDia) {
              ovls.push({ kind: 'INSTN', a: s.nodeId, b: `${i}~${j}${ord[i].cornerAfter ? '/cnr' : ''}`, dist: dd, x: (ord[i].pos[0] + ord[j].pos[0]) / 2, y: (ord[i].pos[1] + ord[j].pos[1]) / 2 });
            }
          }
        }
      }
      ovls.sort((p, q) => p.dist - q.dist);
      for (const o of ovls.slice(0, 25)) {
        console.error(`[stops] ${o.kind} ${o.dist.toFixed(1)}px ${o.a} vs ${o.b} @(${o.x.toFixed(0)},${o.y.toFixed(0)})`);
      }
      console.error(`[stops] egregious overlaps: ${ovls.length} (ringDia=${ringDia.toFixed(1)})`);
      }
    }
    if (slideBoxed > 0) console.error('[stops] slide-boxed (octilinearity broken): ' + slideBoxed);
    if (
      slid.length > 0 &&
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
    ) {
      for (const s of slid) {
        const label = layout.nodes.get(s.nodeId)?.label ?? s.nodeId;
        console.error(`[stops] slid "${label}" clear of mega box at (${s.at[0].toFixed(0)},${s.at[1].toFixed(0)})`);
      }
    }

    // Terminus trim: a line that ENDS at this station has exactly one drawn
    // incident lane, and its ribbon runs all the way to the NODE — but the
    // rigid-row solve (and the collision slides) move the marker DOT off the
    // node along that lane, so the terminating ink pokes straight THROUGH the
    // capsule and out the far side (320 Pl's Y on Seattle). Trim the node-end
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
        if (mk.mega) continue; // box covers everything
        let incEdge: string | null = null;
        let nInc = 0;
        for (const e of layout.edges) {
          if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
          if (segPath.has(e.id + '|' + mk.lineId)) { nInc++; incEdge = e.id; }
        }
        if (nInc !== 1 || !incEdge) continue; // terminus = one drawn incident lane
        const poly = segPath.get(incEdge + '|' + mk.lineId);
        const edge = edgeById.get(incEdge);
        if (!poly || !edge || poly.length < 2) continue;
        const pts = edge.from === mk.flagNode ? poly : [...poly].reverse();
        const d = arcToPoint(pts, mk.pos);
        if (d > r + 2) trimLaneAt(incEdge, mk.lineId, mk.flagNode, d);
      }
    }

    // Station-vs-capsule eviction: a terminus dot can land INSIDE a
    // neighbouring station's capsule when two stops are near-coincident
    // (320 Pl's C terminus dot trapped in 307 Pl's C+Y elbow on Seattle).
    // The dot's only lane runs straight into that capsule, so it cannot
    // slide out ALONG it. Instead ROTATE the terminus stub: redraw it as a
    // single straight octilinear segment leaving the shared capsule-side
    // anchor in the octilinear direction closest to the original, far enough
    // to carry the dot clear of every foreign capsule (octilinearity holds
    // by construction — one axis-aligned leg).
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
      const capsules = gathered.filter((o) => o.marks.length >= 2 && !boxOf(o).mega);
      // candidate dot clear of every FOREIGN capsule (spine segments + member bullets)?
      const dotClear = (p: Pixel, selfNode: string): boolean => {
        for (const o of capsules) {
          if (o.nodeId === selfNode) continue;
          for (const [a, b] of spineSegsOf(o)) if (ptSegD(p[0], p[1], a, b) < need) return false;
          for (const om of o.marks) if (hyp(p[0] - om.pos[0], p[1] - om.pos[1]) < 2 * r) return false;
        }
        return true;
      };
      // the new stub may legitimately lie inside the anchor's capsule for the
      // first ~capHalf (every line leaves a capsule through its fill), but
      // BEYOND that it must run in open space — otherwise the rotated stub
      // just slices across the foreign capsule (SW diagonal across 307 Pl).
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
        if (boxOf(s).mega) continue;
        for (const mk of s.marks) {
          if (mk.mega) continue;
          if (dotClear(mk.pos, s.nodeId)) continue; // not trapped
          // terminus = exactly one drawn incident lane
          let incEdge: string | null = null;
          let nInc = 0;
          for (const e of layout.edges) {
            if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
            if (segPath.has(e.id + '|' + mk.lineId)) { nInc++; incEdge = e.id; }
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
          if (!placed) continue; // no clean octilinear escape — leave it
          mk.pos = placed;
          mk.cornerAfter = undefined;
          mk.chain = 0;
          const rebuilt: Pixel[] = [placed, anchor];
          segPath.set(incEdge + '|' + mk.lineId, edge.from === mk.flagNode ? rebuilt : [...rebuilt].reverse());
          evicted.push({ node: s.nodeId, to: placed });
        }
      }
      if (
        evicted.length > 0 &&
        typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
      ) {
        for (const e of evicted) {
          const label = layout.nodes.get(e.node)?.label ?? e.node;
          console.error(`[stops] evicted "${label}" terminus dot clear of foreign capsule -> (${e.to[0].toFixed(0)},${e.to[1].toFixed(0)})`);
        }
      }
    }

    for (const s of gathered) {
      for (const m of s.marks) addStop(m.lineId, m.color, s.nodeId, m.pos, m.chain, m.cornerAfter, m.mega);
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
  // the gentle join left raw (F/G chevron at Chestnut St) — to keep the marker
  // solver's lane input pristine — get filleted HERE, after every marker /
  // slide / eviction read of segPath is done. So this rounds only the DRAWN
  // ribbon and cannot mega-box (the dots are already seated). Reuses the
  // regressive curveLaneJoin; marks the pair mitered so the connector pass
  // skips it. Only touches consecutive pairs no earlier join already handled.
  const noDrawFillet =
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_NO_DRAWFILLET === '1';
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
        joinCurves.push({ lineId, node: endA, a: rj.a, apex: rj.apex, b: rj.b });
      }
    }
  }

  emitLanes();

  // Node connectors: where a line continues across a node between two edges
  // whose lane slots differ, bridge the lateral jog so the line reads as
  // continuous. Driven by traversals (the line's actual edge sequence).
  const connSeen = new Set<string>();
  for (const [lineId, traversal] of layout.lineTraversals) {
    if (!lineById.has(lineId)) continue;
    let prevIdx = -1;
    for (let i = 0; i < traversal.length; i++) {
      if (!segPath.has(traversal[i].edgeId + '|' + lineId)) continue; // undrawn/suppressed
      if (prevIdx < 0) {
        prevIdx = i;
        continue;
      }
      const a = traversal[prevIdx];
      const b = traversal[i];
      // a gap of SUPPRESSED slivers between two drawn lanes still bridges:
      // the guest line crosses the host bundle in one stroke
      let bridging = false;
      if (i > prevIdx + 1) {
        bridging = true;
        for (let k = prevIdx + 1; k < i; k++) {
          if (!suppressed.has(traversal[k].edgeId + '|' + lineId)) {
            bridging = false;
            break;
          }
        }
        if (!bridging) {
          prevIdx = i;
          continue;
        }
      }
      prevIdx = i;
      const ea = edgeById.get(a.edgeId);
      const eb = edgeById.get(b.edgeId);
      if (!ea || !eb) continue;
      const endA = a.reversed ? ea.from : ea.to;
      const startB = b.reversed ? eb.to : eb.from;
      if (!bridging && endA !== startB) continue; // discontinuity — nothing to bridge
      const pairKey = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
      const key = lineId + '|' + endA + '>' + startB + '|' + pairKey;
      const miterKey = lineId + '|' + endA + '|' + pairKey;
      if (connSeen.has(key) || mitered.has(miterKey)) continue;
      connSeen.add(key);
      const pa = lineEndAt(a.edgeId, lineId, endA);
      const pb = lineEndAt(b.edgeId, lineId, startB);
      if (!pa || !pb) continue;
      const gap = hyp(pb[0] - pa[0], pb[1] - pa[1]);
      if (gap < 0.5 || gap > spacing * 8) continue; // coincident, or not a lane jog
      let d = dByLine.get(lineId);
      if (!d) dByLine.set(lineId, (d = []));
      // Tangent-matched cubic instead of a straight chord: a lateral lane jog
      // reads as a smooth S through the node, not a crimp (LOOM transitmap's
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
      // The S only works when the jog makes forward progress along the
      // travel direction: cap the tangent extension at the chord's
      // LONGITUDINAL span. A pure lateral jog (lanes of two collinear edges
      // ending at the same station of the corridor — Flatbush h3497 grays)
      // has lon ~ 0; tangent-matched controls would balloon a 180-degree
      // hairpin east of the node, so it degrades to a plain crossover chord.
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
      d.push('M' + pa[0].toFixed(1) + ',' + pa[1].toFixed(1));
      if (dirA[0] * dirB[0] + dirA[1] * dirB[1] < -0.3 || k < 1.5 || prog < 0) {
        // regressive turn (or no forward progress): tangent-matched control
        // points would bulge the bridge outward — a plain chord across the
        // junction reads as the line passing straight through
        d.push('L' + pb[0].toFixed(1) + ',' + pb[1].toFixed(1));
      } else {
        const c1: Pixel = [pa[0] + dirA[0] * k, pa[1] + dirA[1] * k];
        const c2: Pixel = [pb[0] - dirB[0] * k, pb[1] - dirB[1] * k];
        d.push(
          'C' + c1[0].toFixed(1) + ',' + c1[1].toFixed(1) + ' ' +
          c2[0].toFixed(1) + ',' + c2[1].toFixed(1) + ' ' +
          pb[0].toFixed(1) + ',' + pb[1].toFixed(1),
        );
      }
      segments.push({ p1: pa, p2: pb });
    }
  }

  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
  ) {
    console.error(
      `[ribbons] per-edge: ${segPath.size} segments across ${layout.edges.length} edges, ` +
      `${mitered.size} mitered joins, ${connSeen.size} connector candidates, ${dByLine.size} lines`,
    );
  }

  const casingParts: string[] = [];
  const strokeParts: string[] = [];

  for (const [lineId, line] of lineById) {
    const d = dByLine.get(lineId);
    if (!d || d.length < 2) continue;
    const dStr = d.join(' ');
    casingParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + bg + '" stroke-width="' + casingWidth +
        '" stroke-linecap="round" stroke-linejoin="round"/>',
    );
    strokeParts.push(
      '<path d="' + dStr + '" fill="none" stroke="' + escapeXml(line.color) + '" stroke-width="' +
        LINE_WIDTH + '" stroke-linecap="round" stroke-linejoin="round" data-line-id="' + escapeXml(line.id) + '"/>',
    );
  }
  const edgeParts: string[] = [...casingParts, ...strokeParts];

  if (args.ghostNodeIds) {
    for (const gid of args.ghostNodeIds) stopsByNode.delete(gid);
  }

  // LINE degree: total drawn lines across the node's incident edges — the
  // mega-capsule trigger. Two 3-line bundles crossing perpendicular = 12;
  // a thin capsule only fails when the bundles are this large.
  const degByNode = new Map<string, number>();
  for (const e of layout.edges) {
    const n = (orderOf.get(e.id) ?? e.lines.map((l) => l.id)).length;
    degByNode.set(e.from, (degByNode.get(e.from) ?? 0) + n);
    degByNode.set(e.to, (degByNode.get(e.to) ?? 0) + n);
  }
  const stopParts = renderStops(stopsByNode, dark, membersByNode, degByNode, args.showStations !== false);
  const placements = showLabels ? placeLabels(layout, nodePx, stopsByNode, segments) : new Map();
  const labelParts: string[] = [];
  for (const n of layout.nodes.values()) {
    if (args.ghostNodeIds?.has(n.id)) continue;
    const placement = placements.get(n.id);
    const anchor = nodePx.get(n.id);
    if (!placement || !anchor) continue;
    labelParts.push(renderLabel(n, placement, anchor, stopsByNode.has(n.id), dark));
  }

  const waterPart = args.water ? waterBackdrop(layout, nodePx, args.water, dark) : '';

  let transferPart = '';
  if (args.transfers && args.transfers.length > 0) {
    const excludeKeys = edgeKeysFromGraph(layout.edges);
    const dotR = LINE_WIDTH * 0.7;
    const dotOf = (id: string): { center: Pixel; radius: number } | null => {
      const marks = stopsByNode.get(id);
      if (!marks || marks.length === 0) {
        const p = nodePx.get(id);
        return p ? { center: p, radius: dotR } : null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const m of marks) {
        if (m.pos[0] < minX) minX = m.pos[0];
        if (m.pos[0] > maxX) maxX = m.pos[0];
        if (m.pos[1] < minY) minY = m.pos[1];
        if (m.pos[1] > maxY) maxY = m.pos[1];
      }
      const center: Pixel = [(minX + maxX) / 2, (minY + maxY) / 2];
      const radius = hyp(maxX - minX, maxY - minY) / 2 + dotR;
      return { center, radius };
    };
    transferPart = renderTransferConnectors(
      args.transfers,
      (p) => {
        const a = dotOf(p.fromId);
        const b = dotOf(p.toId);
        if (!a || !b) return null;
        return { from: a.center, to: b.center, radius: Math.max(a.radius, b.radius) };
      },
      excludeKeys,
      { dark, strokeWidth: LINE_WIDTH * 0.35 },
    );
  }

  // Geographic-topo/smoothed pass an explicit geography frame; absent (e.g. no
  // geography, or pure-octi schematic) → fall back to the rendered network extent.
  const fr = args.frame ?? contentFrame(nodePx, layout.edges, edgePolyline, width, height);
  const frameAttr =
    ' data-frame="' + fr.x.toFixed(1) + ' ' + fr.y.toFixed(1) + ' ' + fr.w.toFixed(1) + ' ' + fr.h.toFixed(1) + '"';
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '"' + frameAttr + '>\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
    (waterPart ? waterPart + '\n' : '') +
    (args.gridOverlay ? args.gridOverlay + '\n' : '') +
    '<g class="edges">\n' + edgeParts.join('\n') + '\n</g>\n' +
    (transferPart ? transferPart + '\n' : '') +
    '<g class="stops">\n' + stopParts.join('\n') +
    '\n</g>\n<g class="stations">\n' + labelParts.join('\n') + '\n</g>\n</svg>'
  );
}

export function renderOctilinear(layout: Layout, opts: OctiOptions = {}): string {
  const showLabels = opts.showLabels !== false;
  const dark = opts.dark === true;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const grow = (c: Cell) => {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  };
  for (const n of layout.nodes.values()) grow(n.cell);
  for (const e of layout.edges) for (const c of e.path) grow(c);
  if (!isFinite(minX)) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';

  const offX = -minX;
  const offY = -minY;
  const maxRow = maxY + offY;
  const toPx = (c: Cell): Pixel => gridToPx([c[0] + offX, c[1] + offY], maxRow);
  const width = (maxX - minX) * CELL_PX + PAD * 2;
  const height = (maxY - minY) * CELL_PX + PAD * 2;

  const nodePx = new Map<string, Pixel>();
  for (const n of layout.nodes.values()) nodePx.set(n.id, toPx(n.cell));

  return renderRibbons({
    layout,
    nodePx,
    edgePolyline: (e) => e.path.map(toPx),
    width,
    height,
    dark,
    showLabels,
    showStations: opts.showStations,
    water: opts.water,
    transfers: opts.transfers,
  });
}
