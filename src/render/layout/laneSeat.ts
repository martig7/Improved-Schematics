// Lane-aware seating for the rectangle ("rectRows") Tokyu design, applied to the
// WHOLE stop set at once: every box (single stops and interchange members alike)
// is pinned to its own DRAWN lane and may only slide ALONG that lane (an arc
// parameter on the lane curve), clamped to the lane's drawn extent so it never
// sits past where the line ends. Overlapping boxes of ANY two stations slide
// apart along their lanes mutually, so cross-station deconfliction never drags a
// box off its line the way a rigid whole-capsule translation would.
//
// Station identity is preserved: boxes cluster into capsule PARTS only with
// members of their OWN station (official station groups only), and each
// station's parts are joined by its own thin connectors.
//
// Capsule FLUSH invariant: a drawn capsule always hugs its boxes exactly (the
// member bbox plus the uniform pad). When settled boxes do not line up into a
// row on their lanes, the fallback is never a larger cover rect: members either
// FLOAT slightly off their line to snap into an exact packed row, or the cluster
// SPLITS into several flush parts joined by the shared thin connectors.
//
// Fully deterministic: fixed (i < j) scan order, fixed slide steps, sqrt-based
// distance (Math.hypot is not correctly rounded across V8), and lane evaluation
// through curvePoint / curveTangent, so offline output equals in-game output.

import type { Point } from '../stations/types';
import type { LaneCurve } from './chainPlace';
import { curvePoint, curveTangent } from './chainPlace';
import { mstConnectors, PAD_FRAC, CAP_GAP_FRAC, type RectSeatOut } from './rectSeat';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

// One box to seat: its line, the drawn lane curve it rides, and the arc position
// of its on-lane anchor (the dot the placement solver committed).
export interface LaneItem {
  lineId: string;
  curve: LaneCurve;
  t0: number;
}

/** One station's boxes for the global seat. */
export interface LaneStation {
  station: string;
  items: LaneItem[];
}

/** An immovable footprint the seated boxes must clear (a capsule seated by the
 *  curve-less fallback path, or a static single box). */
export interface LaneObstacle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LaneSeatAllOut {
  /** Capsule (centers, flush part rects, connectors) per MULTI-box station. */
  byStation: Map<string, RectSeatOut>;
  /** Final box position per station per item index (all stations, singles too). */
  posByStation: Map<string, Point[]>;
}

const CLUSTER_FRAC = 1.5;   // center-distance (in box units) that still clusters
const DECONFLICT_ITERS = 300;
// Max distance a box may FLOAT off its own lane for its station's parts to merge
// into one shared row. Within the cap, nearby parts (crossing corridors
// included) fuse into a single capsule instead of a chain of singletons; beyond
// it the members stay on their lines in separate connected parts.
const FLOAT_CAP_FRAC = 1.25;
// Reach for the part-merge test: parts whose padded rects come within this of
// each other are merge candidates.
const MERGE_REACH_FRAC = 1.0;
// Cross-axis tolerance for banding settled boxes into one snapped row, wide
// enough to absorb the lane offsets of one trunk's parallel lanes.
const BAND_TOL_FRAC = 0.9;
// Per-box slide bound (arc px from the anchor). Escaping from under a wide
// capsule can need several box widths; mutual relaxation (no box ever hops a
// neighbour) and the lane-extent clamp are the real anti-marching protections,
// so the cap is generous and only backstops a pathological cascade.
const SLIDE_CAP_FRAC = 8;
// Tie threshold for slide-direction projections: below this the direction is
// ambiguous and the tie breaks by index (opposite signs), so a coincident pair
// splits instead of co-drifting.
const EPS_TIE = 1e-9;
// Tangential anchor pull for the row-centering solve. The perpendicular
// residuals leave the along-lane direction undetermined when a row's lanes run
// nearly parallel, and the exact normal-equation solution then explodes along
// it (a slight segment tilt trades huge along-lane drift for marginal
// perpendicular gain, dragging a terminus row off its route ends). The pull
// ramps in as the smallest eigenvalue of the normal matrix falls below
// ANCHOR_EIG_FRAC of the member count and vanishes for a well-determined
// crossing, which keeps its exact both-on-line solution.
const ANCHOR_W = 0.25;
const ANCHOR_EIG_FRAC = 0.05;

