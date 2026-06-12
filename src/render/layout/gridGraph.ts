// LOOM basegraph port: the stateful octilinear grid graph Γ' with the full
// constraint mechanics of Brosi & Bast's reference implementation
// (loom/src/octi/basegraph/{GridGraph,OctiGridGraph}.cpp):
//
//  - every base node owns 8 port nodes; ports join the centre via SINK edges
//    (closed/INF except while routing an incident support edge), each other
//    via BEND edges (45°-step turn penalties), and the opposite port of the
//    neighbouring base node via GRID edges (axis/diagonal hop costs);
//  - routing an edge SETTLES the grid edges it uses: their resident-edge sets
//    are recorded, the touched nodes' bend edges are soft-closed (SOFT_INF =
//    "topology violation", not just expensive), and the crossing diagonal of
//    every used diagonal is hard-blocked — this is what kills the X-crossing
//    tangles that a pure penalty model lets through;
//  - settled station nodes carry node-cost vectors (bend/spacing/topo-block,
//    written by the octilinearizer) on their sink edges so later edges enter
//    at ports consistent with the original circular edge ordering.
//
// Everything is indexed numerically (typed arrays) so the local search in
// octi.ts can afford thousands of A* queries.

import type { Pixel } from './types';

export interface Penalties {
  p0: number;
  p45: number;
  p90: number;
  p135: number;
  verticalPen: number;
  horizontalPen: number;
  diagonalPen: number;
  ndMovePen: number;
  /** Spring cost weight: penalizes drawing a collapsed station chain on a
   *  path with fewer grid hops than it has stations (Drawing::draw). */
  densityPen: number;
  /** NOT in LOOM: cost of crossing STRAIGHT THROUGH a grid node already
   *  occupied by another corridor (an overlap crossing — each bundle keeps
   *  its preferred course). Turning inside another corridor stays
   *  soft-closed; station nodes stay protected. Keep above ~2x a 90° bend
   *  so corridors don't slice through bundles gratuitously, but well below
   *  the cost of a staircase detour around them. */
  crossingPen: number;
}

/** LOOM's shipped defaults (octi/basegraph/BaseGraph.h). */
export const DEFAULT_PENALTIES: Penalties = {
  p0: 0,
  p45: 2,
  p90: 1.5,
  p135: 1,
  verticalPen: 0,
  horizontalPen: 0,
  diagonalPen: 0.5,
  ndMovePen: 0.5,
  // LOOM ships 10, but it pairs that with label space requirements: a chain of
  // k+1 stations is FORCED onto >= k+1 grid hops. On dense downtown chains
  // that makes the router add switchback zigzags (or worse, giant detours)
  // purely to lengthen the path. We redistribute stations evenly along the
  // corridor instead, so cramped chains are merely cosy — keep the pressure
  // below the cost of a single extra hop so it never buys a switchback.
  densityPen: 0.5,
  crossingPen: 4,
};

/** Cost of using a soft-closed edge: feasible but counted as a topology
 *  violation by the drawing score (BaseGraph.h SOFT_INF). */
export const SOFT_INF = 100_000;

// Direction convention (LOOM OctiGridGraph::neigh): 0=N(0,+1), 1=NE(1,1),
// 2=E(1,0), 3=SE(1,-1), 4=S(0,-1), 5=SW(-1,-1), 6=W(-1,0), 7=NW(-1,1).
// "+y" is simply the grid's row direction; orientation consistency with the
// support graph's edge orderings is all that matters.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [1, 1, 0, -1, -1, -1, 0, 1];

const F_CLOSED = 1; // hard closed -> cost INF
const F_SOFT = 2;   // soft closed -> cost SOFT_INF + raw (counts a violation)
const F_BLOCKED = 4; // crossing-diagonal block -> like soft closed
const F_CROSS = 8;  // overlap crossing -> finite crossingPen + raw (legal)

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RouteResult {
  /** Directed edge indices source-centre → target-centre (sinks included). */
  edges: number[];
  /** Effective traversal cost of each edge at query time (incl. geo pens). */
  costs: number[];
  /** Total path cost including endpoint sink costs. */
  cost: number;
  /** Base index of the source / target centres the path connected. */
  fromBase: number;
  toBase: number;
}

