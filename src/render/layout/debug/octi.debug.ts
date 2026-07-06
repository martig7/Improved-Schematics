// LOOM octi diagnostics (env-gated, dev only). Extracted from octi.ts so the
// octilinearizer keeps only the call sites. Enable with OCTI_DEBUG (ordering
// scores + local-search convergence), OCTI_BLOCKAGE (route-wander census),
// OCTI_TRACE_PATHS / OCTI_TRACE_CHAIN / OCTI_TRACE_GEO / OCTI_TRACE_CE (course
// traces). Every exported function self-gates on its env flag and reproduces
// the exact console output the inlined blocks did.
import { envStr } from '../../../env';
import { SOFT_INF, type OctiGridGraph } from '../gridGraph';
import type { Pixel, SupportEdge } from '../types';

/** OCTI_DEBUG gate — matches the original `const DBG` guard (typeof-process +
 *  envStr) so logs fire under exactly the same conditions. */
const DBG = (): boolean => typeof process !== 'undefined' && !!envStr('OCTI_DEBUG');
/** OCTI_BLOCKAGE gate — matches the original `const BLOCKAGE` guard. */
const BLOCKAGE = (): boolean => typeof process !== 'undefined' && !!envStr('OCTI_BLOCKAGE');

/** Structural view of the private Drawing class — only the members the
 *  diagnostics read (so the private class need not be exported). */
interface DrawingLike {
  nds: Map<string, number>;
  edgs: Map<string, number[]>;
  edgCosts: Map<string, number>;
  springCosts: Map<string, number>;
  vios: Map<string, number>;
  violations: number;
  score(): number;
  drawn(ceId: string): boolean;
  clone(): this;
  eraseEdgeFromGrid(ceId: string, grid: OctiGridGraph): void;
  eraseEdge(ce: SupportEdge, grid: OctiGridGraph, ctx: CtxLike): void;
  applyEdgeToGrid(ceId: string, grid: OctiGridGraph): void;
}

/** Structural view of the private CombCtx — the accessors the traces call. */
interface CtxLike {
  posOf: (nd: string) => Pixel;
  adjEdges: (nd: string) => SupportEdge[];
  circDist: (nd: string, aEdge: string, bEdge: string) => number;
}

/** OCTI_BLOCKAGE census accumulator + reporter. Lives here (not in octi.ts)
 *  because it exists only to log; octi seeds it via reset()/report() and
 *  probeDirectCourse() feeds it during the insertion loop. */
export const blockageStats = {
  routed: 0,
  wanderers: 0,
  cells: {} as Record<string, number>,
  worst: {} as Record<string, number>,
  samples: [] as string[],
  reset(): void {
    this.routed = 0;
    this.wanderers = 0;
    this.cells = {};
    this.worst = {};
    this.samples = [];
  },
  report(): void {
    if (!BLOCKAGE()) return;
    const fmt = (o: Record<string, number>): string =>
      Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    console.error(
      `[blockage] routed=${this.routed} wanderers(>1.5x)=${this.wanderers} ` +
      `worst-per-edge{ ${fmt(this.worst)} } course-cells{ ${fmt(this.cells)} }`,
    );
    for (const s of this.samples) console.error(`[blockage]   ${s}`);
  },
};

const dist = (a: Pixel, b: Pixel): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
};

/** Blockage census (OCTI_BLOCKAGE): when an edge routes at 1.5x+ its endpoint
 *  chord, walk the ideal octilinear course between the CHOSEN endpoint bases at
 *  that exact moment's grid state and classify each step. Self-gates on
 *  OCTI_BLOCKAGE; octi calls it unconditionally after drawing each edge. */