/**
 * Seat every station's boxes together: global mutual along-lane deconflict, then
 * per-station flush clustering, then a rigid part-level deconflict (merge
 * backstop within a station only). `box` is the fixed box side; `gap` the
 * edge-to-edge clearance used both to detect overlap and to space packed boxes.
 */
export function laneSeatAll(
  stationsIn: LaneStation[],
  box: number,
  gap: number,
  obstacles: LaneObstacle[] = [],
): LaneSeatAllOut {
  const pad = box * PAD_FRAC;
  const rx = (box + 2 * pad) * PAD_FRAC;
  const capGap = box * CAP_GAP_FRAC;
  const clear = box + gap;              // min center separation for non-overlap
  const clusterD = box * CLUSTER_FRAC;  // cluster when centers are within this
  const step = box * 0.3;
  const pitch = clear;                  // packed row spacing (edge-to-edge + gap)
  const bandTol = box * BAND_TOL_FRAC;
  const chainGap = 2 * pitch;           // max along gap that still joins a row
  const half = box / 2 + box * 0.12;    // box half footprint incl clearance margin

  // Flatten with station tags; per-item arc state. `anchor` keeps the seed
  // position (the station's true spot on its lane) for the degenerate-system
  // pull in lsqShift.
  interface Slot { station: string; lineId: string; curve: LaneCurve; t: number; lo: number; hi: number; anchor: Point }
  const slots: Slot[] = [];
  const indexByStation = new Map<string, number[]>();
  for (const st of stationsIn) {
    const idx: number[] = [];
    for (const it of st.items) {
      const total = it.curve.cum[it.curve.cum.length - 1];
      const cap = box * SLIDE_CAP_FRAC;
      const t0 = Math.max(0, Math.min(total, it.t0));
      const a = curvePoint(it.curve, t0);
      slots.push({
        station: st.station, lineId: it.lineId, curve: it.curve,
        t: t0,
        lo: Math.max(0, it.t0 - cap), hi: Math.min(total, it.t0 + cap),
        anchor: [a[0], a[1]],
      });
      idx.push(slots.length - 1);
    }
    indexByStation.set(st.station, idx);
  }
  const n = slots.length;
  const posOf = (i: number): Point => {
    const p = curvePoint(slots[i].curve, slots[i].t);
    return [p[0], p[1]];
  };
  const clampT = (i: number, tt: number) => Math.max(slots[i].lo, Math.min(slots[i].hi, tt));

  // Phase 1: GLOBAL mutual deconflict along lanes. Every overlapping box pair
  // (any two stations) steps apart along each box's own lane; a box overlapping
  // an immovable obstacle steps away alone. Ties break by index so coincident
  // pairs split instead of marching together.
  for (let iter = 0; iter < DECONFLICT_ITERS; iter++) {
    let moved = false;
    const P = slots.map((_, i) => posOf(i));
    for (let i = 0; i < n; i++) {
      for (const b of obstacles) {
        const pi = P[i];
        if (pi[0] + half <= b.x0 || b.x1 <= pi[0] - half || pi[1] + half <= b.y0 || b.y1 <= pi[1] - half) continue;
        const tg = curveTangent(slots[i].curve, slots[i].t);
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        const proj = (pi[0] - cx) * tg[0] + (pi[1] - cy) * tg[1];
        const nt = clampT(i, slots[i].t + (proj >= 0 ? 1 : -1) * step);
        if (nt !== slots[i].t) { slots[i].t = nt; P[i] = posOf(i); moved = true; }
      }
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(P[i][0] - P[j][0]) >= clear || Math.abs(P[i][1] - P[j][1]) >= clear) continue;
        const tgi = curveTangent(slots[i].curve, slots[i].t);
        const tgj = curveTangent(slots[j].curve, slots[j].t);
        const si = (P[i][0] - P[j][0]) * tgi[0] + (P[i][1] - P[j][1]) * tgi[1];
        const sj = (P[j][0] - P[i][0]) * tgj[0] + (P[j][1] - P[i][1]) * tgj[1];
        const sgnI = si > EPS_TIE ? 1 : si < -EPS_TIE ? -1 : -1;
        const sgnJ = sj > EPS_TIE ? 1 : sj < -EPS_TIE ? -1 : 1;
        const ni = clampT(i, slots[i].t + sgnI * step);
        const nj = clampT(j, slots[j].t + sgnJ * step);
        if (ni !== slots[i].t) { slots[i].t = ni; P[i] = posOf(i); moved = true; }
        if (nj !== slots[j].t) { slots[j].t = nj; P[j] = posOf(j); moved = true; }
      }
    }
    if (!moved) break;
  }

  const pts = slots.map((_, i) => posOf(i));
  const tgs = slots.map((_, i) => curveTangent(slots[i].curve, slots[i].t));

  // Per-STATION clustering: members of one station that settled close AND run
  // roughly parallel share a capsule part; crossing corridors stay separate and
  // get a connector. Boxes of different stations never cluster.
  interface Part { station: string; members: number[]; horiz: boolean }
  const parts: Part[] = [];
  for (const st of stationsIn) {
    const idx = indexByStation.get(st.station)!;
    if (idx.length === 0) continue;
    const parent = new Map<number, number>(idx.map((i) => [i, i]));
    const find = (x: number): number => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
      return x;
    };
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        const i = idx[a], j = idx[b];
        const close = hyp(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < clusterD;
        const parallel = Math.abs(tgs[i][0] * tgs[j][0] + tgs[i][1] * tgs[j][1]) > 0.7;
        if (close && parallel) parent.set(find(i), find(j));
      }
    }
    const byRoot = new Map<number, number[]>();
    for (const i of idx) {
      const r = find(i);
      const arr = byRoot.get(r);
      if (arr) arr.push(i); else byRoot.set(r, [i]);
    }
    const clusters = [...byRoot.values()].sort((a, b) => Math.min(...a) - Math.min(...b));
    // Band each cluster into aligned row parts against the FIRST member's cross
    // (fixed reference), fewer-parts axis wins (tie horizontal).
    const bandParts = (mem: number[], horiz: boolean): number[][] => {
      const along = horiz ? 0 : 1;
      const cross = horiz ? 1 : 0;
      const sorted = [...mem].sort((a, b) => pts[a][along] - pts[b][along] || a - b);
      const out: number[][] = [];
      let cur: number[] = [];
      for (const i of sorted) {
        const joins =
          cur.length > 0 &&
          Math.abs(pts[i][cross] - pts[cur[0]][cross]) <= bandTol &&
          pts[i][along] - pts[cur[cur.length - 1]][along] <= chainGap;
        if (joins) cur.push(i);
        else { if (cur.length > 0) out.push(cur); cur = [i]; }
      }
      if (cur.length > 0) out.push(cur);
      return out;
    };
    for (const mem of clusters) {
      const h = bandParts(mem, true);
      const v = bandParts(mem, false);
      const useH = h.length <= v.length;
      for (const m of useH ? h : v) parts.push({ station: st.station, members: m, horiz: useH });
    }
  }

  // Snap a part into an exact packed row (shared mean cross, pitch spacing
  // centered on the mean along). The sanctioned FLOAT: a snapped box may sit
  // slightly off its lane so its capsule can be flush.
  // Nearest point on a member's lane to p, with that segment's unit tangent.
  const laneFoot = (i: number, p: Point): { q: Point; t: Point; d: number } => {
    const cpts = slots[i].curve.pts;
    let best = Infinity;
    let q: Point = [p[0], p[1]];
    let t: Point = [1, 0];
    for (let k = 1; k < cpts.length; k++) {
      const ax = cpts[k - 1][0], ay = cpts[k - 1][1];
      const dx = cpts[k][0] - ax, dy = cpts[k][1] - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      const fx = ax + dx * u, fy = ay + dy * u;
      const d = hyp(p[0] - fx, p[1] - fy);
      if (d < best) {
        best = d;
        q = [fx, fy];
        const len = Math.sqrt(l2);
        t = [dx / len, dy / len];
      }
    }
    // A curve whose every segment is sub-pixel has no usable segment above;
    // the honest distance is to its first vertex. Returning Infinity instead
    // would turn the least-squares residual into Infinity * 0 = NaN and poison
    // the whole part.
    if (best === Infinity && cpts.length > 0) {
      q = [cpts[0][0], cpts[0][1]];
      best = hyp(p[0] - q[0], p[1] - q[1]);
    }
    return { q, t, d: best };
  };
  const distToLane = (i: number, p: Point): number => laneFoot(i, p).d;
  // Pack members into an exact pitch row along one axis, centered on their mean.
  const packedRow = (members: number[], horiz: boolean): Map<number, Point> => {
    const m = members.length;
    const along = horiz ? 0 : 1;
    const cross = horiz ? 1 : 0;
    let meanA = 0, meanC = 0;
    for (const i of members) { meanA += pts[i][along]; meanC += pts[i][cross]; }
    meanA /= m; meanC /= m;
    const order = [...members].sort((a, b) => pts[a][along] - pts[b][along] || a - b);
    const out = new Map<number, Point>();
    order.forEach((i, k) => {
      const p: [number, number] = [0, 0];
      p[along] = meanA + (k - (m - 1) / 2) * pitch;
      p[cross] = meanC;
      out.set(i, p as Point);
    });
    return out;
  };
  // Shift a packed row rigidly so every member sits AS CENTERED ON ITS OWN LANE
  // as possible: Gauss-Newton least squares over the members' distances to the
  // nearest point on their own lane, with two free parameters (the row origin).
  // The residual gradient is the RADIAL direction from the lane foot to the box
  // center: for an interior foot that equals the segment normal, and for a foot
  // clamped at a lane endpoint or vertex (a terminus box) it is the true
  // distance gradient, where a segment normal would impose a phantom
  // constraint. A member already on its lane contributes its segment normal as
  // the stay-on-line direction. A crossing pair solves exactly (both boxes dead
  // on their lines); parallel lanes center the row across them; a singular
  // system shifts along the common direction only. Iterated so the foot points
  // re-resolve across bends and tips; the shift is capped per pass so a
  // degenerate configuration can never fling the row.
  // One Gauss-Newton step: the rigid shift that best centers the given box
  // positions on their own lanes (least squares over the true distances to the
  // nearest lane point, radial gradients; a singular system shifts along the
  // common direction only). Capped so a degenerate configuration cannot fling
  // the row.
  const lsqShift = (posMap: Map<number, Point>): [number, number] => {
    let m00 = 0, m01 = 0, m11 = 0, r0 = 0, r1 = 0;
    let n0: Point | null = null;
    let sNx = 0, sNy = 0, sE = 0, cnt = 0;
    const feet: Array<{ i: number; p: Point; t: Point }> = [];
    for (const [i, p] of posMap) {
      const f = laneFoot(i, p);
      feet.push({ i, p, t: f.t });
      let nx: number, ny: number, e: number;
      if (f.d > 1e-6) {
        nx = (p[0] - f.q[0]) / f.d;
        ny = (p[1] - f.q[1]) / f.d;
        e = f.d;
      } else {
        nx = -f.t[1];
        ny = f.t[0];
        e = 0;
      }
      m00 += nx * nx; m01 += nx * ny; m11 += ny * ny;
      r0 -= e * nx; r1 -= e * ny;
      if (!n0) n0 = [nx, ny];
      const sgn = nx * n0[0] + ny * n0[1] < 0 ? -1 : 1;
      sNx += sgn * nx; sNy += sgn * ny; sE += sgn * e;
      cnt++;
    }
    if (cnt === 0) return [0, 0];
    // Degenerate-system anchor pull (see ANCHOR_W): when the perpendicular
    // system barely determines one direction, pin it with a tangential pull
    // toward each member's seed anchor instead of solving the near-null
    // direction exactly.
    const trM = m00 + m11;
    const det0 = m00 * m11 - m01 * m01;
    const lmin = (trM - Math.sqrt(Math.max(0, trM * trM - 4 * det0))) / 2;
    const wa = ANCHOR_W * Math.max(0, 1 - lmin / (ANCHOR_EIG_FRAC * cnt));
    if (wa > 0) {
      for (const { i, p, t } of feet) {
        const e = (p[0] - slots[i].anchor[0]) * t[0] + (p[1] - slots[i].anchor[1]) * t[1];
        m00 += wa * t[0] * t[0]; m01 += wa * t[0] * t[1]; m11 += wa * t[1] * t[1];
        r0 -= wa * e * t[0]; r1 -= wa * e * t[1];
      }
    }
    const det = m00 * m11 - m01 * m01;
    let u = 0, v = 0;
    if (Math.abs(det) > 1e-9) {
      u = (r0 * m11 - r1 * m01) / det;
      v = (m00 * r1 - m01 * r0) / det;
    } else {
      const len = hyp(sNx, sNy);
      if (len > 1e-9) {
        const s = -(sE / cnt);
        u = s * (sNx / len);
        v = s * (sNy / len);
      }
    }
    const mag = hyp(u, v);
    const cap = 2 * box * FLOAT_CAP_FRAC;
    if (mag > cap) { u *= cap / mag; v *= cap / mag; }
    return [u, v];
  };
  const centerOnLanes = (posMap: Map<number, Point>): void => {
    for (let pass = 0; pass < 6; pass++) {
      const [u, v] = lsqShift(posMap);
      for (const [, p] of posMap) { p[0] += u; p[1] += v; }
      if (hyp(u, v) < 0.05) break; // converged
    }
  };
  const snapPart = (part: Part): void => {
    if (part.members.length < 2) return;
    const posMap = packedRow(part.members, part.horiz);
    centerOnLanes(posMap);
    for (const [i, p] of posMap) { pts[i][0] = p[0]; pts[i][1] = p[1]; }
  };
  for (const part of parts) snapPart(part);

  // Rigid part-level deconflict over ALL stations' parts plus the obstacles:
  // overlapping part capsules slide apart as whole units along their own row
  // axis (flush packing preserved), with index tie-breaks. MERGE backstop for a
  // stuck pair applies only WITHIN one station (official groups never mix);
  // a stuck cross-station pair is accepted after the budget (bounded residue).
  const rectOf = (part: { members: number[] }): { x0: number; y0: number; x1: number; y1: number } => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of part.members) {
      if (pts[i][0] < x0) x0 = pts[i][0];
      if (pts[i][0] > x1) x1 = pts[i][0];
      if (pts[i][1] < y0) y0 = pts[i][1];
      if (pts[i][1] > y1) y1 = pts[i][1];
    }
    const h = box / 2 + pad;
    return { x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h };
  };
  const centerOf = (part: { members: number[] }): Point => {
    let x = 0, y = 0;
    for (const i of part.members) { x += pts[i][0]; y += pts[i][1]; }
    return [x / part.members.length, y / part.members.length];
  };
  // SINGLETON-MINIMIZING merge: nearby parts of ONE station fuse into a single
  // packed row when every member's snapped position stays within FLOAT_CAP of
  // its own lane. Crossing-corridor members thus share a capsule when they are
  // genuinely at the crossing (small bounded float), while far-flung platforms
  // keep their own on-line parts and a connector. Deterministic: fixed scan
  // order, first acceptable merge applies, part count strictly decreases.
  const floatCap = box * FLOAT_CAP_FRAC;
  const mergeReach = box * MERGE_REACH_FRAC;
  // Trial positions for a merged member set: exact pitch row, then rigidly
  // centered on the members' own lanes (same placement snapPart applies).
  const trialSnap = (members: number[], horiz: boolean): Map<number, Point> => {
    const out = packedRow(members, horiz);
    centerOnLanes(out);
    return out;
  };
  {
    const reachRect = (part: Part) => {
      const r = rectOf(part);
      return { x0: r.x0 - mergeReach / 2, y0: r.y0 - mergeReach / 2, x1: r.x1 + mergeReach / 2, y1: r.y1 + mergeReach / 2 };
    };
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < parts.length && !merged; i++) {
        for (let j = i + 1; j < parts.length && !merged; j++) {
          if (parts[i].station !== parts[j].station) continue; // groups never mix
          const a = reachRect(parts[i]);
          const b = reachRect(parts[j]);
          if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0) continue;
          const union = parts[i].members.concat(parts[j].members);
          let bestAxis: boolean | null = null;
          let bestFloat = Infinity;
          let bestPos: Map<number, Point> | null = null;
          for (const horiz of [true, false]) {
            const trial = trialSnap(union, horiz);
            let worst = 0;
            for (const [k, p] of trial) {
              const d = distToLane(k, p);
              if (d > worst) worst = d;
            }
            if (worst < bestFloat - 1e-9) { bestFloat = worst; bestAxis = horiz; bestPos = trial; }
          }
          if (bestAxis === null || bestFloat > floatCap) continue;
          for (const [k, p] of bestPos!) { pts[k][0] = p[0]; pts[k][1] = p[1]; }
          parts[i] = { station: parts[i].station, members: union, horiz: bestAxis };
          parts.splice(j, 1);
          merged = true;
        }
      }
    }
  }

  const overlaps = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean => {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + capGap;
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + capGap;
    return ox > 0 && oy > 0;
  };
  // Move one part by (dx, dy). A SINGLETON part is exactly on its lane and must
  // stay there: the motion PROJECTS onto its lane arc (clamped to the drawn
  // extent), so a lone box can only slide along its line. A multi-box row
  // translates rigidly (any direction), because the centering pull below keeps
  // fighting it back onto its lanes; flush packing survives either way.
  const movePart = (part: Part, dx: number, dy: number): boolean => {
    if (part.members.length === 1) {
      const i = part.members[0];
      const tg = curveTangent(slots[i].curve, slots[i].t);
      const proj = dx * tg[0] + dy * tg[1];
      if (Math.abs(proj) < 1e-9) return false;
      const nt = clampT(i, slots[i].t + proj);
      if (nt === slots[i].t) return false;
      slots[i].t = nt;
      const p = posOf(i);
      pts[i][0] = p[0];
      pts[i][1] = p[1];
      return true;
    }
    for (const k of part.members) { pts[k][0] += dx; pts[k][1] += dy; }
    return true;
  };

  // UNIFIED CONTACT-VS-OVERLAP SOLVE. Everything the seating wants from the
  // part layer is one problem: minimize every box's distance to its own lane
  // subject to no two footprints overlapping. Each iteration takes a damped
  // least-squares CENTERING step per row (the objective's descent direction),
  // then PROJECTS the overlap constraints: every overlapping pair separates
  // along its minimal-translation axis, the penetration split half and half
  // (obstacles push their full penetration onto the part). Because pushes are
  // penetration-proportional, pressure chains cannot balance into a frozen
  // cycle, and because the pull and the push act together, a contested
  // junction settles at the residual-balancing equilibrium by itself: no
  // separate deconflict, re-centering, or pair-balancing stages. Singleton
  // parts stay exactly on their lanes (projected motion) and carry no
  // centering error. Deterministic: fixed iteration order, fixed damping,
  // index tie-breaks, bounded iterations.
  const CENTER_DAMP = 0.6;
  const SOLVE_ITERS = 48;
  const runSolve = (): void => {
    for (let iter = 0; iter < SOLVE_ITERS; iter++) {
      let maxMove = 0;
      // Descent: damped centering pull toward each row's own lanes.
      for (const part of parts) {
        if (part.members.length < 2) continue;
        const posMap = new Map<number, Point>();
        for (const k of part.members) posMap.set(k, [pts[k][0], pts[k][1]]);
        const [u, v] = lsqShift(posMap);
        const du = u * CENTER_DAMP, dv = v * CENTER_DAMP;
        const mag = hyp(du, dv);
        if (mag < 0.02) continue;
        for (const k of part.members) { pts[k][0] += du; pts[k][1] += dv; }
        if (mag > maxMove) maxMove = mag;
      }
      // Projection: separate every overlapping pair along the minimal axis.
      for (let i = 0; i < parts.length; i++) {
        let a = rectOf(parts[i]);
        for (const b of obstacles) {
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + capGap;
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + capGap;
          if (ox <= 0 || oy <= 0) continue;
          const ci = centerOf(parts[i]);
          let dx = 0, dy = 0;
          if (ox <= oy) dx = (ci[0] >= (b.x0 + b.x1) / 2 ? 1 : -1) * ox;
          else dy = (ci[1] >= (b.y0 + b.y1) / 2 ? 1 : -1) * oy;
          if (movePart(parts[i], dx, dy)) {
            a = rectOf(parts[i]);
            const m = hyp(dx, dy);
            if (m > maxMove) maxMove = m;
          }
        }
        for (let j = i + 1; j < parts.length; j++) {
          const ri = rectOf(parts[i]);
          const rj = rectOf(parts[j]);
          const ox = Math.min(ri.x1, rj.x1) - Math.max(ri.x0, rj.x0) + capGap;
          const oy = Math.min(ri.y1, rj.y1) - Math.max(ri.y0, rj.y0) + capGap;
          if (ox <= 0 || oy <= 0) continue;
          const ci = centerOf(parts[i]);
          const cj = centerOf(parts[j]);
          let dx = 0, dy = 0;
          if (ox <= oy) {
            const d = ci[0] - cj[0];
            const sgn = d > EPS_TIE ? 1 : d < -EPS_TIE ? -1 : -1;
            dx = sgn * ox / 2;
          } else {
            const d = ci[1] - cj[1];
            const sgn = d > EPS_TIE ? 1 : d < -EPS_TIE ? -1 : -1;
            dy = sgn * oy / 2;
          }
          const mi2 = movePart(parts[i], dx, dy);
          const mj2 = movePart(parts[j], -dx, -dy);
          if (mi2 || mj2) {
            const m = hyp(dx, dy);
            if (m > maxMove) maxMove = m;
          }
        }
      }
      if (maxMove < 0.03) break; // settled
    }
  };
  // Solve, with the same-station MERGE backstop: a pair of one station's parts
  // that stays overlapping after the solve fuses into one row and the solve
  // resumes (part count strictly decreases, so this terminates). Cross-station
  // or obstacle residue after the budget is accepted (bounded, rare).
  for (;;) {
    runSolve();
    let mi = -1, mj = -1;
    outer: for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (parts[i].station !== parts[j].station) continue; // groups never mix
        if (overlaps(rectOf(parts[i]), rectOf(parts[j]))) { mi = i; mj = j; break outer; }
      }
    }
    if (mi < 0) break;
    const union = parts[mi].members.concat(parts[mj].members);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of union) {
      if (pts[k][0] < x0) x0 = pts[k][0];
      if (pts[k][0] > x1) x1 = pts[k][0];
      if (pts[k][1] < y0) y0 = pts[k][1];
      if (pts[k][1] > y1) y1 = pts[k][1];
    }
    parts[mi] = { station: parts[mi].station, members: union, horiz: (x1 - x0) >= (y1 - y0) };
    parts.splice(mj, 1);
    snapPart(parts[mi]);
  }

  // Emit: FLUSH capsule per part; per-station connectors over its own parts.
  const byStation = new Map<string, RectSeatOut>();
  const posByStation = new Map<string, Point[]>();
  for (const st of stationsIn) {
    const idx = indexByStation.get(st.station)!;
    posByStation.set(st.station, idx.map((i) => [pts[i][0], pts[i][1]] as Point));
    if (idx.length < 2) continue;
    const centers = new Map<string, Point>();
    for (const i of idx) centers.set(slots[i].lineId, [pts[i][0], pts[i][1]]);
    const groups: RectSeatOut['groups'] = [];
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const part of parts) {
      if (part.station !== st.station) continue;
      const r = rectOf(part);
      const g = { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 };
      groups.push({ ...g, rx });
      rects.push(g);
    }
    const connectors = mstConnectors(rects, box * 0.16, box * 0.28);
    byStation.set(st.station, { centers, groups, connectors });
  }
  return { byStation, posByStation };
}

/**
 * Single-station convenience wrapper over laneSeatAll (used by tests and any
 * caller seating one hub in isolation).
 */
export function laneSeat(items: LaneItem[], box: number, gap: number): RectSeatOut {
  const out = laneSeatAll([{ station: 's', items }], box, gap);
  const seat = out.byStation.get('s');
  if (seat) return seat;
  // Degenerate 0/1-item station: mirror the flush singleton shape.
  const pad = box * PAD_FRAC;
  const rx = (box + 2 * pad) * PAD_FRAC;
  const centers = new Map<string, Point>();
  const groups: RectSeatOut['groups'] = [];
  const pos = out.posByStation.get('s') ?? [];
  items.forEach((it, k) => {
    if (pos[k]) centers.set(it.lineId, pos[k]);
  });
  for (const [, c] of centers) {
    groups.push({ x: c[0] - box / 2 - pad, y: c[1] - box / 2 - pad, w: box + 2 * pad, h: box + 2 * pad, rx });
  }
  return { centers, groups, connectors: [] };
}