export class OctiGridGraph {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originY: number;
  readonly pens: Penalties;

  /** bendCosts[ang] for ang 0..3 = straight, 135°, 90°, 45° interior turns
   *  (OctiGridGraph ctor). bendCosts[0] doubles as the per-hop "A" correction. */
  readonly bendCosts: [number, number, number, number];

  private readonly nBases: number;
  private readonly sinkCount: number; // 16 per base
  private readonly bendCount: number; // 56 per base
  private readonly cost0: Float64Array; // raw costs, all directed edges
  private readonly flags: Uint8Array;

  /** grid edge idx -> resident support-edge ids. */
  private readonly resEdgs = new Map<number, Set<string>>();

  private readonly ndClosed: Uint8Array;
  private readonly ndSettled: Uint8Array;
  private readonly settledMap = new Map<string, number>(); // support nd -> base

  // A* heuristic constants (OctiGridGraph ctor).
  private readonly heurHopCost: number;
  private readonly heurXCost: number;
  private readonly heurYCost: number;
  private readonly heurDiagSave: number;

  // A* scratch (generation-stamped so queries need no clearing).
  private readonly dist: Float64Array;
  private readonly stamp: Int32Array;
  private readonly parentEdge: Int32Array;
  private readonly parentNode: Int32Array;
  private generation = 0;

  constructor(bounds: Bounds, cellSize: number, pens: Penalties = DEFAULT_PENALTIES, padCells = 2) {
    this.cellSize = cellSize;
    this.pens = pens;
    const c0 = Math.floor(bounds.minX / cellSize) - padCells;
    const c1 = Math.ceil(bounds.maxX / cellSize) + padCells;
    const r0 = Math.floor(bounds.minY / cellSize) - padCells;
    const r1 = Math.ceil(bounds.maxY / cellSize) + padCells;
    this.cols = c1 - c0 + 1;
    this.rows = r1 - r0 + 1;
    this.originX = c0 * cellSize;
    this.originY = r0 * cellSize;
    this.nBases = this.cols * this.rows;

    const A = pens.p45 - pens.p135;
    this.bendCosts = [A, A + pens.p45, A + pens.p90, pens.p45];

    this.heurHopCost = A;
    let hx = pens.horizontalPen + this.heurHopCost;
    let hy = pens.verticalPen + this.heurHopCost;
    const hd = pens.diagonalPen + this.heurHopCost;
    if (hd < hx) hx = hd;
    if (hd < hy) hy = hd;
    this.heurXCost = hx;
    this.heurYCost = hy;
    this.heurDiagSave = hd > hx + hy ? 0 : hd - hx - hy;

    this.sinkCount = this.nBases * 16;
    this.bendCount = this.nBases * 56;
    const nEdges = this.sinkCount + this.bendCount + this.nBases * 8;
    this.cost0 = new Float64Array(nEdges);
    this.flags = new Uint8Array(nEdges);
    this.ndClosed = new Uint8Array(this.nBases);
    this.ndSettled = new Uint8Array(this.nBases);

    const nNodes = this.nBases * 9;
    this.dist = new Float64Array(nNodes);
    this.stamp = new Int32Array(nNodes);
    this.parentEdge = new Int32Array(nNodes);
    this.parentNode = new Int32Array(nNodes);

    this.writeInitialCosts();
  }

  // ---- indexing -----------------------------------------------------------

  baseIdx(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return col * this.rows + row;
  }

  baseCol(b: number): number { return (b / this.rows) | 0; }
  baseRow(b: number): number { return b % this.rows; }

  basePos(b: number): Pixel {
    return [this.originX + this.baseCol(b) * this.cellSize, this.originY + this.baseRow(b) * this.cellSize];
  }

  centerNode(b: number): number { return b * 9; }
  portNode(b: number, d: number): number { return b * 9 + 1 + d; }
  /** -1 for a centre node, else the port's direction. */
  portDir(node: number): number { return (node % 9) - 1; }
  baseOfNode(node: number): number { return (node / 9) | 0; }

