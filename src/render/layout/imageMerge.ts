// Post-octilinearization consolidation, ported from LOOM's
// Drawing::getLineGraph: octi's constraint relaxation lets two support edges
// share grid segments (counted as "violations"); drawn naively both lines
// land on identical pixels and one hides the other. LOOM rebuilds the graph
// from the drawn image: coincident segment runs become single edges carrying
// the union of lines, which the renderer then fans into a parallel bundle.
//
// We walk every support edge's image path, group consecutive segments by the
// exact set of support edges that draw them, split the resulting runs at any
// vertex hosting an original node (stations need nodes), and re-emit a
// support graph + image whose edges are those runs. Line traversals, station
// anchors, and stop flags are remapped onto the new edges.

import { debugMergeChains, traceFoldCollapse, traceSpliceCandidate } from './debug/imageMerge.debug';
import { LINE_WIDTH, LINE_GAP } from '../constants';
import type {
  Pixel,
  SupportGraph,
  SupportEdge,
  SupportStation,
  Image,
  TraversalStep,
  SupportNode,
} from './types';

const Q = 8; // vertex quantization: 1/8 px

function vKey(p: Pixel): string {
  return Math.round(p[0] * Q) + ',' + Math.round(p[1] * Q);
}

function segKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

interface Run {
  verts: string[];   // vertex keys, run-forward order
  pts: Pixel[];      // matching positions
  owners: string;    // canonical owner-set key
  lines: Set<string>;
}

/** Split a polyline at absolute lattice crossings (multiples of `s` in x and
 *  y). Two paths drawn over the SAME grid stretch can carry vertices at
 *  different positions along it (grid nodes vs expandImage's interpolated
 *  slice points). Then vertex-pair segment keys never align and the shared
 *  run goes undetected, leaving two lines drawn at identical coordinates with
 *  zero lane offset (one invisible under the other). Absolute crossings align
 *  coincident geometry regardless of vertex phase and need no grid origin. */