export function probeDirectCourse(
  grid: OctiGridGraph,
  ce: SupportEdge,
  res: { edges: number[]; fromBase: number; toBase: number },
): void {
  if (!BLOCKAGE()) return;
  let arc = 0;
  for (const ge of res.edges) {
    if (!grid.isGridEdge(ge)) continue;
    const [a, b] = grid.gridEdgeBases(ge);
    arc += dist(grid.basePos(a), grid.basePos(b));
  }
  const chord = dist(grid.basePos(res.fromBase), grid.basePos(res.toBase));
  blockageStats.routed++;
  if (chord < 1e-6 || arc / chord <= 1.5) return;
  blockageStats.wanderers++;
  let c = grid.baseCol(res.fromBase);
  let r = grid.baseRow(res.fromBase);
  const tc = grid.baseCol(res.toBase);
  const tr = grid.baseRow(res.toBase);
  const seen: Record<string, number> = {};
  const bump = (k: string): void => {
    seen[k] = (seen[k] ?? 0) + 1;
    blockageStats.cells[k] = (blockageStats.cells[k] ?? 0) + 1;
  };
  let guard = 0;
  while ((c !== tc || r !== tr) && guard++ < 500) {
    const sc = Math.sign(tc - c);
    const sr = Math.sign(tr - r);
    const cur = grid.baseIdx(c, r);
    const nxt = grid.baseIdx(c + sc, r + sr);
    const ge = grid.getNEdg(cur, nxt);
    bump(ge >= 0 ? grid.edgeClass(ge) : 'offgrid');
    if (grid.isClosed(nxt)) bump('closedNode');
    else if (grid.isSettledBase(nxt) && (c + sc !== tc || r + sr !== tr)) bump('settledBase');
    c += sc;
    r += sr;
  }
  const rank = ['closed', 'blocked', 'closedNode', 'soft', 'settledBase', 'cross', 'offgrid', 'free'];
  let worst = 'free';
  for (const k of rank) { if (seen[k]) { worst = k; break; } }
  blockageStats.worst[worst] = (blockageStats.worst[worst] ?? 0) + 1;
  if (blockageStats.samples.length < 12) {
    blockageStats.samples.push(
      `${ce.id} span=${chord.toFixed(0)}px ratio=${(arc / chord).toFixed(2)} worst=${worst} ` +
      `course{ ${Object.entries(seen).map(([k, v]) => `${k}:${v}`).join(' ')} }`,
    );
  }
}

/** Drawn arc length over endpoint chord for a placed support edge (1 = the
 *  route is as direct as its endpoints allow; > 1.5 = it wanders). Used by the
 *  final-state blockage census below. */
function drawnRatio(drawing: DrawingLike, ce: SupportEdge, grid: OctiGridGraph): number {
  const path = drawing.edgs.get(ce.id);
  const fb = drawing.nds.get(ce.from);
  const tb = drawing.nds.get(ce.to);
  if (!path || fb === undefined || tb === undefined) return 1;
  let arc = 0;
  for (const ge of path) {
    if (!grid.isGridEdge(ge)) continue;
    const [a, b] = grid.gridEdgeBases(ge);
    arc += dist(grid.basePos(a), grid.basePos(b));
  }
  const chord = dist(grid.basePos(fb), grid.basePos(tb));
  return chord < 1e-6 ? 1 : arc / chord;
}

/** OCTI_DEBUG: NO_CANDS diagnostic when an edge has no routable endpoint
 *  candidates. */
export function debugNoCands(
  frNd: string,
  toNd: string,
  frCands: number[],
  toCands: number[],
  deg: (nd: string) => number,
  isSettled: (nd: string) => boolean,
): void {
  if (!envStr('OCTI_DEBUG')) return;
  const why = (nd: string, cands: number[]) =>
    `${nd}(deg=${deg(nd)},settled=${isSettled(nd)},cands=${cands.length})`;
  console.error(`[octi] NO_CANDS ${why(frNd, frCands)} -> ${why(toNd, toCands)}`);
}

/** OCTI_DEBUG: drawn-level detour-cut summary (only when cuts happened). */
export function debugDetourCuts(cuts: number, cutsSub: number, cutsShort: number, cutsFold: number): void {
  if (!DBG() || !cuts) return;
  console.error(
    `[octi] drawn-level detour cuts: ${cuts} (sub-cell chord ${cutsSub}, widened shortcut ${cutsShort}, fold-cut ${cutsFold})`,
  );
}

/** OCTI_TRACE_PATHS=<x,y>: dump every final path passing within 30px of the
 *  probe point. */
