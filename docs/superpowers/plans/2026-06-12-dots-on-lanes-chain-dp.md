# Dots-on-Lanes Chain-DP Marker Placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cross-line station-marker placement stack with the spec'd dots-on-lanes model: each dot is an arc parameter on its own lane curve, the station's chain is solved exactly by DP, and the capsule renders as a stroked spine through the dots.

**Architecture:** New pure module `src/render/layout/chainPlace.ts` (lane curves, chain ordering, exact DP solver, RDP). `renderOctilinear.ts` builds curves/groups per station, calls the solver, writes back positions + chain indices, and **deletes** the perpendicular collapse, seatOnLane corrections, PAV fights, the 2-D elbow solver, normalization, and the snap pass. `stops.ts` replaces the per-segment stadium + joint renderer with a spine path. Gates updated to parse spine paths and to a tighter seating threshold.

**Tech Stack:** TypeScript, node:test via `npm test` (`tsx --test`), offline render via `dev/render-from-dump.ts`, gates `dev/_chk-*.ts`. Spec: `docs/superpowers/specs/2026-06-12-dots-on-lanes-chain-dp-design.md` (read it first; the energy/targets are NOT tunable on a whim — pitch target ρ, not 2r, is load-bearing, see spec §2.3).

**Baseline note:** before Task 1, snapshot baselines: `npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_base-nyc` and `npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_base-sea`. Map-wide marker movement is EXPECTED; evaluation is by gates + named-station crops, not zero-diff.

---

### Task 1: chainPlace — lane curves and geometry

**Files:**
- Create: `src/render/layout/chainPlace.ts`
- Test: `src/render/layout/chainPlace.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/render/layout/chainPlace.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaneCurve, curvePoint, curveTangent, rdpSimplify,
} from './chainPlace';
import type { Pixel } from './types';

test('buildLaneCurve chains two incident sides through the node', () => {
  // both sides oriented AWAY from the node at (0,0): east and west
  const east: Pixel[] = [[0, 0], [50, 0]];
  const west: Pixel[] = [[0, 0], [-50, 0]];
  const c = buildLaneCurve([east, west], [0, 0], 24);
  const total = c.cum[c.cum.length - 1];
  assert.ok(Math.abs(total - 48) < 0.01);          // windowed to ±24
  assert.ok(Math.abs(c.anchorT - 24) < 0.01);      // anchor mid-curve
  const p = curvePoint(c, c.anchorT);
  assert.ok(Math.hypot(p[0], p[1]) < 0.01);        // anchor point = node
});

test('buildLaneCurve terminus (one side) ends at the node', () => {
  const only: Pixel[] = [[0, 0], [50, 0]];
  const c = buildLaneCurve([only], [0, 0], 24);
  const total = c.cum[c.cum.length - 1];
  assert.ok(Math.abs(total - 24) < 0.01);          // one side, windowed
  assert.ok(Math.abs(c.anchorT - total) < 0.01);   // anchor at the tip end
});

test('curvePoint clamps and interpolates', () => {
  const c = buildLaneCurve([[[0, 0], [10, 0]], [[0, 0], [-10, 0]]], [0, 0], 24);
  assert.deepEqual(curvePoint(c, -5), curvePoint(c, 0));
  const mid = curvePoint(c, c.anchorT + 5);
  assert.ok(Math.abs(mid[0] - 5) < 0.01 && Math.abs(mid[1]) < 0.01);
});

test('curveTangent is unit and follows the polyline', () => {
  const c = buildLaneCurve([[[0, 0], [0, 30]], [[0, 0], [0, -30]]], [0, 0], 24);
  const tg = curveTangent(c, c.anchorT);
  assert.ok(Math.abs(Math.abs(tg[1]) - 1) < 1e-6 && Math.abs(tg[0]) < 1e-6);
});

test('rdpSimplify collapses near-collinear chains, keeps corners', () => {
  const wiggle: Pixel[] = [[0, 0], [5, 0.3], [10, -0.2], [15, 0.1], [20, 0]];
  assert.equal(rdpSimplify(wiggle, 0.75).length, 2);
  const corner: Pixel[] = [[0, 0], [10, 0], [10, 10]];
  assert.equal(rdpSimplify(corner, 0.75).length, 3);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/chainPlace.test.ts`
Expected: FAIL — `Cannot find module './chainPlace'`.

