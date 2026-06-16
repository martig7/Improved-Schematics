// LOOM octi: schematicize a support graph by jointly placing stations on an
// octilinear grid and routing each edge octilinearly. Faithful port of LOOM's
// heuristic Octilinearizer (loom/src/octi/Octilinearizer.cpp + combgraph/
// Drawing.cpp), the approach of Brosi & Bast:
//
//  1. try several edge-insertion orderings (most lines first, shortest first,
//     adjacent-degree, growth orders) and keep the best-scoring drawing;
//  2. route every support edge over the constraint grid graph (gridGraph.ts)
//     with hard settle/close/block mechanics and per-node cost vectors that
//     preserve the original circular edge ordering around each station;
//  3. local search: repeatedly un-settle each station, try all 8 neighbouring
//     grid positions (plus staying put), re-route its incident edges, and keep
//     the best-scoring placement until convergence.

import type { Pixel, SupportGraph, SupportEdge, Image } from './types';
import {
  OctiGridGraph,
  DEFAULT_PENALTIES,
  SOFT_INF,
  type Penalties,
} from './gridGraph';
import { cutPolylineFolds } from './topo';

export interface OctiOptions {
  /** Geographic-course enforcement penalty (LOOM's -G enfGeoPen). A grid edge
   *  d cells away from the support edge's real course pays `affinity·d²` extra.
   *  0 = pure LOOM schematic. */
  geographicAffinity: number;
  /** Override base grid cell size; default = median support-edge length divided
   *  by `cellDivisor`. */
  cellSize?: number;
  /** Fineness divisor: base cell = median edge length / cellDivisor. */
  cellDivisor?: number;
  /** Station displacement radius in grid cells (LOOM maxGrDist). Default 3. */
  maxGrDist?: number;
  /** Max local-search iterations (LOOM heurLocSearchIters). Default 100. */
  locSearchIters?: number;
  /** Grid penalty overrides. */
  penalties?: Partial<Penalties>;
  /** Length-preservation weight: penalize a drawn corridor whose endpoint chord
   *  undershoots its warped geographic chord (preserves spacing where octi
   *  would otherwise compress the density warp's dilation). 0 = off. Overridden
   *  by the OCTI_LENPRES env for sweeps. */
  lenPresW?: number;
  /** DIAGNOSTIC ONLY (default true). When explicitly false, skip the
   *  degree-2 collapse (combineDeg2) and route the planarized support graph
   *  directly, so EVERY station node is placed by the octilinearizer itself
   *  instead of being redistributed evenly along a comb corridor. Used by the
   *  full-station-placement spike; never set in production. */
  combineDeg2?: boolean;
}

export const DEFAULT_OCTI_OPTIONS: OctiOptions = {
  geographicAffinity: 0,
  cellDivisor: 1.5,
  maxGrDist: 3,
  locSearchIters: 100,
};

const MAX_STALL_RETRIES = 3;
const CONVERGENCE_THRESHOLD = 0.05;

/** Set OCTI_DEBUG=1 to log ordering scores and local-search convergence. */
const DBG: boolean =
  typeof process !== 'undefined' && !!(process as { env?: Record<string, string> }).env?.OCTI_DEBUG;

function dist(a: Pixel, b: Pixel): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function medianEdgeLength(h: SupportGraph): number {
  const lens: number[] = [];
  for (const e of h.edges.values()) {
    let total = 0;
    for (let i = 1; i < e.points.length; i++) total += dist(e.points[i - 1], e.points[i]);
    lens.push(total);
  }
  if (lens.length === 0) return 100;
  lens.sort((a, b) => a - b);
  const mid = lens.length >> 1;
  return lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
}

function bounds(h: SupportGraph) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of h.nodes.values()) {
    if (n.pos[0] < minX) minX = n.pos[0];
    if (n.pos[0] > maxX) maxX = n.pos[0];
    if (n.pos[1] < minY) minY = n.pos[1];
    if (n.pos[1] > maxY) maxY = n.pos[1];
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

// ---- short-edge contraction (LOOM OctiMain: tg.contractEdges(gridSize/2)) ---

/**
 * Merge nodes joined by an edge shorter than half a grid cell. Two skeleton
 * interchanges a few pixels apart would otherwise be forced onto distinct
 * grid nodes a full cell apart, strangling the surrounding cells and forcing
 * topology violations on everything routed past them.
 */
function contractShortEdges(
  h: SupportGraph,
  minLen: number,
): { hK: SupportGraph; merged: Map<string, string> } {
  const nodes = new Map(h.nodes);
  const edges = new Map<string, SupportEdge>();
  for (const [id, e] of h.edges) {
    edges.set(id, { ...e, points: e.points.slice(), lineIds: new Set(e.lineIds) });
  }
  const adj = new Map<string, Set<string>>();
  for (const id of nodes.keys()) adj.set(id, new Set());
  for (const e of edges.values()) {
    adj.get(e.from)?.add(e.id);
    adj.get(e.to)?.add(e.id);
  }

  const stationNodes = new Set<string>();
  for (const st of h.stations.values()) stationNodes.add(st.nodeId);

  const parent = new Map<string, string>();
  const queue = [...edges.keys()];
  while (queue.length) {
    const eid = queue.pop()!;
    const e = edges.get(eid);
    if (!e) continue;
    if (e.from === e.to) {
      edges.delete(eid);
      adj.get(e.from)?.delete(eid);
      continue;
    }
    if (polyLen(e.points) >= minLen) continue;
    // Terminal-stub guard: contracting a station-bearing dead-end would merge
    // the terminus station onto its junction and drop the stub's out-and-back
    // traversal steps downstream (imageMerge silently drops empty chains).
    if (
      (adj.get(e.from)!.size === 1 && stationNodes.has(e.from)) ||
      (adj.get(e.to)!.size === 1 && stationNodes.has(e.to))
    ) {
      continue;
    }

    // contract e.to into e.from
    const a = e.from;
    const b = e.to;
    const aPos = nodes.get(a)!.pos;
    edges.delete(eid);
    adj.get(a)!.delete(eid);
    adj.get(b)!.delete(eid);
    for (const oid of [...(adj.get(b) ?? [])]) {
      const oe = edges.get(oid);
      if (!oe) continue;
      if (oe.from === b) {
        oe.from = a;
        oe.points[0] = aPos;
      }
      if (oe.to === b) {
        oe.to = a;
        oe.points[oe.points.length - 1] = aPos;
      }
      if (oe.from === oe.to) {
        edges.delete(oid);
        adj.get(a)!.delete(oid);
        continue;
      }
      adj.get(a)!.add(oid);
      queue.push(oid); // repointing may have shortened it below the threshold
    }
    adj.delete(b);
    nodes.delete(b);
    parent.set(b, a);
  }

  if (parent.size === 0) return { hK: h, merged: new Map() };

  const merged = new Map<string, string>();
  for (const old of parent.keys()) {
    let k = parent.get(old)!;
    while (parent.has(k)) k = parent.get(k)!;
    merged.set(old, k);
  }

  const adjArr = new Map<string, string[]>();
  for (const [k, v] of adj) adjArr.set(k, [...v]);
  const hK: SupportGraph = {
    nodes,
    edges,
    adj: adjArr,
    lineRefs: h.lineRefs,
    lineTraversals: h.lineTraversals,
    stations: h.stations,
    stopAt: h.stopAt,
  };
  return { hK, merged };
}

// ---- planarization ----------------------------------------------------------

/**
 * Insert explicit intersection nodes wherever two support-edge courses cross
 * (LOOM resolves non-planarities during topology extraction). Without this,
 * two corridors that genuinely cross can only be drawn by paying a SOFT_INF
 * topology violation — so the router instead sends one of them on a giant
 * detour around the whole network.
 */
export function planarize(h: SupportGraph): { hP: SupportGraph; splits: Map<string, string[]> } {
  const END_EPS = 4; // crossings this close to an edge end are touches, not crossings
  const edges = [...h.edges.values()];

  // bounding boxes for the pair prefilter
  const boxes = edges.map((e) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of e.points) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX, minY, maxX, maxY };
  });

  const nodeAt = new Map<string, string>(); // quantized pos -> node id
  const newNodes = new Map<string, Pixel>();
  const cuts = new Map<string, Array<{ d: number; nodeId: string }>>();
  let counter = 0;

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      const ba = boxes[i];
      const bb = boxes[j];
      if (ba.minX > bb.maxX || bb.minX > ba.maxX || ba.minY > bb.maxY || bb.minY > ba.maxY) continue;

      const lenA = polyLen(a.points);
      const lenB = polyLen(b.points);
      let accA = 0;
      for (let s = 1; s < a.points.length; s++) {
        const p1 = a.points[s - 1];
        const p2 = a.points[s];
        const segA = dist(p1, p2);
        let accB = 0;
        for (let t = 1; t < b.points.length; t++) {
          const q1 = b.points[t - 1];
          const q2 = b.points[t];
          const segB = dist(q1, q2);
          const hit = segIntersect(p1, p2, q1, q2);
          if (hit) {
            const dA = accA + hit.t * segA;
            const dB = accB + hit.u * segB;
            if (dA > END_EPS && dA < lenA - END_EPS && dB > END_EPS && dB < lenB - END_EPS) {
              const key = Math.round(hit.p[0] * 8) + ',' + Math.round(hit.p[1] * 8);
              let nid = nodeAt.get(key);
              if (!nid) {
                nid = '__x' + counter++;
                nodeAt.set(key, nid);
                newNodes.set(nid, hit.p);
              }
              (cuts.get(a.id) ?? cuts.set(a.id, []).get(a.id)!).push({ d: dA, nodeId: nid });
              (cuts.get(b.id) ?? cuts.set(b.id, []).get(b.id)!).push({ d: dB, nodeId: nid });
            }
          }
          accB += segB;
        }
        accA += segA;
      }
    }
  }

  if (cuts.size === 0) return { hP: h, splits: new Map() };

  const nodes = new Map(h.nodes);
  for (const [id, pos] of newNodes) nodes.set(id, { id, pos });

  const outEdges = new Map<string, SupportEdge>();
  const splits = new Map<string, string[]>();
  for (const e of edges) {
    const cs = cuts.get(e.id);
    if (!cs || cs.length === 0) {
      outEdges.set(e.id, e);
      continue;
    }
    cs.sort((x, y) => x.d - y.d);
    // drop duplicate/near-duplicate cuts (multi-pair hits at the same spot)
    const uniq: Array<{ d: number; nodeId: string }> = [];
    for (const c of cs) {
      const last = uniq[uniq.length - 1];
      if (last && (c.nodeId === last.nodeId || c.d - last.d < 1)) continue;
      uniq.push(c);
    }
    const total = polyLen(e.points);
    const stops = [0, ...uniq.map((c) => c.d), total];
    const ndIds = [e.from, ...uniq.map((c) => c.nodeId), e.to];
    const subIds: string[] = [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const id = e.id + '__s' + k;
      const pts = slicePoly(e.points, stops[k], stops[k + 1]);
      outEdges.set(id, { id, from: ndIds[k], to: ndIds[k + 1], points: pts, lineIds: new Set(e.lineIds) });
      subIds.push(id);
    }
    splits.set(e.id, subIds);
  }

  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) adj.set(id, []);
  for (const e of outEdges.values()) {
    adj.get(e.from)?.push(e.id);
    adj.get(e.to)?.push(e.id);
  }

  const hP: SupportGraph = {
    nodes,
    edges: outEdges,
    adj,
    lineRefs: h.lineRefs,
    lineTraversals: h.lineTraversals,
    stations: h.stations,
    stopAt: h.stopAt,
  };
  return { hP, splits };
}

