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

import type { SupportGraph, SupportNode, SupportEdge, Pixel, TraversalStep } from './types';

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

/** maxBundle(n) = the biggest welded trunk through n: the max over the node's
 *  EXTERNAL incident edges of edge.lineIds.size. A big maxBundle is the signal
 *  that a single coincident trunk carries many lines that want to fan out. */
function maxBundle(h: SupportGraph, nodeId: string): number {
  let m = 0;
  for (const eid of h.adj.get(nodeId) ?? []) {
    const e = h.edges.get(eid);
    if (!e || e.splitInternal) continue;
    if (e.lineIds.size > m) m = e.lineIds.size;
  }
  return m;
}

/** directionality(n) = number of DISTINCT exit bearings across the node's
 *  EXTERNAL incident edges, so two near-collinear arms count as ONE direction.
 *  This separates a genuine fan-out (deg-3+ with distinct bearings) from a
 *  2-way pass-through (two opposite arms = 1 axis) or a near-straight trunk
 *  whose arms happen to be split into >2 collinear edges. Bearings within
 *  `tolDeg` of each other (same OR opposite, since a pass-through is one axis)
 *  collapse to a single direction. Returns the distinct-axis count (0 if no
 *  external edges); a 2-way pass-through and a T/4-way cross both score low. */
function directionality(h: SupportGraph, nodeId: string, step: number, tolDeg: number): number {
  const angs: number[] = [];
  for (const eid of h.adj.get(nodeId) ?? []) {
    const e = h.edges.get(eid);
    if (!e || e.splitInternal) continue;
    const dir = exitDir(h, e, nodeId, step);
    // axis angle in [0, 180): collinear OR opposite arms collapse to one axis.
    let a = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
    a = ((a % 180) + 180) % 180;
    angs.push(a);
  }
  if (angs.length === 0) return 0;
  angs.sort((x, y) => x - y);
  // Count clusters of axis-angles separated by > tolDeg, wrapping at 180.
  let clusters = 1;
  for (let i = 1; i < angs.length; i++) {
    if (angs[i] - angs[i - 1] > tolDeg) clusters++;
  }
  // wrap-around: first and last in the same cluster if within tol across 180.
  if (clusters > 1 && angs.length > 1) {
    const wrap = angs[0] + 180 - angs[angs.length - 1];
    if (wrap <= tolDeg) clusters--;
  }
  return clusters;
}

