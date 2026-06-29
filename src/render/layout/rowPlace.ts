// Rigid-row marker placement (spec: docs/superpowers/specs/
// 2026-06-12-rigid-row-markers-design.md, v2). The unit of optimization is
// the bundle ROW — a straight octilinear line whose dots are intersections
// of the row line with the member lane curves. Collinearity, on-lane-ness
// and octilinearity hold by construction (R1/R2); the pairing-conditioned
// chain DP is exact on the discretized state space (R3); the only fallback
// is the caller's mega box on a null return (R4 — no partial degradation).

import type { Pixel } from './types';
import { type LaneCurve, curvePoint, curveTangent } from './chainPlace';

// sqrt(a²+b²) — correctly-rounded cross-V8 (Math.hypot is not), so marker
// placement (and the box-vs-row decision it feeds) is bit-identical on any engine.
const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface RowOpts {
  minGap: number;        // 2r - 0.05
  arcLimit: number;      // slide window each side (24; caller escalates to 48)
  step?: number;         // slide grid, default 0.5
  extCap: number;        // max extension per row at a corner (6 * spacing)
  slideW?: number;       // W_S, default 0.05
  rotW?: number;         // W_ROT, default 20 (px per 45-degree step)
  blocked?: (p: Pixel) => boolean; // spec §6 mask — a row state is infeasible
                                   // if ANY of its dots is blocked (never dropped)
  proximity?: (p: Pixel) => number; // SOFT §6 mask — per-dot proximity penalty
                                     // (≥0) added to the state cost; biases the
                                     // search toward spacing without vetoing a
                                     // crowded-but-feasible seat (MASKED hubs)
  dbgLabel?: string; // OCTI_PLACE_DEBUG: station id, for the per-box diagnosis log
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

// OCTI_PLACE_DEBUG only: why a bundle's row states all failed (→ mega box).
interface BundleStat {
  tried: number;      // (slide × axis) states enumerated
  noCross: number;    // states where a member lane never crossed the row line
  pinch: number;      // states where consecutive dots fell below minGap
  blocked: number;    // states vetoed by the §6 mask (already-placed dots)
  bestMinGap: number; // largest min-gap among states that crossed all lanes
}

/** Crossings of the row LINE (A, u) with a lane polyline: walk the vertices
 *  computing the signed lateral offset (pt−A)·n, n = perp(u); a sign change
 *  brackets a crossing (lerp). Returns the crossing nearest `near` (the
 *  member's own anchor), or null when the line misses the windowed lane.
 *  A vertex on the line (|offset| ~ 0) counts as a crossing itself — for a
 *  segment collinear with the row line that admits its endpoints, which is
 *  enough: the truly degenerate row-along-own-lane states either die on the
 *  floor checks or belong to single-member bundles (special-cased below). */
export const lineCrossNearest = (c: LaneCurve, A: Pixel, u: Pixel, near: Pixel): Pixel | null => {
  const nx = -u[1];
  const ny = u[0];
  let best: Pixel | null = null;
  let bestD = Infinity;
  const consider = (p: Pixel) => {
    // squared distance — monotone-equivalent to the true distance for the
    // nearest-crossing pick, but correctly-rounded (no Math.hypot), so the
    // choice is bit-stable across V8 engines (matters when a folded lane
    // admits two crossings; the collision slide reuses this primitive).
    const dx = p[0] - near[0];
    const dy = p[1] - near[1];
    const d = dx * dx + dy * dy;
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
  // Turn penalty: charge each corner for how much the chain BENDS, so the DP
  // prefers a straighter capsule (a parallel end-to-end join, or the gentlest
  // V) over a sharp elbow when the dots admit it. (1 + o1·o2) ∈ [0,2]: 0 for a
  // straight join, 1 at 90°, 2 at a reversal — cross-V8-safe (dot only) and ≥0
  // so the chain-DP pruning stays sound. OCTI_TURNW tunes it (0 = off).
  const turnW = (() => {
    const v =
      typeof process !== 'undefined' ? Number((process as { env?: Record<string, string> }).env?.OCTI_TURNW) : NaN;
    return Number.isFinite(v) ? v : 12;
  })();
  const { minGap, arcLimit, extCap, blocked, proximity } = opts;
  const n = curves.length;
  const g = groups.length;
  const anchorPos = curves.map((c) => curvePoint(c, c.anchorT));

  // ---- step 1: row states per bundle --------------------------------------
  const buildStates = (group: number[], stats?: BundleStat): RowState[] => {
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
    // Quantize atan2 (not correctly-rounded cross-V8) to 1e-6 rad — absorbs the
    // engine ULP diff while preserving the rest-axis snap (round below).
    const perpAng = Math.round(Math.atan2(mx, -my) * 1e6) / 1e6; // angle of the perp vector (-my, mx)
    const restIdx = ((Math.round(perpAng / QUARTER) % 4) + 4) % 4;
    const m = Math.max(0, Math.round(arcLimit / step));
    const states: RowState[] = [];
    for (let j = -m; j <= m; j++) {
      const s = j * step;
      const A = curvePoint(carrier, carrier.anchorT + s);
      for (let axis = 0; axis < 4; axis++) {
        if (stats) stats.tried++;
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
          if (!hit) { if (stats) stats.noCross++; continue; } // a member's lane never crosses the row line
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
          // min consecutive gap (equiv. to the original first-violation break:
          // feasible iff every gap ≥ minGap iff the min gap ≥ minGap)
          let mg = Infinity;
          for (let gi = 1; gi < dots.length; gi++) {
            const gap = (pr[gi] - pr[gi - 1]) * sgn;
            if (gap < mg) mg = gap;
          }
          if (stats && mg > stats.bestMinGap) stats.bestMinGap = mg; // this state crossed all lanes
          if (mg < minGap) { feas = false; if (stats) stats.pinch++; }
        }
        if (feas && blocked) {
          for (const p of dots) {
            if (blocked(p)) { feas = false; if (stats) stats.blocked++; break; } // §6 mask — never dropped
          }
        }
        if (!feas) continue;
        // SOFT §6 mask: instead of vetoing crowded dots, charge a per-dot
        // proximity penalty so the chain-DP biases toward states that seat
        // clear of already-placed neighbours but STILL seats a crowded hub
        // (MASKED boxes) rather than mega-boxing it.
        let proxPen = 0;
        if (proximity) for (const p of dots) proxPen += proximity(p);
        const asc = dots.map((_, gi) => gi).sort((x, y) => (pr[x] - pr[y]) || (x - y)); // total tie-break: index unique (cross-V8 stable)
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
          cost: slideW * Math.abs(s) + rotW * rot + proxPen,
        });
      }
    }
    return states;
  };
  const dbg =
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_PLACE_DEBUG === '1';
  const statsArr: BundleStat[] = [];
  const bundleStates = groups.map((grp, i) => {
    const st: BundleStat | undefined = dbg
      ? { tried: 0, noCross: 0, pinch: 0, blocked: 0, bestMinGap: -Infinity }
      : undefined;
    if (st) statsArr[i] = st;
    return buildStates(grp, st);
  });
  // a bundle with no feasible row anywhere dooms every pairing → mega box
  if (bundleStates.some((st) => st.length === 0)) {
    if (dbg) {
      for (let i = 0; i < groups.length; i++) {
        if (bundleStates[i].length > 0) continue;
        const s = statsArr[i];
        const grp = groups[i];
        // Min pairwise separation of member stop-anchors. When two members
        // coincide here, their lanes are interlined on ONE drawn edge — the
        // COINCIDENT failure (no spacing can separate them), as opposed to a
        // PINCHED bundle whose lanes are distinct but merely seated too tight.
        let minAnchorSep = Infinity;
        for (let a = 0; a < grp.length; a++) {
          for (let b = a + 1; b < grp.length; b++) {
            const d = hyp(anchorPos[grp[a]][0] - anchorPos[grp[b]][0], anchorPos[grp[a]][1] - anchorPos[grp[b]][1]);
            if (d < minAnchorSep) minAnchorSep = d;
          }
        }
        // bestMinGap is the largest (over all all-lanes-crossing states) of the
        // min consecutive signed gap. A non-positive value means even the best
        // row has a coincident/order-reversed pair → lanes crossed/interlined,
        // which no positive spacing (minGap relaxation) can recover. That is
        // COINCIDENT; a positive-but-sub-minGap gap is the spacing-fixable PINCHED.
        const crossedAny = s.bestMinGap > -Infinity;
        const cls =
          s.noCross >= s.tried
            ? 'NO-CROSSING (lanes never admit a row-line crossing → divergent/coincident; NOT slide/spacing fixable)'
            : crossedAny && s.bestMinGap <= 0
              ? `COINCIDENT (best gap ${s.bestMinGap.toFixed(2)}px ≤ 0 → member lanes interlined/crossed on one drawn edge; NOT spacing-fixable — needs upstream octi/topo de-weld)`
              : crossedAny && s.bestMinGap < minGap
                ? `PINCHED (closest gap ${s.bestMinGap.toFixed(2)}px < minGap ${minGap.toFixed(2)}px → octi seated the lanes too tight; fixable UPSTREAM)`
                : s.blocked > 0
                  ? 'MASKED (§6: every crossing state vetoed by an already-placed station → ordering-dependent)'
                  : 'UNKNOWN';
        const gapStr = crossedAny ? `${s.bestMinGap.toFixed(2)}px` : 'never crossed';
        const sepStr = minAnchorSep === Infinity ? 'n/a' : `${minAnchorSep.toFixed(2)}px`;
        console.error(
          `[rowPlace] BOX ${opts.dbgLabel ?? '?'} bundle ${i + 1}/${g} members=${groups[i].length}: ` +
            `${s.tried} states (noCross=${s.noCross} pinch=${s.pinch} blocked=${s.blocked}) ` +
            `closestGap=${gapStr} minAnchorSep=${sepStr} minGap=${minGap.toFixed(2)}px → ${cls}`,
        );
      }
    }
    return null;
  }

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
    // cross-row dot floor at PAIR level (spec §2.2: station-level checks cover
    // NON-adjacent rows — adjacent floors must hold here). Without it the
    // ext-minimizing argmin can pull facing dots of a 45° pair to ~0.77*minGap
    // (corner still clears both), and the station post-check then nulls the
    // whole solve to mega even though feasible configurations exist.
    for (const p of P.dots) {
      for (const q of Q.dots) {
        if (hyp(p[0] - q[0], p[1] - q[1]) < minGap) return null;
      }
    }
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
      ext1 = hyp(corner[0] - e1[0], corner[1] - e1[1]);
      ext2 = hyp(corner[0] - e2[0], corner[1] - e2[1]);
    }
    // SOFT elbow: the ext1+ext2 cost term already biases the DP toward short
    // connectors, so extCap is kept only as a LARGE safety bound (a runaway
    // elbow that reaches across the map is still rejected). Divergent bundles
    // whose facing ends sit beyond the old hard cap (Beach & Mason ms15,
    // Columbus ms17) now PAIR — their elbow length is simply paid for in cost.
    if (ext1 > extCap || ext2 > extCap) return null; // safety bound only (extCap now large)
    // the corner must clear every dot of BOTH rows (spec §2.2). Applied to
    // the parallel join too: its synthetic corner crowds the facing dots as
    // the gap closes, which the spec's blanket clearance clause forbids —
    // this also keeps degenerate slid-together joins out of the DP.
    for (const d of P.dots) {
      if (hyp(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    for (const d of Q.dots) {
      if (hyp(corner[0] - d[0], corner[1] - d[1]) < minGap) return null;
    }
    const turnPen = turnW * (1 + (o1x * o2x + o1y * o2y)); // ≥0; 0 = straight join
    return { cost: ext1 + ext2 + turnPen, corner };
  };

  // ---- step 3: pairing enumeration + chain DP over bundles -----------------
  interface DPResult {
    cost: number;
    seq: number[];      // bundle indices in chain order
    orients: number[];  // orientation bit per chain position
    states: RowState[]; // chosen state per chain position
    corners: Pixel[];   // corner after chain position k (length g-1)
  }
  // §2.2 station-level floors (all-pairs NON-adjacent dot floor + corner
  // clearance; adjacent pairs are already floored in pairEval). Run per
  // (seq,mask) inside runDP (idea ③) so a colliding pairing is rejected and the
  // search keeps going, instead of nulling the whole station after the global
  // min-cost pairing was chosen (the mn199 / "7 St" box class).
  let dbgMinNonAdj = Infinity; // OCTI_PLACE_DEBUG: closest non-adjacent gap seen
  const stationFloorsOk = (states: RowState[], corners: Pixel[]): boolean => {
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        for (const p of states[i].dots) {
          for (const q of states[j].dots) {
            const dd = hyp(p[0] - q[0], p[1] - q[1]);
            if (dd < minGap - 1e-9) {
              if (dbg) dbgMinNonAdj = Math.min(dbgMinNonAdj, dd);
              return false;
            }
          }
        }
      }
    }
    for (let i = 0; i < corners.length; i++) {
      for (let j = i + 1; j < corners.length; j++) {
        if (hyp(corners[i][0] - corners[j][0], corners[i][1] - corners[j][1]) < minGap - 1e-9) return false;
      }
      for (const st of states) {
        for (const d of st.dots) {
          if (hyp(corners[i][0] - d[0], corners[i][1] - d[1]) < minGap - 1e-9) return false;
        }
      }
    }
    return true;
  };
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
    const states = seq.map((bi, k) => bundleStates[bi][chosen[k]]);
    const corners = seq.slice(1).map((_, k) => cornerAt[k][chosen[k + 1]]);
    // idea ③: reject this (seq,mask) if its min-cost chain violates a station
    // floor, so tryPairing keeps searching other permutations/orientations.
    if (!stationFloorsOk(states, corners)) return null;
    return { cost: prev[end], seq, orients, states, corners };
  };

  // Orientation-FOLDED DP: rather than a separate fixed-orientation DP for each of
  // the 2^g masks, fold orientation into the DP STATE (state index × orient bit), so
  // ONE DP per permutation jointly minimizes over all orientation assignments. This
  // removes the 2^(g-2) cross-mask redundancy by RESTRUCTURING — not by caching
  // (pairEval is ~50ns, too cheap to memoize; see docs/fresh-gen-plan.md). Returns
  // {fallback:true} when the cheapest chain over all orientations violates a station
  // floor: stationFloorsOk is all-pairs (not chain-decomposable), so we then run the
  // exhaustive per-mask search for that permutation, recovering the EXACT feasibility
  // outcome (so the mega-box set is unchanged). NOT byte-identical: equal-cost
  // orientation ties may resolve differently than the mask-order first-found rule.
  const runDPFolded = (seq: number[]): { r: DPResult | null; fallback: boolean } => {
    const s0 = bundleStates[seq[0]];
    let prev = new Array<number>(s0.length * 2);
    for (let si = 0; si < s0.length; si++) { prev[si * 2] = s0[si].cost; prev[si * 2 + 1] = s0[si].cost; }
    const back: Int32Array[] = [];
    const cornerAt: Pixel[][] = [];
    for (let k = 1; k < seq.length; k++) {
      const cur = bundleStates[seq[k]];
      const pst = bundleStates[seq[k - 1]];
      const cost = new Array<number>(cur.length * 2).fill(Infinity);
      const bk = new Int32Array(cur.length * 2).fill(-1);
      const cn: Pixel[] = new Array(cur.length * 2);
      for (let qi = 0; qi < cur.length; qi++) {
        for (let oq = 0; oq < 2; oq++) {
          const qIdx = qi * 2 + oq;
          let bestC = Infinity;
          let arg = -1;
          let bc: Pixel | null = null;
          for (let pi = 0; pi < pst.length; pi++) {
            for (let op = 0; op < 2; op++) {
              const pIdx = pi * 2 + op;
              if (prev[pIdx] >= bestC) continue; // pair cost ≥ 0: sound pruning
              const pr = pairEval(pst[pi], op, cur[qi], oq);
              if (!pr) continue;
              const c = prev[pIdx] + pr.cost;
              if (c < bestC) { bestC = c; arg = pIdx; bc = pr.corner; }
            }
          }
          if (arg >= 0) { cost[qIdx] = bestC + cur[qi].cost; bk[qIdx] = arg; cn[qIdx] = bc!; }
        }
      }
      back.push(bk);
      cornerAt.push(cn);
      prev = cost;
    }
    let end = -1;
    for (let qIdx = 0; qIdx < prev.length; qIdx++) {
      if (isFinite(prev[qIdx]) && (end < 0 || prev[qIdx] < prev[end])) end = qIdx;
    }
    if (end < 0) return { r: null, fallback: false }; // no finite chain — no mask can do better
    const chosen = new Array<number>(seq.length);
    chosen[seq.length - 1] = end;
    for (let k = seq.length - 1; k >= 1; k--) chosen[k - 1] = back[k - 1][chosen[k]];
    const orients = chosen.map((ci) => ci & 1);
    const states = seq.map((bi, k) => bundleStates[bi][chosen[k] >> 1]);
    const corners = seq.slice(1).map((_, k) => cornerAt[k][chosen[k + 1]]);
    if (!stationFloorsOk(states, corners)) return { r: null, fallback: true };
    return { r: { cost: prev[end], seq, orients, states, corners }, fallback: false };
  };

  // Held-Karp subset DP: the global min-cost Hamiltonian PATH over the g bundles,
  // with orientation folded into the DP state (sub-state = stateIndex*2 + orientBit).
  // dp[mask][i] is the min cost of a chain covering exactly the bundle set `mask`,
  // ending at bundle i in each sub-state; the unique predecessor subset of (mask,i) is
  // mask\{i}. This computes each ordered (bundle-pair, state, orient) transition once
  // per containing subset — O(2^g·g²·states²) vs the folded permutation enumeration's
  // O(g!·states²) — so each pairEval combo is evaluated 2^(g-2) times instead of (g-1)!
  // (≈3× fewer at g5). Returns the unconstrained global min chain (floor checked by the
  // caller); null if no finite chain exists.
  const heldKarp = (): DPResult | null => {
    const full = (1 << g) - 1;
    const cell = (mask: number, i: number) => mask * g + i;
    const dp: (Float64Array | undefined)[] = new Array((1 << g) * g);
    const bkI: (Int32Array | undefined)[] = new Array((1 << g) * g); // predecessor bundle
    const bkS: (Int32Array | undefined)[] = new Array((1 << g) * g); // predecessor sub-state
    const bkC: ((Pixel | null)[] | undefined)[] = new Array((1 << g) * g); // corner to predecessor
    for (let i = 0; i < g; i++) { // singletons: orient is free, state cost independent of it
      const sz = bundleStates[i].length * 2;
      const d = new Float64Array(sz);
      for (let si = 0; si < sz; si++) d[si] = bundleStates[i][si >> 1].cost;
      const c = cell(1 << i, i);
      dp[c] = d; bkI[c] = new Int32Array(sz).fill(-1); bkS[c] = new Int32Array(sz).fill(-1);
      bkC[c] = new Array(sz).fill(null);
    }
    for (let mask = 1; mask <= full; mask++) {
      for (let i = 0; i < g; i++) {
        if (!(mask & (1 << i))) continue;
        const di = dp[cell(mask, i)];
        if (!di) continue;
        const iStates = bundleStates[i];
        const szi = di.length;
        for (let j = 0; j < g; j++) {
          if (mask & (1 << j)) continue;
          const nmask = mask | (1 << j);
          const jStates = bundleStates[j];
          const szj = jStates.length * 2;
          const nc = cell(nmask, j);
          let dj = dp[nc];
          if (!dj) {
            dj = new Float64Array(szj).fill(Infinity); dp[nc] = dj;
            bkI[nc] = new Int32Array(szj).fill(-1); bkS[nc] = new Int32Array(szj).fill(-1);
            bkC[nc] = new Array(szj).fill(null);
          }
          const nI = bkI[nc]!, nS = bkS[nc]!, nC = bkC[nc]!;
          for (let sj = 0; sj < szj; sj++) {
            const cj = jStates[sj >> 1].cost;
            let bestExcl = dj[sj] - cj; // best-so-far over earlier predecessors i', minus cur cost
            for (let si = 0; si < szi; si++) {
              const base = di[si];
              if (base >= bestExcl) continue; // pair cost ≥ 0: sound pruning
              const pr = pairEval(iStates[si >> 1], si & 1, jStates[sj >> 1], sj & 1);
              if (!pr) continue;
              const c = base + pr.cost;
              if (c < bestExcl) { bestExcl = c; nI[sj] = i; nS[sj] = si; nC[sj] = pr.corner; }
            }
            const tot = bestExcl + cj;
            if (tot < dj[sj]) dj[sj] = tot;
          }
        }
      }
    }
    let bestCost = Infinity, bi = -1, bsi = -1;
    for (let i = 0; i < g; i++) {
      const d = dp[cell(full, i)];
      if (!d) continue;
      for (let si = 0; si < d.length; si++) if (d[si] < bestCost) { bestCost = d[si]; bi = i; bsi = si; }
    }
    if (bi < 0) return null;
    const revSeq: number[] = [], revStates: RowState[] = [], revOrient: number[] = [], revCorner: Pixel[] = [];
    let mask = full, i = bi, si = bsi;
    while (i >= 0) {
      revSeq.push(i); revStates.push(bundleStates[i][si >> 1]); revOrient.push(si & 1);
      const pi = bkI[cell(mask, i)]![si];
      if (pi < 0) break;
      revCorner.push(bkC[cell(mask, i)]![si]!); // corner between predecessor pi and i
      const psi = bkS[cell(mask, i)]![si];
      mask &= ~(1 << i); i = pi; si = psi;
    }
    revSeq.reverse(); revStates.reverse(); revOrient.reverse(); revCorner.reverse();
    return { cost: bestCost, seq: revSeq, orients: revOrient, states: revStates, corners: revCorner };
  };

  let best: DPResult | null = null;
  const tryKeep = (r: DPResult | null) => {
    if (r && (!best || r.cost < best.cost)) best = r; // strict <: first found
  };
  const fullMaskEnum = (seq: number[]) => {
    for (let mask = 0; mask < (1 << seq.length); mask++) tryKeep(runDP(seq, mask));
  };
  const tryFolded = (seq: number[]) => {
    const f = runDPFolded(seq);
    if (f.r) tryKeep(f.r);
    else if (f.fallback) fullMaskEnum(seq); // cheapest chain failed a floor — search all orientations
  };
  // Exhaustive fallback: all g! permutations (deterministic lexicographic order), each
  // a folded DP with a per-mask floor fallback. This is the proven feasible-chain search
  // that fixes the mega-box set — Held-Karp defers to it when its optimum fails a floor.
  const foldedEnum = () => {
    const perm: number[] = [];
    const used = new Array(g).fill(false);
    const rec = () => {
      if (perm.length === g) { tryFolded([...perm]); return; }
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
  };
  if (g === 5) {
    // g=5 is the pathological case: the folded enumeration is g!·2^g/2^g = 5! = 120
    // permutations, each a 776²-wide DP — one such station dominated London (~24s, 80%
    // of its placement cost). Held-Karp collapses the permutations (each ordered pair
    // evaluated 2^(g-2)=8× instead of (g-1)!=24×, ~3× fewer pairEval). Fast PRE-PASS: if
    // its global-min chain clears the all-pairs station floor, take it; else fall back to
    // the exhaustive folded enumeration, preserving the mega-box set exactly.
    //   Gated to g=5 deliberately: at g≤4 the fold is already fast and Held-Karp's gain
    // is marginal, while its fall-back (when the cheapest chain fails a floor, common on
    // dense/boxy layouts like SF) costs MORE than it saves — measured a 1.4× regression
    // on SF when applied at g4. g=5 has the opposite profile: huge base cost, optimum
    // usually feasible.
    const hk = heldKarp();
    if (hk && stationFloorsOk(hk.states, hk.corners)) best = hk;
    else foldedEnum();
  } else if (g <= 5) {
    foldedEnum(); // g ≤ 4: the orientation-folded permutation enumeration (proven, fast)
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
        const d = hyp(head[0] - tail[0], head[1] - tail[1]);
        if (d < bd) { bd = d; pick = i; }
      }
      used[pick] = true;
      seq.push(pick);
    }
    tryKeep(runDP(seq, 0));
  }
  if (!best) {
    if (dbg) {
      const reason =
        dbgMinNonAdj < Infinity
          ? `NON-ADJACENT-FLOOR closest ${dbgMinNonAdj.toFixed(2)}px < minGap ${minGap.toFixed(2)}px → ` +
            `${dbgMinNonAdj < 1 ? 'COINCIDENT/structural (NOT fixable by spacing)' : 'near-miss'} ` +
            `— no pairing/orientation avoids it (idea ③ tried all g!·2^g)`
          : `NO-PAIRING (g=${g}; cross-row dot floor / corner clearance / ext-cap / V-not-T; ` +
            `minGap ${minGap.toFixed(2)}px)`;
      console.error(`[rowPlace] BOX ${opts.dbgLabel ?? '?'}: ${reason}`);
    }
    return null;
  }
  const win: DPResult = best;
  // station-level non-adjacent + corner floors are now enforced INSIDE runDP per
  // (seq,mask) (idea ③), so `best` already satisfies them — no post-check here.

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