function splitAtLattice(pts: Pixel[], s: number): Pixel[] {
  if (s <= 0 || pts.length < 2) return pts;
  const out: Pixel[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const ts: number[] = [];
    for (const [d, a0] of [[dx, a[0]], [dy, a[1]]] as const) {
      if (Math.abs(d) < 1e-9) continue;
      const lo = Math.min(a0, a0 + d);
      const hi = Math.max(a0, a0 + d);
      for (let c = Math.ceil(lo / s) * s; c <= hi; c += s) {
        const t = (c - a0) / d;
        if (t > 1e-9 && t < 1 - 1e-9) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (const t of ts) out.push([a[0] + dx * t, a[1] + dy * t]);
    out.push(b);
  }
  return out;
}

export function mergeCoincidentPaths(
  h: SupportGraph,
  img: Image,
): { h: SupportGraph; img: Image } {
  // Lattice step: half a grid cell aligns every grid-conforming segment;
  // floor keeps degenerate cell sizes from exploding the vertex count.
  const lattice = Math.max(4, (img.cellSize ?? 16) / 2);

  // ---- pass 0: mutual vertex phase alignment -------------------------------
  // Coincident paths can carry vertices at different arc positions (grid
  // nodes vs interpolated slice points vs station snaps). splitAtLattice
  // aligns grid-phase geometry, but a SUB-LATTICE vertex of one path leaves
  // the other path's overlapping segment keyed straight past it: the shared
  // span never groups by owner set, and the two paths re-emit as parallel
  // duplicate edges on identical pixels. A line that rides one duplicate out
  // and the other back then draws a twin-strand fold with a self-crossing
  // instead of a coincident retrace. Split every path at any vertex (of any
  // path, or any node placement) that lies on a segment interior, so
  // coincident geometry always shares vertex phase.
  const preSplit = new Map<string, Pixel[]>();
  const candSeen = new Set<string>();
  const cands: Pixel[] = [];
  const addCand = (p: Pixel): void => {
    const k = vKey(p);
    if (candSeen.has(k)) return;
    candSeen.add(k);
    cands.push([p[0], p[1]]);
  };
  const edgeIdsAll = [...h.edges.keys()].sort();
  for (const eid of edgeIdsAll) {
    const rawPath = img.paths.get(eid);
    if (!rawPath || rawPath.length < 2) continue;
    const path = splitAtLattice(rawPath, lattice);
    preSplit.set(eid, path);
    for (const p of path) addCand(p);
  }
  for (const nid of [...h.nodes.keys()].sort()) {
    const p = img.placement.get(nid);
    if (p) addCand(p);
  }
  const CELL = Math.max(4, lattice);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < cands.length; i++) {
    const k = Math.floor(cands[i][0] / CELL) + ',' + Math.floor(cands[i][1] / CELL);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }
  // On-segment tolerance: well under the vertex quantization step, so only
  // genuinely coincident geometry gains vertices and the sub-quantum bend an
  // insertion introduces cannot survive quantization.
  const EPS = 0.25;
  const splitAtForeignVerts = (pts: Pixel[]): Pixel[] => {
    const out: Pixel[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) { out.push(b); continue; }
      const ka = vKey(a);
      const kb = vKey(b);
      const x0 = Math.min(a[0], b[0]) - EPS;
      const x1 = Math.max(a[0], b[0]) + EPS;
      const y0 = Math.min(a[1], b[1]) - EPS;
      const y1 = Math.max(a[1], b[1]) + EPS;
      const hits: Array<{ t: number; k: string; p: Pixel }> = [];
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const arr = buckets.get(cx + ',' + cy);
          if (!arr) continue;
          for (const ci of arr) {
            const v = cands[ci];
            const kv = vKey(v);
            if (kv === ka || kv === kb) continue;
            const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
            if (t <= 1e-6 || t >= 1 - 1e-6) continue;
            const ddx = v[0] - (a[0] + dx * t);
            const ddy = v[1] - (a[1] + dy * t);
            if (ddx * ddx + ddy * ddy > EPS * EPS) continue;
            hits.push({ t, k: kv, p: [v[0], v[1]] });
          }
        }
      }
      hits.sort((u, w) => (u.t - w.t) || (u.k < w.k ? -1 : u.k > w.k ? 1 : 0));
      for (const hh of hits) out.push(hh.p);
      out.push(b);
    }
    return out;
  };

  // ---- pass 1: vertex/segment inventory -----------------------------------
  const vPos = new Map<string, Pixel>();
  const edgeVerts = new Map<string, string[]>(); // edge -> vertex keys (from→to)
  const segOwners = new Map<string, Set<string>>();

  for (const e of h.edges.values()) {
    const pre = preSplit.get(e.id);
    if (!pre) {
      edgeVerts.set(e.id, []);
      continue;
    }
    const path = splitAtForeignVerts(pre);
    const verts: string[] = [];
    for (const p of path) {
      const k = vKey(p);
      if (verts.length && verts[verts.length - 1] === k) continue;
      verts.push(k);
      if (!vPos.has(k)) vPos.set(k, [p[0], p[1]]);
    }
    edgeVerts.set(e.id, verts);
    for (let i = 1; i < verts.length; i++) {
      const sk = segKey(verts[i - 1], verts[i]);
      let s = segOwners.get(sk);
      if (!s) segOwners.set(sk, (s = new Set()));
      s.add(e.id);
    }
  }

  const ownersKeyOf = (sk: string): string => [...(segOwners.get(sk) ?? [])].sort().join(',');

  // ---- pass 2: greedy runs of identical owner sets -------------------------
  // Vertices that must terminate runs: original node placements (stations and
  // topology nodes need their own graph nodes), plus any vertex where the
  // owner set changes (handled by the grouping itself).
  const nodeVerts = new Map<string, string>(); // vertex key -> old node id (first)
  for (const [nid] of h.nodes) {
    const p = img.placement.get(nid);
    if (p) {
      const k = vKey(p);
      if (!nodeVerts.has(k)) nodeVerts.set(k, nid);
    }
  }

  const runs: Run[] = [];
  const segToRun = new Map<string, { run: number; idx: number; fwd: boolean }>();

  const edgeIdsSorted = [...h.edges.keys()].sort();
  for (const eid of edgeIdsSorted) {
    const verts = edgeVerts.get(eid)!;
    let open: Run | null = null;
    const closeRun = () => {
      if (!open) return;
      const runIdx = runs.length;
      runs.push(open);
      for (let i = 1; i < open.verts.length; i++) {
        segToRun.set(segKey(open.verts[i - 1], open.verts[i]), { run: runIdx, idx: i - 1, fwd: true });
      }
      open = null;
    };
    for (let i = 1; i < verts.length; i++) {
      const a = verts[i - 1];
      const b = verts[i];
      const sk = segKey(a, b);
      if (segToRun.has(sk)) {
        closeRun();
        continue; // segment already owned by an earlier run
      }
      const ok = ownersKeyOf(sk);
      // a node-vertex in the middle must split the run so the node exists
      const boundary = nodeVerts.has(a);
      if (open && (open.owners !== ok || (boundary && open.verts.length > 1))) closeRun();
      if (open && open.verts[open.verts.length - 1] !== a) closeRun();
      if (!open) {
        open = { verts: [a], pts: [vPos.get(a)!], owners: ok, lines: new Set() };
      }
      open.verts.push(b);
      open.pts.push(vPos.get(b)!);
      if (nodeVerts.has(b)) closeRun();
    }
    closeRun();
  }

  // run line sets = union over owner edges
  for (const run of runs) {
    for (const owner of run.owners.split(',')) {
      const oe = h.edges.get(owner);
      if (oe) for (const l of oe.lineIds) run.lines.add(l);
    }
  }

  // ---- pass 3: materialize nodes and edges --------------------------------
  const newNodes = new Map<string, SupportNode>();
  const vertNode = new Map<string, string>(); // vertex key -> new node id
  let nSeq = 0;
  const nodeAt = (vk: string): string => {
    let id = vertNode.get(vk);
    if (id) return id;
    id = 'mn' + nSeq++;
    vertNode.set(vk, id);
    newNodes.set(id, { id, pos: vPos.get(vk)!.slice() as Pixel });
    return id;
  };

  const newEdges = new Map<string, SupportEdge>();
  const newAdj = new Map<string, string[]>();
  const runEdgeId: string[] = [];
  runs.forEach((run, i) => {
    const id = 'me' + i;
    runEdgeId.push(id);
    const from = nodeAt(run.verts[0]);
    const to = nodeAt(run.verts[run.verts.length - 1]);
    newEdges.set(id, {
      id,
      from,
      to,
      points: run.pts.map((p) => p.slice() as Pixel),
      lineIds: new Set(run.lines),
    });
    if (!newAdj.has(from)) newAdj.set(from, []);
    if (!newAdj.has(to)) newAdj.set(to, []);
    newAdj.get(from)!.push(id);
    newAdj.get(to)!.push(id);
  });

  // ---- pass 4: per-old-edge chains of (run, direction) --------------------
  const chains = new Map<string, Array<{ run: number; rev: boolean }>>();
  for (const eid of edgeIdsSorted) {
    const verts = edgeVerts.get(eid)!;
    const chain: Array<{ run: number; rev: boolean }> = [];
    for (let i = 1; i < verts.length; i++) {
      const sk = segKey(verts[i - 1], verts[i]);
      const hit = segToRun.get(sk);
      if (!hit) continue;
      const run = runs[hit.run];
      // direction: does this edge traverse the run's segment forward?
      const fwd = run.verts[hit.idx] === verts[i - 1];
      const rev = !fwd;
      const last = chain[chain.length - 1];
      if (last && last.run === hit.run && last.rev === rev) continue;
      chain.push({ run: hit.run, rev });
    }
    chains.set(eid, chain);
  }
  // dev: OCTI_MERGEDBG=<edgeId,edgeId> dumps an old edge's vertex list and its
  // run chain after pass 4 (which runs cover it, in what order/orientation).
  debugMergeChains(edgeVerts, vPos, segKey, segToRun, ownersKeyOf, chains, runs);

  // ---- pass 5: remap traversals, stations, stops ---------------------------
  const lineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, steps] of h.lineTraversals) {
    const out: TraversalStep[] = [];
    for (const step of steps) {
      const chain = chains.get(step.edgeId);
      if (!chain || chain.length === 0) continue;
      const seq = step.reversed
        ? chain.slice().reverse().map((c) => ({ run: c.run, rev: !c.rev }))
        : chain;
      for (const c of seq) {
        const last = out[out.length - 1];
        const edgeId = runEdgeId[c.run];
        if (last && last.edgeId === edgeId && last.reversed === c.rev) continue;
        out.push({ edgeId, reversed: c.rev });
      }
    }
    if (out.length) lineTraversals.set(lineId, out);
  }

  const mapOldNode = (oldId: string): string | null => {
    const p = img.placement.get(oldId);
    if (!p) return null;
    const direct = vertNode.get(vKey(p));
    if (direct) return direct;
    // node sat on a vertex that no run kept (fully degenerate area): nearest
    let best: string | null = null;
    let bestD = Infinity;
    for (const [vk, nid] of vertNode) {
      const q = vPos.get(vk)!;
      const d = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2); // correctly-rounded cross-V8
      if (d < bestD) { bestD = d; best = nid; }
    }
    return best;
  };

  const stations = new Map<string, SupportStation>();
  for (const [gid, st] of h.stations) {
    const nid = mapOldNode(st.nodeId);
    if (!nid) continue;
    const stopNodes = new Map<string, string>();
    for (const [lineId, oldNid] of st.stopNodes ?? []) {
      const mapped = mapOldNode(oldNid);
      if (mapped) stopNodes.set(lineId, mapped);
    }
    stations.set(gid, { ...st, nodeId: nid, stopNodes });
  }

  const stopAt = new Set<string>();
  for (const key of h.stopAt) {
    const sep = key.indexOf('|');
    const lineId = key.slice(0, sep);
    const nid = mapOldNode(key.slice(sep + 1));
    if (nid) stopAt.add(lineId + '|' + nid);
  }

  // ---- output ---------------------------------------------------------------
  const placement = new Map<string, Pixel>();
  for (const [id, n] of newNodes) placement.set(id, n.pos);
  const paths = new Map<string, Pixel[]>();
  for (const [id, e] of newEdges) paths.set(id, e.points.map((p) => p.slice() as Pixel));

  return {
    h: {
      nodes: newNodes,
      edges: newEdges,
      adj: newAdj,
      lineRefs: h.lineRefs,
      lineTraversals,
      stations,
      stopAt,
    },
    img: { placement, paths, cellSize: img.cellSize },
  };
}