  sinkOutIdx(b: number, d: number): number { return b * 16 + d * 2; }     // centre -> port
  sinkInIdx(b: number, d: number): number { return b * 16 + d * 2 + 1; }  // port -> centre
  bendIdx(b: number, i: number, j: number): number {
    return this.sinkCount + b * 56 + i * 7 + (j < i ? j : j - 1);          // port i -> port j
  }
  gridIdx(b: number, d: number): number { return this.sinkCount + this.bendCount + b * 8 + d; }
  isGridEdge(e: number): boolean { return e >= this.sinkCount + this.bendCount; }
  isSinkEdge(e: number): boolean { return e < this.sinkCount; }

  /** For grid edge gridIdx(b,d): the opposite directed edge gridIdx(nbr, opp). */
  reverseGridEdge(e: number): number {
    const rel = e - this.sinkCount - this.bendCount;
    const b = (rel / 8) | 0;
    const d = rel % 8;
    const nb = this.neigh(b, d);
    return this.gridIdx(nb, (d + 4) % 8);
  }

  /** Endpoint bases of a grid edge. */
  gridEdgeBases(e: number): [number, number] {
    const rel = e - this.sinkCount - this.bendCount;
    const b = (rel / 8) | 0;
    const d = rel % 8;
    return [b, this.neigh(b, d)];
  }

  /** Direction of a grid edge (from its source base toward its target). */
  gridEdgeDir(e: number): number {
    return (e - this.sinkCount - this.bendCount) % 8;
  }

  neigh(b: number, d: number): number {
    if (d > 7) return b;
    return this.baseIdx(this.baseCol(b) + DX[d], this.baseRow(b) + DY[d]);
  }

  getDir(a: number, b: number): number {
    const dx = this.baseCol(b) - this.baseCol(a);
    const dy = this.baseRow(b) - this.baseRow(a);
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    for (let d = 0; d < 8; d++) if (DX[d] === sx && DY[d] === sy) return d;
    return -1;
  }

  /** Directed grid edge from a's port toward adjacent base b; -1 if absent. */
  getNEdg(a: number, b: number): number {
    if (a < 0 || b < 0 || a === b) return -1;
    const d = this.getDir(a, b);
    if (d < 0 || this.neigh(a, d) !== b) return -1;
    return this.gridIdx(a, d);
  }

  // ---- costs --------------------------------------------------------------