/** Proper segment intersection; returns params t,u in [0,1] and the point. */
function segIntersect(
  p1: Pixel, p2: Pixel, q1: Pixel, q2: Pixel,
): { p: Pixel; t: number; u: number } | null {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
  const qpx = q1[0] - p1[0];
  const qpy = q1[1] - p1[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { p: [p1[0] + t * rx, p1[1] + t * ry], t, u };
}

// ---- degree-2 collapse (LOOM CombGraph::combineDeg2) ------------------------

/** A collapsed chain: nodes[0..K] and the K original edges joining them, in
 *  the orientation of the merged edge (from → to). */
interface Chain {
  nodes: string[];
  edges: Array<{ id: string; reversed: boolean }>;
}

interface CollapseInfo {
  /** merged edge id -> chain of original nodes/edges it replaces. */
  chains: Map<string, Chain>;
  /** merged edge id -> line sets facing each endpoint (for bend matching). */
  endLines: Map<string, { from: Set<string>; to: Set<string> }>;
}

/** Excise course folds the grid cannot represent: a stretch that leaves a
 *  point and returns within half a cell of it, with lateral extent below one
 *  cell. Support-level fold cutting (sanitizeEdgeGeometry) can't see these —
 *  they span station NODES and only appear when combineDeg2 welds a chain
 *  through them (e.g. a terminus 12px behind the previous stop: 12 Pl →
 *  10 St → 1 Pl spans ~25px ≈ one cell). The router honors the phantom
 *  length by retracing its own corridor, and imageMerge then fuses the
 *  retrace into a phantom deg-3 hub — the terminus "branch" artifact.
 *  Real balloon loops have extent ≥ a cell and remain drawable. */
export function cutSubCellFolds(pts: Pixel[], cell: number): Pixel[] {
  if (pts.length < 3) return pts;
  const retEps = cell * 0.5;
  const minArc = cell * 0.75; // below this it's RDP-scale wiggle, not a fold
  let out = pts;
  for (let pass = 0; pass < 6; pass++) {
    const arcs: number[] = [0];
    for (let i = 1; i < out.length; i++) arcs.push(arcs[i - 1] + dist(out[i - 1], out[i]));
    let cutFrom = -1;
    let cutTo = -1;
    outer: for (let i = 0; i < out.length - 2; i++) {
      // scan j from the far end so the LARGEST excisable fold cuts first
      for (let j = out.length - 1; j > i + 1; j--) {
        if (arcs[j] - arcs[i] < minArc) break; // arc gap only shrinks as j--
        if (dist(out[i], out[j]) > retEps) continue;
        let extent = 0;
        for (let k = i + 1; k < j; k++) extent = Math.max(extent, dist(out[k], out[i]));
        if (extent <= cell) {
          cutFrom = i;
          cutTo = j;
          break outer;
        }
      }
    }
    if (cutFrom < 0) break;
    out = [...out.slice(0, cutFrom + 1), ...out.slice(cutTo)];
    if (out.length < 3) break;
  }
  return out;
}

/**
 * Collapse every degree-2 station into its corridor, exactly like LOOM's comb
 * graph: octi then routes only the topological skeleton (interchanges and
 * termini) and the intermediate stations are redistributed evenly along the
 * drawn path afterwards. Without this, every station needs its own grid cell
 * and dense chains spiral around each other fighting for space.
 */
export function combineDeg2(h: SupportGraph): { hC: SupportGraph; info: CollapseInfo } {
  const nodes = new Map(h.nodes);
  const edges = new Map<string, SupportEdge>();
  for (const [id, e] of h.edges) {
    edges.set(id, { ...e, points: e.points.slice(), lineIds: new Set(e.lineIds) });
  }
  const adj = new Map<string, Set<string>>();
  for (const id of nodes.keys()) adj.set(id, new Set());
  for (const e of edges.values()) {
    adj.get(e.from)?.add(e.id);
    adj.get(e.to)?.add(e.id);
  }

  const chains = new Map<string, Chain>();
  const endLines = new Map<string, { from: Set<string>; to: Set<string> }>();
  let counter = 0;

  const chainOf = (e: SupportEdge): Chain =>
    chains.get(e.id) ?? { nodes: [e.from, e.to], edges: [{ id: e.id, reversed: false }] };
  const endOf = (e: SupportEdge): { from: Set<string>; to: Set<string> } =>
    endLines.get(e.id) ?? { from: e.lineIds, to: e.lineIds };
  const revChain = (c: Chain): Chain => ({
    nodes: c.nodes.slice().reverse(),
    edges: c.edges.slice().reverse().map((x) => ({ id: x.id, reversed: !x.reversed })),
  });

  const sameLines = (x: ReadonlySet<string>, y: ReadonlySet<string>): boolean => {
    if (x.size !== y.size) return false;
    for (const v of x) if (!y.has(v)) return false;
    return true;
  };

  const queue = [...nodes.keys()];
  while (queue.length) {
    const n = queue.pop()!;
    const aIds = adj.get(n);
    if (!aIds || aIds.size !== 2) continue;
    const [ia, ib] = [...aIds];
    const ea = edges.get(ia);
    const eb = edges.get(ib);
    if (!ea || !eb) continue;
    const na = ea.from === n ? ea.to : ea.from;
    const nb = eb.from === n ? eb.to : eb.from;
    if (na === nb || na === n || nb === n) continue;
    // Line-set boundary guard (mirrors topo's contractDegree2WithMatchingLines):
    // a degree-2 node where the line sets CHANGE is a service junction (e.g. a
    // terminal loop where line U hands over to line X). Collapsing through it
    // hides the junction inside one comb edge — the router then flattens the
    // structure (west-Tacoma terminal loop drew 65% of its arc, joins packed
    // into one tip knot at the projection min-gap) and the junction station
    // can never be placed as a skeleton node.
    if (!sameLines(ea.lineIds, eb.lineIds)) continue;
    // multigraph guard (LOOM: don't merge if it would duplicate an edge)
    let exists = false;
    for (const eid of adj.get(na) ?? []) {
      const e = edges.get(eid)!;
      if ((e.from === na && e.to === nb) || (e.from === nb && e.to === na)) {
        exists = true;
        break;
      }
    }
    if (exists) continue;

    // orient ea as na→n and eb as n→nb
    let cA = chainOf(ea);
    let lA = endOf(ea);
    if (ea.from !== na) {
      cA = revChain(cA);
      lA = { from: lA.to, to: lA.from };
    }
    let cB = chainOf(eb);
    let lB = endOf(eb);
    if (eb.from !== n) {
      cB = revChain(cB);
      lB = { from: lB.to, to: lB.from };
    }
    const ptsA = ea.from === na ? ea.points.slice() : ea.points.slice().reverse();
    const ptsB = eb.from === n ? eb.points.slice() : eb.points.slice().reverse();

    const id = '__cmb' + counter++;
    edges.set(id, {
      id,
      from: na,
      to: nb,
      points: ptsA.concat(ptsB.slice(1)),
      lineIds: new Set([...ea.lineIds, ...eb.lineIds]),
    });
    chains.set(id, { nodes: [...cA.nodes, ...cB.nodes.slice(1)], edges: [...cA.edges, ...cB.edges] });
    endLines.set(id, { from: lA.from, to: lB.to });
    chains.delete(ea.id);
    chains.delete(eb.id);
    endLines.delete(ea.id);
    endLines.delete(eb.id);

    edges.delete(ea.id);
    edges.delete(eb.id);
    nodes.delete(n);
    adj.delete(n);
    adj.get(na)!.delete(ea.id);
    adj.get(na)!.add(id);
    adj.get(nb)!.delete(eb.id);
    adj.get(nb)!.add(id);
  }

  const adjArr = new Map<string, string[]>();
  for (const [k, v] of adj) adjArr.set(k, [...v]);
  const hC: SupportGraph = {
    nodes,
    edges,
    adj: adjArr,
    lineRefs: h.lineRefs,
    lineTraversals: h.lineTraversals,
    stations: h.stations,
    stopAt: h.stopAt,
  };
  return { hC, info: { chains, endLines } };
}

// ---- polyline helpers for station redistribution ----------------------------

function polyLen(p: readonly Pixel[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
}

function pointAlong(p: readonly Pixel[], target: number): Pixel {
  if (p.length === 0) return [0, 0];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const seg = dist(p[i - 1], p[i]);
    if (acc + seg >= target && seg > 0) {
      const t = (target - acc) / seg;
      return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
    }
    acc += seg;
  }
  return p[p.length - 1];
}

/** Sub-polyline between arc lengths d0..d1 (inclusive interpolated cuts). */
function slicePoly(p: readonly Pixel[], d0: number, d1: number): Pixel[] {
  const out: Pixel[] = [pointAlong(p, d0)];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const seg = dist(p[i - 1], p[i]);
    const at = acc + seg;
    if (at > d0 + 1e-9 && at < d1 - 1e-9) out.push([p[i][0], p[i][1]]);
    acc = at;
    if (acc >= d1) break;
  }
  out.push(pointAlong(p, d1));
  return out;
}