// ---- manufactured fold-stub collapse ----------------------------------------
// A mid-course station can end up drawn OFF the line between its neighbors,
// with both incident course legs merged onto one shared approach. The
// coincident-path merge above then honestly turns that shared approach into a
// stub edge hanging off a junction, and every line's course goes out and back
// over the stub. A non-stopping line's detour is spliced later by the hook
// pass, but a STOP pins the fold forever: a mid-route station renders as a
// fake branch tip.
//
// Such a fold is MANUFACTURED: the GRAPH course runs straight through the
// station. The graph traversal is the course truth, so it identifies a fold
// no matter which stage manufactured it (the drawn-level merge, or an earlier
// weld/contraction that folded the support graph itself). A REAL out-and-back
// (a terminus platform, a genuine stub track the route serves and returns
// from) retraces in the GRAPH traversal too, and keeps its stub. Collapsing
// moves the station onto the fold base, which sits on its actual course, and
// drops the stub edge plus the retrace from every traversal.

// Longest stub the collapse treats as a placement artifact, in grid cells. A
// manufactured fold spans the station's displacement off its course (one or
// two cells); anything longer is real geometry that must stay visible.
const FOLD_STUB_MAX_CELLS = 2;

/**
 * Collapse manufactured fold stubs in the merged graph, in place.
 *
 * A candidate stub is a degree-1 node S whose single edge E carries at least
 * one stop flag at S, where EVERY line on E immediately retraces E (out and
 * back through S), no line on E genuinely turns around at a station seated on
 * S per the graph-course truth, and E's arc stays within the stub cap.
 * S's stations, stop flags, and traversals remap onto the fold base node.
 *
 * @param h    merged support graph (mutated)
 * @param img  merged image (mutated)
 * @param realTurnGroups genuine course turnarounds from the GRAPH traversals,
 *   as "lineId|stationGroupId" keys: the stations where a line's course
 *   really reverses. A stub whose seated stations are all absent from this
 *   set is a manufactured fold for every line that retraces it.
 * @returns number of stubs collapsed
 */