- [ ] **Step 3: Implement the geometry layer**

```ts
// src/render/layout/chainPlace.ts
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
  else pts = [...sides[0]].reverse().concat(sides[1]);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test src/render/layout/chainPlace.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/layout/chainPlace.ts src/render/layout/chainPlace.test.ts
git commit -m "feat(chain): lane curves, tangents, RDP for dots-on-lanes placement"
```

---

### Task 2: chainPlace — exact chain DP solver

**Files:**
- Modify: `src/render/layout/chainPlace.ts` (append)
- Test: `src/render/layout/chainPlace.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to the test file)

```ts
import { solveChain } from './chainPlace';

const PITCH = 5.5;
const MINGAP = 2 * 2.45 - 0.05;
const OPTS = { pitch: PITCH, minGap: MINGAP, anchorW: 0.05, linkW: 0.25 };
const through = (pts: Pixel[], anchor: Pixel) => {
  // build a through-curve from one long polyline by splitting at the anchor
  // (test convenience: both "incident sides" derived from one geometry)
  return buildLaneCurve([pts, [...pts].reverse()], anchor, 24);
};

test('P1: parallel lanes yield the exact perpendicular straight row', () => {
  // three horizontal lanes at pitch, anchors staggered in x
  const curves = [
    through([[-60, 0], [60, 0]], [-3, 0]),
    through([[-60, PITCH], [60, PITCH]], [0, PITCH]),
    through([[-60, 2 * PITCH], [60, 2 * PITCH]], [3, 2 * PITCH]),
  ];
  const sol = solveChain(curves, [[0, 1, 2]], OPTS);
  const xs = sol.pos.map((p) => p[0]);
  assert.ok(Math.abs(xs[0] - xs[1]) <= 0.51 && Math.abs(xs[1] - xs[2]) <= 0.51,
    `not perpendicular: ${xs}`);
  for (let k = 1; k < 3; k++) {
    const d = Math.hypot(sol.pos[k][0] - sol.pos[k - 1][0], sol.pos[k][1] - sol.pos[k - 1][1]);
    assert.ok(Math.abs(d - PITCH) < 0.6, `pair dist ${d}`);
  }
});