// ---- comb context ----------------------------------------------------------

/** Static per-input data: degrees, circular edge orderings (LOOM CombGraph /
 *  EdgeOrdering), simplified courses and geo-pen caches. */
interface CombCtx {
  h: SupportGraph;
  deg: (nd: string) => number;
  ldeg: (nd: string) => number;
  posOf: (nd: string) => Pixel;
  adjEdges: (nd: string) => SupportEdge[];
  /** circular distance from edge a to edge b in the angular ordering at nd. */
  circDist: (nd: string, aEdge: string, bEdge: string) => number;
  /** line set of edge e facing node nd (end-specific for collapsed chains). */
  linesAt: (e: SupportEdge, nd: string) => ReadonlySet<string>;
  /** number of original edges a (possibly collapsed) edge represents. */
  childCount: (ceId: string) => number;
  maxGrDist: number;
  geoW: number;
  /** Length-preservation weight (0 = off). Penalizes a drawn corridor whose
   *  endpoint chord undershoots its warped geographic chord — preserves spacing
   *  without forcing angles (the user-preferred fix for octi compressing the
   *  density warp; ndMovePen tethered positions and forced angles instead). */
  lenPresW: number;
  /** warped geographic endpoint chord (spacing target) of a support edge. */
  geoLenOf: (ce: SupportEdge) => number;
  /** per support edge: decimated course + per-grid-edge penalty cache. */
  geoPenFor: (ce: SupportEdge, grid: OctiGridGraph) => ((e: number) => number) | undefined;
}

function buildCombCtx(
  h: SupportGraph,
  grid: OctiGridGraph,
  opts: OctiOptions,
  info: CollapseInfo,
): CombCtx {
  const degM = new Map<string, number>();
  const ldegM = new Map<string, number>();
  const orderPos = new Map<string, Map<string, number>>();

  for (const [id] of h.nodes) {
    const adj = h.adj.get(id) ?? [];
    degM.set(id, adj.length);
    let l = 0;
    for (const eid of adj) l += h.edges.get(eid)?.lineIds.size ?? 0;
    ldegM.set(id, l);

    // EdgeOrdering: adjacent edges sorted by descending departure angle, which
    // matches stepping port indices clockwise (LOOM PairCmp sorts descending).
    // The tangent is taken one grid CELL along the course, not at the first
    // geometry sample (~4px): merge rounds leave micro-wiggles at junctions,
    // and a noise-scale tangent can mirror the circular order — the topology
    // blocking in writeNdCosts then pins an edge on the wrong side of its
    // siblings and forces a corridor-wide detour (W-line Lawrence->Burke bug).
    // The first grid hop subtends a full cell, so that is the scale the port
    // ordering physically describes.
    const nd = h.nodes.get(id)!;
    const entries: Array<{ eid: string; ang: number }> = [];
    for (const eid of adj) {
      const e = h.edges.get(eid);
      if (!e) continue;
      const pts = e.from === id ? e.points : [...e.points].reverse();
      let ref: Pixel = pts.length > 1 ? pts[pts.length - 1] : h.nodes.get(e.from === id ? e.to : e.from)!.pos;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        acc += dist(pts[i - 1], pts[i]);
        if (acc >= grid.cellSize) { ref = pts[i]; break; }
      }
      entries.push({ eid, ang: Math.atan2(ref[1] - nd.pos[1], ref[0] - nd.pos[0]) });
    }
    entries.sort((a, b) => (b.ang - a.ang) || a.eid.localeCompare(b.eid));
    const m = new Map<string, number>();
    entries.forEach((en, i) => m.set(en.eid, i));
    orderPos.set(id, m);
  }

  const geoW = opts.geographicAffinity ?? 0;
  const lenEnv =
    typeof process !== 'undefined'
      ? Number((process as { env?: Record<string, string> }).env?.OCTI_LENPRES)
      : NaN;
  const lenPresW = Number.isFinite(lenEnv) ? lenEnv : (opts.lenPresW ?? 0);
  const chordCache = new Map<string, number>();
  const geoLenOf = (ce: SupportEdge): number => {
    let v = chordCache.get(ce.id);
    if (v === undefined) {
      v = dist(ce.points[0], ce.points[ce.points.length - 1]);
      chordCache.set(ce.id, v);
    }
    return v;
  };
  const courses = new Map<string, Pixel[]>();
  const penCaches = new Map<string, Map<number, number>>();

  const courseOf = (ce: SupportEdge): Pixel[] => {
    let c = courses.get(ce.id);
    if (!c) {
      // decimate to ~half-cell resolution so distance queries stay cheap
      const minStep = grid.cellSize / 2;
      c = [ce.points[0]];
      for (let i = 1; i < ce.points.length - 1; i++) {
        if (dist(c[c.length - 1], ce.points[i]) >= minStep) c.push(ce.points[i]);
      }
      if (ce.points.length > 1) c.push(ce.points[ce.points.length - 1]);
      courses.set(ce.id, c);
    }
    return c;
  };

  const distToCourse = (p: Pixel, course: Pixel[]): number => {
    let best = Infinity;
    for (let i = 1; i < course.length; i++) {
      best = Math.min(best, pointToSegment(p, course[i - 1], course[i]));
    }
    return best === Infinity ? 0 : best;
  };

  return {
    h,
    deg: (nd) => degM.get(nd) ?? 0,
    ldeg: (nd) => ldegM.get(nd) ?? 0,
    posOf: (nd) => h.nodes.get(nd)!.pos,
    adjEdges: (nd) =>
      (h.adj.get(nd) ?? [])
        .map((eid) => h.edges.get(eid))
        .filter((e): e is SupportEdge => !!e),
    circDist: (nd, a, b) => {
      const m = orderPos.get(nd);
      if (!m) return 0;
      const pa = m.get(a);
      const pb = m.get(b);
      if (pa === undefined || pb === undefined) return 0;
      const n = m.size;
      return (pb - pa + n) % n;
    },
    linesAt: (e, nd) => {
      const el = info.endLines.get(e.id);
      if (!el) return e.lineIds;
      return e.from === nd ? el.from : el.to;
    },
    childCount: (ceId) => info.chains.get(ceId)?.edges.length ?? 1,
    maxGrDist: opts.maxGrDist ?? 3,
    geoW,
    lenPresW,
    geoLenOf,
    geoPenFor: (ce, g) => {
      if (!geoW) return undefined;
      let cache = penCaches.get(ce.id);
      if (!cache) penCaches.set(ce.id, (cache = new Map()));
      const course = courseOf(ce);
      // Bow-scaled enforcement: a chain whose real course is much longer than
      // its endpoint span (a corridor that swings far around) is exactly the
      // one the router will shortcut — and a flat global affinity that is
      // safe for straight chains is too weak to defend a bow (the W line's
      // Lawrence->Burke Court corridor drew SOUTH of its span though every
      // station lies north). Scale the penalty by the bow factor, capped 4x.
      const span = dist(ce.points[0], ce.points[ce.points.length - 1]);
      const bow = span > 1e-6 ? Math.max(1, polyLen(ce.points) / span) : 4;
      // Quadratic in the bow, capped: a 1.7x bow pays ~3x, a loop pays 8x.
      // Linear scaling measured too weak (the W-line western bow still cut
      // inside at 1.7x); straight chains stay at base affinity.
      const w = geoW * Math.min(8, bow * bow);
      return (e: number) => {
        let v = cache!.get(e);
        if (v !== undefined) return v;
        const [a, b] = g.gridEdgeBases(e);
        const pa = g.basePos(a);
        const pb = g.basePos(b);
        const d = Math.max(distToCourse(pa, course), distToCourse(pb, course)) / g.cellSize;
        v = Math.min(SOFT_INF, w * d * d);
        cache!.set(e, v);
        return v;
      };
    },
  };
}

function pointToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const t = c1 / c2;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

// ---- drawing (LOOM combgraph/Drawing) --------------------------------------

class Drawing {
  /** support node -> settled base index. */
  nds = new Map<string, number>();
  /** support edge -> grid-edge indices, oriented edge.from → edge.to. */
  edgs = new Map<string, number[]>();
  ndReachCosts = new Map<string, number>();
  ndBndCosts = new Map<string, number>();
  edgCosts = new Map<string, number>();
  springCosts = new Map<string, number>();
  lengthCosts = new Map<string, number>();
  vios = new Map<string, number>();
  violations = 0;
  c = Infinity;

  score(): number {
    if (this.c === Infinity) return Infinity;
    return this.c + this.violations * SOFT_INF;
  }

  clone(): Drawing {
    const d = new Drawing();
    d.nds = new Map(this.nds);
    d.edgs = new Map(this.edgs); // path arrays are immutable once recorded
    d.ndReachCosts = new Map(this.ndReachCosts);
    d.ndBndCosts = new Map(this.ndBndCosts);
    d.edgCosts = new Map(this.edgCosts);
    d.springCosts = new Map(this.springCosts);
    d.lengthCosts = new Map(this.lengthCosts);
    d.vios = new Map(this.vios);
    d.violations = this.violations;
    d.c = this.c;
    return d;
  }