export function tracePaths(paths: ReadonlyMap<string, Pixel[]>): void {
  const traceP =
    typeof process !== 'undefined'
      ? envStr('OCTI_TRACE_PATHS')
      : undefined;
  if (!traceP) return;
  const [tx, ty] = traceP.split(',').map(Number);
  for (const [id, p] of paths) {
    if (p.some((q) => (q[0] - tx) ** 2 + (q[1] - ty) ** 2 < 900)) {
      console.error(`[octi] path ${id}: ${p.map((q) => `(${q[0].toFixed(0)},${q[1].toFixed(0)})`).join(' ')}`);
    }
  }
}

/** OCTI_TRACE_CHAIN=<nodeId|x,y>: dump projection inputs/outputs for the chain
 *  containing that node. `nearestArcOn`/`pointAlong` are octi-private, passed
 *  in as callbacks. */
export function traceChain(
  eId: string,
  path: readonly Pixel[],
  L: number,
  tot: number,
  chainNodes: readonly string[],
  arcs: readonly number[],
  posOfNode: (n: string) => Pixel | undefined,
  nearestArcOn: (path: readonly Pixel[], q: Pixel) => number,
  pointAlong: (path: readonly Pixel[], target: number) => Pixel,
): void {
  const traceNd =
    typeof process !== 'undefined'
      ? envStr('OCTI_TRACE_CHAIN')
      : undefined;
  const traceHit = (() => {
    if (!traceNd) return false;
    if (traceNd.includes(',')) {
      const [tx, ty] = traceNd.split(',').map(Number);
      return chainNodes.some((n) => {
        const p = posOfNode(n);
        return p && (p[0] - tx) ** 2 + (p[1] - ty) ** 2 < 900;
      });
    }
    return chainNodes.includes(traceNd);
  })();
  if (!traceHit) return;
  console.error(`[octi] TRACE_CHAIN ${eId} L=${L.toFixed(1)} pathStart=(${path[0]}) pathEnd=(${path[path.length - 1]})`);
  console.error(`[octi]   path: ${path.map((p) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`).slice(0, 12).join(' ')}${path.length > 12 ? ' ...' : ''}`);
  for (let i = 0; i <= tot; i++) {
    const p = posOfNode(chainNodes[i]);
    const raw = p && i > 0 && i < tot ? nearestArcOn(path, p).toFixed(1) : '-';
    console.error(
      `[octi]   node[${i}] ${chainNodes[i]} true=(${p?.map((x) => x.toFixed(0))}) rawArc=${raw} arc=${arcs[i].toFixed(1)} -> (${pointAlong(path, arcs[i]).map((x) => x.toFixed(0))})`,
    );
  }
}

/** OCTI_DEBUG: per-ordering-method drawing result. */
export function debugMethod(method: string, status: string, score: number, violations: number, ms: number): void {
  if (!DBG()) return;
  console.error(
    `[octi] ${method}: ${status} score=${score.toFixed(1)} ` +
    `vios=${violations} (${ms}ms)`,
  );
}

/** OCTI_DEBUG: per-sweep local-search progress. */
export function debugSweep(iter: number, score: number, violations: number, sweepImp: number, msTotal: number): void {
  if (!DBG()) return;
  console.error(
    `[octi] locSearch sweep ${iter}: score=${score.toFixed(1)} ` +
    `vios=${violations} (imp ${sweepImp.toFixed(2)}, ${msTotal}ms total)`,
  );
}

/** OCTI_DEBUG: why the local search stopped, plus final score and per-edge
 *  violation dump. `posOf` is octi-private, passed in. */
export function debugLocalSearchStop(
  drawing: DrawingLike,
  locConverged: boolean,
  locSweeps: number,
  iters: number,
  h: { edges: Map<string, SupportEdge>; nodes: Map<string, { pos: Pixel }> },
): void {
  if (DBG())
    console.log(
      `[octi] localSearch stop: ${locConverged ? 'CONVERGED' : 'ITERS-CAP'} ` +
      `after ${locSweeps}/${iters} sweeps, residual vios=${drawing.violations}, score=${drawing.score().toFixed(1)}`,
    );

  if (DBG()) {
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
}

/** OCTI_BLOCKAGE final-state census: wander, course-detour, and loop-collapse
 *  populations in the state we actually draw. `polyArea`, `allWindows`,
 *  `allLoops` and the detour constants are octi-private, passed in. Self-gates
 *  on OCTI_BLOCKAGE; octi calls it unconditionally. */
export function blockageFinalCensus(
  drawing: DrawingLike,
  grid: OctiGridGraph,
  hEdges: readonly SupportEdge[],
  allWindows: ReadonlyArray<{ nds: string[]; ref: number }>,
  allLoops: ReadonlyArray<{ nds: string[]; target: number }>,
  polyArea: (nds: string[], posOf: (id: string) => Pixel | null) => number,
  detourFree: number,
  detourSlack: number,
): void {
  if (!BLOCKAGE()) return;
  let wander = 0;
  let total = 0;
  let worstR = 1;
  for (const ce of hEdges) {
    if (ce.from === ce.to || !drawing.drawn(ce.id)) continue;
    total++;
    const r = drawnRatio(drawing, ce, grid);
    if (r > 1.5) wander++;
    if (r > worstR) worstR = r;
  }
  console.error(`[blockage:final] wanderers=${wander} of ${total} drawn (worst ratio ${worstR.toFixed(2)})`);
  let bad = 0;
  let worstX = 0;
  const posAt = (id: string): Pixel | null => {
    const bIdx = drawing.nds.get(id);
    return bIdx === undefined ? null : grid.basePos(bIdx);
  };
  for (const w of allWindows) {
    let arc = 0;
    let ok = true;
    let pPrev: Pixel | null = null;
    for (const m of w.nds) {
      const p = posAt(m);
      if (!p) { ok = false; break; }
      if (pPrev) arc += dist(pPrev, p);
      pPrev = p;
    }
    if (!ok || arc < 1e-6) continue;
    const a = posAt(w.nds[0])!;
    const b = posAt(w.nds[w.nds.length - 1])!;
    const chord = Math.max(dist(a, b), grid.cellSize / 2);
    const excess = arc / chord - Math.max(w.ref + detourSlack, detourFree);
    if (excess > 0) { bad++; if (excess > worstX) worstX = excess; }
  }
  console.error(`[blockage:course] detour windows=${bad} of ${allWindows.length} (worst excess ${worstX.toFixed(2)})`);
  let collapsed = 0;
  let worstFrac = 1;
  for (const lc of allLoops) {
    const drawn = polyArea(lc.nds, posAt);
    const frac = drawn / lc.target;
    if (frac < 0.5) collapsed++;
    if (frac < worstFrac) worstFrac = frac;
  }
  console.error(`[blockage:loop] collapsed loops=${collapsed} of ${allLoops.length} (worst frac ${worstFrac.toFixed(2)})`);
}

/** OCTI_TRACE_GEO=1 (+ OCTI_TRACE_CE=<id,...>): per comb edge, the geographic-
 *  course penalty actually paid and how far the final path strays, plus a deep
 *  grid-occupancy / ordering / re-route audit for named edges. Reaches into the
 *  private Drawing/CombCtx and re-invokes the private drawOrder — all passed in
 *  as arguments/callbacks. Self-gates on OCTI_TRACE_GEO. */
export function traceGeo<D extends DrawingLike, C extends CtxLike>(
  drawing: D,
  grid: OctiGridGraph,
  ctx: C,
  h: { edges: Map<string, SupportEdge>; nodes: Map<string, { pos: Pixel }> },
  geoAffinity: number,
  polyLen: (p: readonly Pixel[]) => number,
  drawOrder: (
    order: readonly SupportEdge[],
    preSettled: ReadonlyMap<string, number>,
    grid: OctiGridGraph,
    drawing: D,
    globCutoff: number,
    ctx: C,
  ) => string,
): void {
  if (!envStr('OCTI_TRACE_GEO')) return;
  const geoW = geoAffinity ?? 0;
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
  // course in the final state, the would-be faithful corridor's residents.
  const traceCe = envStr('OCTI_TRACE_CE');
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

    // Rip the edge up and re-route it under the FINAL constraints. If this
    // finds a cheaper path, the local-search edge sweep would have fixed it
    // and simply never got the chance.
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

function pointToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.sqrt((p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2);
  const t = c1 / c2;
  return Math.sqrt((p[0] - (a[0] + t * vx)) ** 2 + (p[1] - (a[1] + t * vy)) ** 2);
}