test('P2/clean-track: chain escapes a kinked region', () => {
  // lane B kinks away at x>0; clean parallel track exists at x<0
  const a = through([[-60, 0], [60, 0]], [6, 0]);
  const b = through([[-60, PITCH], [0, PITCH], [40, PITCH + 40]], [6, PITCH + 6]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(Math.abs(d - PITCH) < 0.8, `gap ${d} — should sit on clean track`);
  assert.ok(sol.pos[1][0] < 1, `lane-B dot at x=${sol.pos[1][0]} — should escape the kink`);
});

test('links pull group ends together (one-sided)', () => {
  // two colinear terminus lanes facing each other with a 20px gap
  const a = buildLaneCurve([[[-10, 0], [-50, 0]]], [-30, 0], 24); // tip at x=-10
  const b = buildLaneCurve([[[10, 0], [50, 0]]], [30, 0], 24);    // tip at x=+10
  const sol = solveChain([a, b], [[0], [1]], OPTS);
  assert.ok(sol.pos[0][0] > -10.6 && sol.pos[1][0] < 10.6,
    `tips not pulled together: ${sol.pos[0][0]}, ${sol.pos[1][0]}`);
});

test('hard floor: crossing lanes never violate min gap', () => {
  const a = through([[-40, -40], [40, 40]], [0, 0]);
  const b = through([[-40, 40], [40, -40]], [0.5, -0.5]);
  const sol = solveChain([a, b], [[0, 1]], OPTS);
  const d = Math.hypot(sol.pos[1][0] - sol.pos[0][0], sol.pos[1][1] - sol.pos[0][1]);
  assert.ok(d >= MINGAP - 1e-6, `floor violated: ${d}`);
});

test('deterministic: identical runs give identical output', () => {
  const curves = [
    through([[-60, 0], [60, 0]], [-3, 0]),
    through([[-60, PITCH], [60, PITCH]], [2, PITCH]),
  ];
  const s1 = solveChain(curves, [[0, 1]], OPTS);
  const s2 = solveChain(curves, [[0, 1]], OPTS);
  assert.deepEqual(s1, s2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/render/layout/chainPlace.test.ts`
Expected: FAIL — `solveChain` is not exported.

- [ ] **Step 3: Implement the solver** (append to `chainPlace.ts`)

```ts
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
        const ex = d - o.pitch;
        const pc = isLink ? (ex > 0 ? linkW * ex * ex : 0) : ex * ex;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test src/render/layout/chainPlace.test.ts`
Expected: PASS (10 tests). If P1 fails by exactly one grid step, the assertion tolerances (0.51/0.6) are the spec'd discretization bound — investigate the energy, do NOT loosen tolerances.

- [ ] **Step 5: Run the whole suite**

Run: `npm test` — Expected: 160 tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/render/layout/chainPlace.ts src/render/layout/chainPlace.test.ts
git commit -m "feat(chain): exact chain-DP solver (P1/P2 property tests)"
```

---

### Task 3: spine renderer in stops.ts

**Files:**
- Modify: `src/render/layout/types.ts:93-105` (StopMark)
- Modify: `src/render/stops.ts` (multi-dot branch)

- [ ] **Step 1: Add `chain` to StopMark** (keep `dir`/`seg` for now — removed in Task 4)

```ts
  /** Chain position within the station's marker (dots-on-lanes model):
   *  dots sorted by this index form the capsule spine. */
  chain?: number;
```

- [ ] **Step 2: Replace the multi-segment renderer with the spine**

In `src/render/stops.ts`, KEEP: the imports, `renderStops` signature, `wrap`, `dotOf`, the single-dot branch (`if (!capsule)`), the MEGA_BOXES branch, and the degenerate branch (`if (best < 1e-3)`) with its farthest-pair loop. DELETE everything from the comment `// Multi-angle capsule (real-NYC Atlantic Av–Barclays style)` down to (but not including) the final `out.push(wrap(cx, cy, inner + dots));` block, and replace with:

```ts
    // Spine capsule (dots-on-lanes model, spec 2026-06-12): the marker is
    // the chain of dots in solved order; the capsule is the RDP-simplified
    // polyline through the dot centers, stroked round — border then fill.
    // Dots are on the spine by construction (P3), so containment is
    // structural and lateral widening no longer exists.
    const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
    const spine = rdpSimplify(ordered.map((mk) => mk.pos), 0.75);
    const dAttr = 'M ' + spine.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ');
    const pathSvg = (color: string, w: number, withAttrs: boolean): string =>
      '<path d="' + dAttr + '" fill="none" stroke="' + color +
      '" stroke-width="' + w.toFixed(1) +
      '" stroke-linecap="round" stroke-linejoin="round"' +
      (withAttrs ? attrs : '') + '/>';
    const inner = pathSvg(stroke, 2 * r + 6, false) + pathSvg(fill, 2 * r + 3, true);
    const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
    const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
    out.push(wrap(cx, cy, inner + dots));
```

Add the import: `import { rdpSimplify } from './layout/chainPlace';`

- [ ] **Step 3: Compile + suite**

Run: `npx tsc --noEmit 2>&1 | Select-String 'stops.ts'` — Expected: no output.
Run: `npm test` — Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/render/stops.ts src/render/layout/types.ts
git commit -m "feat(stops): spine capsule renderer (chain order, RDP, round joins)"
```

---

### Task 4: wire chain placement into renderOctilinear; delete the cross-line stack

**Files:**
- Modify: `src/render/renderOctilinear.ts` (stations block, ~lines 480-1300)
- Modify: `src/render/layout/types.ts` (drop `dir`/`seg` from StopMark)

This is the surgery task. Work top-down with the compiler as the safety net.

- [ ] **Step 1: Add imports and the per-node incident-lane helper**

```ts
import { buildLaneCurve, curveTangent, solveChain } from './layout/chainPlace';
```

Next to the existing `lanePolysOf`, add (this is the per-node variant — `lanePolysOf` is map-wide and stays for the hull pass):

```ts
    // incident lane polylines of a line at a node, oriented AWAY from it
    const lanePolysAt = (lineId: string, nodeId: string): Pixel[][] => {
      const out: Pixel[][] = [];
      for (const edge of layout.edges) {
        if (edge.from !== nodeId && edge.to !== nodeId) continue;
        const poly = segPath.get(edge.id + '|' + lineId);
        if (!poly || poly.length < 2) continue;
        out.push(edge.from === nodeId ? poly : [...poly].reverse());
      }
      return out;
    };
```

- [ ] **Step 2: Replace the marker-placement region with chain placement**

Inside the `for (const s of gathered)` stations loop, DELETE these blocks in their entirety (locate by the quoted landmarks):
- the entry-direction bucket grouping (assigns `mk.dir` / `mk.seg`; landmark: the multi-angle grouping comment block and union-find chaining over buckets),
- the perpendicular collapse + `respaceAlong` calls (landmark: `// no lane direction available: farthest-pair fallback`),
- `seatOnLane` and `laneDirAt` definitions (landmarks at the `const seatOnLane = (` and `const laneDirAt = (` declarations),
- `applySlide`, `seatableSeg`, `ptSegDist`, `slideRangeSeatable`, `asIsMaxDist`, the pre-normalization loop (landmark: `// A segment standing at a NESTED bundle bend`),
- the elbow solver loop (landmark: `for (let bI = 1; bI < segInfos.length; bI++)`) including `dotsClear`/`dotsClear2`/`segInfos`/`centroidOf`/`halfLenOf`,
- the final snap pass (landmark: `// FINAL lane-fidelity pass`).

KEEP: `lanePointAt`, `lanePolysOf`, `trimLaneAt`, the mega-slide pass, the small-vs-small hull pass, `respaceAlong` ONLY if the mega path still references it (compiler will say; delete if orphaned).

In place of the deleted region, insert:

```ts
        // ---- dots-on-lanes chain placement (spec 2026-06-12) -------------
        if (s.marks.length === 1) {
          s.marks[0].chain = 0;
        } else if (s.marks.length > 1) {
          const curves = s.marks.map((mk) =>
            buildLaneCurve(lanePolysAt(mk.lineId, mk.flagNode), mk.pos, CHAIN_ARC_LIMIT),
          );
          // groups: marks sharing an incident drawn edge ride one corridor
          const sets = s.marks.map((mk) => {
            const set = new Set<string>();
            for (const edge of layout.edges) {
              if (edge.from !== mk.flagNode && edge.to !== mk.flagNode) continue;
              if (segPath.has(edge.id + '|' + mk.lineId)) set.add(edge.id);
            }
            return set;
          });
          const parent = s.marks.map((_, i) => i);
          const find = (x: number): number =>
            parent[x] === x ? x : (parent[x] = find(parent[x]));
          for (let i = 0; i < sets.length; i++) {
            for (let j = i + 1; j < sets.length; j++) {
              for (const id of sets[i]) {
                if (sets[j].has(id)) { parent[find(i)] = find(j); break; }
              }
            }
          }
          const byRoot = new Map<number, number[]>();
          s.marks.forEach((_, i) => {
            const rt = find(i);
            let arr = byRoot.get(rt);
            if (!arr) { arr = []; byRoot.set(rt, arr); }
            arr.push(i);
          });
          // within-group order = lateral order across the corridor
          const groups = [...byRoot.values()].map((idx) => {
            if (idx.length === 1) return idx;
            const t0 = curveTangent(curves[idx[0]], curves[idx[0]].anchorT);
            let mx = 0;
            let my = 0;
            for (const i of idx) {
              const tg = curveTangent(curves[i], curves[i].anchorT);
              const sgn = tg[0] * t0[0] + tg[1] * t0[1] < 0 ? -1 : 1;
              mx += tg[0] * sgn;
              my += tg[1] * sgn;
            }
            const len = Math.hypot(mx, my) || 1;
            const nx = -my / len;
            const ny = mx / len;
            return [...idx].sort((a, b) =>
              (s.marks[a].pos[0] * nx + s.marks[a].pos[1] * ny) -
              (s.marks[b].pos[0] * nx + s.marks[b].pos[1] * ny));
          });
          const sol = solveChain(curves, groups, {
            pitch: spacing,
            minGap: 2 * r - 0.05,
            anchorW: 0.05,
            linkW: 0.25,
            // spec §6: dots of already-placed stations veto states
            blocked: (p) => {
              for (const q of placedDots) {
                if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 * r - 0.05) return true;
              }
              return false;
            },
          });
          for (let k = 0; k < sol.order.length; k++) {
            const i = sol.order[k];
            s.marks[i].pos = sol.pos[i];
            s.marks[i].chain = k;
          }
        }
        for (const mk of s.marks) placedDots.push(mk.pos);
```

with, declared near `spacing` (the `placedDots` accumulator goes immediately before the `for (const s of gathered)` stations loop):

```ts
  const CHAIN_ARC_LIMIT = 24; // ±arc window per lane curve (~one grid cell)
```

```ts
    const placedDots: Pixel[] = []; // spec §6: earlier stations mask later DPs
```

Stations must therefore be processed in a deterministic order — confirm the `gathered` loop iterates a stable array (it does; it is built once per render).

- [ ] **Step 3: Rework the hull pass and addStop**

In the small-vs-small hull pass, replace the per-`seg` stadium enumeration inside `hullsOf` with consecutive chain pairs:

```ts
      const ordered = [...s.marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
      const segs: Array<[Pixel, Pixel]> = [];
      for (let i = 1; i < ordered.length; i++) segs.push([ordered[i - 1].pos, ordered[i].pos]);
      if (segs.length === 0) segs.push([ordered[0].pos, ordered[0].pos]);
      // half-width: capsule fill half + border = r + 3 (lat widening is gone)
```

Change `addStop` (renderOctilinear.ts:479): replace the `dir?: Pixel, seg?: number` parameters with `chain?: number`, store it on the StopMark, and update the call site at line ~1461 to `addStop(m.lineId, m.color, s.nodeId, m.pos, m.chain)`. The per-edge fallback call sites (~1470/1474) stay as-is (no chain → renderer treats insertion order).

- [ ] **Step 4: Drop `dir`/`seg` from StopMark and chase the compiler**

Remove both fields from `types.ts` AND from the inline mark type inside `renderOctilinear.ts` (the `marks: Array<{ lineId; color; flagNode; pos; dir?; seg? }>` declaration at ~line 585 — replace `dir?: Pixel; seg?: number;` with `chain?: number;`). Run `npx tsc --noEmit 2>&1 | Select-String 'renderOctilinear|stops.ts|types.ts'` and delete every orphaned reference (the deleted blocks were their only writers; `placeLabels`/`transfers` do not read them — verify with `Grep '\.seg|\.dir' src/render` and confirm remaining hits are unrelated locals).

- [ ] **Step 5: Render + smoke-check**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/_chk-seating.ts dev/_dumpnyc.svg 10
```
Expected: render completes within ~1.5× baseline time; seating mean ≤ 0.2px and **0 dots > 2px** (the model's core promise — if violated, debug placement before proceeding; suspects in order: anchor projection onto the wrong incident side, group order sign flips, window too small at long join trims).

- [ ] **Step 6: Run suite + commit**

Run: `npm test` — all pass.

```bash
git add src/render/renderOctilinear.ts src/render/layout/types.ts
git commit -m "feat(stops): chain-DP placement wired in; cross-line stack deleted"
```

---

### Task 5: gates + verification sweep

**Files:**
- Modify: `dev/_chk-markerfit.ts` (parse spine paths)
- Modify: `dev/_chk-seating.ts` (tighten thresholds)

- [ ] **Step 1: Teach the markerfit gate spine paths**

In BOTH sections of `dev/_chk-markerfit.ts`, the hulls currently come from `<line …>` matches. Add path parsing and concatenate:

```ts
const pathSegs = (innerSvg: string) => {
  const segs: Array<{ a: [number, number]; b: [number, number]; half: number }> = [];
  for (const pm of innerSvg.matchAll(/<path d="M ([-\d. L]+)"[^>]*stroke-width="([\d.-]+)"/g)) {
    const nums = pm[1].split(/[ L]+/).filter((x) => x.length).map(Number);
    const half = +pm[2] / 2;
    if (nums.length === 2) segs.push({ a: [nums[0], nums[1]], b: [nums[0], nums[1]], half });
    for (let i = 3; i < nums.length; i += 2) {
      segs.push({ a: [nums[i - 3], nums[i - 2]], b: [nums[i - 1], nums[i]], half });
    }
  }
  return segs;
};
```

Section 1: after the `lines` regex matches (line 21), build the unified segment list and run the existing fit loop over it:

```ts
  const lineSegs = lines.map((b) => ({
    a: [+b[1], +b[2]] as [number, number],
    b: [+b[3], +b[4]] as [number, number],
    half: +b[5] / 2,
  }));
  const allSegs = [...lineSegs, ...pathSegs(inner)];
  // …in the fit branch, replace `lines.length > 0` with `allSegs.length > 0`
  // and iterate `for (const sg of allSegs)` using sg.a / sg.b / sg.half with
  // the same point-to-segment + half-width arithmetic as today.
```

Section 2: in the `Hull` builder (line 80), the hull's `lines` array becomes the same unified mapping: `lines: [...lineSegs2, ...pathSegs(inner)]` where `lineSegs2` is the existing line-match mapping already present at line 81.

- [ ] **Step 2: Tighten the seating gate**

In `dev/_chk-seating.ts`, change the report threshold from `> 2` to `> 1` and add a fail count for `> 2`, printing `FAIL: <n> dots >2px off-lane` when n > 0.

- [ ] **Step 3: Full gate battery on both saves**

```bash
npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc
npx tsx dev/render-from-dump.ts improvedschematics-input.json dev/_dumpsea-after
npx tsx dev/_chk-seating.ts dev/_dumpnyc.svg 10
npx tsx dev/_chk-seating.ts dev/_dumpsea-after.svg 10
npx tsx dev/_chk-markerfit.ts dev/_dumpnyc.svg
npx tsx dev/_chk-markerfit.ts dev/_dumpsea-after.svg
npx tsx dev/_chk-overdraw.ts dev/_dumpnyc.svg
npx tsx dev/_chk-overdraw.ts dev/_dumpsea-after.svg
```
Expected: seating 0 dots >2px both saves; markerfit 0 overflow/stacked; overlaps ≤ the current residual lists (NYC 5, SEA 2); overdraw OK.

- [ ] **Step 4: Named-station crops (dark + labels for NYC)**

```bash
$env:IS_DARK='1'; $env:IS_LABELS='1'; npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnycdark; $env:IS_DARK=$null; $env:IS_LABELS=$null
npx tsx dev/_crop-nycdark.ts 960 1420 90 80 dev/_v42-22st.png      # 22 St V + flush link
npx tsx dev/_crop-nycdark.ts 830 1495 110 100 dev/_v42-stlukes.png # St Lukes column + L
npx tsx dev/_crop-any.ts dev/_dumpnyc.svg 1360 840 110 100 dev/_v42-broadway.png
npx tsx dev/_crop-any.ts dev/_dumpnyc.svg 2380 1430 110 100 dev/_v42-terminus.png
npx tsx dev/_crop-any.ts dev/_dumpsea-after.svg 1058 1034 60 60 dev/_v42-sea-jd.png
npx tsx dev/_crop-any.ts dev/_dumpsea-after.svg 772 1990 60 60 dev/_v42-sea-z.png
npx tsx dev/_crop-any.ts dev/_dumpsea-after.svg 1090 985 110 100 dev/_v42-sea-central.png
```
Review each against the approved looks (22 St V, St Lukes L, Broadway row, G/F/D chevron, Seattle pills). Spines may sit a few px shifted — that is the model working; judge shape quality, not displacement.

- [ ] **Step 5: Position diff + performance**

```bash
npx tsx dev/_diff-dots.ts dev/_base-nyc.svg dev/_dumpnyc.svg
Measure-Command { npx tsx dev/render-from-dump.ts improvedschematics-input-nyc.json dev/_dumpnyc } | Select-Object TotalSeconds
```
Expected: widespread small moves (fine); render ≤ 1.5× baseline.

- [ ] **Step 6: Commit**

```bash
git add dev/_chk-markerfit.ts dev/_chk-seating.ts
git commit -m "test(gates): spine-path hulls in markerfit; seating gate fails >2px"
```

---

### Task 6: ship v0.2.42

**Files:**
- Modify: `manifest.json` (version), `src/ui/SchematicPanel.tsx` (toolbar version string)

- [ ] **Step 1:** bump both version strings `0.2.41` → `0.2.42`.
- [ ] **Step 2:** `npm run build` — expect `dist/index.js` built clean.
- [ ] **Step 3:** Commit:

```bash
git add manifest.json src/ui/SchematicPanel.tsx
git commit -m "feat(stops): dots-on-lanes chain-DP marker placement (v0.2.42)"
```

- [ ] **Step 4:** Update the project memory (`loom-octi-pipeline.md`): mark the redesign IMPLEMENTED, note the new module, the deleted stack, gate-expectation changes, and any surprises found during Task 5.
- [ ] **Step 5:** Hand to the user for the in-game check on both saves (panel reopen hot-loads the bundle). Do not merge or iterate further until their visual verdict.