  draw(
    ce: SupportEdge,
    rev: boolean,
    edges: number[],
    costs: number[],
    fromBase: number,
    toBase: number,
    grid: OctiGridGraph,
    childs: number,
    geoChord = 0,
    lenPresW = 0,
  ): void {
    if (this.c === Infinity) this.c = 0;

    const srcNd = rev ? ce.to : ce.from;
    const dstNd = rev ? ce.from : ce.to;
    this.nds.set(srcNd, fromBase);
    this.nds.set(dstNd, toBase);

    let edgC = this.edgCosts.get(ce.id) ?? 0;
    for (let i = 0; i < edges.length; i++) {
      let ec = costs[i];
      if (ec >= SOFT_INF) {
        const v = Math.floor(ec / SOFT_INF);
        ec -= v * SOFT_INF;
        this.vios.set(ce.id, (this.vios.get(ce.id) ?? 0) + v);
        this.violations += v;
      }
      this.c += ec;
      if (i === 0) {
        this.attribute(srcNd, ec);
      } else if (i === edges.length - 1) {
        this.attribute(dstNd, ec);
      } else {
        edgC += ec;
      }
    }
    this.edgCosts.set(ce.id, edgC);

    const gridEdges = edges.filter((e) => grid.isGridEdge(e));
    if (rev) {
      gridEdges.reverse();
      for (let i = 0; i < gridEdges.length; i++) gridEdges[i] = grid.reverseGridEdge(gridEdges[i]);
    }
    this.edgs.set(ce.id, gridEdges);

    // spring/density cost: a collapsed chain of k+1 stations drawn over fewer
    // than k+1 grid hops gets squeezed (EuroVis paper, Drawing::draw)
    const k = childs - 1;
    let spring = 0;
    if (k > 0) {
      const l = gridEdges.length;
      const cc = grid.pens.densityPen / k;
      const F = cc * (k + 1 - l);
      if (F > 0) spring = 0.5 * cc * (k + 1 - l) * (k + 1 - l);
    }
    this.springCosts.set(ce.id, spring);
    this.c += spring;

    // length preservation: penalize a corridor whose drawn endpoint chord
    // undershoots its warped geographic chord — keeps spacing without forcing
    // angles. Endpoint-distance based, so straightening a bow is NOT penalized
    // (only genuine compression). The local search pulls compressed corridors
    // back open (St Lukes/Watts/Howard) while leaving junction angles free.
    let lenPen = 0;
    if (lenPresW > 0 && geoChord > 0) {
      const drawnChord = dist(grid.basePos(fromBase), grid.basePos(toBase));
      const short = geoChord - drawnChord;
      if (short > 0) {
        const s = short / grid.cellSize;
        lenPen = lenPresW * s * s;
      }
    }
    this.lengthCosts.set(ce.id, lenPen);
    this.c += lenPen;
  }

  private attribute(nd: string, ec: number): void {
    if (!this.ndReachCosts.has(nd)) {
      this.ndReachCosts.set(nd, ec);
      this.ndBndCosts.set(nd, 0);
    } else {
      this.ndBndCosts.set(nd, (this.ndBndCosts.get(nd) ?? 0) + ec);
    }
  }

  drawn(ceId: string): boolean { return this.edgs.has(ceId); }

  eraseEdge(ce: SupportEdge, grid: OctiGridGraph, ctx: CombCtx): void {
    this.edgs.delete(ce.id);
    this.c -= this.edgCosts.get(ce.id) ?? 0;
    this.edgCosts.delete(ce.id);
    this.c -= this.springCosts.get(ce.id) ?? 0;
    this.springCosts.delete(ce.id);
    this.c -= this.lengthCosts.get(ce.id) ?? 0;
    this.lengthCosts.delete(ce.id);

    this.c -= this.ndBndCosts.get(ce.from) ?? 0;
    this.c -= this.ndBndCosts.get(ce.to) ?? 0;
    const bf = this.recalcBends(ce.from, grid, ctx);
    const bt = this.recalcBends(ce.to, grid, ctx);
    this.ndBndCosts.set(ce.from, bf);
    this.ndBndCosts.set(ce.to, bt);
    this.c += bf + bt;

    this.violations -= this.vios.get(ce.id) ?? 0;
    this.vios.delete(ce.id);
  }

  eraseNd(nd: string): void {
    this.nds.delete(nd);
    this.c -= this.ndReachCosts.get(nd) ?? 0;
    this.c -= this.ndBndCosts.get(nd) ?? 0;
    this.ndReachCosts.delete(nd);
    this.ndBndCosts.delete(nd);
  }

  /** Re-derive node bend costs from the drawn geometry (Drawing::recalcBends).
   *  Counts each pair of line-sharing adjacent drawn edges once. */
  private recalcBends(nd: string, grid: OctiGridGraph, ctx: CombCtx): number {
    if (!this.nds.has(nd)) return 0;
    let c = 0;
    const adj = ctx.adjEdges(nd);
    for (const e of adj) {
      const pe = this.edgs.get(e.id);
      if (!pe || pe.length === 0) continue;
      const dirA = this.dirAt(nd, e, pe, grid);
      if (dirA < 0) continue;
      const eLines = ctx.linesAt(e, nd);
      for (const f of adj) {
        if (f === e) continue;
        const pf = this.edgs.get(f.id);
        if (!pf || pf.length === 0) continue;
        const fLines = ctx.linesAt(f, nd);
        let shared = false;
        for (const l of eLines) {
          if (fLines.has(l)) { shared = true; break; }
        }
        if (!shared) continue;
        const dirB = this.dirAt(nd, f, pf, grid);
        if (dirB < 0) continue;
        c += grid.getBendPen(dirA, dirB);
      }
    }
    return c / 2;
  }

  /** Port direction with which edge e's drawn path leaves node nd. The path
   *  is oriented e.from → e.to, so at e.from it departs via the first grid
   *  edge's direction; at e.to it arrives at the opposite port of the last. */
  private dirAt(nd: string, e: SupportEdge, path: number[], grid: OctiGridGraph): number {
    if (e.from === nd) return grid.gridEdgeDir(path[0]);
    if (e.to === nd) return (grid.gridEdgeDir(path[path.length - 1]) + 4) % 8;
    return -1;
  }

  eraseEdgeFromGrid(ceId: string, grid: OctiGridGraph): void {
    const path = this.edgs.get(ceId);
    if (!path) return;
    for (const e of path) {
      const [a, b] = grid.gridEdgeBases(e);
      grid.unSettleEdg(ceId, a, b);
    }
  }

  applyEdgeToGrid(ceId: string, grid: OctiGridGraph): void {
    const path = this.edgs.get(ceId);
    if (!path) return;
    for (const e of path) {
      const [a, b] = grid.gridEdgeBases(e);
      grid.settleEdg(a, b, ceId);
    }
  }

  eraseFromGrid(grid: OctiGridGraph): void {
    for (const ceId of this.edgs.keys()) this.eraseEdgeFromGrid(ceId, grid);
    for (const nd of this.nds.keys()) grid.unSettleNd(nd);
  }

  applyToGrid(grid: OctiGridGraph): void {
    for (const [nd, b] of this.nds) grid.settleNd(b, nd);
    for (const ceId of this.edgs.keys()) this.applyEdgeToGrid(ceId, grid);
  }
}

// ---- node costs (GridGraph::{nodeBendPen,spacingPen,topoBlockPen}) ---------

function writeNdCosts(
  grid: OctiGridGraph,
  b: number,
  ndId: string,
  ce: SupportEdge,
  ctx: CombCtx,
): void {
  const isIncident = (ceId: string): boolean => {
    const e = ctx.h.edges.get(ceId);
    return !!e && (e.from === ndId || e.to === ndId);
  };
  const out = grid.getSettledAdjEdgs(b, isIncident);
  const addC = new Float64Array(8);

  // topoBlockPen: block ports that would violate the circular edge ordering.
  for (let i = 0; i < 8; i++) {
    if (!out[i]) continue;
    for (let j = i + 1; j < i + 8; j++) {
      const oj = out[j % 8];
      if (!oj) continue;
      if (oj === out[i]) break;
      const da = ctx.circDist(ndId, out[i]!, ce.id);
      const db = ctx.circDist(ndId, oj, ce.id);
      if (db < da) {
        for (let x = i + 1; x < j; x++) addC[x % 8] = -Infinity;
      }
    }
  }

  // spacingPen: keep free ports between settled edges so that edges expected
  // between them (per the circular ordering) still fit.
  for (let i = 0; i < 8; i++) {
    if (!out[i]) continue;
    const dCw = ctx.circDist(ndId, out[i]!, ce.id);
    const dCCw = ctx.circDist(ndId, ce.id, out[i]!);

    let addSpace = 0;
    for (let j = 1; j < dCw + addSpace && j < 32; j++) {
      const cur = (i + j) % 8;
      const nb = grid.neigh(b, cur);
      if (nb < 0) addSpace++;
      if (nb >= 0 && !out[cur] && grid.isClosed(nb) && !grid.isSettledBase(nb)) addSpace++;
      addC[cur] = -Infinity;
    }

    addSpace = 0;
    for (let j = 1; j < dCCw + addSpace && j < 32; j++) {
      const cur = (((i - j) % 8) + 8) % 8;
      const nb = grid.neigh(b, cur);
      if (nb < 0) addSpace++;
      if (nb >= 0 && !out[cur] && grid.isClosed(nb) && !grid.isSettledBase(nb)) addSpace++;
      addC[cur] = -Infinity;
    }
  }

  // nodeBendPen: a line continuing through this node should leave via a port
  // that doesn't bend it sharply against its settled continuation.
  const ceLines = ctx.linesAt(ce, ndId);
  for (let i = 0; i < 8; i++) {
    const o = out[i];
    if (!o) continue;
    const other = ctx.h.edges.get(o);
    if (!other) continue;
    const otherLines = ctx.linesAt(other, ndId);
    let shared = false;
    for (const l of ceLines) {
      if (otherLines.has(l)) { shared = true; break; }
    }
    if (!shared) continue;
    for (let j = 0; j < 8; j++) {
      if (addC[j] !== -Infinity) addC[j] += grid.getBendPen(i, j);
    }
  }

  grid.addCostVec(b, addC);
}

// ---- candidate selection (Octilinearizer::{getCands,getRtPair}) -----------

function adjSettledBases(nd: string, grid: OctiGridGraph, ctx: CombCtx): Set<number> {
  const s = new Set<number>();
  for (const e of ctx.adjEdges(nd)) {
    const other = e.from === nd ? e.to : e.from;
    const b = grid.getSettled(other);
    if (b >= 0) s.add(b);
  }
  return s;
}

