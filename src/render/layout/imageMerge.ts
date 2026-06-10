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
 *  slice points) — then vertex-pair segment keys never align and the shared
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

  // ---- pass 1: vertex/segment inventory -----------------------------------
  const vPos = new Map<string, Pixel>();
  const edgeVerts = new Map<string, string[]>(); // edge -> vertex keys (from→to)
  const segOwners = new Map<string, Set<string>>();

  for (const e of h.edges.values()) {
    const rawPath = img.paths.get(e.id);
    if (!rawPath || rawPath.length < 2) {
      edgeVerts.set(e.id, []);
      continue;
    }
    const path = splitAtLattice(rawPath, lattice);
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
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) { bestD = d; best = nid; }
    }
    return best;
  };

  const stations = new Map<string, SupportStation>();
  for (const [gid, st] of h.stations) {
    const nid = mapOldNode(st.nodeId);
    if (nid) stations.set(gid, { ...st, nodeId: nid });
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