export function collapseFoldStubs(
  h: SupportGraph,
  img: Image,
  realTurnGroups: ReadonlySet<string>,
): number {
  const arcOf = (pts: Pixel[]): number => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      acc += Math.sqrt(dx * dx + dy * dy);
    }
    return acc;
  };
  const maxArc = FOLD_STUB_MAX_CELLS * (img.cellSize ?? 16);

  let collapsed = 0;
  const nodeIds = [...h.nodes.keys()].sort();
  for (const sid of nodeIds) {
    const inc = h.adj.get(sid) ?? [];
    if (inc.length !== 1) continue;
    const eid = inc[0];
    const e = h.edges.get(eid);
    if (!e) continue;
    const jid = e.from === sid ? e.to : e.from;
    if (jid === sid) continue;
    // the stub must host a stop: a stop-less fold belongs to the hook splice
    let hasStop = false;
    for (const l of e.lineIds) if (h.stopAt.has(l + '|' + sid)) { hasStop = true; break; }
    if (!hasStop) continue;
    if (arcOf(e.points) > maxArc) continue;
    // The graph-truth veto is keyed by the stations seated on the stub. A
    // stop flag with no seated station has no truth to consult; keep the
    // stub rather than guess.
    const gidsAtStub: string[] = [];
    for (const [gid, st] of h.stations) if (st.nodeId === sid) gidsAtStub.push(gid);
    if (gidsAtStub.length === 0) continue;
    // every line on the stub must go out and back over it WITH S AS THE TIP
    // (each visit is an adjacent flipped pair whose turnaround point is S).
    // A lone step means the line TERMINATES on the stub, and a pair whose tip
    // is the OTHER end means S is a terminus station whose lines turn around
    // beyond it; both are real geometry. A line whose GRAPH course genuinely
    // turns around at a station seated here keeps its stub too.
    let ok = true;
    for (const l of e.lineIds) {
      if (gidsAtStub.some((gid) => realTurnGroups.has(l + '|' + gid))) { ok = false; break; }
      const steps = h.lineTraversals.get(l) ?? [];
      let visits = 0;
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].edgeId !== eid) continue;
        const next = steps[i + 1];
        if (!next || next.edgeId !== eid || next.reversed === steps[i].reversed) { ok = false; break; }
        const tip = steps[i].reversed ? e.from : e.to;
        if (tip !== sid) { ok = false; break; }
        visits++;
        i++; // consume the pair
      }
      if (visits === 0) ok = false;
      if (!ok) break;
    }
    if (!ok) continue;

    // collapse: drop the stub, remap everything at S onto the fold base J
    h.edges.delete(eid);
    img.paths.delete(eid);
    h.adj.delete(sid);
    const jAdj = h.adj.get(jid);
    if (jAdj) h.adj.set(jid, jAdj.filter((x) => x !== eid));
    h.nodes.delete(sid);
    img.placement.delete(sid);
    for (const [l, steps] of h.lineTraversals) {
      if (!e.lineIds.has(l)) continue;
      const out: TraversalStep[] = [];
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].edgeId === eid) continue;
        out.push(steps[i]);
      }
      h.lineTraversals.set(l, out);
    }
    for (const st of h.stations.values()) {
      if (st.nodeId === sid) st.nodeId = jid;
      if (st.stopNodes) {
        for (const [l, n] of st.stopNodes) if (n === sid) st.stopNodes.set(l, jid);
      }
    }
    const remapped: string[] = [];
    for (const key of h.stopAt) {
      const sep = key.indexOf('|');
      if (key.slice(sep + 1) === sid) remapped.push(key);
    }
    for (const key of remapped) {
      h.stopAt.delete(key);
      h.stopAt.add(key.slice(0, key.indexOf('|')) + '|' + jid);
    }
    traceFoldCollapse(sid, jid, eid, [...e.lineIds], arcOf(e.points));
    collapsed++;
  }
  return collapsed;
}

// ---- per-line stop-fold splice ----------------------------------------------
// A manufactured fold can sit on a SHARED corridor: the folded line retraces a
// short edge that other lines genuinely pass through, so the fold tip is not a
// degree-1 stub and the node-level collapse above cannot act (deleting the
// edge would cut the through lines). The fold is still per-line course
// fiction, and only that line's traversal needs repair: drop the immediate
// out-and-back pair and re-home the line's stop onto the fold base, which
// sits on its real course. Other lines and the shared edge are untouched.
//
// The through-sibling gate is what separates an ERASABLE fold from drawn
// geometry. When another line traverses the fold edge without folding, the
// corridor stays inked and the folded line loses nothing spatial. When every
// line on the edge folds (a degenerate ring drawn as out-and-back arms), the
// fold IS the ink that reaches those stations, and erasing it collapses real
// service: courses hollow out, station groups pile onto one node, and the
// one-label-per-node layout drops their names.

