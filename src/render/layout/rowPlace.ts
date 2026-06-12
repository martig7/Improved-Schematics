// Rigid-row marker placement (spec: docs/superpowers/specs/
// 2026-06-12-rigid-row-markers-design.md, v2). The unit of optimization is
// the bundle ROW — a straight octilinear line whose dots are intersections
// of the row line with the member lane curves. Collinearity, on-lane-ness
// and octilinearity hold by construction (R1/R2); the pairing-conditioned
// chain DP is exact on the discretized state space (R3); the only fallback
// is the caller's mega box on a null return (R4 — no partial degradation).

import type { Pixel } from './types';
import { type LaneCurve, curvePoint, curveTangent } from './chainPlace';

export interface RowOpts {
  minGap: number;        // 2r - 0.05
  arcLimit: number;      // slide window each side (24; caller escalates to 48)
  step?: number;         // slide grid, default 0.5
  extCap: number;        // max extension per row at a corner (6 * spacing)
  slideW?: number;       // W_S, default 0.05
  rotW?: number;         // W_ROT, default 20 (px per 45-degree step)
  blocked?: (p: Pixel) => boolean; // spec §6 mask — a row state is infeasible
                                   // if ANY of its dots is blocked (never dropped)
}

export interface RowSolution {
  /** per input mark index: dot position (row line × its lane curve) */
  pos: Pixel[];
  /** station-wide visiting order over mark indices (rows concatenated) */
  order: number[];
  /** corner vertex AFTER order[k] (chain position), for pair boundaries */
  cornerAfter: Map<number, Pixel>;
  cost: number;
}

const QUARTER = Math.PI / 4;

// the four octilinear axes (mod 180°) as unit vectors: 0°, 45°, 90°, 135°
const AXES: ReadonlyArray<Pixel> = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
];

interface RowState {
  s: number;       // slide along the carrier curve
  axis: number;    // index into AXES
  u: Pixel;        // row direction (AXES[axis])
  dots: Pixel[];   // aligned with the bundle's group order
  asc: number[];   // group positions sorted by ascending projection on u
  a: Pixel;        // outermost dot at min projection
  b: Pixel;        // outermost dot at max projection
  cost: number;    // slideW*|s| + rotW*rot — the unary state cost
}

/** Crossings of the row LINE (A, u) with a lane polyline: walk the vertices
 *  computing the signed lateral offset (pt−A)·n, n = perp(u); a sign change
 *  brackets a crossing (lerp). Returns the crossing nearest `near` (the
 *  member's own anchor), or null when the line misses the windowed lane.
 *  A vertex on the line (|offset| ~ 0) counts as a crossing itself — for a
 *  segment collinear with the row line that admits its endpoints, which is
 *  enough: the truly degenerate row-along-own-lane states either die on the
 *  floor checks or belong to single-member bundles (special-cased below). */
const lineCrossNearest = (c: LaneCurve, A: Pixel, u: Pixel, near: Pixel): Pixel | null => {
  const nx = -u[1];
  const ny = u[0];
  let best: Pixel | null = null;
  let bestD = Infinity;
  const consider = (p: Pixel) => {
    const d = Math.hypot(p[0] - near[0], p[1] - near[1]);
    if (d < bestD) { bestD = d; best = p; }
  };
  let f1 = (c.pts[0][0] - A[0]) * nx + (c.pts[0][1] - A[1]) * ny;
  if (Math.abs(f1) < 1e-9) consider(c.pts[0]);
  for (let i = 1; i < c.pts.length; i++) {
    const f2 = (c.pts[i][0] - A[0]) * nx + (c.pts[i][1] - A[1]) * ny;
    if (Math.abs(f2) < 1e-9) {
      consider(c.pts[i]);
    } else if (f1 * f2 < 0) {
      const t = f1 / (f1 - f2);
      consider([
        c.pts[i - 1][0] + (c.pts[i][0] - c.pts[i - 1][0]) * t,
        c.pts[i - 1][1] + (c.pts[i][1] - c.pts[i - 1][1]) * t,
      ]);
    }
    f1 = f2;
  }
  return best;
};

interface PairRes { cost: number; corner: Pixel; }

/** Exact bundle-level solve per spec v2 §2. groups = mark indices per bundle
 *  in lane order; curves[i] = mark i's lane curve. Returns null when NO
 *  pairing/orientation admits a feasible configuration — caller falls back
 *  to the mega box (spec v2 §3). */
