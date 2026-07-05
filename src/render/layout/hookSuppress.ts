// Suppress zero-progress synthetic hooks (LON pink-triangle / hairpin fix).
//
// After supportToLayout + the spur-step cleanup, the topo merge can route a
// line's whole bundle down a shared lane to a SYNTHETIC (non-station) junction
// and fan back, so a geographically collinear line draws a closed triangle and
// out-and-back lines draw hairpins — purely through synthetic layout nodes.
//
// This pass detects, per line, maximal traversal runs whose INTERIOR nodes are
// all synthetic, and — when the run detours (pathLen/chordLen > ratio) AND
// genuinely folds (min consecutive-segment dot < fold) — splices in a short
// octilinear two-segment shortcut edge A->E carrying the line, dropping the
// line from the hook run's edges.
//
// Determinism: + − × ÷ √ min max and id-ordered iteration only. No
// Math.atan2/pow; octilinear snap via |dx|,|dy| comparisons.

import type { Layout, LayoutEdge, LineRef, TraversalStep, EdgeStop, Cell } from './types';

const DEFAULT_RATIO = 1.7;
const DEFAULT_FOLD = -0.2;
const MAX_SPLICES_PER_LINE = 8;
/** |dx|-|dy| slack under which a chord counts as already octilinear. */
const OCTI_TOL = 1e-6;

interface Runstep {
  travIndex: number; // index into the line's traversal array
  edge: LayoutEdge;
  reversed: boolean;
  from: string; // node id entered from
  to: string; // node id exited to
}

/** Node cell as a plain [x,y] tuple. */
function cellOf(layout: Layout, id: string): Cell | undefined {
  return layout.nodes.get(id)?.cell;
}

/** Euclidean length via sqrt (cross-V8 determinism: hypot avoided). */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Normalized direction of a segment, or [0,0] for a zero-length segment. */
function unit(ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [0, 0];
  return [dx / len, dy / len];
}

/** Octilinear two-segment shortcut course A..E through the layout cells.
 *  One axis-aligned leg + one 45° leg; corner chosen nearest the chord.
 *  Degenerates to a single segment when the chord is already octilinear.
 *  (Also used by octi's drawn-level detour excision as the replacement
 *  course for hairpin-routed edges.) */
export function shortcutCourse(ax: number, ay: number, ex: number, ey: number): Cell[] {
  const dx = ex - ax;
  const dy = ey - ay;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;

  // already octilinear? (horizontal, vertical, or exact 45°)
  if (adx <= OCTI_TOL || ady <= OCTI_TOL || (adx - ady <= OCTI_TOL && ady - adx <= OCTI_TOL)) {
    return [
      [ax, ay] as Cell,
      [ex, ey] as Cell,
    ];
  }

  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const m = adx < ady ? adx : ady; // diagonal covers min(|dx|,|dy|) each axis

  // two candidate corners depending on ordering (straight-first / diagonal-first)
  let cStraight: Cell;
  let cDiag: Cell;
  if (adx >= ady) {
    // horizontal-dominant: straight leg is horizontal
    cStraight = [ax + sx * (adx - m), ay] as Cell; // straight then diagonal
    cDiag = [ax + sx * m, ay + sy * m] as Cell; // diagonal then horizontal
  } else {
    // vertical-dominant: straight leg is vertical
    cStraight = [ax, ay + sy * (ady - m)] as Cell;
    cDiag = [ax + sx * m, ay + sy * m] as Cell;
  }

  // pick the corner nearest the chord (min perpendicular distance).
  const perp = (cx: number, cy: number): number => {
    // |cross(E-A, C-A)| / |E-A|
    const chordLen = Math.sqrt(dx * dx + dy * dy);
    if (chordLen === 0) return 0;
    const cross = dx * (cy - ay) - dy * (cx - ax);
    const a = cross < 0 ? -cross : cross;
    return a / chordLen;
  };
  const dS = perp(cStraight[0], cStraight[1]);
  const dD = perp(cDiag[0], cDiag[1]);
  // deterministic tie-break: straight-first when equal
  const corner = dS <= dD ? cStraight : cDiag;
  return [
    [ax, ay] as Cell,
    corner,
    [ex, ey] as Cell,
  ];
}

