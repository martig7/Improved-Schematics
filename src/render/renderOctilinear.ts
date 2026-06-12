// Octilinear renderer + reusable ribbon renderer. The ribbon core
// (renderRibbons) takes pre-projected node pixels and is also used by the
// smoothed renderer; renderOctilinear is the grid-cell variant the schematic
// mode uses (ported from dev/reference/renderSvg.js + gridToPx.js).

import type { Layout, Cell, Pixel, StopMark } from './layout/types';
import type { WaterCollection } from './types';
import { CELL_PX, PAD, LINE_WIDTH, LINE_GAP, MEGA_BOXES } from './constants';
import { DARK_THEME, DEFAULT_THEME } from './types';
import { offsetPolyline, curveLaneJoin, taperLaneEnd } from './layout/offsets';
import { renderStops } from './stops';
import { placeLabels, renderLabel, type Segment } from './labels';
import { escapeXml } from './escape';
import type { TransferPair } from './transfers';
import { renderTransferConnectors, edgeKeysFromGraph } from './transfers';

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
      const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]);
      const l2 = Math.hypot(b[0] - v[0], b[1] - v[1]);
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
        acc += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
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
          if (mine && theirs) jog += Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]);
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
  const joinCurves: Array<{ lineId: string; a: Pixel; apex: Pixel; b: Pixel }> = [];
  const joinStopPos = new Map<string, Pixel>(); // nodeId|lineId -> on-curve position
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
        joinCurves.push({ lineId, a: join.a, apex: join.apex, b: join.b });
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
      const gap = Math.hypot(qb[0] - qa[0], qb[1] - qa[1]);
      if (gap < 0.5 || gap > spacing * 8) continue;
      const lenA = Math.hypot(qa[0] - qa1[0], qa[1] - qa1[1]);
      const lenB = Math.hypot(qb[0] - qb1[0], qb[1] - qb1[1]);
      if (lenA < 1e-6 || lenB < 1e-6) continue;
      // directions: A pointing INTO the node, B pointing OUT
      const dirA: Pixel = [(qa[0] - qa1[0]) / lenA, (qa[1] - qa1[1]) / lenA];
      const dirB: Pixel = [(qb1[0] - qb[0]) / lenB, (qb1[1] - qb[1]) / lenB];
      const dot = dirA[0] * dirB[0] + dirA[1] * dirB[1];
      if (dot < 0.85) continue; // genuine corner the join rejected — keep S connector
      const polyLenOf = (poly: Pixel[]): number => {
        let L = 0;
        for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        return L;
      };
      const taperA = Math.min(spacing * 8, polyLenOf(pA) * 0.45);
      const taperB = Math.min(spacing * 8, polyLenOf(pB) * 0.45);
      if (taperA < gap || taperB < gap) continue; // no room — keep S connector
      const mid: Pixel = [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2];
      taperLaneEnd(pA, aAtStart, mid, taperA);
      taperLaneEnd(pB, bAtStart, mid, taperB);
      endMoved.add(keyA);
      endMoved.add(keyB);
      const pairKey2 = a.edgeId < b.edgeId ? a.edgeId + '|' + b.edgeId : b.edgeId + '|' + a.edgeId;
      mitered.add(lineId + '|' + endA + '|' + pairKey2);
    }
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
    dir?: Pixel,
    seg?: number,
  ) => {
    const key = nodeId + '|' + lineId;
    if (stopSeen.has(key)) return;
    stopSeen.add(key);
    if (!stopsByNode.has(nodeId)) stopsByNode.set(nodeId, []);
    stopsByNode.get(nodeId)!.push({ lineId, color, pos, name: lineById.get(lineId)?.label, dir, seg });
  };
  const membersByNode = args.stations ? new Map<string, number>() : undefined;
  if (args.stations) {
    // Group-keyed markers: ONE bucket per station group at its node, marks
    // gathered from each line's own stop-flag node (per-line flags can sit
    // on diverged corridors — 307 Pl's cyan terminus vs its green column).
    const laneDirAt = (lineId: string, nodeId: string): Pixel | null => {
      for (const edge of layout.edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue;
        const poly = segPath.get(edge.id + '|' + lineId);
        if (!poly || poly.length < 2) continue;
        const atStart = edge.from === nodeId;
        const pts = atStart ? poly : [...poly].reverse();
        // walk ~10px of arc for a CORRIDOR-scale direction — the first
        // segment after a join trim is junction-interior scrap and mirrors
        // marker segment grouping at busy nodes
        const a = pts[0];
        let b = pts[pts.length - 1];
        let acc = 0;
        for (let i = 1; i < pts.length; i++) {
          acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (acc >= 10) { b = pts[i]; break; }
        }
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-6) continue;
        return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      }
      return null;
    };
    interface StMarks {
      nodeId: string;
      members: number;
      marks: Array<{
        lineId: string;
        color: string;
        flagNode: string;
        pos: Pixel;
        dir?: Pixel;
        seg?: number;
      }>;
      flagNodes: Set<string>;
    }
    const gathered: StMarks[] = [];
    for (const st of args.stations) {
      membersByNode!.set(st.nodeId, st.members);
      const marks: StMarks['marks'] = [];
      const flagNodes = new Set<string>();
      for (const [lineId, flagNode] of st.stopNodes) {
        const line = lineById.get(lineId);
        if (!line) continue;
        const p = drawnEndAt.get(flagNode + '|' + lineId);
        if (!p) continue;
        const d = laneDirAt(lineId, flagNode);
        marks.push({ lineId, color: line.color, flagNode, pos: [p[0], p[1]], dir: d ?? undefined });
        flagNodes.add(flagNode);
      }
      // All marks at one node: their longitudinal scatter is a join-curve
      // artifact (each lane trims/curves differently), and the farthest-pair
      // capsule axis would run ALONG the bundle — lines visibly piercing a
      // lengthwise pill (Court). Project marks onto the bundle cross-section
      // so the capsule spans ACROSS the lanes. Multi-node stations (diverged
      // corridors) keep their true spanning marks.
      if (marks.length > 1 && flagNodes.size === 1) {
        const dir = laneDirAt(marks[0].lineId, [...flagNodes][0]);
        if (dir) {
          const cx = marks.reduce((s, m) => s + m.pos[0], 0) / marks.length;
          const cy = marks.reduce((s, m) => s + m.pos[1], 0) / marks.length;
          for (const m of marks) {
            const lon = (m.pos[0] - cx) * dir[0] + (m.pos[1] - cy) * dir[1];
            m.pos = [m.pos[0] - lon * dir[0], m.pos[1] - lon * dir[1]];
          }
        }
      }
      gathered.push({ nodeId: st.nodeId, members: st.members, marks, flagNodes });
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
          const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (acc + seg >= d) {
            const t = seg > 1e-9 ? (d - acc) / seg : 0;
            p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
            break;
          }
          acc += seg;
        }
        const dd = Math.hypot(p[0] - awayFrom[0], p[1] - awayFrom[1]);
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
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
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
    // Dot layout pass (user spec). Mega boxes: marks group PER BUNDLE —
    // marks whose lanes share a direction axis and sit near one another are
    // one bundle crossing the box; each group lays out across ITS bundle
    // (cross-section row through the group's centroid) instead of one global
    // row. Thin capsules: dots stay on their lanes but get a minimum
    // spacing along the marker axis so near-coincident marks (perpendicular
    // crossings — Kew Gardens Rd) never stack their bullets. Done BEFORE
    // boxOf is consumed so the box and collision slides see final positions.
    const respaceAlong = (
      marks: StMarks['marks'],
      ux: number,
      uy: number,
      step: number,
      collapse: boolean, // also kill scatter perpendicular to the row
    ) => {
      const cx = marks.reduce((acc, m) => acc + m.pos[0], 0) / marks.length;
      const cy = marks.reduce((acc, m) => acc + m.pos[1], 0) / marks.length;
      const order = marks.map((m, i) => ({
        i,
        t: (m.pos[0] - cx) * ux + (m.pos[1] - cy) * uy,
        c: m.color,
      }));
      if (collapse) {
        // mega-box rows are cosmetic: keep color families contiguous (by
        // family mean position), members in lane order within the family
        const fam = new Map<string, { sum: number; n: number }>();
        for (const o of order) {
          const f = fam.get(o.c) ?? { sum: 0, n: 0 };
          f.sum += o.t;
          f.n++;
          fam.set(o.c, f);
        }
        order.sort((p, q) => {
          if (p.c !== q.c) {
            const fp = fam.get(p.c)!;
            const fq = fam.get(q.c)!;
            const d = fp.sum / fp.n - fq.sum / fq.n;
            if (d !== 0) return d;
            return p.c < q.c ? -1 : 1;
          }
          return p.t - q.t;
        });
      } else {
        order.sort((p, q) => p.t - q.t);
      }
      // Minimal-displacement min-gap (pool adjacent violators): dots stay
      // EXACTLY at their lane positions unless a gap violation forces a
      // local pool, and pooled runs center on their own members' mean — no
      // global recenter drift (the old shift slid whole rows laterally off
      // their bundles: the 2 St seating bug).
      const d = order.map((o, k) => o.t - k * step);
      const blocks: Array<{ sum: number; n: number }> = [];
      for (const x of d) {
        blocks.push({ sum: x, n: 1 });
        while (
          blocks.length > 1 &&
          blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n >=
            blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n
        ) {
          const b = blocks.pop()!;
          blocks[blocks.length - 1].sum += b.sum;
          blocks[blocks.length - 1].n += b.n;
        }
      }
      const ts: number[] = [];
      for (const b of blocks) {
        const mean = b.sum / b.n;
        for (let k = 0; k < b.n; k++) ts.push(mean + ts.length * step);
      }
      order.forEach((o, k) => {
        const t = ts[k];
        const mk = marks[o.i];
        if (collapse) mk.pos = [cx + ux * t, cy + uy * t];
        else {
          const dt = t - o.t;
          mk.pos = [mk.pos[0] + ux * dt, mk.pos[1] + uy * dt];
        }
      });
    };
    for (const s of gathered) {
      if (s.marks.length < 2) continue;
      if (boxOf(s).mega) {
        // bundle grouping: quantized lane-direction axis + spatial chaining
        const n = s.marks.length;
        const bucket = s.marks.map((mk) => {
          const d = laneDirAt(mk.lineId, mk.flagNode);
          if (!d) return -1;
          const a = ((Math.atan2(d[1], d[0]) % Math.PI) + Math.PI) % Math.PI;
          return Math.round(a / (Math.PI / 4)) % 4;
        });
        const parent = s.marks.map((_, i) => i);
        const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            // null-dir marks (suppressed lane pieces) chain with any nearby
            // bucket rather than forming phantom segments of their own
            if (bucket[i] !== bucket[j] && bucket[i] !== -1 && bucket[j] !== -1) continue;
            const d = Math.hypot(
              s.marks[i].pos[0] - s.marks[j].pos[0],
              s.marks[i].pos[1] - s.marks[j].pos[1],
            );
            // chain reach covers marks separated by PASSING lanes between
            // their stop lanes (Howard St: 3 and 1 ride the outer lanes of
            // a 4-lane bundle, ~3 pitches apart) without bridging to a
            // genuinely separate parallel corridor (>= ~1.5 cells away)
            if (d < spacing * 4) parent[find(i)] = find(j);
          }
        }
        const groups = new Map<number, number[]>();
        for (let i = 0; i < n; i++) {
          const g = find(i);
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g)!.push(i);
        }
        const rows: Array<{ idx: number[]; dir: Pixel }> = [];
        for (const idx of groups.values()) {
          const dir = laneDirAt(s.marks[idx[0]].lineId, s.marks[idx[0]].flagNode) ?? [1, 0];
          rows.push({ idx, dir: [dir[0], dir[1]] });
          if (idx.length < 2) continue;
          // row runs ACROSS the bundle (the lanes' cross-section)
          respaceAlong(idx.map((i) => s.marks[i]), -dir[1], dir[0], 2 * r + 1.6, true);
        }
        // Bundles CROSS inside the box, so rows from different bundles can
        // land on each other — slide the smaller row along its own bundle
        // direction (stays on its lanes, purely cosmetic under the box)
        // until every cross-row dot pair clears.
        const minD = 2 * r + 1.6;
        for (let iter = 0; iter < 12; iter++) {
          let movedAny = false;
          for (let gi = 0; gi < rows.length; gi++) {
            for (let gj = gi + 1; gj < rows.length; gj++) {
              let dmin = Infinity;
              for (const i of rows[gi].idx) {
                for (const j of rows[gj].idx) {
                  dmin = Math.min(dmin, Math.hypot(
                    s.marks[i].pos[0] - s.marks[j].pos[0],
                    s.marks[i].pos[1] - s.marks[j].pos[1],
                  ));
                }
              }
              if (dmin >= minD - 0.05) continue;
              const small = rows[gi].idx.length <= rows[gj].idx.length ? rows[gi] : rows[gj];
              const big = small === rows[gi] ? rows[gj] : rows[gi];
              const cAt = (g: { idx: number[] }): Pixel => [
                g.idx.reduce((acc, i) => acc + s.marks[i].pos[0], 0) / g.idx.length,
                g.idx.reduce((acc, i) => acc + s.marks[i].pos[1], 0) / g.idx.length,
              ];
              const sc = cAt(small);
              const bc = cAt(big);
              const along = (sc[0] - bc[0]) * small.dir[0] + (sc[1] - bc[1]) * small.dir[1];
              const sign = along >= 0 ? 1 : -1;
              for (const i of small.idx) {
                s.marks[i].pos = [
                  s.marks[i].pos[0] + small.dir[0] * sign * 2,
                  s.marks[i].pos[1] + small.dir[1] * sign * 2,
                ];
              }
              movedAny = true;
            }
          }
          if (!movedAny) break;
        }
      } else {
        // Multi-angle capsules: group marks by entry-direction bundle (45°
        // quantized lane axis + spatial chaining). Each group becomes its
        // own capsule SEGMENT (real-NYC Atlantic Av–Barclays multi-angle
        // marker) and lays its dots along its own axis with a minimum gap —
        // differently-angled bundles stay separately bundled at the marker.
        const n = s.marks.length;
        const bucket = s.marks.map((mk) => {
          const d = mk.dir;
          if (!d) return -1;
          const a = ((Math.atan2(d[1], d[0]) % Math.PI) + Math.PI) % Math.PI;
          return Math.round(a / (Math.PI / 4)) % 4;
        });
        const parent = s.marks.map((_, i) => i);
        const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            // null-dir marks (suppressed lane pieces) chain with any nearby
            // bucket rather than forming phantom segments of their own
            if (bucket[i] !== bucket[j] && bucket[i] !== -1 && bucket[j] !== -1) continue;
            const d = Math.hypot(
              s.marks[i].pos[0] - s.marks[j].pos[0],
              s.marks[i].pos[1] - s.marks[j].pos[1],
            );
            // chain reach covers marks separated by PASSING lanes between
            // their stop lanes (Howard St: 3 and 1 ride the outer lanes of
            // a 4-lane bundle, ~3 pitches apart) without bridging to a
            // genuinely separate parallel corridor (>= ~1.5 cells away)
            if (d < spacing * 4) parent[find(i)] = find(j);
          }
        }
        const groups = new Map<number, number[]>();
        for (let i = 0; i < n; i++) {
          const g = find(i);
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g)!.push(i);
        }
        let segIdx = 0;
        for (const idx of groups.values()) {
          for (const i of idx) s.marks[i].seg = segIdx;
          segIdx++;
          if (idx.length < 2) continue;
          // The segment axis is the bundle's CROSS-SECTION (perpendicular
          // to the mean lane direction), never the marks' scatter — the
          // capsule must sit perpendicular to the route its lines actually
          // take (user rule: the BADC capsule at 22 St reads horizontal
          // across its vertical bundle). Collapse the joins' longitudinal
          // scatter onto the cross line through the group centroid, then
          // enforce the minimum dot gap along it.
          let d0: Pixel | undefined;
          for (const i of idx) {
            if (s.marks[i].dir) { d0 = s.marks[i].dir; break; }
          }
          if (d0) {
            let mx = 0, my = 0;
            for (const i of idx) {
              const d = s.marks[i].dir ?? d0;
              const sgn = d[0] * d0[0] + d[1] * d0[1] < 0 ? -1 : 1;
              mx += d[0] * sgn;
              my += d[1] * sgn;
            }
            // snap the cross-axis to the octilinear grid (a capsule reads
            // as exactly horizontal/diagonal/vertical, not approximately)
            const rawAng = Math.atan2(mx, -my); // angle of the perpendicular
            const snapAng = Math.round(rawAng / (Math.PI / 4)) * (Math.PI / 4);
            const ux = Math.cos(snapAng);
            const uy = Math.sin(snapAng);
            const cx = idx.reduce((acc, i) => acc + s.marks[i].pos[0], 0) / idx.length;
            const cy = idx.reduce((acc, i) => acc + s.marks[i].pos[1], 0) / idx.length;
            for (const i of idx) {
              const mk = s.marks[i];
              const t = (mk.pos[0] - cx) * ux + (mk.pos[1] - cy) * uy;
              mk.pos = [cx + ux * t, cy + uy * t];
            }
            respaceAlong(idx.map((i) => s.marks[i]), ux, uy, 2 * r, false);
          } else {
            // no lane direction available: farthest-pair fallback
            let ai = idx[0], bi = idx[0], span = 0;
            for (const i of idx) {
              for (const j of idx) {
                const d = Math.hypot(
                  s.marks[i].pos[0] - s.marks[j].pos[0],
                  s.marks[i].pos[1] - s.marks[j].pos[1],
                );
                if (d > span) { span = d; ai = i; bi = j; }
              }
            }
            if (span > 1) {
              const ux = (s.marks[bi].pos[0] - s.marks[ai].pos[0]) / span;
              const uy = (s.marks[bi].pos[1] - s.marks[ai].pos[1]) / span;
              respaceAlong(idx.map((i) => s.marks[i]), ux, uy, 2 * r, false);
            }
          }
        }
        // Tip-to-tip elbow solver (user design): the segments' octilinear
        // axes intersect at the elbow point P; sliding a segment along its
        // own bundle (dots ride their lanes) moves P, so search a bounded
        // slide for each newcomer segment that minimizes the tip extension
        // both segments need to reach P — REJECTING any slide that brings
        // dots of different segments within a dot diameter. The extension
        // itself is drawn by renderStops (tips extended to the axes'
        // intersection); here we only place the segments.
        const segInfos: Array<{ idx: number[]; u: Pixel; v: Pixel; }> = [];
        for (const idx of groups.values()) {
          let d0: Pixel | undefined;
          for (const i of idx) {
            if (s.marks[i].dir) { d0 = s.marks[i].dir; break; }
          }
          let u: Pixel = [1, 0];
          if (d0) {
            let mx = 0, my = 0;
            for (const i of idx) {
              const d = s.marks[i].dir ?? d0;
              const sgn = d[0] * d0[0] + d[1] * d0[1] < 0 ? -1 : 1;
              mx += d[0] * sgn;
              my += d[1] * sgn;
            }
            const snapAng = Math.round(Math.atan2(mx, -my) / (Math.PI / 4)) * (Math.PI / 4);
            u = [Math.cos(snapAng), Math.sin(snapAng)];
          }
          segInfos.push({ idx, u, v: [-u[1], u[0]] });
        }
        const centroidOf = (idx: number[]): Pixel => [
          idx.reduce((acc, i) => acc + s.marks[i].pos[0], 0) / idx.length,
          idx.reduce((acc, i) => acc + s.marks[i].pos[1], 0) / idx.length,
        ];
        const halfLenOf = (idx: number[], c: Pixel, u: Pixel): number => {
          let h = 0;
          for (const i of idx) {
            h = Math.max(h, Math.abs((s.marks[i].pos[0] - c[0]) * u[0] + (s.marks[i].pos[1] - c[1]) * u[1]));
          }
          return h;
        };
        const dotsClear = (movedSeg: number[], offset: Pixel): boolean => {
          for (const i of movedSeg) {
            const px = s.marks[i].pos[0] + offset[0];
            const py = s.marks[i].pos[1] + offset[1];
            for (let j = 0; j < s.marks.length; j++) {
              if (movedSeg.includes(j)) continue;
              if (Math.hypot(px - s.marks[j].pos[0], py - s.marks[j].pos[1]) < 2 * r - 0.05) return false;
            }
          }
          return true;
        };
        for (let bI = 1; bI < segInfos.length; bI++) {
          const B = segInfos[bI];
          const cB0 = centroidOf(B.idx);
          let aI = 0;
          let bestD = Infinity;
          for (let j = 0; j < bI; j++) {
            const cj = centroidOf(segInfos[j].idx);
            const d = Math.hypot(cB0[0] - cj[0], cB0[1] - cj[1]);
            if (d < bestD) { bestD = d; aI = j; }
          }
          const A = segInfos[aI];
          const cA = centroidOf(A.idx);
          const halfA = halfLenOf(A.idx, cA, A.u);
          const denom = A.u[0] * B.u[1] - A.u[1] * B.u[0];
          const maxSlide = spacing * 1.5;
          let bestS: number | null = null;
          let bestScore = Infinity;
          for (let sl = -maxSlide; sl <= maxSlide + 1e-6; sl += 1) {
            const off: Pixel = [B.v[0] * sl, B.v[1] * sl];
            if (!dotsClear(B.idx, off)) continue;
            const cB: Pixel = [cB0[0] + off[0], cB0[1] + off[1]];
            let score: number;
            if (Math.abs(denom) < 0.05) {
              // parallel axes: minimize the lateral offset so the rows can
              // join collinearly end-to-end
              score = Math.abs((cB[0] - cA[0]) * A.v[0] + (cB[1] - cA[1]) * A.v[1]) * 2;
            } else {
              const t = ((cB[0] - cA[0]) * B.u[1] - (cB[1] - cA[1]) * B.u[0]) / denom;
              const px = cA[0] + A.u[0] * t;
              const py = cA[1] + A.u[1] * t;
              const halfB = halfLenOf(B.idx, cB0, B.u);
              const extA = Math.max(0, Math.abs(t) - halfA);
              const extB = Math.max(
                0,
                Math.abs((px - cB[0]) * B.u[0] + (py - cB[1]) * B.u[1]) - halfB,
              );
              score = extA + extB;
            }
            score += Math.abs(sl) * 0.05;
            if (score < bestScore - 1e-9) { bestScore = score; bestS = sl; }
          }
          if (bestS !== null && Math.abs(bestS) > 1e-9) {
            for (const i of B.idx) {
              s.marks[i].pos = [
                s.marks[i].pos[0] + B.v[0] * bestS,
                s.marks[i].pos[1] + B.v[1] * bestS,
              ];
            }
          } else if (bestS === null) {
            // no collision-free slide at all: push apart along the bundle
            // until dots clear (old fallback)
            for (let k = 0; k < 16 && !dotsClear(B.idx, [0, 0]); k++) {
              for (const i of B.idx) {
                s.marks[i].pos = [s.marks[i].pos[0] + B.v[0] * 2, s.marks[i].pos[1] + B.v[1] * 2];
              }
            }
          }
        }
      }
    }
    const megas = gathered.filter((s) => boxOf(s).mega);
    const slid: Array<{ nodeId: string; at: Pixel }> = [];
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
            slid.push({ nodeId: s.nodeId, at: [(x0 + x1) / 2, (y0 + y1) / 2] });
            break;
          }
        }
        break; // resolved (or gave up) against the first overlapping mega
      }
    }

    // Small-vs-small collisions: neighbouring stations' markers must not
    // overlap (user rule). Penetration is measured between the markers'
    // actual SEGMENT HULLS (per-seg stadium axes + half-widths — bbox tests
    // miss/false-flag multi-angle capsules); the marker with fewer marks
    // slides along its own lanes until every hull pair clears.
    {
      type Hull = Array<{ a: Pixel; b: Pixel; half: number }>;
      const hullsOf = (marks: StMarks['marks'], posOf?: (i: number) => Pixel): Hull => {
        const segs = new Map<number, number[]>();
        marks.forEach((m, i) => {
          const k = m.seg ?? 0;
          if (!segs.has(k)) segs.set(k, []);
          segs.get(k)!.push(i);
        });
        const out: Hull = [];
        for (const idx of segs.values()) {
          const p = (i: number): Pixel => (posOf ? posOf(i) : marks[i].pos);
          let sa = p(idx[0]);
          let sb = p(idx[0]);
          let span = 0;
          for (const i of idx) {
            for (const j of idx) {
              const d = Math.hypot(p(i)[0] - p(j)[0], p(i)[1] - p(j)[1]);
              if (d > span) { span = d; sa = p(i); sb = p(j); }
            }
          }
          let lat = 0;
          if (span > 1e-6) {
            const nx = -(sb[1] - sa[1]) / span;
            const ny = (sb[0] - sa[0]) / span;
            for (const i of idx) {
              lat = Math.max(lat, Math.abs((p(i)[0] - sa[0]) * nx + (p(i)[1] - sa[1]) * ny));
            }
          }
          out.push({ a: sa, b: sb, half: r + 3 + lat });
        }
        return out;
      };
      const ptSeg = (px: number, py: number, a: Pixel, b: Pixel): number => {
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const l2 = vx * vx + vy * vy;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) : 0;
        return Math.hypot(px - (a[0] + vx * t), py - (a[1] + vy * t));
      };
      const segSegDist = (a1: Pixel, b1: Pixel, a2: Pixel, b2: Pixel): number =>
        Math.min(
          ptSeg(a1[0], a1[1], a2, b2), ptSeg(b1[0], b1[1], a2, b2),
          ptSeg(a2[0], a2[1], a1, b1), ptSeg(b2[0], b2[1], a1, b1),
        );
      const penBetween = (A: Hull, B: Hull): number => {
        let pen = -Infinity;
        for (const ha of A) {
          for (const hb of B) {
            pen = Math.max(pen, ha.half + hb.half - segSegDist(ha.a, ha.b, hb.a, hb.b));
          }
        }
        return pen;
      };
      const smalls = gathered.filter((s) => s.marks.length > 0 && !boxOf(s).mega);
      for (let ai = 0; ai < smalls.length; ai++) {
        for (let bi = ai + 1; bi < smalls.length; bi++) {
          if (penBetween(hullsOf(smalls[ai].marks), hullsOf(smalls[bi].marks)) <= 0.5) continue;
          const S = smalls[ai].marks.length <= smalls[bi].marks.length ? smalls[ai] : smalls[bi];
          const O = S === smalls[ai] ? smalls[bi] : smalls[ai];
          const oHull = hullsOf(O.marks);
          const ob = boxOf(O);
          const center: Pixel = [(ob.x0 + ob.x1) / 2, (ob.y0 + ob.y1) / 2];
          for (let d = 4; d <= 32; d += 4) {
            const moved = S.marks.map((mk) => lanePointAt(mk.lineId, mk.flagNode, center, d));
            if (moved.some((p) => !p)) break;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const t of moved) {
              x0 = Math.min(x0, t!.p[0]); y0 = Math.min(y0, t!.p[1]);
              x1 = Math.max(x1, t!.p[0]); y1 = Math.max(y1, t!.p[1]);
            }
            const pad = r + 3;
            const clearOf = (box: { x0: number; y0: number; x1: number; y1: number }): boolean =>
              x0 - pad >= box.x1 + 1 || x1 + pad <= box.x0 - 1 || y0 - pad >= box.y1 + 1 || y1 + pad <= box.y0 - 1;
            const trialHull = hullsOf(S.marks, (i) => moved[i]!.p);
            if (penBetween(trialHull, oHull) > -1 || !megas.every((m) => clearOf(boxOf(m)))) continue;
            for (let i = 0; i < S.marks.length; i++) {
              const mk = S.marks[i];
              mk.pos = moved[i]!.p;
              let incident = 0;
              for (const e of layout.edges) {
                if (e.from !== mk.flagNode && e.to !== mk.flagNode) continue;
                if (!segPath.has(e.id + '|' + mk.lineId)) continue;
                if (!drawsOn(mk.lineId, e.id)) continue;
                incident++;
              }
              if (incident <= 1) trimLaneAt(moved[i]!.edgeId, mk.lineId, mk.flagNode, d);
            }
            slid.push({ nodeId: S.nodeId, at: [(x0 + x1) / 2, (y0 + y1) / 2] });
            break;
          }
        }
      }
    }
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

    for (const s of gathered) {
      for (const m of s.marks) addStop(m.lineId, m.color, s.nodeId, m.pos, m.dir, m.seg);
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
      const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
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
        const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
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
      const tLen = Math.hypot(tx, ty) || 1;
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
      const radius = Math.hypot(maxX - minX, maxY - minY) / 2 + dotR;
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

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width +
    '" height="' + height + '">\n<rect width="' + width + '" height="' + height + '" fill="' + bg + '"/>\n' +
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