export function solveRows(
  curves: LaneCurve[],
  groups: number[][],
  opts: RowOpts,
): RowSolution | null {
  const step = opts.step ?? 0.5;
  const slideW = opts.slideW ?? 0.05;
  const rotW = opts.rotW ?? 20;
  const { minGap, arcLimit, extCap, blocked } = opts;
  const n = curves.length;
  const g = groups.length;
  const anchorPos = curves.map((c) => curvePoint(c, c.anchorT));

  // ---- step 1: row states per bundle --------------------------------------
  const buildStates = (group: number[]): RowState[] => {
    const carrier = curves[group[0]];
    // rest axis: octilinear snap of the bundle perpendicular — perp of the
    // mean SIGN-NORMALIZED member tangent at the anchors (same normalization
    // as the grouping code in renderOctilinear). Math.round half-up breaks
    // the exact-22.5° tie deterministically.
    const t0 = curveTangent(carrier, carrier.anchorT);
    let mx = 0;
    let my = 0;
    for (const i of group) {
      const tg = curveTangent(curves[i], curves[i].anchorT);
      const sgn = tg[0] * t0[0] + tg[1] * t0[1] < 0 ? -1 : 1;
      mx += tg[0] * sgn;
      my += tg[1] * sgn;
    }
    const perpAng = Math.atan2(mx, -my); // angle of the perp vector (-my, mx)
    const restIdx = ((Math.round(perpAng / QUARTER) % 4) + 4) % 4;
    const m = Math.max(0, Math.round(arcLimit / step));
    const states: RowState[] = [];
    for (let j = -m; j <= m; j++) {
      const s = j * step;
      const A = curvePoint(carrier, carrier.anchorT + s);
      for (let axis = 0; axis < 4; axis++) {
        const u = AXES[axis];
        let dots: Pixel[];
        if (group.length === 1) {
          // one-member row: the dot IS the slide point on its own curve; θ
          // still orients the row line for corner derivation (plan step 3)
          dots = [A];
        } else {
          const got: Pixel[] = [];
          let hit = true;
          for (let gi = 0; gi < group.length; gi++) {
            const p = lineCrossNearest(curves[group[gi]], A, u, anchorPos[group[gi]]);
            if (!p) { hit = false; break; }
            got.push(p);
          }
          if (!hit) continue; // a member's lane never crosses the row line
          dots = got;
        }
        // lane-order consistency + floor: projections strictly monotone in
        // the group's lane order (either direction — a reversed row is the
        // same row) with consecutive gaps ≥ minGap. Dots are collinear, so
        // the projected gap IS the pair distance.
        const pr = dots.map((p) => p[0] * u[0] + p[1] * u[1]);
        let feas = true;
        if (dots.length > 1) {
          const sgn = pr[1] - pr[0] > 0 ? 1 : -1;
          for (let gi = 1; gi < dots.length; gi++) {
            if ((pr[gi] - pr[gi - 1]) * sgn < minGap) { feas = false; break; }
          }
        }
        if (feas && blocked) {
          for (const p of dots) {
            if (blocked(p)) { feas = false; break; } // §6 mask — never dropped
          }
        }
        if (!feas) continue;
        const asc = dots.map((_, gi) => gi).sort((x, y) => pr[x] - pr[y]);
        const dIdx = (((axis - restIdx) % 4) + 4) % 4;
        const rot = Math.min(dIdx, 4 - dIdx); // 45° steps from rest: 0..2
        states.push({
          s,
          axis,
          u,
          dots,
          asc,
          a: dots[asc[0]],
          b: dots[asc[asc.length - 1]],
          cost: slideW * Math.abs(s) + rotW * rot,
        });
      }
    }
    return states;
  };
  const bundleStates = groups.map(buildStates);
  // a bundle with no feasible row anywhere dooms every pairing
  if (bundleStates.some((st) => st.length === 0)) return null;

  // ---- single bundle: best unary state, no corners -------------------------
  if (g === 1) {
    let best: RowState | null = null;
    for (const st of bundleStates[0]) {
      if (!best || st.cost < best.cost) best = st; // strict <: first found wins
    }
    const win = best!; // non-empty checked above
    const pos: Pixel[] = new Array(n);
    const order: number[] = [];
    for (const gi of win.asc) {
      pos[groups[0][gi]] = win.dots[gi];
      order.push(groups[0][gi]);
    }
    return { pos, order, cornerAfter: new Map(), cost: win.cost };
  }

  // ---- step 2: pair feasibility + cost -------------------------------------
  // Orientation bit 0 = forward (members ascending along u: head=a, tail=b);
  // bit 1 = reversed. The pair joins row p's TAIL to row q's HEAD.
  const pairEval = (P: RowState, op: number, Q: RowState, oq: number): PairRes | null => {
    const e1 = op ? P.a : P.b;
    const o1x = (op ? -1 : 1) * P.u[0]; // outward direction at p's tail
    const o1y = (op ? -1 : 1) * P.u[1];
    const e2 = oq ? Q.b : Q.a;
    const o2x = (oq ? 1 : -1) * Q.u[0]; // outward direction at q's head
    const o2y = (oq ? 1 : -1) * Q.u[1];
    let corner: Pixel;
    let ext1: number;
    let ext2: number;
    if (P.axis === Q.axis) {
      // parallel rows (same snapped axis): feasible only if collinear within
      // sub-pixel lateral offset — they join end-to-end (spec §2.2)
      const lat = Math.abs((e2[0] - e1[0]) * -P.u[1] + (e2[1] - e1[1]) * P.u[0]);
      if (lat >= 0.75) return null;
      // end-to-end means the facing ends point at each other; same-direction
      // orientations would interleave the two rows' bodies on one line
      if (o1x * o2x + o1y * o2y > -0.5) return null;
      const gap = (e2[0] - e1[0]) * o1x + (e2[1] - e1[1]) * o1y;
      if (gap < 0) return null; // rows may not overlap along the shared line
      ext1 = gap / 2;
      ext2 = gap / 2;
      corner = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2];
    } else {
      // V-not-T: the corner = intersection of the two row LINES must lie
      // at-or-beyond the facing end of EACH row along its outward direction
      // (extension only, never poking into a row's side; −0.5px tolerance)
      const cross = P.u[0] * Q.u[1] - P.u[1] * Q.u[0]; // ≥ sin45° — axes differ
      const t = ((e2[0] - e1[0]) * Q.u[1] - (e2[1] - e1[1]) * Q.u[0]) / cross;
      corner = [e1[0] + t * P.u[0], e1[1] + t * P.u[1]];
      const d1 = (corner[0] - e1[0]) * o1x + (corner[1] - e1[1]) * o1y;
      const d2 = (corner[0] - e2[0]) * o2x + (corner[1] - e2[1]) * o2y;
      if (d1 < -0.5 || d2 < -0.5) return null;
      ext1 = Math.hypot(corner[0] - e1[0], corner[1] - e1[1]);
      ext2 = Math.hypot(corner[0] - e2[0], corner[1] - e2[1]);
    }
    if (ext1 > extCap || ext2 > extCap) return null; // markers stay local
    // the corner must clear every dot of BOTH rows (spec §2.2). Applied to
    // the parallel join too: its synthetic corner crowds the facing dots as
    // the gap closes, which the spec's blanket clearance clause forbids —
    // this also keeps degenerate slid-together joins out of the DP.
    for (const d of P.dots) {
      if (Math.hypot(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    for (const d of Q.dots) {
      if (Math.hypot(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    return { cost: ext1 + ext2, corner };
  };

  // ---- step 3: pairing enumeration + chain DP over bundles -----------------
  interface DPResult {
    cost: number;
    seq: number[];      // bundle indices in chain order
    orients: number[];  // orientation bit per chain position
    states: RowState[]; // chosen state per chain position
    corners: Pixel[];   // corner after chain position k (length g-1)
  }
  const runDP = (seq: number[], mask: number): DPResult | null => {
    const orients = seq.map((_, k) => (mask >> k) & 1);
    let prev = bundleStates[seq[0]].map((st) => st.cost);
    const back: Int32Array[] = [];
    const cornerAt: Pixel[][] = [];
    for (let k = 1; k < seq.length; k++) {
      const cur = bundleStates[seq[k]];
      const pst = bundleStates[seq[k - 1]];
      const cost = new Array<number>(cur.length).fill(Infinity);
      const bk = new Int32Array(cur.length).fill(-1);
      const cn: Pixel[] = new Array(cur.length);
      for (let qi = 0; qi < cur.length; qi++) {
        let best = Infinity;
        let arg = -1;
        let bc: Pixel | null = null;
        for (let pi = 0; pi < pst.length; pi++) {
          if (prev[pi] >= best) continue; // pair cost ≥ 0: sound pruning
          const pr = pairEval(pst[pi], orients[k - 1], cur[qi], orients[k]);
          if (!pr) continue;
          const c = prev[pi] + pr.cost;
          if (c < best) { best = c; arg = pi; bc = pr.corner; }
        }
        if (arg >= 0) {
          cost[qi] = best + cur[qi].cost;
          bk[qi] = arg;
          cn[qi] = bc!;
        }
      }
      back.push(bk);
      cornerAt.push(cn);
      prev = cost;
    }
    let end = -1;
    for (let qi = 0; qi < prev.length; qi++) {
      if (isFinite(prev[qi]) && (end < 0 || prev[qi] < prev[end])) end = qi;
    }
    if (end < 0) return null;
    const chosen = new Array<number>(seq.length);
    chosen[seq.length - 1] = end;
    for (let k = seq.length - 1; k >= 1; k--) chosen[k - 1] = back[k - 1][chosen[k]];
    return {
      cost: prev[end],
      seq,
      orients,
      states: seq.map((bi, k) => bundleStates[bi][chosen[k]]),
      corners: seq.slice(1).map((_, k) => cornerAt[k][chosen[k + 1]]),
    };
  };

  let best: DPResult | null = null;
  const tryPairing = (seq: number[], mask: number) => {
    const r = runDP(seq, mask);
    if (r && (!best || r.cost < best.cost)) best = r; // strict <: first found
  };
  if (g <= 5) {
    // exhaustive g! · 2^g, in fixed lexicographic order (deterministic)
    const perm: number[] = [];
    const used = new Array(g).fill(false);
    const rec = () => {
      if (perm.length === g) {
        for (let mask = 0; mask < (1 << g); mask++) tryPairing([...perm], mask);
        return;
      }
      for (let i = 0; i < g; i++) {
        if (used[i]) continue;
        used[i] = true;
        perm.push(i);
        rec();
        perm.pop();
        used[i] = false;
      }
    };
    rec();
  } else {
    // beyond 5 bundles (unobserved — spec notes g ≤ 4): greedy sequence by
    // nearest unused head anchor, forward orientations — the solveChain
    // enumeration pattern, one level up
    const seq = [0];
    const used = new Array(g).fill(false);
    used[0] = true;
    while (seq.length < g) {
      const lastG = groups[seq[seq.length - 1]];
      const tail = anchorPos[lastG[lastG.length - 1]];
      let pick = -1;
      let bd = Infinity;
      for (let i = 0; i < g; i++) {
        if (used[i]) continue;
        const head = anchorPos[groups[i][0]];
        const d = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
        if (d < bd) { bd = d; pick = i; }
      }
      used[pick] = true;
      seq.push(pick);
    }
    tryPairing(seq, 0);
  }
  if (!best) return null;
  const win: DPResult = best;

  // ---- step 4: station-level post-checks (violation ⇒ mega signal) ---------
  // all-pairs dot floors across rows (non-adjacent included — the pair check
  // only guarded corners); 1e-9 slack so re-checking pair-level accepts is
  // float-stable
  for (let i = 0; i < g; i++) {
    for (let j = i + 1; j < g; j++) {
      for (const p of win.states[i].dots) {
        for (const q of win.states[j].dots) {
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) < minGap - 1e-9) return null;
        }
      }
    }
  }
  // corner-vs-corner and corner-vs-dot (dots of non-paired rows included)
  for (let i = 0; i < win.corners.length; i++) {
    for (let j = i + 1; j < win.corners.length; j++) {
      const ci = win.corners[i];
      const cj = win.corners[j];
      if (Math.hypot(ci[0] - cj[0], ci[1] - cj[1]) < minGap - 1e-9) return null;
    }
    for (const st of win.states) {
      for (const d of st.dots) {
        if (Math.hypot(win.corners[i][0] - d[0], win.corners[i][1] - d[1]) < minGap - 1e-9) {
          return null;
        }
      }
    }
  }

  // ---- step 5: output -------------------------------------------------------
  const pos: Pixel[] = new Array(n);
  const order: number[] = [];
  const cornerAfter = new Map<number, Pixel>();
  for (let k = 0; k < win.seq.length; k++) {
    const grp = groups[win.seq[k]];
    const st = win.states[k];
    const seqGi = win.orients[k] ? [...st.asc].reverse() : st.asc;
    for (const gi of seqGi) {
      pos[grp[gi]] = st.dots[gi];
      order.push(grp[gi]);
    }
    if (k < win.seq.length - 1) cornerAfter.set(order.length - 1, win.corners[k]);
  }
  return { pos, order, cornerAfter, cost: win.cost };
}