export function suppressHooks(
  layout: Layout,
  opts?: { ratio?: number; fold?: number },
): { spliced: number } {
  const ratio = opts?.ratio ?? DEFAULT_RATIO;
  const fold = opts?.fold ?? DEFAULT_FOLD;

  const edgeById = new Map<string, LayoutEdge>(layout.edges.map((e) => [e.id, e]));

  let spliced = 0;

  // deterministic: iterate lines by id order.
  const lineIds = [...layout.lineTraversals.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  for (const lineId of lineIds) {
    const trav = layout.lineTraversals.get(lineId);
    if (!trav || trav.length < 2) continue;

    // Plan ALL fold runs from the pristine step list, then apply. Game routes
    // traverse their edges out-and-back, so a fold appears TWICE in one
    // traversal (mirrored); splicing one run must not corrupt the detection or
    // the edges of its mirror. Runs are index-disjoint, so the plans compose.
    const steps = resolveSteps(trav, edgeById);
    if (steps.length < 2) continue;

    // Run boundaries are THIS LINE's own stops (read from edge stop flags),
    // not the global station set: a fold that threads other lines' stations
    // without serving them is still a fold (SEA line 2 bowed down the 50 St
    // column — stops it never serves — and the old station-segmented scan
    // could never span it). The interior-stop guard in planRun stays as the
    // correctness backstop.
    const stopsAtSeam = (a: Runstep, b: Runstep | undefined): boolean => {
      const sa = a.edge.stops.get(lineId);
      if (sa && (a.reversed ? sa.atFrom : sa.atTo)) return true;
      if (b) {
        const sb = b.edge.stops.get(lineId);
        if (sb && (b.reversed ? sb.atTo : sb.atFrom)) return true;
      }
      return false;
    };

    const plans: SplicePlan[] = [];
    let i = 0;
    while (i < steps.length) {
      let j = i + 1;
      while (j < steps.length && !stopsAtSeam(steps[j - 1], steps[j])) j++;
      if (j - i >= 2) {
        const plan = planRun(lineId, steps, i, j, layout, ratio, fold);
        if (plan) plans.push(plan);
      }
      // next run starts at this run's terminating stop node.
      i = j;
    }

    // Apply in REVERSE traversal order so earlier splice indices stay valid.
    const capped = plans.slice(0, MAX_SPLICES_PER_LINE);
    for (let k = capped.length - 1; k >= 0; k--) {
      applyPlan(capped[k], trav, layout, edgeById);
      spliced++;
    }

    // Strip the line from run edges its rewritten traversal no longer visits.
    // (An edge can sit inside one run yet still carry the line elsewhere in
    // the same traversal — the mirror leg — so membership follows usage.)
    if (capped.length > 0) {
      const used = new Set(trav.map((s) => s.edgeId));
      for (const p of capped) {
        for (const e of p.runEdges) {
          if (!used.has(e.id)) removeLineFromEdge(e, lineId);
        }
      }
    }
  }

  // Purge emptied edges once, after every line's splices are applied.
  pruneEmptyEdges(layout, edgeById);

  return { spliced };
}

/** Materialize the ordered node-visiting steps for a traversal. */
function resolveSteps(trav: TraversalStep[], edgeById: Map<string, LayoutEdge>): Runstep[] {
  const out: Runstep[] = [];
  for (let k = 0; k < trav.length; k++) {
    const s = trav[k];
    const e = edgeById.get(s.edgeId);
    // Defensive only: steps are resolved from the pristine traversal before any
    // splice, and edge pruning is deferred until all lines are done, so a
    // missing edge here is an upstream invariant violation.
    if (!e) continue;
    const from = s.reversed ? e.to : e.from;
    const to = s.reversed ? e.from : e.to;
    out.push({ travIndex: k, edge: e, reversed: s.reversed, from, to });
  }
  return out;
}

/** A planned splice: everything needed to rewrite the traversal later without
 *  re-reading layout state that other splices may have changed. */
interface SplicePlan {
  lineId: string;
  A: string;
  E: string;
  cA: Cell;
  cE: Cell;
  startIdx: number; // trav index of the run's first step
  endIdx: number;   // trav index of the run's last step
  runEdges: LayoutEdge[];
  lineRef: LineRef;
  stopAtA: boolean;
  stopAtE: boolean;
}

/** Detect whether the run steps[i..j-1] is a spliceable fold. Pure read. */
function planRun(
  lineId: string,
  steps: Runstep[],
  i: number,
  j: number,
  layout: Layout,
  ratio: number,
  fold: number,
): SplicePlan | null {
  const run = steps.slice(i, j);
  const A = run[0].from;
  const E = run[run.length - 1].to;

  // Safety: closed loop at one node.
  if (A === E) return null;

  // Safety: the line must not STOP at any interior node of the run.
  // Interior nodes are run[k].to for k in [0, run.length-2]; also the shared
  // seam is run[k].to == run[k+1].from. Read stop flags the way the spur-step
  // cleanup does: flag "at far node" = reversed ? atFrom : atTo.
  for (let k = 0; k < run.length; k++) {
    const rs = run[k];
    const stop = rs.edge.stops.get(lineId);
    if (!stop) continue;
    const stopAtTo = rs.reversed ? stop.atFrom : stop.atTo;
    const stopAtFrom = rs.reversed ? stop.atTo : stop.atFrom;
    // stopping at an interior node (any node strictly between A and E) blocks.
    if (k < run.length - 1 && stopAtTo) return null; // rs.to is interior
    if (k > 0 && stopAtFrom) return null; // rs.from is interior
  }

  // Geometry: node cells along the run.
  const cA = cellOf(layout, A);
  const cE = cellOf(layout, E);
  if (!cA || !cE) return null;

  const seq: Cell[] = [cA];
  for (const rs of run) {
    const c = cellOf(layout, rs.to);
    if (!c) return null;
    seq.push(c);
  }

  // pathLen along the run vs chord A->E.
  let pathLen = 0;
  for (let k = 0; k + 1 < seq.length; k++) {
    pathLen += dist(seq[k][0], seq[k][1], seq[k + 1][0], seq[k + 1][1]);
  }
  const chordLen = dist(cA[0], cA[1], cE[0], cE[1]);
  if (chordLen === 0) return null;
  if (pathLen / chordLen <= ratio) return null;

  // Fold: min consecutive-segment direction dot < fold.
  let minDot = 1;
  const dirs: Array<[number, number]> = [];
  for (let k = 0; k + 1 < seq.length; k++) {
    dirs.push(unit(seq[k][0], seq[k][1], seq[k + 1][0], seq[k + 1][1]));
  }
  for (let k = 0; k + 1 < dirs.length; k++) {
    const d0 = dirs[k];
    const d1 = dirs[k + 1];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (dot < minDot) minDot = dot;
  }
  if (minDot >= fold) return null;

  const lineRef = findLineRef(run, lineId);
  if (!lineRef) return null;

  return {
    lineId,
    A,
    E,
    cA,
    cE,
    startIdx: run[0].travIndex,
    endIdx: run[run.length - 1].travIndex,
    runEdges: run.map((rs) => rs.edge),
    lineRef,
    stopAtA: boundaryStop(run[0], lineId, true),
    stopAtE: boundaryStop(run[run.length - 1], lineId, false),
  };
}

/** Splice one planned run: reuse (either orientation) or build the shortcut
 *  edge, seat the line + its boundary stops on it, rewrite the traversal.
 *  Edge membership cleanup happens AFTER all of a line's plans are applied. */
function applyPlan(
  p: SplicePlan,
  trav: TraversalStep[],
  layout: Layout,
  edgeById: Map<string, LayoutEdge>,
): void {
  // The mirror leg of an out-and-back fold produces the same shortcut with A/E
  // swapped — reuse the forward edge with a reversed step instead of minting a
  // second, coincident edge.
  const fwdId = `hook:${p.A}:${p.E}`;
  const revId = `hook:${p.E}:${p.A}`;
  let shortcut = edgeById.get(fwdId);
  let reversed = false;
  if (!shortcut && edgeById.has(revId)) {
    shortcut = edgeById.get(revId)!;
    reversed = true;
  }
  if (!shortcut) {
    shortcut = {
      id: fwdId,
      from: p.A,
      to: p.E,
      path: shortcutCourse(p.cA[0], p.cA[1], p.cE[0], p.cE[1]),
      lines: [],
      lineOrder: [],
      stops: new Map<string, EdgeStop>(),
    };
    layout.edges.push(shortcut);
    edgeById.set(fwdId, shortcut);
  }
  // add the line to the shortcut edge (dedupe; keep line list id-sorted).
  if (!shortcut.lines.some((l) => l.id === p.lineId)) {
    shortcut.lines.push({ id: p.lineRef.id, label: p.lineRef.label, color: p.lineRef.color });
    shortcut.lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    shortcut.lineOrder = shortcut.lines.map((l) => l.id);
  }
  // carry the line's endpoint stop flags onto the shortcut, in the EDGE's
  // orientation (merge with flags a mirror-leg splice may already have set).
  const atFrom = reversed ? p.stopAtE : p.stopAtA;
  const atTo = reversed ? p.stopAtA : p.stopAtE;
  if (atFrom || atTo) {
    const prev = shortcut.stops.get(p.lineId);
    shortcut.stops.set(p.lineId, {
      atFrom: atFrom || !!prev?.atFrom,
      atTo: atTo || !!prev?.atTo,
    });
  }
  // Rewrite the traversal: replace steps [startIdx .. endIdx] (contiguous in
  // trav) with one step over the shortcut edge.
  trav.splice(p.startIdx, p.endIdx - p.startIdx + 1, { edgeId: shortcut.id, reversed });
}

function findLineRef(run: Runstep[], lineId: string): LineRef | undefined {
  for (const rs of run) {
    const lr = rs.edge.lines.find((l) => l.id === lineId);
    if (lr) return lr;
  }
  return undefined;
}

/** Whether the line stops at the run's boundary node (A when atStart, else E). */
function boundaryStop(rs: Runstep, lineId: string, atStart: boolean): boolean {
  const stop = rs.edge.stops.get(lineId);
  if (!stop) return false;
  if (atStart) {
    // boundary node is rs.from
    return rs.reversed ? stop.atTo : stop.atFrom;
  }
  // boundary node is rs.to
  return rs.reversed ? stop.atFrom : stop.atTo;
}

function removeLineFromEdge(edge: LayoutEdge, lineId: string): void {
  edge.lines = edge.lines.filter((l) => l.id !== lineId);
  edge.lineOrder = edge.lineOrder.filter((id) => id !== lineId);
  edge.stops.delete(lineId);
}

function pruneEmptyEdges(layout: Layout, edgeById: Map<string, LayoutEdge>): void {
  const kept: LayoutEdge[] = [];
  for (const e of layout.edges) {
    if (e.lines.length === 0) {
      edgeById.delete(e.id);
    } else {
      kept.push(e);
    }
  }
  layout.edges.length = 0;
  for (const e of kept) layout.edges.push(e);
}