/**
 * Splice manufactured stop-pinned folds out of individual line traversals,
 * in place.
 *
 * A candidate is an immediate same-edge out-and-back pair in one line's
 * traversal whose tip hosts that line's stop flag, where the seated stations
 * are all absent from the graph-course truth for the line (no genuine
 * turnaround), the edge's arc stays within the stub cap, and at least one
 * OTHER line traverses the fold edge without folding (the corridor is real
 * ink that survives the splice). The pair is removed; the line's stop flag
 * and per-line station stop node move to the fold base once the line no
 * longer visits the tip at all (a remaining genuine visit keeps the stop
 * where it is). Stop-less folds stay for the hook splice, and the station
 * node itself follows only when no line's stop references the tip anymore.
 *
 * Each line's splices commit only if they conserve service: the rewritten
 * course must stay non-empty and still visit every node the line stops at
 * (with moved stops counted at their new base). A violating rewrite is
 * discarded whole, so the pass can never hollow out a course.
 *
 * @param h    merged support graph (mutated)
 * @param img  merged image (cellSize only; geometry is not touched)
 * @param realTurnGroups genuine course turnarounds, "lineId|stationGroupId"
 * @returns number of pairs spliced
 */
export function spliceStopFolds(
  h: SupportGraph,
  img: Image,
  realTurnGroups: ReadonlySet<string>,
): number {
  const arcOf = (pts: Pixel[]): number => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      acc += Math.sqrt(dx * dx + dy * dy);
    }
    return acc;
  };
  const maxArc = FOLD_STUB_MAX_CELLS * (img.cellSize ?? 16);

  const gidsAt = (nid: string): string[] => {
    const gids: string[] = [];
    for (const [gid, st] of h.stations) if (st.nodeId === nid) gids.push(gid);
    return gids;
  };

  // Lines that traverse each edge WITHOUT folding (any step over the edge
  // that is not half of an immediate same-edge out-and-back pair). Built
  // once from the pristine traversals.
  const throughLines = new Map<string, Set<string>>();
  for (const [l, steps] of h.lineTraversals) {
    for (let i = 0; i < steps.length; i++) {
      const prev = steps[i - 1];
      const next = steps[i + 1];
      const s = steps[i];
      const pairedPrev = prev && prev.edgeId === s.edgeId && prev.reversed !== s.reversed;
      const pairedNext = next && next.edgeId === s.edgeId && next.reversed !== s.reversed;
      if (pairedPrev || pairedNext) continue;
      let set = throughLines.get(s.edgeId);
      if (!set) throughLines.set(s.edgeId, (set = new Set()));
      set.add(l);
    }
  }

  let spliced = 0;
  const rehome = new Map<string, string>(); // tip node -> fold base (first wins)
  const lineIds = [...h.lineTraversals.keys()].sort();
  for (const l of lineIds) {
    const steps = h.lineTraversals.get(l)!;
    const movedTips = new Set<string>();
    const plannedBase = new Map<string, string>(); // tip -> base for THIS line
    // A fold can be several edges deep (out over a chain, back over the same
    // chain): consuming the innermost pair makes the next pair immediate, so
    // the scan repeats on its own rewrite until a fixpoint. The bound is the
    // deepest chain a stub cap's worth of edges can form.
    let cur: TraversalStep[] = steps;
    let changedAny = false;
    for (let round = 0; round < 8; round++) {
      const out: TraversalStep[] = [];
      let changed = false;
      for (let i = 0; i < cur.length; i++) {
        const s1 = cur[i];
        const s2 = cur[i + 1];
        if (s1 && s2 && s1.edgeId === s2.edgeId && s1.reversed !== s2.reversed) {
          const e = h.edges.get(s1.edgeId);
          if (e) {
            const arc = arcOf(e.points);
            const tip = s1.reversed ? e.from : e.to;
            const base = s1.reversed ? e.to : e.from;
            const gids = gidsAt(tip);
            const siblings = throughLines.get(s1.edgeId);
            const corridorStaysInked = !!siblings && [...siblings].some((l2) => l2 !== l);
            const veto = gids.some((gid) => realTurnGroups.has(l + '|' + gid));
            const take =
              arc <= maxArc &&
              corridorStaysInked &&
              h.stopAt.has(l + '|' + tip) &&
              gids.length > 0 &&
              !veto;
            traceSpliceCandidate(l, s1.edgeId, tip, {
              arc, maxArc, inked: corridorStaysInked,
              stopAtTip: h.stopAt.has(l + '|' + tip), gids: gids.length, veto, taken: take,
            });
            if (take) {
              movedTips.add(tip);
              if (!plannedBase.has(tip)) plannedBase.set(tip, base);
              changed = true;
              i++; // consume the pair
              continue;
            }
          }
        }
        out.push(s1);
      }
      if (!changed) break;
      changedAny = true;
      cur = out;
    }
    if (!changedAny) continue;
    const out = cur;

    // Service conservation: the rewrite commits only if the new course is
    // non-empty and still visits every stop node of the line, counting each
    // moved stop at its base. A deep fold moves bases in a CHAIN (the outer
    // pair's base is itself an inner tip), so targets resolve transitively to
    // the first node the new course still visits. Otherwise discard the whole
    // rewrite.
    const visited = new Set<string>();
    for (const s of out) {
      const e = h.edges.get(s.edgeId);
      if (!e) continue;
      visited.add(e.from);
      visited.add(e.to);
    }
    const resolveBase = (n: string): string => {
      let x = n;
      for (let hops = 0; hops < 8 && movedTips.has(x) && !visited.has(x); hops++) {
        const b = plannedBase.get(x);
        if (!b) break;
        x = b;
      }
      return x;
    };
    let conserved = out.length > 0;
    if (conserved) {
      for (const key of h.stopAt) {
        if (!key.startsWith(l + '|')) continue;
        const n = key.slice(key.indexOf('|') + 1);
        const target = resolveBase(n);
        // only stops the OLD course could reach are held to the invariant
        let reachableBefore = false;
        for (const s of steps) {
          const e = h.edges.get(s.edgeId);
          if (e && (e.from === n || e.to === n)) { reachableBefore = true; break; }
        }
        if (reachableBefore && !visited.has(target)) { conserved = false; break; }
      }
    }
    if (!conserved) continue;

    h.lineTraversals.set(l, out);
    for (const tip of movedTips) if (!rehome.has(tip)) rehome.set(tip, resolveBase(tip));
    spliced += movedTips.size;
    // the stop follows only when the line no longer visits the tip at all;
    // a remaining genuine visit keeps its stop in place
    for (const tip of movedTips) {
      if (visited.has(tip)) continue;
      const base = resolveBase(tip);
      h.stopAt.delete(l + '|' + tip);
      h.stopAt.add(l + '|' + base);
      for (const gid of gidsAt(tip)) {
        const st = h.stations.get(gid)!;
        if (st.stopNodes?.get(l) === tip) st.stopNodes.set(l, base);
      }
    }
    // membership follows usage: strip the line from edges its rewritten
    // traversal no longer covers, so no unused lane is painted
    const used = new Set(out.map((s) => s.edgeId));
    for (const s of steps) {
      if (used.has(s.edgeId)) continue;
      h.edges.get(s.edgeId)?.lineIds.delete(l);
    }
  }

  // a station whose stops all moved off its node follows them to the base
  for (const st of h.stations.values()) {
    const base = rehome.get(st.nodeId);
    if (!base) continue;
    let anchored = false;
    for (const key of h.stopAt) {
      if (key.slice(key.indexOf('|') + 1) === st.nodeId) { anchored = true; break; }
    }
    if (!anchored) st.nodeId = base;
  }

  return spliced;
}