interface SplitOpts {
  dirMin: number;
  bundleMin: number;
  ldegRecurse: number; // recursion density floor: keep cutting a leaf while ldeg > this
  tolDeg: number; // bearing tolerance for distinct-direction clustering
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
  const dir = directionality(h, nodeId, opts.step, opts.tolDeg);
  const mb = maxBundle(h, nodeId);
  // Recursion bound — DECOUPLED from the candidate filter. Which hubs we START
  // on is (dir >= DIRMIN AND maxBundle >= BUNDLEMIN); but once a chosen hub's
  // trunk is broken into sub-BUNDLEMIN pieces, its leaf can still carry many
  // lines and must keep splitting to seat as a clean capsule segment. So recurse
  // while the leaf is STILL too dense (ldeg > LDEG_RECURSE, default 6 — the
  // design's LDEG_CAP); stop otherwise. (Gating recursion on maxBundle instead
  // halts after one cut and loses the densest hub's needed 2nd cut.) Plus the
  // existing leaf-budget / depth / too-small (deg < 3) backstops.
  if (
    ld <= opts.ldegRecurse ||
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

  // RECURSIVE-SPLIT FIX (contiguity): a line that arrives at THIS leaf via an
  // INHERITED parent spine/fan edge (splitInternal) and then leaves via a single
  // onward external arm has only ONE external arm here. That arm lands wholly on
  // one partition side, so the line is in plusLines XOR minusLines, never the
  // intersection — and the new spine would drop it, breaking the through-line
  // exactly at this cut. The inherited splitInternal edges all stay on the + leaf
  // (plusAdj keeps every non-minus edge), so they are a + side feed. Fold their
  // lines into plusLines: a line crossing the cut (inherited-feed on +, external
  // arm on −, or vice-versa) then lands in the intersection and rides the spine.
  for (const eid of plusAdj) {
    const e = h.edges.get(eid);
    if (!e || !e.splitInternal) continue;
    for (const l of e.lineIds) plusLines.add(l);
  }

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

  // TRAVERSAL STITCH (drawn-contiguity, 2026-06): the support-graph surgery
  // above rehomes the − side's external arms onto the minus leaf and adds the
  // spine, but it does NOT touch lineTraversals — those were built before the
  // split and still hop a through-line directly from its + arm (ending at
  // plusId) to its − arm (starting at minus.id) with NO step on the spine. The
  // renderer draws/bridges strictly along the traversal (drawsOn / connector
  // pass are keyed off it, and the connector pass refuses to bridge two lanes
  // that meet at DIFFERENT nodes via `endA !== startB`), so the spine lane is
  // never drawn and the two arm lanes dead-end ~half a cell apart in open
  // space — the visible dangling stub (Stratford mn34/mn35, Poplar). Fix: walk
  // each spine line's traversal and, at every point where it steps directly
  // between the two leaves (endpoint plusId ↔ minus.id, in either order),
  // SPLICE the spine step in. Now the traversal reads arm→spine→arm, the spine
  // lane is drawn, and consecutive lanes meet at the same node so the connector
  // pass bridges them. Done in splitHubs (not the renderer) because this is the
  // missing graph-traversal step, not a render-layer artifact.
  if (spineLines.size > 0 && env('OCTI_NO_STITCH') !== '1') {
    const endOf = (st: TraversalStep): string | undefined => {
      const e = h.edges.get(st.edgeId);
      if (!e) return undefined;
      return st.reversed ? e.from : e.to;
    };
    const startOf = (st: TraversalStep): string | undefined => {
      const e = h.edges.get(st.edgeId);
      if (!e) return undefined;
      return st.reversed ? e.to : e.from;
    };
    for (const lineId of spineLines) {
      const trav = h.lineTraversals.get(lineId);
      if (!trav || trav.length < 2) continue;
      const out: TraversalStep[] = [trav[0]];
      for (let i = 1; i < trav.length; i++) {
        const prev = trav[i - 1];
        const cur = trav[i];
        const a = endOf(prev);
        const b = startOf(cur);
        // crosses the cut between the two leaves, and is not already on the spine
        const crosses =
          (a === plusId && b === minus.id) || (a === minus.id && b === plusId);
        if (crosses && prev.edgeId !== spine.id && cur.edgeId !== spine.id) {
          out.push({ edgeId: spine.id, reversed: a === minus.id });
        }
        out.push(cur);
      }
      if (out.length !== trav.length) h.lineTraversals.set(lineId, out);
    }
  }

  if (DBG()) {
    // eslint-disable-next-line no-console
    console.error(
      `[splitHubs] split ${nodeId} @(${node.pos[0].toFixed(0)},${node.pos[1].toFixed(0)}) (deg=${d} ldeg=${ld} dir=${dir} maxBundle=${mb}) -> +[${plusEdges.length}e/${plusLines.size}l] -[${minusEdges.length}e/${minusLines.size}l] spine=${spineLines.size}`,
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
    dirMin: numEnv('OCTI_SPLIT_DIRMIN', 3),
    bundleMin: numEnv('OCTI_SPLIT_BUNDLEMIN', 5),
    ldegRecurse: numEnv('OCTI_SPLIT_LDEG_RECURSE', 6),
    tolDeg: numEnv('OCTI_SPLIT_DIRTOL', 20),
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

  // Candidate predicate (Phase-1): a hub qualifies ONLY if it is BOTH a real
  // fan-out (directionality >= DIRMIN, default 3 — excludes 2-way pass-throughs)
  // AND has a big welded trunk (maxBundle >= BUNDLEMIN, default 5). Both
  // required (AND). This excludes fat-but-straight trunks (low directionality)
  // and thin high-deg junctions (small maxBundle) — the wrong hubs whose leaves
  // crowded each other when the old deg/ldeg predicate split them blindly.
  const candidates = [...h.nodes.keys()].filter((id) => {
    const dir = directionality(h, id, opts.step, opts.tolDeg);
    const mb = maxBundle(h, id);
    return dir >= opts.dirMin && mb >= opts.bundleMin;
  });
  // densest line-occupancy first (preserves Phase-0 hub selection so the cap=1
  // default still picks the genuine fan-fold trunk / Liverpool St), then biggest
  // welded trunk, then id for determinism.
  candidates.sort(
    (a, b) =>
      (ldeg(h, b) - ldeg(h, a)) ||
      (maxBundle(h, b) - maxBundle(h, a)) ||
      (a < b ? -1 : 1),
  );

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

  // PHASE-2 DENSITY-AWARE THROTTLE (neighbor-crowding guard).
  // Splitting a hub fans its lines out into two leaves offset ±perp·offset. If a
  // NEAR-NEIGHBOUR hub is also split, the two splits' leaves land in adjacent
  // grid cells; octi cannot seat them apart and a NEW pinched/coincident box
  // appears at (or beside) the neighbour (uncapped London: Farringdon /
  // Canada Water beside the King's-Cross / Whitechapel splits). The throttle
  // walks candidates DENSEST-FIRST (so the most-deserving hub always wins) and
  // SKIPS a candidate whose origin sits within minSep of an ALREADY-COMMITTED
  // split hub: only the denser of two close hubs splits. minSep is expressed as
  // a multiple of the leaf offset (OCTI_SPLIT_MINSEP, the leaf-spread scale), so
  // it tracks the actual crowding radius regardless of network/zoom.
  //   minSep = OCTI_SPLIT_MINSEP * opts.offset   (0 disables the throttle)
  // The guard is INERT at cap=1 (one split → no prior committed hub to clear) and
  // when the flag is off (splitHubs returns early), so both the shipped default
  // and the cap=1 path stay byte-identical regardless of this factor.
  // Default factor 5 was tuned by sweep on uncapped London (OCTI_WARP=1.6): it is
  // the value that drives uncapped to ZERO new boxes vs flag-off (only Whitechapel
  // stays boxed, as it is flag-off too), keeping the King's-Cross + Ealing-Broadway
  // resolutions and the Whitechapel de-weld. NOTE the box count is highly reflow-
  // sensitive to this factor (4.5→13 boxes, 5.0→1 box, 5.5→8): factor 5 is an
  // isolated optimum, NOT a robust plateau — see the report. It only matters on the
  // multi-hub path; raise/override OCTI_SPLIT_MINSEP for further sweeps.
  const minSepFactor = (() => {
    const raw = env('OCTI_SPLIT_MINSEP');
    if (raw === undefined || raw === '') return 5; // sweep-tuned default; inert at cap=1
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  })();
  const minSep = minSepFactor * opts.offset;
  const committed: Pixel[] = []; // origin positions of hubs we've already split

  let splits = 0;
  let throttled = 0;
  for (const nodeId of candidates) {
    if (splits >= limit) break;
    // node may have been consumed/renamed by a prior split (it can't — we never
    // delete the hub node, only reattach its edges), but its degree may have
    // changed if it was a leaf of another hub. Re-check.
    if (!h.nodes.get(nodeId)) continue;
    const dir = directionality(h, nodeId, opts.step, opts.tolDeg);
    const mb = maxBundle(h, nodeId);
    if (!(dir >= opts.dirMin && mb >= opts.bundleMin)) continue;

    // Neighbor-crowding throttle: defer this split if a denser hub already split
    // close by (its leaves would otherwise crowd this neighbour into a new box).
    if (minSep > 0) {
      const node = h.nodes.get(nodeId)!;
      let tooClose = false;
      for (const c of committed) {
        if (dist(node.pos, c) < minSep) { tooClose = true; break; }
      }
      if (tooClose) {
        throttled++;
        if (DBG()) {
          // eslint-disable-next-line no-console
          console.error(
            `[splitHubs] THROTTLE skip ${nodeId} @(${h.nodes.get(nodeId)!.pos[0].toFixed(0)},${h.nodes.get(nodeId)!.pos[1].toFixed(0)}) ldeg=${ldeg(h, nodeId)} (within ${minSep.toFixed(1)}px of a committed split)`,
          );
        }
        continue;
      }
    }

    const originId = stationByNode.get(nodeId) ?? nodeId;
    const splitPos: Pixel = h.nodes.get(nodeId)!.pos.slice() as Pixel;
    const leaves = new Set<string>();
    splitNode(h, nodeId, originId, opts, 0, leaves);
    if (leaves.size < 2) continue; // no progress

    committed.push(splitPos);
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
    console.error(`[splitHubs] split ${splits} hub(s) of ${candidates.length} candidate(s); throttled ${throttled} (minSep=${minSep.toFixed(1)}px, offset=${opts.offset.toFixed(1)})`);
  }
  return h;
}