function getCands(
  nd: string,
  preSettled: ReadonlyMap<string, number>,
  grid: OctiGridGraph,
  maxGrDist: number,
  ctx: CombCtx,
): number[] {
  if (grid.isSettled(nd)) return [grid.getSettled(nd)];
  const pre = preSettled.get(nd);
  if (pre !== undefined) {
    return pre >= 0 && !grid.isClosed(pre) && !grid.isSettledBase(pre) ? [pre] : [];
  }
  // Demand at most 8 free directions — the grid maxes out at 8, so a comb
  // node of degree 9+ could otherwise NEVER place (the whole drawing then
  // falls back to raw geographic segments). Extra edges beyond 8 share grid
  // edges as SOFT_INF violations and the post-octi merge bundles them.
  const need = Math.min(8, ctx.deg(nd));
  return grid.getGrNdCands(ctx.posOf(nd), need, maxGrDist, adjSettledBases(nd, grid, ctx));
}

function getRtPair(
  frNd: string,
  toNd: string,
  preSettled: ReadonlyMap<string, number>,
  grid: OctiGridGraph,
  ctx: CombCtx,
): [number[], number[]] {
  if (grid.isSettled(frNd) && grid.isSettled(toNd)) {
    return [[grid.getSettled(frNd)], [grid.getSettled(toNd)]];
  }

  let fr: number[] = [];
  let to: number[] = [];
  let maxGrDist = ctx.maxGrDist;
  const frPos = ctx.posOf(frNd);
  const toPos = ctx.posOf(toNd);

  for (let i = 0; (fr.length === 0 || to.length === 0) && i < 10; i++) {
    const frCands = getCands(frNd, preSettled, grid, maxGrDist, ctx);
    const toCands = getCands(toNd, preSettled, grid, maxGrDist, ctx);

    const frSet = new Set(frCands);
    const toSet = new Set(toCands);
    fr = frCands.filter((b) => !toSet.has(b));
    to = toCands.filter((b) => !frSet.has(b));

    // Voronoi split of the shared candidates.
    for (const b of frCands) {
      if (!toSet.has(b)) continue;
      const p = grid.basePos(b);
      if (dist(p, frPos) < dist(p, toPos)) fr.push(b);
      else to.push(b);
    }

    maxGrDist += i * 2;
  }

  return [fr, to];
}

// ---- the core edge-insertion loop (Octilinearizer::draw) -------------------

type Undrawable = 'DRAWN' | 'NO_PATH' | 'NO_CANDS';

function drawOrder(
  order: readonly SupportEdge[],
  preSettled: ReadonlyMap<string, number>,
  grid: OctiGridGraph,
  drawing: Drawing,
  globCutoff: number,
  ctx: CombCtx,
): Undrawable {
  const A = grid.pens.p45 - grid.pens.p135;

  for (const ce of order) {
    if (ce.from === ce.to) continue; // degenerate self-loop: nothing to route

    let cutoff = globCutoff - drawing.score();
    if (drawing.score() === Infinity) cutoff = Infinity;

    let frNd = ce.from;
    let toNd = ce.to;
    let rev = false;

    let [frCands, toCands] = getRtPair(frNd, toNd, preSettled, grid, ctx);
    if (frCands.length === 0 || toCands.length === 0) {
      if (
        typeof process !== 'undefined' &&
        (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
      ) {
        const why = (nd: string, cands: number[]) =>
          `${nd}(deg=${ctx.deg(nd)},settled=${grid.isSettled(nd)},cands=${cands.length})`;
        console.error(`[octi] NO_CANDS ${why(frNd, frCands)} -> ${why(toNd, toCands)}`);
      }
      return 'NO_CANDS';
    }

    if (toCands.length > frCands.length) {
      [frNd, toNd] = [toNd, frNd];
      [frCands, toCands] = [toCands, frCands];
      rev = true;
    }

    // open sinks; unsettled endpoints pay the displacement penalty plus the
    // turn-cost offset (subtracted from the recorded costs again below)
    let costOffsetFrom = 0;
    let costOffsetTo = 0;
    for (const b of frCands) {
      if (grid.isSettled(frNd)) {
        grid.openSinkFr(b, 0);
      } else {
        costOffsetFrom = A;
        grid.openSinkFr(b, A + grid.ndMovePen(ctx.posOf(frNd), b));
      }
    }
    for (const b of toCands) {
      if (grid.isSettled(toNd)) {
        grid.openSinkTo(b, 0);
      } else {
        costOffsetTo = A;
        grid.openSinkTo(b, A + grid.ndMovePen(ctx.posOf(toNd), b));
      }
    }

    // node costs are only meaningful at already-settled nodes
    if (frCands.length === 1 && grid.isSettled(frNd)) writeNdCosts(grid, frCands[0], frNd, ce, ctx);
    if (toCands.length === 1 && grid.isSettled(toNd)) writeNdCosts(grid, toCands[0], toNd, ce, ctx);

    const res = grid.route(
      frCands,
      toCands,
      cutoff + costOffsetTo + costOffsetFrom,
      ctx.geoPenFor(ce, grid),
    );

    if (!res) {
      for (const b of toCands) grid.closeSinkTo(b);
      for (const b of frCands) grid.closeSinkFr(b);
      return 'NO_PATH';
    }

    // remove the offsets so recorded costs aren't distorted
    res.costs[0] -= costOffsetFrom;
    res.costs[res.costs.length - 1] -= costOffsetTo;

    drawing.draw(ce, rev, res.edges, res.costs, res.fromBase, res.toBase, grid, ctx.childCount(ce.id), ctx.geoLenOf(ce), ctx.lenPresW);

    for (const b of toCands) grid.closeSinkTo(b);
    for (const b of frCands) grid.closeSinkFr(b);

    // settleRes
    grid.settleNd(res.toBase, toNd);
    grid.settleNd(res.fromBase, frNd);
    for (const e of res.edges) {
      if (!grid.isGridEdge(e)) continue;
      const [a, b] = grid.gridEdgeBases(e);
      grid.settleEdg(a, b, ce.id);
    }
  }

  return 'DRAWN';
}

// ---- edge orderings (Octilinearizer::getOrdering) ---------------------------

type OrderMethod =
  | 'NUM_LINES'
  | 'LENGTH'
  | 'ADJ_ND_DEGREE'
  | 'ADJ_ND_LDEGREE'
  | 'GROWTH_DEG'
  | 'GROWTH_LDEG';

const ALL_METHODS: OrderMethod[] = [
  'NUM_LINES',
  'LENGTH',
  'ADJ_ND_DEGREE',
  'ADJ_ND_LDEGREE',
  'GROWTH_DEG',
  'GROWTH_LDEG',
];

function getOrdering(method: OrderMethod, ctx: CombCtx): SupportEdge[] {
  const edges = [...ctx.h.edges.values()];
  const straight = (e: SupportEdge) => dist(ctx.posOf(e.from), ctx.posOf(e.to));
  const pairDesc = (key: (nd: string) => number) => (a: SupportEdge, b: SupportEdge) => {
    const aMax = Math.max(key(a.from), key(a.to));
    const aMin = Math.min(key(a.from), key(a.to));
    const bMax = Math.max(key(b.from), key(b.to));
    const bMin = Math.min(key(b.from), key(b.to));
    return (bMax - aMax) || (bMin - aMin) || a.id.localeCompare(b.id);
  };

  switch (method) {
    case 'NUM_LINES':
      return edges.sort((a, b) => (b.lineIds.size - a.lineIds.size) || a.id.localeCompare(b.id));
    case 'LENGTH':
      return edges.sort((a, b) => (straight(a) - straight(b)) || a.id.localeCompare(b.id));
    case 'ADJ_ND_DEGREE':
      return edges.sort(pairDesc(ctx.deg));
    case 'ADJ_ND_LDEGREE':
      return edges.sort(pairDesc(ctx.ldeg));
    case 'GROWTH_DEG':
      return growthOrder(ctx, ctx.deg);
    case 'GROWTH_LDEG':
      return growthOrder(ctx, ctx.ldeg);
  }
}

/** BFS-like growth from the most important node (Octilinearizer
 *  getGrowthOrder). */
function growthOrder(ctx: CombCtx, key: (nd: string) => number): SupportEdge[] {
  const settled = new Set<string>();
  const order: SupportEdge[] = [];

  const popMax = (arr: string[]): string | undefined => {
    if (arr.length === 0) return undefined;
    let bi = 0;
    for (let i = 1; i < arr.length; i++) if (key(arr[i]) > key(arr[bi])) bi = i;
    const v = arr[bi];
    arr[bi] = arr[arr.length - 1];
    arr.pop();
    return v;
  };

  const global = [...ctx.h.nodes.keys()];
  for (;;) {
    const seed = popMax(global);
    if (seed === undefined) break;
    const dangling: string[] = [seed];
    for (;;) {
      const n = popMax(dangling);
      if (n === undefined) break;
      if (settled.has(n)) continue;
      const adj = ctx.adjEdges(n).slice().sort((a, b) => {
        const ka = Math.max(key(a.from), key(a.to));
        const kb = Math.max(key(b.from), key(b.to));
        return (kb - ka) || a.id.localeCompare(b.id);
      });
      for (const e of adj) {
        const other = e.from === n ? e.to : e.from;
        if (settled.has(other)) continue;
        dangling.push(other);
        order.push(e);
      }
      settled.add(n);
    }
  }
  return order;
}

// ---- main -------------------------------------------------------------------

export function octi(h: SupportGraph, opts: OctiOptions): Image {
  // grid cell from the ORIGINAL station spacing (LOOM: gridSize = avg adjacent
  // station distance), but route the planarized, deg-2-collapsed skeleton
  let dg = opts.cellSize ?? Math.max(4, medianEdgeLength(h) / (opts.cellDivisor ?? 1.5));
  const pens: Penalties = { ...DEFAULT_PENALTIES, ...(opts.penalties ?? {}) };
  const { hK, merged } = contractShortEdges(h, dg / 2);
  const { hP, splits } = planarize(hK);
  // DIAGNOSTIC bypass (opts.combineDeg2 === false): route the planarized
  // graph as-is. Empty CollapseInfo means childCount=1, linesAt=edge lines,
  // and expandImage degenerates to a passthrough.
  const { hC, info } =
    opts.combineDeg2 === false
      ? { hC: hP, info: { chains: new Map(), endLines: new Map() } as CollapseInfo }
      : combineDeg2(hP);
  if (opts.combineDeg2 !== false) {
    // combineDeg2 deep-copies edge geometry, so in-place fold cutting is safe
    for (const e of hC.edges.values()) {
      if (e.points.length > 2) e.points = cutSubCellFolds(e.points, dg);
    }
  }

  const finish = (imgP: Image): Image => {
    const joined = expandContraction(contractSplits(imgP, hK, splits), h, merged);
    // Drawn-level detour excision runs on the REJOINED edge paths: planarize
    // splits edges at crossings into straight sub-paths, so a port-congestion
    // hook around a saturated junction cluster (the Republican St yellow:
    // sub-cell node pairs can't be grid-adjacent and detour multi-hop) only
    // exists once contractSplits stitches them back together. A path that
    // returns within ~3/4 cell of itself after 1.5+ cells of arc is excised;
    // the bridge lands inside the cluster, under the interchange marker.
    // Stations are h-level NODES (path endpoints, preserved by the cut).
    const paths = new Map(joined.paths);
    let cuts = 0;
    for (const [id, p] of paths) {
      if (p.length < 3) continue;
      // sub-cell span with a multi-hop detour: replace with the chord
      const span = dist(p[0], p[p.length - 1]);
      if (span < dg * 1.2 && polyLen(p) > Math.max(2 * span, dg * 0.75)) {
        paths.set(id, [p[0], p[p.length - 1]]);
        cuts++;
        continue;
      }
      if (p.length <= 3) continue;
      // minArc one cell: the return-distance guard (eps = 3/4 cell) already
      // protects genuine U-turns — any real grid U returns a full cell away
      const cut = cutPolylineFolds(p, dg * 0.75, dg);
      if (cut.length !== p.length) {
        cuts++;
        paths.set(id, cut);
      }
    }
    if (DBG && cuts) console.error(`[octi] drawn-level detour cuts: ${cuts}`);
    const traceP =
      typeof process !== 'undefined'
        ? (process as { env?: Record<string, string> }).env?.OCTI_TRACE_PATHS
        : undefined;
    if (traceP) {
      const [tx, ty] = traceP.split(',').map(Number);
      for (const [id, p] of paths) {
        if (p.some((q) => Math.hypot(q[0] - tx, q[1] - ty) < 30)) {
          console.error(`[octi] path ${id}: ${p.map((q) => `(${q[0].toFixed(0)},${q[1].toFixed(0)})`).join(' ')}`);
        }
      }
    }
    return pinStationTermini({ placement: joined.placement, paths, cellSize: joined.cellSize }, h);
  };

  for (let attempt = 0; ; attempt++) {
    const grid = new OctiGridGraph(bounds(h), dg, pens);
    const result = tryDraw(hC, grid, opts, info);
    if (result) {
      // Drawn-level detour-loop excision: a routed path that returns within
      // ~3/4 cell of itself after 3+ cells of arc is a port-congestion
      // detour around a saturated junction (the Republican St yellow loop —
      // the router prefers a multi-cell loop over a SOFT_INF violation).
      // Excise it; the short bridge lands at the junction, under its
      // marker, and the line reads as passing straight through. Genuine
      // terminal loops are multi-edge cycles and are untouched.
      return finish(expandImage(result, hP, hC, info));
    }
    if (attempt >= MAX_STALL_RETRIES) {
      // Fallback: snap each skeleton node to its nearest base centre; direct
      // segments; stations redistributed along them as usual.
      const grid2 = new OctiGridGraph(bounds(h), dg, pens);
      const placement = new Map<string, Pixel>();
      for (const [id, n] of hC.nodes) placement.set(id, snapToGrid(grid2, n.pos));
      const paths = new Map<string, Pixel[]>();
      for (const e of hC.edges.values()) {
        paths.set(e.id, [placement.get(e.from)!, placement.get(e.to)!]);
      }
      return finish(expandImage({ placement, paths, cellSize: dg }, hP, hC, info));
    }
    dg *= 0.9; // stalling rule: shrink and rebuild
  }
}

/** Pin degree-1 station nodes to their TRUE (warped geographic) position.
 *  A terminus drawn a grid-quantized cell away can land in water or visually
 *  swallow its last hop; the final stub segment bends slightly off-grid —
 *  geographic truth at line ends beats strict octilinearity (user choice). */
function pinStationTermini(img: Image, h: SupportGraph): Image {
  const stationNodes = new Set<string>();
  for (const st of h.stations.values()) stationNodes.add(st.nodeId);
  const placement = new Map(img.placement);
  const paths = new Map(img.paths);
  for (const [nid, eids] of h.adj) {
    if (eids.length !== 1 || !stationNodes.has(nid)) continue;
    const truePos = h.nodes.get(nid)?.pos;
    if (!truePos) continue;
    placement.set(nid, truePos.slice() as Pixel);
    const e = h.edges.get(eids[0]);
    if (!e) continue;
    const path = paths.get(e.id);
    if (!path || path.length === 0) continue;
    const p2 = path.map((p) => p.slice() as Pixel);
    if (e.from === nid) p2[0] = truePos.slice() as Pixel;
    if (e.to === nid) p2[p2.length - 1] = truePos.slice() as Pixel;
    paths.set(e.id, p2);
  }
  return { placement, paths, cellSize: img.cellSize };
}

/** Give contracted-away nodes the position of their cluster representative,
 *  and contracted edges a (degenerate) straight path. */
function expandContraction(imgK: Image, h: SupportGraph, merged: Map<string, string>): Image {
  if (merged.size === 0) return imgK;
  const placement = new Map(imgK.placement);
  for (const [oldId, keptId] of merged) {
    const p = placement.get(keptId);
    if (p) placement.set(oldId, p);
  }
  const paths = new Map(imgK.paths);
  for (const e of h.edges.values()) {
    if (!paths.has(e.id)) {
      const a = placement.get(e.from);
      const b = placement.get(e.to);
      if (a && b) paths.set(e.id, [a, b]);
    }
  }
  return { placement, paths, cellSize: imgK.cellSize };
}

/** Rejoin the paths of planarization sub-edges into their original edges. */
function contractSplits(imgP: Image, h: SupportGraph, splits: Map<string, string[]>): Image {
  if (splits.size === 0) return imgP;
  const placement = new Map<string, Pixel>();
  for (const [id] of h.nodes) {
    const p = imgP.placement.get(id);
    if (p) placement.set(id, p);
  }
  const paths = new Map<string, Pixel[]>();
  for (const e of h.edges.values()) {
    const parts = splits.get(e.id);
    if (!parts) {
      const p = imgP.paths.get(e.id);
      if (p) paths.set(e.id, p);
      continue;
    }
    const poly: Pixel[] = [];
    for (const part of parts) {
      const sub = imgP.paths.get(part);
      if (!sub) continue;
      for (const pt of sub) {
        const last = poly[poly.length - 1];
        if (last && Math.abs(last[0] - pt[0]) < 1e-9 && Math.abs(last[1] - pt[1]) < 1e-9) continue;
        poly.push(pt);
      }
    }
    if (poly.length >= 2) paths.set(e.id, poly);
  }
  // safety net for anything that fell through
  for (const e of h.edges.values()) {
    if (!paths.has(e.id)) {
      const a = placement.get(e.from);
      const b = placement.get(e.to);
      if (a && b) paths.set(e.id, [a, b]);
    }
  }
  return { placement, paths, cellSize: imgP.cellSize };
}

/** Arc-length position of the nearest point on `path` to `q`. */
function nearestArcOn(path: readonly Pixel[], q: Pixel): number {
  let acc = 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / c2));
    const d = Math.hypot(q[0] - (a[0] + vx * t), q[1] - (a[1] + vy * t));
    const seg = Math.sqrt(c2);
    if (d < bestD) {
      bestD = d;
      best = acc + seg * t;
    }
    acc += seg;
  }
  return best;
}

