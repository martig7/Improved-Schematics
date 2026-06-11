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

// ---- per-group station separation ------------------------------------------
// Distinct station groups can end up fused onto ONE drawn node: corridors that
// genuinely converge below the merge radius put their anchor nodes within a
// couple of pixels, octi's short-edge contraction folds them into one grid
// node, and the vertex fusion above keeps them as a single mn. Drawn that way,
// two real stations become one marker and one label. Rule (user-agreed):
// groups fused at one drawn node whose TRUE separation exceeds ~the merge
// radius must render as separate markers; closer pairs are a legitimate
// shared interchange capsule (e.g. Union Av + Cedar St at 10px).
//
// Mechanism: the station closest to the drawn node keeps it; each other
// station is split onto a new node placed at the projection of its true
// position onto the adjacent drawn corridor (so the marker stays ON its
// line). The hosting edge is cut at that point; traversals, stop flags and
// the station mapping are remapped. Mutates h and img in place.

const MIN_SPLIT_ARC = 8; // px: min arc from either edge end (≈ 2 marker radii)

export function separateFusedStations(
  h: SupportGraph,
  img: Image,
  minSep: number,
): void {
  const dist = (a: Pixel, b: Pixel) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
      (a, b) => dist(a.truePos!, nodePos) - dist(b.truePos!, nodePos) || a.id.localeCompare(b.id),
    );
    const keeper = withTrue[0];

    for (const st of withTrue.slice(1)) {
      if (dist(st.truePos!, keeper.truePos!) <= minSep) continue;

      // best projection of the true position onto the adjacent drawn edges
      let best: {
        eid: string;
        segIdx: number;
        t: number;
        p: Pixel;
        d: number;
        arcFromSplit: number;
        arcTotal: number;
      } | null = null;
      // Candidate edges: those at the node, HOPPING OVER edges too short to
      // split (a 9px hop to an adjacent junction must not win "best" and then
      // bail — the true position usually projects cleanly onto the corridor
      // just past it; Lake Av sits beyond the 83 Av junction 9px away).
      // A candidate must CARRY one of the station's serving lines: the stop
      // flag only renders on an edge that carries the line, so splitting onto
      // a foreign corridor makes the station vanish entirely (no marker, no
      // label). With no valid candidate the pair stays fused — a shared
      // capsule beats a disappeared station.
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
            // too short to split: hop across it and consider the far side
            const other = e.from === cur ? e.to : e.from;
            if (!visited.has(other)) {
              visited.add(other);
              frontier.push(other);
            }
          }
        }
      }
      const candidates: Array<NonNullable<typeof best>> = [];
      for (const eid of candEdges) {
        const e = h.edges.get(eid)!;
        const pts = img.paths.get(eid) ?? e.points;
        let arc = 0;
        const arcs: number[] = [0];
        for (let i = 1; i < pts.length; i++) {
          arc += dist(pts[i - 1], pts[i]);
          arcs.push(arc);
        }
        let bestOnEdge: NonNullable<typeof best> | null = null;
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
        if (bestOnEdge) candidates.push(bestOnEdge);
      }
      // same-side candidates first (the marker should sit on the side of the
      // node its true position lies on), then by projection distance
      const side = (c: (typeof candidates)[number]): number => {
        const dx = st.truePos![0] - nodePos[0];
        const dy = st.truePos![1] - nodePos[1];
        return (c.p[0] - nodePos[0]) * dx + (c.p[1] - nodePos[1]) * dy > 0 ? 0 : 1;
      };
      candidates.sort((x, y) => side(x) - side(y) || x.d - y.d);

      // try candidates closest-first until one yields a split point with real
      // visual separation from the fused node (an edge can pass right next to
      // it mid-arc, where the end clamps don't help)
      let segIdx = 0;
      let splitP: Pixel | null = null;
      for (const cand of candidates) {
        const arc = Math.max(MIN_SPLIT_ARC, Math.min(cand.arcTotal - MIN_SPLIT_ARC, cand.arcFromSplit));
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
        if (dist(sP, nodePos) < MIN_SPLIT_ARC) continue;
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
      // node only if a station remaining there is still served by it
      st.nodeId = newNid;
      const movedLines = st.stopLines ?? new Set<string>();
      const remaining = new Set<string>();
      for (const other of byNode.get(nid)!) {
        if (other === st || other.nodeId !== nid) continue;
        for (const l of other.stopLines ?? []) remaining.add(l);
      }
      for (const l of movedLines) {
        h.stopAt.add(l + '|' + newNid);
        if (!remaining.has(l)) h.stopAt.delete(l + '|' + nid);
      }
    }
  }
}
