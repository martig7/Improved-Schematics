// Hub split (spec 2026-06-14-hub-split-capsule-design §3, Phase 0).
//
// A VIRTUAL split of a high-degree support-graph hub. The station stays ONE
// station (one capsule, one interchange identity); only the LAYOUT graph
// pretends to split it into sub-nodes so an over-bundled trunk's lines can
// DEPART in their distinct exit directions instead of all fanning off one
// coincident point. A capsule (renderOctilinear, C3) reunites the leaves via
// the station's splitNodeIds, so it still reads as a single place.
//
// Recursive, binary, perpendicular to the dominant (heaviest line-weight) axis.
// hubLocalOrder sorts the through-lines by exit bearing projected onto
// perp(dominant) so the partition is planar. Fan edges H->nPlus / H->nMinus and
// a spine edge nPlus--nMinus are tagged splitInternal; sub-nodes carry
// splitGroup = the origin/station id. Guards in octi.combineDeg2 /
// octi.contractShortEdges / imageMerge preserve the tagged structure.
//
// Gated behind OCTI_SPLIT_HUBS; default off => byte-identical to baseline.

import type { SupportGraph, SupportNode, SupportEdge, Pixel } from './types';

const env = (k: string): string | undefined =>
  typeof process !== 'undefined'
    ? (process as { env?: Record<string, string> }).env?.[k]
    : undefined;

const enabled = (): boolean => env('OCTI_SPLIT_HUBS') === '1';

const numEnv = (k: string, def: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && v > 0 ? v : def;
};

const DBG = (): boolean => env('OCTI_SPLIT_DEBUG') === '1';