// ---- per-group station separation ------------------------------------------
// Distinct station groups can end up fused onto ONE drawn node. Corridors that
// genuinely converge below the merge radius put their anchor nodes within a
// couple of pixels, octi's short-edge contraction folds them into one grid
// node, and the vertex fusion above keeps them as a single mn. Drawn that way,
// two real stations become one marker and one label. Groups fused at one drawn
// node whose TRUE separation exceeds roughly the merge radius must render as
// separate markers. Closer pairs are a legitimate shared interchange capsule.
//
// Mechanism: the station closest to the drawn node keeps it; each other
// station is split onto a new node placed at the projection of its true
// position onto the adjacent drawn corridor (so the marker stays ON its
// line). The hosting edge is cut at that point; traversals, stop flags and
// the station mapping are remapped. Mutates h and img in place.

const MIN_SPLIT_ARC = 8; // px: min arc from either edge end (≈ 2 marker radii)

// A station split seated INSIDE a junction's corner fan puts its marks where
// the outer lanes have already turned off toward their meet points, and the
// stranded lane piece between the mark and the corner degenerates into a
// backward stub. The node-side split floor therefore scales with the fan's
// depth: the widest incident bundle's half width, obliquity-corrected for
// 45-degree corners, plus two lane pitches of margin.
const fanDepthAt = (h: SupportGraph, nid: string): number => {
  let maxLines = 1;
  for (const eid of h.adj.get(nid) ?? []) {
    const e = h.edges.get(eid);
    if (e && e.lineIds.size > maxLines) maxLines = e.lineIds.size;
  }
  const pitch = LINE_WIDTH + LINE_GAP;
  return ((maxLines - 1) / 2) * pitch * Math.SQRT2 + 2 * pitch;
};

