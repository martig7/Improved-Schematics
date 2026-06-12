// Dots-on-lanes marker placement (spec: docs/superpowers/specs/
// 2026-06-12-dots-on-lanes-chain-dp-design.md). A dot's position is an arc
// parameter on its own lane curve; a station's marker is a chain over its
// dots, solved EXACTLY per station by dynamic programming (spec P4). The
// pair-distance target is the lane PITCH, not the dot diameter — with 2r
// the optimizer chases lane-pinch regions (crossings) instead of clean
// parallel track (spec §2.3).

import type { Pixel } from './types';

export interface LaneCurve {
  pts: Pixel[];     // windowed polyline through the station
  cum: number[];    // cumulative arc length; cum[0] = 0
  anchorT: number;  // arc position of the stop anchor
}

const arcCum = (pts: Pixel[]): number[] => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
};

export const curvePoint = (c: LaneCurve, t: number): Pixel => {
  const total = c.cum[c.cum.length - 1];
  const tt = Math.max(0, Math.min(total, t));
  let lo = 0;
  let hi = c.cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const seg = c.cum[hi] - c.cum[lo];
  const u = seg < 1e-9 ? 0 : (tt - c.cum[lo]) / seg;
  return [
    c.pts[lo][0] + (c.pts[hi][0] - c.pts[lo][0]) * u,
    c.pts[lo][1] + (c.pts[hi][1] - c.pts[lo][1]) * u,
  ];
};

export const curveTangent = (c: LaneCurve, t: number): Pixel => {
  const total = c.cum[c.cum.length - 1];
  const tt = Math.max(1e-9, Math.min(total - 1e-9, t));
  let lo = 0;
  let hi = c.cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const dx = c.pts[hi][0] - c.pts[lo][0];
  const dy = c.pts[hi][1] - c.pts[lo][1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
};

// arc position of the point on the polyline nearest to p
const projectArc = (pts: Pixel[], cum: number[], p: Pixel): number => {
  let bestD = Infinity;
  let bestT = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const ay = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dy = pts[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - (ax + dx * u), p[1] - (ay + dy * u));
    if (d < bestD) { bestD = d; bestT = cum[i - 1] + Math.sqrt(l2) * u; }
  }
  return bestT;
};

// clip a polyline to the arc range [t0, t1]
const clipArc = (pts: Pixel[], cum: number[], t0: number, t1: number): Pixel[] => {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(t0, total));
  const b = Math.max(a, Math.min(t1, total));
  const tmp: LaneCurve = { pts, cum, anchorT: 0 };
  const out: Pixel[] = [curvePoint(tmp, a)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] > a && cum[i] < b) out.push(pts[i]);
  }
  out.push(curvePoint(tmp, b));
  return out;
};

/** Chain a line's incident lane polylines (each oriented AWAY from the
 *  node) into one curve through the station, windowed to ±arcLimit of the
 *  stop anchor. Terminus lines contribute one side; their domain ends at
 *  the drawn tip. */
export const buildLaneCurve = (
  incident: Pixel[][],
  anchor: Pixel,
  arcLimit: number,
): LaneCurve => {
  const lenOf = (p: Pixel[]) => arcCum(p)[p.length - 1];
  const sides = incident
    .filter((p) => p.length >= 2)
    .sort((x, y) => lenOf(y) - lenOf(x))
    .slice(0, 2);
  let pts: Pixel[];
  if (sides.length === 0) pts = [anchor, [anchor[0] + 1e-6, anchor[1]]];
  else if (sides.length === 1) pts = [...sides[0]].reverse();
  // orientation convention: the curve runs shorter-side → node → longer
  // side, so t increases toward the LONGER side. Consumers must not assume
  // a geographic direction — curveTangent users sign-normalize, and group
  // reversal is explored by the solver's orientation mask.
  else pts = [...sides[1]].reverse().concat(sides[0]);
  const dd: Pixel[] = [pts[0]];
  for (const p of pts) {
    const q = dd[dd.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) dd.push(p);
  }
  if (dd.length < 2) dd.push([dd[0][0] + 1e-6, dd[0][1]]);
  let cum = arcCum(dd);
  const aT = projectArc(dd, cum, anchor);
  const clipped = clipArc(dd, cum, aT - arcLimit, aT + arcLimit);
  cum = arcCum(clipped);
  return { pts: clipped, cum, anchorT: projectArc(clipped, cum, anchor) };
};