function dist(a: Pixel, b: Pixel): number {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Direction (unit vector) with which edge e leaves node nodeId, measured a
 *  little way along the polyline so micro-wiggles at the junction don't flip
 *  the bearing (mirrors octi's grid-cell tangent rationale). */
function exitDir(h: SupportGraph, e: SupportEdge, nodeId: string, step: number): Pixel {
  const pts = e.from === nodeId ? e.points : [...e.points].reverse();
  const a = pts[0];
  let ref: Pixel = pts[pts.length - 1] ?? a;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (acc >= step) { ref = pts[i]; break; }
  }
  const dx = ref[0] - a[0], dy = ref[1] - a[1];
  const m = Math.hypot(dx, dy);
  return m > 1e-9 ? [dx / m, dy / m] : [1, 0];
}

/** ldeg(n) = total line-occupancy across EXTERNAL incident edges. Internal
 *  fan/spine edges are excluded: they re-carry the side's lines and would make
 *  a leaf's ldeg never fall below the original hub's (runaway recursion). */
function ldeg(h: SupportGraph, nodeId: string): number {
  let n = 0;
  for (const eid of h.adj.get(nodeId) ?? []) {
    const e = h.edges.get(eid);
    if (!e || e.splitInternal) continue;
    n += e.lineIds.size;
  }
  return n;
}

/** deg(n) = number of EXTERNAL incident edges (excludes fan/spine). */
function deg(h: SupportGraph, nodeId: string): number {
  let n = 0;
  for (const eid of h.adj.get(nodeId) ?? []) {
    const e = h.edges.get(eid);
    if (!e || e.splitInternal) continue;
    n++;
  }
  return n;
}

interface SplitOpts {
  degCap: number;
  ldegCap: number;
  offset: number;
  step: number; // tangent step for exit bearings (~1 cell)
  maxLeaves: number;
}

/**
 * Split one hub `nodeId` once (binary, perpendicular), then recurse on the two
 * sub-nodes. originId is the station-group id (or the original node id) shared
 * by every leaf as `splitGroup`. Mutates h. Returns the leaf ids it produced
 * (so the caller can record them on the station).
 */
function splitNode(
  h: SupportGraph,
  nodeId: string,
  originId: string,
  opts: SplitOpts,
  depth: number,
  leaves: Set<string>,
): void {
  const node = h.nodes.get(nodeId);
  if (!node) { leaves.add(nodeId); return; }

  const d = deg(h, nodeId);
  const ld = ldeg(h, nodeId);
  // Recursion bound: stop once both caps satisfied, or we'd exceed the leaf
  // budget / depth, or the node is too small to cut. Depth cap is a hard
  // backstop against any non-progressing partition.
  if (
    (d <= opts.degCap && ld <= opts.ldegCap) ||
    leaves.size >= opts.maxLeaves ||
    depth >= opts.maxLeaves ||
    d < 3
  ) {
    leaves.add(nodeId);
    return;
  }

  // Only EXTERNAL edges are partitioned; the fan/spine edges added by a parent
  // split stay attached to this leaf and are never re-cut.
  const incident = (h.adj.get(nodeId) ?? [])
    .map((id) => h.edges.get(id)!)
    .filter((e): e is SupportEdge => !!e && !e.splitInternal);
  if (incident.length < 3) { leaves.add(nodeId); return; }

  // --- dominant axis A = heaviest line-weight bearing direction -------------
  // Sum doubled-angle unit vectors weighted by line count: gives an axis (mod
  // 180 deg), not a direction, so two opposite trunk arms reinforce.
  let mx = 0, my = 0;
  const dirs = new Map<string, Pixel>();
  for (const e of incident) {
    const dir = exitDir(h, e, nodeId, opts.step);
    dirs.set(e.id, dir);
    const th = Math.atan2(dir[1], dir[0]);
    const w = e.lineIds.size;
    mx += Math.cos(2 * th) * w;
    my += Math.sin(2 * th) * w;
  }
  const axisAng = Math.atan2(my, mx) / 2;
  const A: Pixel = [Math.cos(axisAng), Math.sin(axisAng)];
  const perp: Pixel = [-Math.sin(axisAng), Math.cos(axisAng)];

  // --- hubLocalOrder: sort edges by exit bearing projected onto perp(A) -----
  // An edge near-parallel to A is the trunk side; off-axis edges sort by their
  // signed projection onto perp so the partition is planar (top lines -> +,
  // bottom -> -). Tie-break by id for cross-V8 determinism.
  const proj = (e: SupportEdge): number => {
    const dir = dirs.get(e.id)!;
    return dir[0] * perp[0] + dir[1] * perp[1];
  };
  const ordered = incident.slice().sort((a, b) => (proj(a) - proj(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 1));

  // Partition at the line-weight midpoint (not the count midpoint): balances
  // the bundle so each side carries ~half the lines (the user's 4/5).
  const total = incident.reduce((s, e) => s + e.lineIds.size, 0);
  let acc = 0;
  let cut = 0;
  for (let i = 0; i < ordered.length; i++) {
    acc += ordered[i].lineIds.size;
    if (acc >= total / 2) { cut = i + 1; break; }
  }
  // Guard against a degenerate all-on-one-side partition (no progress).
  if (cut <= 0 || cut >= ordered.length) {
    leaves.add(nodeId);
    return;
  }
  const minusEdges = ordered.slice(0, cut); // -perp side
  const plusEdges = ordered.slice(cut);     // +perp side

  // --- materialize the split: REUSE the hub node as the + leaf, add a − leaf --
  // Reusing nodeId for one side avoids a floating degree-2 fork point (which
  // octi cannot place — sub-cell wedged between two coincident leaves → NO_CANDS).
  // The two leaves are offset ±0.5·perp(A) so octi seeds them in distinct cells;
  // the spine +--− is their cross-platform link and the capsule axis (⟂ A).
  const O = opts.offset;
  const plusId = nodeId; // the retained node keeps its station/anchor identity
  const minus: SupportNode = {
    id: nodeId + '_sp-' + depth,
    pos: [node.pos[0] - perp[0] * O, node.pos[1] - perp[1] * O],
    splitGroup: originId,
  };
  // shift the retained node to the + side and tag it as a split leaf
  node.pos = [node.pos[0] + perp[0] * O, node.pos[1] + perp[1] * O];
  node.splitGroup = originId;
  h.nodes.set(minus.id, minus);
  h.adj.set(minus.id, []);

  // When a line that stopped AT the hub moves to the − leaf, its stop flag must
  // follow (the + leaf keeps nodeId, so its flags are already correct).
  const homedLines = new Set<string>();
  const rehomeStop = (lineId: string) => {
    if (homedLines.has(lineId)) return;
    const oldKey = lineId + '|' + nodeId;
    if (h.stopAt.has(oldKey)) {
      h.stopAt.delete(oldKey);
      h.stopAt.add(lineId + '|' + minus.id);
      homedLines.add(lineId);
    }
    for (const st of h.stations.values()) {
      if (st.stopNodes?.get(lineId) === nodeId) st.stopNodes.set(lineId, minus.id);
    }
  };
  // Move the − side's external edges off nodeId onto the minus leaf.
  const minusSet = new Set(minusEdges.map((e) => e.id));
  for (const e of minusEdges) {
    if (e.from === nodeId) { e.from = minus.id; e.points[0] = minus.pos.slice() as Pixel; }
    if (e.to === nodeId) { e.to = minus.id; e.points[e.points.length - 1] = minus.pos.slice() as Pixel; }
    h.adj.get(minus.id)!.push(e.id);
    for (const l of e.lineIds) rehomeStop(l);
  }
  // The + leaf keeps the plus edges + any pre-existing splitInternal edges.
  const plusAdj = (h.adj.get(plusId) ?? []).filter((id) => !minusSet.has(id));
  h.adj.set(plusId, plusAdj);
  // nudge the + side's external edge endpoints to the shifted node position
  for (const e of plusEdges) {
    if (e.from === plusId) e.points[0] = node.pos.slice() as Pixel;
    if (e.to === plusId) e.points[e.points.length - 1] = node.pos.slice() as Pixel;
  }

  const plusLines = new Set<string>();
  const minusLines = new Set<string>();
  for (const e of plusEdges) for (const l of e.lineIds) plusLines.add(l);
  for (const e of minusEdges) for (const l of e.lineIds) minusLines.add(l);

  // Spine edge +--− (the capsule axis). Carries the through-lines shared by both
  // sides; splitInternal so the guards never contract or merge it away.
  const spineLines = new Set<string>();
  for (const l of plusLines) if (minusLines.has(l)) spineLines.add(l);
  const spine: SupportEdge = {
    id: nodeId + '_spine' + depth,
    from: plusId, to: minus.id,
    points: [node.pos.slice() as Pixel, minus.pos.slice() as Pixel],
    lineIds: spineLines, splitInternal: true,
  };
  h.edges.set(spine.id, spine);
  h.adj.get(plusId)!.push(spine.id);
  h.adj.get(minus.id)!.push(spine.id);

  if (DBG()) {
    // eslint-disable-next-line no-console
    console.error(
      `[splitHubs] split ${nodeId} (deg=${d} ldeg=${ld}) -> +[${plusEdges.length}e/${plusLines.size}l] -[${minusEdges.length}e/${minusLines.size}l] spine=${spineLines.size}`,
    );
  }

  // Recurse on each side (perpendicular to ITS dominant axis next time).
  splitNode(h, plusId, originId, opts, depth + 1, leaves);
  splitNode(h, minus.id, originId, opts, depth + 1, leaves);
}

/**
 * Split high-degree hubs in the support graph. Behind OCTI_SPLIT_HUBS.
 * Mutates and returns h for chaining. Records each split station's leaf ids in
 * station.splitNodeIds (C3 capsule reunite).
 */
export function splitHubs(h: SupportGraph): SupportGraph {
  if (!enabled()) return h;

  const opts: SplitOpts = {
    degCap: numEnv('OCTI_SPLIT_DEGCAP', 5),
    ldegCap: numEnv('OCTI_SPLIT_LDEGCAP', 6),
    offset: numEnv('OCTI_SPLIT_OFFSET', 0),
    step: 0,
    maxLeaves: numEnv('OCTI_SPLIT_MAXLEAVES', 8),
  };
  // Seed geometry-derived defaults from the median edge length if not overridden.
  if (opts.offset === 0) {
    // ~0.5 cell. We don't have the grid cell here; estimate from median edge.
    const lens: number[] = [];
    for (const e of h.edges.values()) {
      let t = 0;
      for (let i = 1; i < e.points.length; i++) t += dist(e.points[i - 1], e.points[i]);
      lens.push(t);
    }
    lens.sort((a, b) => a - b);
    const med = lens.length ? lens[lens.length >> 1] : 100;
    // ~0.5 cell: cell ≈ med/1.4, so med/3 seeds the leaves about half a cell
    // apart — enough for octi to snap them to adjacent grid cells.
    opts.offset = Math.max(6, med / 3);
  }
  opts.step = Math.max(opts.offset * 2, 40); // tangent measured ~1 cell out

  // station-bearing nodes first; split largest line-degree first.
  const stationByNode = new Map<string, string>(); // nodeId -> station group id
  for (const st of h.stations.values()) stationByNode.set(st.nodeId, st.id);

  const candidates = [...h.nodes.keys()].filter((id) => {
    const d = deg(h, id);
    const ld = ldeg(h, id);
    return d > opts.degCap || ld > opts.ldegCap;
  });
  candidates.sort((a, b) => (ldeg(h, b) - ldeg(h, a)) || (a < b ? -1 : 1));

  // Cap on how many hubs to split, densest-first. Default 1 (Phase-0
  // conservatism): on dense networks (London) splitting many ADJACENT dense
  // hubs makes their offset leaves crowd each other's grid cells, which octi
  // can't seat — regressing the box count. Splitting only the single densest
  // over-bundled trunk resolves the worst hub (mn198) with a net box-count
  // improvement on both London (6/3 → 4/2) and Chicago (2/1 → 1/0). Raise
  // OCTI_SPLIT_MAXHUBS for sweeps; 0 = unlimited (Phase-2 will replace this
  // with density-aware throttling so non-adjacent dense hubs all split).
  const maxHubsRaw = env('OCTI_SPLIT_MAXHUBS');
  const maxHubs = Number(maxHubsRaw);
  const limit =
    maxHubsRaw === undefined || maxHubsRaw === ''
      ? 1
      : Number.isFinite(maxHubs) && maxHubs > 0
        ? maxHubs
        : Infinity;

  let splits = 0;
  for (const nodeId of candidates) {
    if (splits >= limit) break;
    // node may have been consumed/renamed by a prior split (it can't — we never
    // delete the hub node, only reattach its edges), but its degree may have
    // changed if it was a leaf of another hub. Re-check.
    if (!h.nodes.get(nodeId)) continue;
    const d = deg(h, nodeId);
    const ld = ldeg(h, nodeId);
    if (d <= opts.degCap && ld <= opts.ldegCap) continue;

    const originId = stationByNode.get(nodeId) ?? nodeId;
    const leaves = new Set<string>();
    splitNode(h, nodeId, originId, opts, 0, leaves);
    if (leaves.size < 2) continue; // no progress

    splits++;
    // C3: record the leaves on the station so the capsule spans the group.
    if (stationByNode.has(nodeId)) {
      for (const st of h.stations.values()) {
        if (st.nodeId !== nodeId) continue;
        st.splitNodeIds = [...leaves];
        // keep nodeId as the primary anchor (one of the leaves) for back-compat
        st.nodeId = [...leaves][0];
      }
    }
  }

  if (DBG()) {
    // eslint-disable-next-line no-console
    console.error(`[splitHubs] split ${splits} hub(s) of ${candidates.length} candidate(s)`);
  }
  return h;
}