export function separateFusedStations(
  h: SupportGraph,
  img: Image,
  minSep: number,
): void {
  const dist = (a: Pixel, b: Pixel) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

  const byNode = new Map<string, SupportStation[]>();
  for (const st of h.stations.values()) {
    const arr = byNode.get(st.nodeId) ?? [];
    arr.push(st);
    byNode.set(st.nodeId, arr);
  }

  let seq = 0;
  for (const [nid, sts] of byNode) {
    const withTrue = sts.filter((s) => s.truePos);
    if (withTrue.length < 2) continue;
    const nodePos = h.nodes.get(nid)?.pos;
    if (!nodePos) continue;

    // keeper = closest to the drawn node; others split off when far enough
    // from the keeper's true position
    withTrue.sort(
      (a, b) => (dist(a.truePos!, nodePos) - dist(b.truePos!, nodePos)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0), // raw compare (localeCompare is engine-dependent)
    );
    void minSep; // distinct groups ALWAYS get their own markers; capsule-ness is the group's

    // Candidate corridors for a station's true position: edges at the fused node
    // (hopping OVER ones too short to split) that CARRY one of its serving lines,
    // each with the closest projection of the true position and its arc along the
    // edge. A stop flag only renders on an edge carrying the line, so a foreign
    // corridor would make the station vanish; with no candidate the pair stays
    // fused (a shared capsule beats a disappeared station). Same side of the node
    // as the true position first, then nearest projection. Reads the CURRENT
    // geometry on each call.
    type Cand = { eid: string; segIdx: number; t: number; p: Pixel; d: number; arcFromSplit: number; arcTotal: number };
    const getCandidates = (st: SupportStation): Cand[] => {
      const serves = (e: SupportEdge): boolean => {
        const lines = st.stopLines;
        if (!lines || lines.size === 0) return true;
        for (const l of lines) if (e.lineIds.has(l)) return true;
        return false;
      };
      const candEdges = new Set<string>();
      const visited = new Set<string>([nid]);
      const frontier = [nid];
      while (frontier.length) {
        const cur = frontier.pop()!;
        for (const eid of h.adj.get(cur) ?? []) {
          const e = h.edges.get(eid);
          const pts = img.paths.get(eid) ?? e?.points;
          if (!e || !pts || pts.length < 2) continue;
          let arc = 0;
          for (let i = 1; i < pts.length; i++) arc += dist(pts[i - 1], pts[i]);
          if (arc >= 2 * MIN_SPLIT_ARC && serves(e)) {
            candEdges.add(eid);
          } else if (arc < 2 * MIN_SPLIT_ARC) {
            const other = e.from === cur ? e.to : e.from;
            if (!visited.has(other)) { visited.add(other); frontier.push(other); }
          }
        }
      }
      const cands: Cand[] = [];
      for (const eid of candEdges) {
        const e = h.edges.get(eid)!;
        const pts = img.paths.get(eid) ?? e.points;
        let arc = 0;
        const arcs: number[] = [0];
        for (let i = 1; i < pts.length; i++) { arc += dist(pts[i - 1], pts[i]); arcs.push(arc); }
        let bestOnEdge: Cand | null = null;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          const vx = b[0] - a[0];
          const vy = b[1] - a[1];
          const c2 = vx * vx + vy * vy;
          if (c2 < 1e-9) continue;
          let t = ((st.truePos![0] - a[0]) * vx + (st.truePos![1] - a[1]) * vy) / c2;
          t = Math.max(0, Math.min(1, t));
          const p: Pixel = [a[0] + vx * t, a[1] + vy * t];
          const d = dist(st.truePos!, p);
          const arcAt = arcs[i - 1] + Math.sqrt(c2) * t;
          if (bestOnEdge && d >= bestOnEdge.d) continue;
          bestOnEdge = { eid, segIdx: i - 1, t, p, d, arcFromSplit: arcAt, arcTotal: arc };
        }
        if (bestOnEdge) cands.push(bestOnEdge);
      }
      const side = (c: Cand): number => {
        const dx = st.truePos![0] - nodePos[0];
        const dy = st.truePos![1] - nodePos[1];
        return (c.p[0] - nodePos[0]) * dx + (c.p[1] - nodePos[1]) * dy > 0 ? 0 : 1;
      };
      cands.sort((x, y) => (side(x) - side(y)) || (x.d - y.d) || (x.p[0] - y.p[0]) || (x.p[1] - y.p[1])); // total tie-break by position (cross-V8 stable)
      return cands;
    };

    // Seat non-keepers FARTHEST-ALONG-THE-CORRIDOR first, keyed by the true ARC of
    // each station's projection on the ORIGINAL (unsplit) geometry. Each split
    // subdivides the keeper-incident stub, and the split-corridor BFS only reaches
    // that stub, so a nearer station projects onto the shortened stub; seating the
    // farthest first drops its split beyond the nearer ones, so every later
    // projection lands within the remaining stub at its true arc and drawn order ==
    // route order. Arc (not Euclidean distance to the keeper) is the correct key on
    // a CURVED corridor, where along-line order and straight-line distance disagree.
    // withTrue[0] is the keeper (closest to the drawn node); it stays put.
    const nonKeepers = withTrue.slice(1)
      .map((st) => ({ st, arc: getCandidates(st)[0]?.arcFromSplit ?? -Infinity }))
      .sort((a, b) => (b.arc - a.arc) || (a.st.id < b.st.id ? -1 : a.st.id > b.st.id ? 1 : 0));

    const nodeFloor = Math.max(MIN_SPLIT_ARC, fanDepthAt(h, nid));
    for (const { st } of nonKeepers) {
      const candidates = getCandidates(st);
      let best: Cand | null = null;

      // try candidates closest-first until one yields a split point with real
      // visual separation from the fused node (an edge can pass right next to
      // it mid-arc, where the end clamps don't help)
      let segIdx = 0;
      let splitP: Pixel | null = null;
      for (const cand of candidates) {
        const arc = Math.max(nodeFloor, Math.min(cand.arcTotal - MIN_SPLIT_ARC, cand.arcFromSplit));
        const pts = img.paths.get(cand.eid) ?? h.edges.get(cand.eid)!.points;
        let acc = 0;
        let sIdx = 0;
        let sT = 0;
        let sP: Pixel = pts[0];
        for (let i = 1; i < pts.length; i++) {
          const segLen = dist(pts[i - 1], pts[i]);
          if (acc + segLen >= arc || i === pts.length - 1) {
            sIdx = i - 1;
            sT = segLen > 1e-9 ? Math.min(1, Math.max(0, (arc - acc) / segLen)) : 0;
            sP = [
              pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * sT,
              pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * sT,
            ];
            break;
          }
          acc += segLen;
        }
        if (dist(sP, nodePos) < nodeFloor) continue;
        best = cand;
        segIdx = sIdx;
        splitP = sP;
        break;
      }
      if (!best || !splitP) continue;

      const e = h.edges.get(best.eid)!;
      const pts = (img.paths.get(best.eid) ?? e.points).map((p) => p.slice() as Pixel);

      const head = pts.slice(0, segIdx + 1);
      const tail = pts.slice(segIdx + 1);
      // exact split point (skip duplicating it if it coincides with a vertex)
      if (dist(head[head.length - 1], splitP) > 1e-6) head.push(splitP.slice() as Pixel);
      if (tail.length === 0 || dist(tail[0], splitP) > 1e-6) tail.unshift(splitP.slice() as Pixel);

      const newNid = `ms${seq}`;
      const idA = `${best.eid}_a${seq}`;
      const idB = `${best.eid}_b${seq}`;
      seq++;

      h.nodes.set(newNid, { id: newNid, pos: splitP.slice() as Pixel });
      img.placement.set(newNid, splitP.slice() as Pixel);

      h.edges.delete(best.eid);
      img.paths.delete(best.eid);
      h.edges.set(idA, { id: idA, from: e.from, to: newNid, points: head, lineIds: new Set(e.lineIds) });
      h.edges.set(idB, { id: idB, from: newNid, to: e.to, points: tail, lineIds: new Set(e.lineIds) });
      img.paths.set(idA, head.map((p) => p.slice() as Pixel));
      img.paths.set(idB, tail.map((p) => p.slice() as Pixel));

      const swap = (listNid: string, oldEid: string, newEid: string) => {
        const arr = h.adj.get(listNid);
        if (!arr) return;
        const i = arr.indexOf(oldEid);
        if (i >= 0) arr[i] = newEid;
        else arr.push(newEid);
      };
      swap(e.from, best.eid, idA);
      swap(e.to, best.eid, idB);
      h.adj.set(newNid, [idA, idB]);

      for (const [lineId, steps] of h.lineTraversals) {
        let touched = false;
        const out: TraversalStep[] = [];
        for (const step of steps) {
          if (step.edgeId !== best.eid) {
            out.push(step);
            continue;
          }
          touched = true;
          if (step.reversed) {
            out.push({ edgeId: idB, reversed: true }, { edgeId: idA, reversed: true });
          } else {
            out.push({ edgeId: idA, reversed: false }, { edgeId: idB, reversed: false });
          }
        }
        if (touched) h.lineTraversals.set(lineId, out);
      }

      // move the station and its stop flags; a line keeps its flag at the old
      // node only if a station remaining there is still served by it. Only
      // lines the split corridor actually CARRIES move (a flag on a node
      // with no edge of that line can never render); others keep their
      // existing per-line flag node.
      st.nodeId = newNid;
      const splitLines = h.edges.get(idA)!.lineIds;
      const movedLines = [...(st.stopLines ?? new Set<string>())].filter((l) => splitLines.has(l));
      const remaining = new Set<string>();
      for (const other of byNode.get(nid)!) {
        if (other === st || other.nodeId !== nid) continue;
        for (const l of other.stopLines ?? []) remaining.add(l);
      }
      for (const l of movedLines) {
        h.stopAt.add(l + '|' + newNid);
        if (!remaining.has(l)) h.stopAt.delete(l + '|' + nid);
        st.stopNodes?.set(l, newNid);
      }

      // Lines that STOPPED at the fused node and moved with the split must
      // also stop TRAVERSING to it: reconstruction ran before the split, so a
      // line TERMINATING here retraces through the keeper node and its drawn
      // lanes overshoot the new marker by the split distance. Remove immediate
      // out-and-back step pairs over the keeper-side half; lines genuinely
      // continuing past the keeper traverse it once and are untouched.
      const keeperHalf = e.from === nid ? idA : e.to === nid ? idB : null;
      if (keeperHalf) {
        for (const l of movedLines) {
          const steps = h.lineTraversals.get(l);
          if (!steps) continue;
          // A circular RING course "starts and ends" at the fused node only
          // because its seam sits there: the boundary steps are the course's
          // real loop-closing legs, not bare tails past a relocated terminus,
          // and trimming one opens the drawn ring. Detect the ring before any
          // edit and leave its boundary steps alone. An out-and-back course
          // also ends where it starts, but its seam retraces ONE edge (first
          // and last steps are the same edge in opposite directions); its
          // boundary steps really are turnaround tails and must keep the trim.
          const closed = (() => {
            if (steps.length < 2) return false;
            const first = steps[0];
            const last = steps[steps.length - 1];
            if (first.edgeId === last.edgeId && first.reversed !== last.reversed) return false;
            const eF = h.edges.get(first.edgeId);
            const eL = h.edges.get(last.edgeId);
            if (!eF || !eL) return false;
            const start = first.reversed ? eF.to : eF.from;
            const end = last.reversed ? eL.from : eL.to;
            return start === end;
          })();
          const out: TraversalStep[] = [];
          for (let i = 0; i < steps.length; i++) {
            const s1 = steps[i];
            const s2 = steps[i + 1];
            if (
              s2 &&
              s1.edgeId === keeperHalf &&
              s2.edgeId === keeperHalf &&
              s1.reversed !== s2.reversed
            ) {
              i++; // drop the out-and-back pair
              continue;
            }
            out.push(s1);
          }
          // routes that START or END at the old fused node leave a single
          // keeper-half step at the boundary; trim it as well (open courses
          // only: a closed course's boundary step is its loop-closing leg)
          const eH = h.edges.get(keeperHalf);
          if (!closed && eH && out.length && out[0].edgeId === keeperHalf) {
            const startNode = out[0].reversed ? eH.to : eH.from;
            if (startNode === nid) out.shift();
          }
          if (!closed && eH && out.length && out[out.length - 1].edgeId === keeperHalf) {
            const last = out[out.length - 1];
            const endNode = last.reversed ? eH.from : eH.to;
            if (endNode === nid) out.pop();
          }
          h.lineTraversals.set(l, out);
        }
      }
    }
  }
}