/** Constrained 1D projection of a chain's interior stations onto the routed
 *  path: each station goes to the arc of the nearest point to its TRUE
 *  (warped geographic) position, order is preserved, a minimum gap keeps
 *  dots from colliding, and over-constrained chains fall back to even
 *  spacing. Replaces blind even redistribution, which parked stations in
 *  water and compressed them into short drawn stretches. */
function projectChainArcs(
  path: readonly Pixel[],
  L: number,
  nodes: readonly string[],
  h: SupportGraph,
): number[] {
  const tot = nodes.length - 1;
  const arcs = new Array<number>(tot + 1);
  arcs[0] = 0;
  arcs[tot] = L;
  if (tot <= 1) return arcs;
  const gap = Math.min(L / tot, 8);
  for (let i = 1; i < tot; i++) {
    const n = h.nodes.get(nodes[i]);
    arcs[i] = n ? nearestArcOn(path, n.pos) : (L * i) / tot;
  }
  for (let i = 1; i < tot; i++) arcs[i] = Math.max(arcs[i], arcs[i - 1] + gap);
  arcs[tot] = L;
  for (let i = tot - 1; i >= 1; i--) arcs[i] = Math.min(arcs[i], arcs[i + 1] - gap);
  for (let i = 1; i <= tot; i++) {
    if (arcs[i] <= arcs[i - 1]) {
      for (let k = 1; k < tot; k++) arcs[k] = (L * k) / tot;
      break;
    }
  }
  return arcs;
}

/** Re-derive positions/paths for the original support graph from the drawn
 *  skeleton: intermediate stations of each collapsed chain are placed by
 *  constrained projection of their true positions onto the routed corridor
 *  (LOOM Drawing::getLineGraph places them evenly; see projectChainArcs). */