  private writeInitialCosts(): void {
    const { pens } = this;
    for (let b = 0; b < this.nBases; b++) {
      // Sinks: closed/INF until opened for a routing query.
      for (let d = 0; d < 8; d++) {
        this.cost0[this.sinkOutIdx(b, d)] = Infinity;
        this.cost0[this.sinkInIdx(b, d)] = Infinity;
        this.flags[this.sinkOutIdx(b, d)] = F_CLOSED;
        this.flags[this.sinkInIdx(b, d)] = F_CLOSED;
      }
      // Bends: per-pair turn penalty; INF when either port points off-grid.
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          if (i === j) continue;
          const offGrid = this.neigh(b, i) < 0 || this.neigh(b, j) < 0;
          this.cost0[this.bendIdx(b, i, j)] = offGrid ? Infinity : this.getBendPen(i, j);
        }
      }
      // Grid edges: axis/diagonal hop costs; missing neighbours stay closed.
      for (let d = 0; d < 8; d++) {
        const e = this.gridIdx(b, d);
        if (this.neigh(b, d) < 0) {
          this.cost0[e] = Infinity;
          this.flags[e] = F_CLOSED;
        } else if (d % 4 === 0) {
          this.cost0[e] = pens.verticalPen;
        } else if ((d + 2) % 4 === 0) {
          this.cost0[e] = pens.horizontalPen;
        } else {
          this.cost0[e] = pens.diagonalPen;
        }
      }
    }
  }

  /** Interior turn-angle index between ports i and j (OctiGridGraph::ang). */
  ang(i: number, j: number): number {
    let a = (8 + (i - j)) % 8;
    if (a > 4) a = 8 - a;
    return a % 4;
  }

  getBendPen(i: number, j: number): number {
    return this.bendCosts[this.ang(i, j)];
  }

  /** Effective traversal cost honouring closed/soft/blocked/cross state. */
  edgeCost(e: number): number {
    const f = this.flags[e];
    if (f & (F_SOFT | F_BLOCKED)) return SOFT_INF + this.cost0[e];
    if (f & F_CLOSED) return Infinity;
    if (f & F_CROSS) return this.pens.crossingPen + this.cost0[e];
    return this.cost0[e];
  }

  rawCost(e: number): number { return this.cost0[e]; }

  private open(e: number): void { this.flags[e] &= ~(F_CLOSED | F_SOFT | F_CROSS); }
  private close(e: number): void { this.flags[e] = (this.flags[e] | F_CLOSED) & ~F_SOFT; }
  private crossClose(e: number): void {
    if (!(this.flags[e] & (F_CLOSED | F_SOFT))) this.flags[e] |= F_CROSS;
  }
  private softClose(e: number): void {
    if (!(this.flags[e] & F_CLOSED)) this.flags[e] |= F_SOFT;
    this.flags[e] |= F_CLOSED;
  }
  private block(e: number): void { if (e >= 0) this.flags[e] |= F_BLOCKED; }
  private unblock(e: number): void { if (e >= 0) this.flags[e] &= ~F_BLOCKED; }

  // ---- turn / sink mechanics (GridGraph::{open,close}{Turns,Sink*}) -------

  openTurns(b: number): void {
    if (!this.ndClosed[b]) return;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i !== j) this.open(this.bendIdx(b, i, j));
      }
    }
    this.ndClosed[b] = 0;
  }

  closeTurns(b: number): void {
    if (this.ndClosed[b]) return;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === j) continue;
        const e = this.bendIdx(b, i, j);
        // STRAIGHT pass-through across a corridor-occupied (but unsettled)
        // node is an overlap crossing — legal at a finite price. Turning
        // inside another corridor, and anything at a settled (station/
        // junction) node, stays soft-closed.
        if ((i + 4) % 8 === j && !this.ndSettled[b]) this.crossClose(e);
        else this.softClose(e);
      }
    }
    this.ndClosed[b] = 1;
  }

  isClosed(b: number): boolean { return this.ndClosed[b] === 1; }
  isSettledBase(b: number): boolean { return this.ndSettled[b] === 1; }

  openSinkFr(b: number, cost: number): void {
    for (let d = 0; d < 8; d++) {
      const e = this.sinkOutIdx(b, d);
      this.open(e);
      this.cost0[e] = cost;
    }
  }

  closeSinkFr(b: number): void {
    for (let d = 0; d < 8; d++) {
      const e = this.sinkOutIdx(b, d);
      this.close(e);
      this.cost0[e] = Infinity;
    }
  }

  openSinkTo(b: number, cost: number): void {
    for (let d = 0; d < 8; d++) {
      const e = this.sinkInIdx(b, d);
      this.open(e);
      this.cost0[e] = cost;
    }
  }

  closeSinkTo(b: number): void {
    for (let d = 0; d < 8; d++) {
      const e = this.sinkInIdx(b, d);
      this.close(e);
      this.cost0[e] = Infinity;
    }
  }

  /** Node-cost vector onto the sink edges: < -1 soft-closes the port (spacing/
   *  topo blocking), otherwise the value is added (bend penalties). */
  addCostVec(b: number, addC: Float64Array): void {
    for (let d = 0; d < 8; d++) {
      const sIn = this.sinkInIdx(b, d);
      const sOut = this.sinkOutIdx(b, d);
      if (addC[d] < -1) {
        this.softClose(sIn);
        this.softClose(sOut);
      } else if (addC[d] !== 0) {
        this.cost0[sIn] += addC[d];
        this.cost0[sOut] += addC[d];
      }
    }
  }

  // ---- settling -----------------------------------------------------------

  settleNd(b: number, ndId: string): void {
    this.settledMap.set(ndId, b);
    this.ndSettled[b] = 1;
  }

  unSettleNd(ndId: string): void {
    const b = this.settledMap.get(ndId);
    if (b === undefined) return;
    this.openTurns(b);
    this.ndSettled[b] = 0;
    this.settledMap.delete(ndId);
  }

  isSettled(ndId: string): boolean { return this.settledMap.has(ndId); }
  getSettled(ndId: string): number { return this.settledMap.get(ndId) ?? -1; }

  settleEdg(aB: number, bB: number, ceId: string): void {
    if (aB === bB) return;
    const ge = this.getNEdg(aB, bB);
    const gf = this.getNEdg(bB, aB);
    if (ge < 0 || gf < 0) return;
    this.addResEdg(ge, ceId);
    this.addResEdg(gf, ceId);
    this.closeTurns(aB);
    this.closeTurns(bB);
    // Block the crossing diagonal of a used diagonal (OctiGridGraph).
    const dir = this.getDir(aB, bB);
    if (dir % 2 !== 0) {
      const na = this.neigh(aB, (dir + 7) % 8);
      const nb = this.neigh(aB, (dir + 1) % 8);
      if (na >= 0 && nb >= 0) {
        this.block(this.getNEdg(na, nb));
        this.block(this.getNEdg(nb, na));
      }
    }
  }

  unSettleEdg(ceId: string, aB: number, bB: number): void {
    if (aB === bB) return;
    const ge = this.getNEdg(aB, bB);
    const gf = this.getNEdg(bB, aB);
    if (ge < 0 || gf < 0) return;
    this.delResEdg(ge, ceId);
    this.delResEdg(gf, ceId);

    if (!this.resEdgs.get(ge)?.size) {
      // (GridGraph version: only reopen when the node hosts no other path.)
      if (!this.ndSettled[aB] && this.unused(aB)) this.openTurns(aB);
      if (!this.ndSettled[bB] && this.unused(bB)) this.openTurns(bB);

      const dir = this.getDir(aB, bB);
      if (dir % 2 !== 0) {
        const na = this.neigh(aB, (dir + 7) % 8);
        const nb = this.neigh(aB, (dir + 1) % 8);
        if (na >= 0 && nb >= 0) {
          this.unblock(this.getNEdg(na, nb));
          this.unblock(this.getNEdg(nb, na));
        }
      }
    }
  }

  private addResEdg(e: number, ceId: string): void {
    let s = this.resEdgs.get(e);
    if (!s) this.resEdgs.set(e, (s = new Set()));
    s.add(ceId);
  }

  private delResEdg(e: number, ceId: string): void {
    this.resEdgs.get(e)?.delete(ceId);
  }

  getResEdgs(e: number): ReadonlySet<string> | undefined {
    if (e < 0) return undefined;
    return this.resEdgs.get(e);
  }

  /** No routed path touches any grid edge of this base node. */
  unused(b: number): boolean {
    for (let d = 0; d < 8; d++) {
      const nb = this.neigh(b, d);
      if (nb < 0) continue;
      if (this.resEdgs.get(this.gridIdx(b, d))?.size) return false;
      if (this.resEdgs.get(this.gridIdx(nb, (d + 4) % 8))?.size) return false;
    }
    return true;
  }

  /** Per direction, the resident support edge incident to origNd (if any) on
   *  the adjacent grid edge — LOOM GridGraph::getSettledAdjEdgs. */
  getSettledAdjEdgs(b: number, isIncident: (ceId: string) => boolean): Array<string | null> {
    const out: Array<string | null> = new Array(8).fill(null);
    for (let d = 0; d < 8; d++) {
      const nb = this.neigh(b, d);
      if (nb < 0) continue;
      let res = this.resEdgs.get(this.gridIdx(b, d));
      if (!res?.size) res = this.resEdgs.get(this.gridIdx(nb, (d + 4) % 8));
      if (!res?.size) continue;
      for (const ce of res) {
        if (isIncident(ce)) { out[d] = ce; break; }
      }
    }
    return out;
  }

  // ---- candidates / penalties ----------------------------------------------

  /** Free degree of base b for hosting a station whose adjacent comb nodes
   *  are settled at `adjSettledBases` (GridGraph::getGrNdDeg). */
  getGrNdDeg(b: number, adjSettledBases: ReadonlySet<number>): number {
    let closed = 0;
    let notPresent = 0;
    let settledNeighs = 0;
    for (let d = 0; d < 8; d++) {
      const n = this.neigh(b, d);
      if (n < 0) { notPresent++; continue; }
      if (this.ndSettled[n]) {
        if (!adjSettledBases.has(n)) settledNeighs++;
      } else if (this.ndClosed[n]) {
        closed++;
      }
    }
    return 8 - settledNeighs - closed - notPresent;
  }

  /** Open grid node candidates for placing a station near p, nearest first. */
  getGrNdCands(
    p: Pixel,
    combDeg: number,
    maxGrDist: number,
    adjSettledBases: ReadonlySet<number>,
  ): number[] {
    const maxD = this.cellSize * maxGrDist;
    const cMin = Math.max(0, Math.floor((p[0] - maxD - this.originX) / this.cellSize));
    const cMax = Math.min(this.cols - 1, Math.ceil((p[0] + maxD - this.originX) / this.cellSize));
    const rMin = Math.max(0, Math.floor((p[1] - maxD - this.originY) / this.cellSize));
    const rMax = Math.min(this.rows - 1, Math.ceil((p[1] + maxD - this.originY) / this.cellSize));
    const out: Array<{ b: number; d: number }> = [];
    for (let c = cMin; c <= cMax; c++) {
      for (let r = rMin; r <= rMax; r++) {
        const b = c * this.rows + r;
        if (this.ndClosed[b] || this.ndSettled[b]) continue;
        const pos = this.basePos(b);
        const d = Math.hypot(pos[0] - p[0], pos[1] - p[1]);
        if (d >= maxD) continue;
        if (this.getGrNdDeg(b, adjSettledBases) < combDeg) continue;
        out.push({ b, d });
      }
    }
    out.sort((x, y) => x.d - y.d);
    return out.map((x) => x.b);
  }

  /** Displacement penalty per LOOM OctiGridGraph::ndMovePen. */
  ndMovePen(p: Pixel, b: number): number {
    const { pens, bendCosts } = this;
    const diagCost = bendCosts[0] + Math.min(pens.diagonalPen, pens.horizontalPen + pens.verticalPen + bendCosts[2]);
    const vertCost = bendCosts[0] + Math.min(pens.verticalPen, pens.horizontalPen + pens.diagonalPen + bendCosts[3]);
    const horiCost = bendCosts[0] + Math.min(pens.horizontalPen, pens.verticalPen + pens.diagonalPen + bendCosts[3]);
    const penPerGrid = pens.ndMovePen + Math.max(diagCost, Math.max(vertCost, horiCost));
    const pos = this.basePos(b);
    const d = Math.hypot(pos[0] - p[0], pos[1] - p[1]);
    return (d / this.cellSize) * penPerGrid;
  }

  /** Admissible octilinear A* heuristic (OctiGridGraph::heurCost). */
  heurCost(xa: number, ya: number, xb: number, yb: number): number {
    const dx = Math.abs(xb - xa);
    const dy = Math.abs(yb - ya);
    let edgeCost = this.heurXCost * dx + this.heurYCost * dy + this.heurDiagSave * Math.min(dx, dy);
    if (dx !== dy && dx !== 0 && dy !== 0) edgeCost += this.pens.p135;
    return Math.max(0, edgeCost - this.heurHopCost);
  }

  // ---- router ---------------------------------------------------------------

  /**
   * A* from any source base centre to any target base centre. Sink edges must
   * already be opened by the caller (openSinkFr on sources, openSinkTo on
   * targets); their costs carry the endpoint displacement penalties exactly as
   * in LOOM's Dijkstra setup. `cutoff` prunes any path whose cost exceeds it.
   */
  route(
    sources: readonly number[],
    targets: readonly number[],
    cutoff: number,
    geoPen?: (gridEdgeIdx: number) => number,
  ): RouteResult | null {
    const gen = ++this.generation;
    const { dist, stamp, parentEdge, parentNode } = this;

    const targetSet = new Set<number>();
    const tCoords: number[] = [];
    for (const t of targets) {
      targetSet.add(this.centerNode(t));
      tCoords.push(this.baseCol(t), this.baseRow(t));
    }
    const heur = (node: number): number => {
      const b = this.baseOfNode(node);
      const bx = this.baseCol(b);
      const by = this.baseRow(b);
      let best = Infinity;
      for (let i = 0; i < tCoords.length; i += 2) {
        const h = this.heurCost(bx, by, tCoords[i], tCoords[i + 1]);
        if (h < best) best = h;
      }
      return best;
    };

    // Binary heap of (f, node).
    const heapF: number[] = [];
    const heapN: number[] = [];
    const push = (f: number, n: number) => {
      let i = heapF.length;
      heapF.push(f);
      heapN.push(n);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapF[p] <= heapF[i]) break;
        [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
        [heapN[p], heapN[i]] = [heapN[i], heapN[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heapN[0];
      const lf = heapF.pop()!;
      const ln = heapN.pop()!;
      if (heapF.length) {
        heapF[0] = lf;
        heapN[0] = ln;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heapF.length && heapF[l] < heapF[m]) m = l;
          if (r < heapF.length && heapF[r] < heapF[m]) m = r;
          if (m === i) break;
          [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
          [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
          i = m;
        }
      }
      return top;
    };

    for (const s of sources) {
      const n = this.centerNode(s);
      dist[n] = 0;
      stamp[n] = gen;
      parentEdge[n] = -1;
      parentNode[n] = -1;
      push(heur(n), n);
    }

    const relax = (from: number, e: number, to: number) => {
      let w = this.edgeCost(e);
      if (w === Infinity) return;
      if (geoPen && this.isGridEdge(e)) w += geoPen(e);
      const g = dist[from] + w;
      if (g > cutoff) return;
      if (stamp[to] !== gen || g < dist[to]) {
        dist[to] = g;
        stamp[to] = gen;
        parentEdge[to] = e;
        parentNode[to] = from;
        push(g + heur(to), to);
      }
    };

    let goal = -1;
    while (heapF.length) {
      const f = heapF[0];
      const cur = pop();
      if (stamp[cur] !== gen) continue;
      if (f - heur(cur) > dist[cur] + 1e-9) continue; // stale entry
      if (targetSet.has(cur) && parentEdge[cur] >= 0) { goal = cur; break; }

      const b = this.baseOfNode(cur);
      const pd = this.portDir(cur);
      if (pd < 0) {
        // centre: leave via sink-out edges
        for (let d = 0; d < 8; d++) relax(cur, this.sinkOutIdx(b, d), this.portNode(b, d));
      } else {
        // port: sink-in, bends to other ports, grid hop
        relax(cur, this.sinkInIdx(b, pd), this.centerNode(b));
        for (let j = 0; j < 8; j++) {
          if (j !== pd) relax(cur, this.bendIdx(b, pd, j), this.portNode(b, j));
        }
        const nb = this.neigh(b, pd);
        if (nb >= 0) relax(cur, this.gridIdx(b, pd), this.portNode(nb, (pd + 4) % 8));
      }
    }

    if (goal < 0) return null;

    const edges: number[] = [];
    const costs: number[] = [];
    let n = goal;
    while (parentEdge[n] >= 0) {
      const e = parentEdge[n];
      edges.push(e);
      let w = this.edgeCost(e);
      if (geoPen && this.isGridEdge(e)) w += geoPen(e);
      costs.push(w);
      n = parentNode[n];
    }
    edges.reverse();
    costs.reverse();
    return {
      edges,
      costs,
      cost: dist[goal],
      fromBase: this.baseOfNode(n),
      toBase: this.baseOfNode(goal),
    };
  }
}