/** Ramer–Douglas–Peucker on a point chain (used for the rendered spine). */
export const rdpSimplify = (pts: Pixel[], eps: number): Pixel[] => {
  if (pts.length <= 2) return [...pts];
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0;
    let wi = -1;
    const ax = pts[a][0];
    const ay = pts[a][1];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2));
      const d = Math.hypot(pts[i][0] - (ax + dx * u), pts[i][1] - (ay + dy * u));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps && wi > 0) {
      keep[wi] = true;
      stack.push([a, wi], [wi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
};

export interface ChainOpts {
  pitch: number;    // ρ — lane pitch, the pair-distance target (NOT 2r)
  minGap: number;   // hard non-overlap floor (2r − 0.05)
  step?: number;    // state grid, px (default 0.5)
  anchorW?: number; // λ (default 0.05)
  linkW?: number;   // inter-group link weight (default 0.25, one-sided)
  /** Spec §6 inter-station mask: states whose position is vetoed (e.g.
   *  too close to an already-placed neighboring marker) are infeasible. */
  blocked?: (p: Pixel) => boolean;
}

export interface ChainSolution {
  order: number[]; // station-wide visiting order (indices into curves)
  t: number[];     // chosen arc parameter per curve index
  pos: Pixel[];    // curvePoint(curves[i], t[i]) per curve index
}

/** Exact minimizer of the spec §2.3 chain energy by DP over discretized
 *  arc parameters. Groups are pre-ordered (lane order); group sequence and
 *  orientation are chosen exhaustively by link rest-length (≤5 groups),
 *  greedily beyond. Deterministic. */
export const solveChain = (
  curves: LaneCurve[],
  groups: number[][],
  o: ChainOpts,
): ChainSolution => {
  const step = o.step ?? 0.5;
  const anchorW = o.anchorW ?? 0.05;
  const linkW = o.linkW ?? 0.25;
  const n = curves.length;
  const anchorPos = curves.map((c) => curvePoint(c, c.anchorT));
  if (n === 1) {
    return { order: [0], t: [curves[0].anchorT], pos: [anchorPos[0]] };
  }

  // ---- group sequence + orientation: min total link rest length ----------
  const g = groups.length;
  let bestOrder: number[] | null = null;
  let bestCost = Infinity;
  const evalOrder = (permIdx: number[], mask: number) => {
    let cost = 0;
    let prevEnd: Pixel | null = null;
    const order: number[] = [];
    for (let k = 0; k < g; k++) {
      const gi = groups[permIdx[k]];
      const seq = ((mask >> k) & 1) === 1 ? [...gi].reverse() : gi;
      const head = anchorPos[seq[0]];
      if (prevEnd) cost += Math.hypot(head[0] - prevEnd[0], head[1] - prevEnd[1]);
      prevEnd = anchorPos[seq[seq.length - 1]];
      order.push(...seq);
    }
    if (cost < bestCost) { bestCost = cost; bestOrder = order; }
  };
  if (g <= 5) {
    const perm: number[] = [];
    const used = new Array(g).fill(false);
    const rec = () => {
      if (perm.length === g) {
        for (let mask = 0; mask < (1 << g); mask++) evalOrder(perm, mask);
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
    // greedy: start at group 0, append nearest unused group end
    const seq = [0];
    const used = new Array(g).fill(false);
    used[0] = true;
    while (seq.length < g) {
      const lastG = groups[seq[seq.length - 1]];
      const tail = anchorPos[lastG[lastG.length - 1]];
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < g; i++) {
        if (used[i]) continue;
        const head = anchorPos[groups[i][0]];
        const d = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
        if (d < bd) { bd = d; best = i; }
      }
      used[best] = true;
      seq.push(best);
    }
    bestOrder = seq.flatMap((i) => groups[i]);
  }
  const order = bestOrder ?? groups.flat();
  const groupOf = new Array(n).fill(0);
  groups.forEach((gi, idx) => gi.forEach((i) => { groupOf[i] = idx; }));

  // ---- DP over the chain ---------------------------------------------------
  const states = order.map((i) => {
    const total = curves[i].cum[curves[i].cum.length - 1];
    const st: number[] = [];
    for (let t = 0; t <= total + 1e-9; t += step) st.push(Math.min(t, total));
    return st;
  });
  const statePos = order.map((i, k) => states[k].map((t) => curvePoint(curves[i], t)));
  const vetoed = (p: Pixel): boolean => (o.blocked ? o.blocked(p) : false);
  let prevCost = states[0].map(
    (t, s0) => (vetoed(statePos[0][s0]) ? Infinity :
      anchorW * (t - curves[order[0]].anchorT) ** 2),
  );
  const back: Int32Array[] = [];
  for (let k = 1; k < order.length; k++) {
    const i = order[k];
    const isLink = groupOf[i] !== groupOf[order[k - 1]];
    const pj = statePos[k - 1];
    const cost = new Array<number>(states[k].length).fill(Infinity);
    const bk = new Int32Array(states[k].length).fill(-1);
    for (let s = 0; s < states[k].length; s++) {
      const p = statePos[k][s];
      if (vetoed(p)) { cost[s] = Infinity; bk[s] = -1; continue; }
      let best = Infinity;
      let arg = -1;
      for (let s2 = 0; s2 < pj.length; s2++) {
        if (prevCost[s2] >= best) continue; // pair cost ≥ 0: sound pruning
        const d = Math.hypot(p[0] - pj[s2][0], p[1] - pj[s2][1]);
        if (d < o.minGap) continue;
        // intra: |d² − ρ²| — EXACTLY Δt² on parallel lanes (quadratic in
        // stagger; (d−ρ)² is quartic there and loses to the anchors —
        // brute-force verified). links: one-sided quadratic in excess.
        const ex = d - o.pitch;
        const pc = isLink
          ? (ex > 0 ? linkW * ex * ex : 0)
          : Math.abs(d * d - o.pitch * o.pitch);
        const c2 = prevCost[s2] + pc;
        if (c2 < best) { best = c2; arg = s2; }
      }
      cost[s] = best + anchorW * (states[k][s] - curves[i].anchorT) ** 2;
      bk[s] = arg;
    }
    back.push(bk);
    prevCost = cost;
  }
  let s = 0;
  for (let i2 = 1; i2 < prevCost.length; i2++) {
    if (prevCost[i2] < prevCost[s]) s = i2;
  }
  if (!isFinite(prevCost[s])) {
    // no feasible chain in the window (extreme floor conflicts): degrade
    // gracefully to anchors — dots stay on their lanes either way
    return { order, t: curves.map((c) => c.anchorT), pos: anchorPos };
  }
  const chosen = new Array<number>(order.length).fill(0);
  chosen[order.length - 1] = s;
  for (let k = order.length - 1; k >= 1; k--) {
    s = back[k - 1][s];
    if (s < 0) s = 0;
    chosen[k - 1] = s;
  }
  const t = new Array<number>(n).fill(0);
  const pos: Pixel[] = new Array(n);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    t[i] = states[k][chosen[k]];
    pos[i] = statePos[k][chosen[k]];
  }
  return { order, t, pos };
};