function expandImage(imageC: Image, h: SupportGraph, hC: SupportGraph, info: CollapseInfo): Image {
  const placement = new Map(imageC.placement);
  const paths = new Map<string, Pixel[]>();

  for (const e of hC.edges.values()) {
    const routed = imageC.paths.get(e.id);
    const chain = info.chains.get(e.id);
    if (!chain) {
      if (routed) paths.set(e.id, routed);
      continue;
    }
    const path =
      routed && routed.length >= 2
        ? routed
        : [placement.get(e.from)!, placement.get(e.to)!];
    const L = polyLen(path);
    const tot = chain.edges.length;
    const arcs = projectChainArcs(path, L, chain.nodes, h);
    // Diagnostic (OCTI_TRACE_CHAIN=<nodeId>): dump projection inputs/outputs
    // for the chain containing that node.
    const traceNd =
      typeof process !== 'undefined'
        ? (process as { env?: Record<string, string> }).env?.OCTI_TRACE_CHAIN
        : undefined;
    const traceHit = (() => {
      if (!traceNd) return false;
      if (traceNd.includes(',')) {
        const [tx, ty] = traceNd.split(',').map(Number);
        return chain.nodes.some((n) => {
          const p = h.nodes.get(n)?.pos;
          return p && Math.hypot(p[0] - tx, p[1] - ty) < 30;
        });
      }
      return chain.nodes.includes(traceNd);
    })();
    if (traceHit) {
      console.error(`[octi] TRACE_CHAIN ${e.id} L=${L.toFixed(1)} pathStart=(${path[0]}) pathEnd=(${path[path.length - 1]})`);
      console.error(`[octi]   path: ${path.map((p) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`).slice(0, 12).join(' ')}${path.length > 12 ? ' ...' : ''}`);
      for (let i = 0; i <= tot; i++) {
        const n = h.nodes.get(chain.nodes[i]);
        const raw = n && i > 0 && i < tot ? nearestArcOn(path, n.pos).toFixed(1) : '-';
        console.error(
          `[octi]   node[${i}] ${chain.nodes[i]} true=(${n?.pos.map((x) => x.toFixed(0))}) rawArc=${raw} arc=${arcs[i].toFixed(1)} -> (${pointAlong(path, arcs[i]).map((x) => x.toFixed(0))})`,
        );
      }
    }
    for (let i = 1; i < tot; i++) {
      placement.set(chain.nodes[i], pointAlong(path, arcs[i]));
    }
    for (let i = 0; i < tot; i++) {
      const sub = slicePoly(path, arcs[i], arcs[i + 1]);
      const part = chain.edges[i];
      paths.set(part.id, part.reversed ? sub.slice().reverse() : sub);
    }
  }

  // safety net: anything unplaced/unpathed falls back to straight segments
  for (const [id, n] of h.nodes) {
    if (!placement.has(id)) placement.set(id, n.pos);
  }
  for (const e of h.edges.values()) {
    if (!paths.has(e.id)) {
      paths.set(e.id, [placement.get(e.from)!, placement.get(e.to)!]);
    }
  }

  return { placement, paths, cellSize: imageC.cellSize };
}

function snapToGrid(grid: OctiGridGraph, p: Pixel): Pixel {
  const col = Math.max(0, Math.min(grid.cols - 1, Math.round((p[0] - grid.originX) / grid.cellSize)));
  const row = Math.max(0, Math.min(grid.rows - 1, Math.round((p[1] - grid.originY) / grid.cellSize)));
  return grid.basePos(grid.baseIdx(col, row));
}

function tryDraw(
  h: SupportGraph,
  grid: OctiGridGraph,
  opts: OctiOptions,
  info: CollapseInfo,
): Image | null {
  const ctx = buildCombCtx(h, grid, opts, info);
  const empty = new Map<string, number>();

  // 1. initial drawing: try all orderings, keep the best. On bus-scale
  // networks a single ordering takes seconds, so cap the attempts: the two
  // strongest orderings in practice, plus stop early once one has drawn.
  const big = h.edges.size > 400;
  const methods = big ? (['NUM_LINES', 'GROWTH_LDEG'] as const) : ALL_METHODS;
  let best: Drawing | null = null;
  for (const method of methods) {
    const t = Date.now();
    const order = getOrdering(method, ctx);
    const drawing = new Drawing();
    const status = drawOrder(order, empty, grid, drawing, best?.score() ?? Infinity, ctx);
    drawing.eraseFromGrid(grid); // restore pristine grid for the next try
    if (DBG) {
      console.error(
        `[octi] ${method}: ${status} score=${drawing.score().toFixed(1)} ` +
        `vios=${drawing.violations} (${Date.now() - t}ms)`,
      );
    }
    if (status === 'DRAWN' && drawing.score() < (best?.score() ?? Infinity)) {
      best = drawing;
    }
  }
  if (!best) return null;

  let drawing = best;
  drawing.applyToGrid(grid);

  // 2. local search: re-place every station among its 9 neighbouring grid
  //    positions, re-routing its incident edges, until convergence
  const iters = opts.locSearchIters ?? 100;
  // Termination is iteration- and convergence-bounded ONLY. A former wall-clock
  // budget (Date.now() cutoff) broke the sweep mid-loop at a timing-dependent
  // point, making node placement — and thus which stations fell back to a mega
  // box — non-deterministic across machines/load (the in-game "boxes that come
  // and go with no input change"). iters + CONVERGENCE_THRESHOLD already bound
  // the work deterministically, so the same input always yields the same map.
  const t0 = Date.now(); // OCTI_DEBUG timing log only — never gates control flow
  const nodes = [...h.nodes.keys()].filter((nd) => ctx.deg(nd) > 0);
  const hEdges = [...h.edges.values()];

  // Greedy sweep variant of LOOM's local search: LOOM scores all node moves
  // and applies only the single best per iteration (a side effect of its
  // parallel batch design). Single-threaded we converge much faster by
  // accepting every improving move immediately as we sweep.
  for (let iter = 0; iter < iters; iter++) {
    let sweepImp = 0;

    for (const a of nodes) {
      const curBase = drawing.nds.get(a);
      if (curBase === undefined) continue;
      // Fan re-route order: longest chains first. A junction's short stub
      // edges (1-2 cells, near-unlimited candidate wedges) routed first wall
      // off the port wedge a long course-constrained chain needs; the chain
      // then detours around the whole junction, and the single-edge re-route
      // sweep can never repair it (transiting the stub's turn-closed bases is
      // a violation). Longest-first lets the constrained chain claim its
      // corridor and the flexible stubs adapt (W-line Lawrence->Burke bug).
      const adjE = ctx.adjEdges(a).slice().sort((x, y) => {
        const sx = dist(ctx.posOf(x.from), ctx.posOf(x.to));
        const sy = dist(ctx.posOf(y.from), ctx.posOf(y.to));
        return (sy - sx) || x.id.localeCompare(y.id);
      });

      // un-draw a's incident edges and a itself
      const dcp = drawing.clone();
      for (const ce of adjE) {
        dcp.eraseEdgeFromGrid(ce.id, grid);
        dcp.eraseEdge(ce, grid, ctx);
      }
      dcp.eraseNd(a);
      grid.unSettleNd(a);

      let bestRun: Drawing | null = null;
      let bestScore = drawing.score(); // a move must beat the status quo

      for (let pos = 0; pos <= 8; pos++) {
        const n = grid.neigh(curBase, pos);
        if (n < 0) continue;

        const run = dcp.clone();
        const err = drawOrder(adjE, new Map([[a, n]]), grid, run, bestScore, ctx);

        if (err === 'DRAWN' && run.score() < bestScore) {
          bestRun = run;
          bestScore = run.score();
        }

        // reset the grid to the un-drawn state
        for (const ce of adjE) run.eraseEdgeFromGrid(ce.id, grid);
        if (grid.isSettled(a)) grid.unSettleNd(a);
      }

      if (bestRun) {
        // accept the move immediately
        sweepImp += drawing.score() - bestScore;
        drawing = bestRun;
        const newBase = drawing.nds.get(a)!;
        grid.settleNd(newBase, a);
        for (const ce of adjE) drawing.applyEdgeToGrid(ce.id, grid);
      } else {
        // restore the current drawing on the grid
        grid.settleNd(curBase, a);
        for (const ce of adjE) drawing.applyEdgeToGrid(ce.id, grid);
      }
    }

    // edge re-route sweep: a path drawn early in the insertion order may be
    // forced through violations that no longer exist in the settled end state.
    // Rip each edge up and redraw it under the final constraints.
    for (const ce of hEdges) {
      if (ce.from === ce.to || !drawing.drawn(ce.id)) continue;

      const run = drawing.clone();
      run.eraseEdgeFromGrid(ce.id, grid);
      run.eraseEdge(ce, grid, ctx);
      const before = drawing.score();
      const err = drawOrder([ce], empty, grid, run, before, ctx);

      if (err === 'DRAWN' && run.score() < before - 1e-9) {
        sweepImp += before - run.score();
        drawing = run; // drawOrder already settled the new path on the grid
      } else {
        run.eraseEdgeFromGrid(ce.id, grid);
        drawing.applyEdgeToGrid(ce.id, grid);
      }
    }

    if (DBG) {
      console.error(
        `[octi] locSearch sweep ${iter}: score=${drawing.score().toFixed(1)} ` +
        `vios=${drawing.violations} (imp ${sweepImp.toFixed(2)}, ${Date.now() - t0}ms total)`,
      );
    }
    if (sweepImp < CONVERGENCE_THRESHOLD) break;
  }

  if (DBG) {
    console.error(`[octi] final score=${drawing.score().toFixed(1)} vios=${drawing.violations}`);
    for (const [ceId, v] of drawing.vios) {
      if (v <= 0) continue;
      const e = h.edges.get(ceId);
      const f = e ? h.nodes.get(e.from)?.pos : undefined;
      const t = e ? h.nodes.get(e.to)?.pos : undefined;
      console.error(
        `[octi]   vio x${v} on ${ceId} ` +
        `(${f?.map((x) => x.toFixed(0))} -> ${t?.map((x) => x.toFixed(0))})`,
      );
    }
  }

  // Diagnostic (OCTI_TRACE_GEO=1): per comb edge, what the FINAL routed path
  // actually paid in geographic-course penalty and how far it strays from the
  // course — the ground truth for "is geoPen inert or just out-bid".
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_TRACE_GEO
  ) {
    const geoW = opts.geographicAffinity ?? 0;
    const devTo = (p: Pixel, course: Pixel[]): number => {
      let best = Infinity;
      for (let i = 1; i < course.length; i++) {
        best = Math.min(best, pointToSegment(p, course[i - 1], course[i]));
      }
      return best === Infinity ? 0 : best;
    };
    const rows: Array<{
      id: string; hops: number; bow: number; w: number; paid: number;
      maxDev: number; spring: number; cost: number; fr: Pixel; to: Pixel;
    }> = [];
    for (const ce of h.edges.values()) {
      const path = drawing.edgs.get(ce.id);
      if (!path || path.length === 0) continue;
      const span = dist(ce.points[0], ce.points[ce.points.length - 1]);
      const bow = span > 1e-6 ? Math.max(1, polyLen(ce.points) / span) : 4;
      const w = geoW * Math.min(8, bow * bow);
      let paid = 0;
      let maxDev = 0;
      let hops = 0;
      for (const e of path) {
        if (!grid.isGridEdge(e)) continue;
        hops++;
        const [a, b] = grid.gridEdgeBases(e);
        const d = Math.max(devTo(grid.basePos(a), ce.points), devTo(grid.basePos(b), ce.points)) / grid.cellSize;
        maxDev = Math.max(maxDev, d);
        paid += Math.min(SOFT_INF, w * d * d);
      }
      rows.push({
        id: ce.id, hops, bow, w, paid, maxDev,
        spring: drawing.springCosts.get(ce.id) ?? 0,
        cost: drawing.edgCosts.get(ce.id) ?? 0,
        fr: ctx.posOf(ce.from), to: ctx.posOf(ce.to),
      });
    }
    rows.sort((a, b) => b.maxDev - a.maxDev);
    console.error(`[octi] TRACE_GEO cellSize=${grid.cellSize.toFixed(1)} geoW=${geoW} (top 25 by max course deviation in cells)`);
    for (const r of rows.slice(0, 25)) {
      console.error(
        `[octi]   ${r.id} (${r.fr.map((x) => x.toFixed(0))})->(${r.to.map((x) => x.toFixed(0))}) ` +
        `hops=${r.hops} bow=${r.bow.toFixed(2)} w=${r.w.toFixed(3)} ` +
        `maxDev=${r.maxDev.toFixed(1)}c paid=${r.paid.toFixed(1)} spring=${r.spring.toFixed(1)} cost=${r.cost.toFixed(1)}`,
      );
    }

    // OCTI_TRACE_CE=<id,...>: who occupies the grid along this edge's TRUE
    // course in the final state — the would-be faithful corridor's residents.
    const traceCe = (process as { env?: Record<string, string> }).env?.OCTI_TRACE_CE;
    for (const ceId of (traceCe ?? '').split(',').filter(Boolean)) {
      const ce = h.edges.get(ceId);
      if (!ce) { console.error(`[octi] TRACE_CE ${ceId}: no such edge`); continue; }
      console.error(`[octi] TRACE_CE ${ceId} lines={${[...ce.lineIds].map((l) => l.slice(0, 8)).join(',')}} course pts=${ce.points.length}`);
      const owners = new Map<string, number>();
      let closedBases = 0;
      let samples = 0;
      const step = grid.cellSize / 2;
      let acc = 0;
      let prev = ce.points[0];
      const visit = (p: Pixel) => {
        samples++;
        const col = Math.max(0, Math.min(grid.cols - 1, Math.round((p[0] - grid.originX) / grid.cellSize)));
        const row = Math.max(0, Math.min(grid.rows - 1, Math.round((p[1] - grid.originY) / grid.cellSize)));
        const b = grid.baseIdx(col, row);
        if (grid.isClosed(b)) closedBases++;
        for (let d = 0; d < 8; d++) {
          const res = grid.getResEdgs(grid.gridIdx(b, d));
          if (res) for (const o of res) owners.set(o, (owners.get(o) ?? 0) + 1);
        }
      };
      visit(prev);
      for (let i = 1; i < ce.points.length; i++) {
        let segLen = dist(prev, ce.points[i]);
        while (acc + segLen >= step) {
          const t = (step - acc) / segLen;
          prev = [prev[0] + (ce.points[i][0] - prev[0]) * t, prev[1] + (ce.points[i][1] - prev[1]) * t];
          segLen = dist(prev, ce.points[i]);
          acc = 0;
          visit(prev);
        }
        acc += segLen;
        prev = ce.points[i];
      }
      const lineOf = (oid: string) => {
        const oe = h.edges.get(oid);
        return oe ? [...oe.lineIds].map((l) => l.slice(0, 8)).join('+') : '?';
      };
      console.error(`[octi]   course samples=${samples} closedBases=${closedBases}`);
      for (const [oid, n] of [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        const oe = h.edges.get(oid);
        const fr = oe ? ctx.posOf(oe.from) : undefined;
        const to = oe ? ctx.posOf(oe.to) : undefined;
        console.error(
          `[octi]   resident ${oid} x${n} lines={${lineOf(oid)}} ` +
          `(${fr?.map((x) => x.toFixed(0))})->(${to?.map((x) => x.toFixed(0))})${oid === ceId ? '  <-- SELF' : ''}`,
        );
      }

      // Angular-ordering audit at both endpoints: tangent at 4px (current
      // ordering basis) vs tangent at cell scale (what the first grid hop
      // actually subtends). An order swap between the two = the topology
      // blocking constraint enforces a noise-scale ordering.
      for (const nd of [ce.from, ce.to]) {
        const ndPos = ctx.posOf(nd);
        const rows2: string[] = [];
        for (const ae of ctx.adjEdges(nd)) {
          const pts = ae.from === nd ? ae.points : [...ae.points].reverse();
          const refNear = pts.length > 1 ? pts[1] : ctx.posOf(ae.to === nd ? ae.from : ae.to);
          let acc2 = 0;
          let refCell: Pixel = pts[pts.length - 1];
          for (let i = 1; i < pts.length; i++) {
            acc2 += dist(pts[i - 1], pts[i]);
            if (acc2 >= grid.cellSize) { refCell = pts[i]; break; }
          }
          const angN = Math.atan2(refNear[1] - ndPos[1], refNear[0] - ndPos[0]) * 180 / Math.PI;
          const angC = Math.atan2(refCell[1] - ndPos[1], refCell[0] - ndPos[0]) * 180 / Math.PI;
          rows2.push(
            `${ae.id}${ae.id === ceId ? '*' : ''} lines={${lineOf(ae.id)}} ` +
            `ang4px=${angN.toFixed(0)} angCell=${angC.toFixed(0)} circ=${ctx.circDist(nd, ae.id, ceId)}`,
          );
        }
        console.error(`[octi]   ordering at ${nd} (${ndPos.map((x) => x.toFixed(0))}):`);
        for (const r of rows2) console.error(`[octi]     ${r}`);
      }

      // Active experiment: rip the edge up and re-route it under the FINAL
      // constraints — if this finds a cheaper path, the local-search edge
      // sweep would have fixed it and simply never got the chance.
      if (drawing.drawn(ce.id)) {
        const before = drawing.score();
        for (const [tag, cutoff] of [['budgeted', before], ['unbounded', Infinity]] as const) {
          const run = drawing.clone();
          run.eraseEdgeFromGrid(ce.id, grid);
          run.eraseEdge(ce, grid, ctx);
          const err = drawOrder([ce], new Map(), grid, run, cutoff, ctx);
          const after = run.score();
          let detail = '';
          if (err === 'DRAWN') {
            const path = run.edgs.get(ce.id) ?? [];
            let maxDev = 0;
            let hops = 0;
            for (const e of path) {
              if (!grid.isGridEdge(e)) continue;
              hops++;
              const [a, b] = grid.gridEdgeBases(e);
              const d = Math.max(devTo(grid.basePos(a), ce.points), devTo(grid.basePos(b), ce.points)) / grid.cellSize;
              maxDev = Math.max(maxDev, d);
            }
            detail = ` newPath hops=${hops} maxDev=${maxDev.toFixed(1)}c edgCost=${(run.edgCosts.get(ce.id) ?? 0).toFixed(1)}`;
            // pinpoint each violated (soft-closed/blocked) element of the new
            // path: position + every resident path at its two bases
            for (const e of path) {
              if (grid.edgeCost(e) < SOFT_INF) continue;
              const parts: string[] = [];
              if (grid.isGridEdge(e)) {
                const [a, b] = grid.gridEdgeBases(e);
                for (const bb of [a, b]) {
                  const res = new Set<string>();
                  for (let d8 = 0; d8 < 8; d8++) {
                    const r = grid.getResEdgs(grid.gridIdx(bb, d8));
                    if (r) for (const o of r) res.add(o);
                  }
                  const p = grid.basePos(bb);
                  parts.push(
                    `base(${p[0].toFixed(0)},${p[1].toFixed(0)}) closed=${grid.isClosed(bb)} ` +
                    `settled=${grid.isSettledBase(bb)} residents=[${[...res].join(',')}]`,
                  );
                }
                console.error(`[octi]     VIOLATED grid edge: ${parts.join(' | ')}`);
              } else {
                console.error(`[octi]     VIOLATED non-grid edge (bend/sink) idx=${e}`);
              }
            }
          }
          console.error(
            `[octi]   re-route(${tag}): ${err} before=${before.toFixed(1)} after=${after.toFixed(1)}${detail}`,
          );
          // restore the original drawing on the grid
          if (err === 'DRAWN') run.eraseEdgeFromGrid(ce.id, grid);
          drawing.applyEdgeToGrid(ce.id, grid);
        }
      }
    }
  }

  // 3. extract the image
  const placement = new Map<string, Pixel>();
  for (const [nd, b] of drawing.nds) placement.set(nd, grid.basePos(b));
  for (const [id, n] of h.nodes) {
    if (!placement.has(id)) placement.set(id, snapToGrid(grid, n.pos));
  }

  const paths = new Map<string, Pixel[]>();
  for (const e of h.edges.values()) {
    const gridEdges = drawing.edgs.get(e.id);
    if (!gridEdges || gridEdges.length === 0) {
      paths.set(e.id, [placement.get(e.from)!, placement.get(e.to)!]);
      continue;
    }
    const poly: Pixel[] = [];
    for (let i = 0; i < gridEdges.length; i++) {
      const [a, b] = grid.gridEdgeBases(gridEdges[i]);
      if (i === 0) poly.push(grid.basePos(a));
      poly.push(grid.basePos(b));
    }
    paths.set(e.id, poly);
  }

  return { placement, paths, cellSize: grid.cellSize };
}
