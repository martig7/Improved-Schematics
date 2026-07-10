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
import { mstConnectors, type RectSeatOut } from './rectSeat';

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

const PAD_FRAC = 0.16;      // capsule padding around the box centers
const CAP_GAP_FRAC = 0.12;  // clear gap kept outside a capsule
const CLUSTER_FRAC = 1.5;   // center-distance (in box units) that still clusters
const DECONFLICT_ITERS = 300;
const PART_ITERS = 64;      // rigid part-slide iterations (bounded, deterministic)
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

  // Flatten with station tags; per-item arc state.
  interface Slot { station: string; lineId: string; curve: LaneCurve; t: number; lo: number; hi: number }
  const slots: Slot[] = [];
  const indexByStation = new Map<string, number[]>();
  for (const st of stationsIn) {
    const idx: number[] = [];
    for (const it of st.items) {
      const total = it.curve.cum[it.curve.cum.length - 1];
      const cap = box * SLIDE_CAP_FRAC;
      slots.push({
        station: st.station, lineId: it.lineId, curve: it.curve,
        t: Math.max(0, Math.min(total, it.t0)),
        lo: Math.max(0, it.t0 - cap), hi: Math.min(total, it.t0 + cap),
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
    for (const [i, p] of posMap) {
      const f = laneFoot(i, p);
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
  // Push one part away from a reference point. A SINGLETON part slides along
  // its own LANE arc (clamped to the drawn extent), so a lone box never leaves
  // its line; a snapped multi-box row translates rigidly along its row axis so
  // its flush packing survives. Returns true when anything moved.
  const pushPart = (part: Part, awayFromX: number, awayFromY: number, tieSign: number): boolean => {
    if (part.members.length === 1) {
      const i = part.members[0];
      const tg = curveTangent(slots[i].curve, slots[i].t);
      const proj = (pts[i][0] - awayFromX) * tg[0] + (pts[i][1] - awayFromY) * tg[1];
      const sgn = proj > EPS_TIE ? 1 : proj < -EPS_TIE ? -1 : tieSign;
      const nt = clampT(i, slots[i].t + sgn * step);
      if (nt === slots[i].t) return false;
      slots[i].t = nt;
      const p = posOf(i);
      pts[i][0] = p[0];
      pts[i][1] = p[1];
      return true;
    }
    const c = centerOf(part);
    const ax = part.horiz ? 0 : 1;
    const d = c[ax] - (ax === 0 ? awayFromX : awayFromY);
    const sgn = d > EPS_TIE ? 1 : d < -EPS_TIE ? -1 : tieSign;
    for (const k of part.members) pts[k][ax] += sgn * step;
    return true;
  };
  const slideRound = (): boolean => {
    let moved = false;
    for (let i = 0; i < parts.length; i++) {
      const a = rectOf(parts[i]);
      for (const b of obstacles) {
        if (!overlaps(a, b)) continue;
        if (pushPart(parts[i], (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 1)) moved = true;
      }
      for (let j = i + 1; j < parts.length; j++) {
        if (!overlaps(rectOf(parts[i]), rectOf(parts[j]))) continue;
        const ci = centerOf(parts[i]);
        const cj = centerOf(parts[j]);
        if (pushPart(parts[i], cj[0], cj[1], -1)) moved = true;
        if (pushPart(parts[j], ci[0], ci[1], 1)) moved = true;
      }
    }
    return moved;
  };
  for (;;) {
    let iter = 0;
    while (iter < PART_ITERS && slideRound()) iter++;
    if (iter < PART_ITERS) break; // converged: no overlap remains
    let mi = -1, mj = -1;
    outer: for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (parts[i].station !== parts[j].station) continue; // groups never mix
        if (overlaps(rectOf(parts[i]), rectOf(parts[j]))) { mi = i; mj = j; break outer; }
      }
    }
    if (mi < 0) break; // only cross-station or obstacle residue remains: accept
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

  // CONSTRAINED RE-CENTERING polish: the deconflict slide displaces rows in
  // fixed steps and can overshoot, dumping all the displacement on one capsule
  // while slack remains. Each multi-box row now pulls back toward its lanes by
  // the largest fraction of its least-squares shift that creates NO overlap
  // with any other part or obstacle, over a few passes, so every capsule
  // reclaims whatever line contact the crowding allows and the unavoidable
  // residual spreads instead of piling up. Singleton parts are already on
  // their lanes and skip. Deterministic: fixed part order, fixed fractions.
  {
    const shiftedRect = (part: Part, u: number, v: number) => {
      const r = rectOf(part);
      return { x0: r.x0 + u, y0: r.y0 + v, x1: r.x1 + u, y1: r.y1 + v };
    };
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].members.length < 2) continue;
        const posMap = new Map<number, Point>();
        for (const k of parts[i].members) posMap.set(k, [pts[k][0], pts[k][1]]);
        const [u, v] = lsqShift(posMap);
        if (hyp(u, v) < 0.05) continue;
        // Largest fraction of the shift that stays clear of every other part
        // and obstacle, found by bisection (the available slack is often much
        // smaller than the wanted shift, so fixed fractions starve).
        const clearAt = (t: number): boolean => {
          const trial = shiftedRect(parts[i], u * t, v * t);
          for (const b of obstacles) if (overlaps(trial, b)) return false;
          for (let j = 0; j < parts.length; j++) {
            if (j !== i && overlaps(trial, rectOf(parts[j]))) return false;
          }
          return true;
        };
        let lo = 0;
        if (clearAt(1)) lo = 1;
        else {
          let hi = 1;
          for (let b = 0; b < 8; b++) {
            const mid = (lo + hi) / 2;
            if (clearAt(mid)) lo = mid; else hi = mid;
          }
        }
        if (lo * hyp(u, v) < 0.05) continue;
        for (const k of parts[i].members) { pts[k][0] += u * lo; pts[k][1] += v * lo; }
        improved = true;
      }
      if (!improved) break;
    }
    // PAIR BALANCING: two capsules pressed against each other over a contested
    // junction cannot both center individually (the greedy pass gives the
    // first-comer everything). A joint least-squares shift over BOTH parts'
    // members moves the pressed pair as ONE unit to the residual-balancing
    // position, bisected against everything else, so the unavoidable
    // displacement splits between the capsules and each line still passes
    // through its box. Singleton parts stay out (they are exactly on-lane).
    for (let pass = 0; pass < 4; pass++) {
      let improved = false;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].members.length < 2) continue;
        for (let j = i + 1; j < parts.length; j++) {
          if (parts[j].members.length < 2) continue;
          const a = rectOf(parts[i]);
          const b = rectOf(parts[j]);
          const gx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
          const gy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
          if (Math.max(gx, gy) > capGap + 0.35) continue; // not pressed together
          const union = new Map<number, Point>();
          for (const k of parts[i].members) union.set(k, [pts[k][0], pts[k][1]]);
          for (const k of parts[j].members) union.set(k, [pts[k][0], pts[k][1]]);
          const [u, v] = lsqShift(union);
          if (hyp(u, v) < 0.05) continue;
          const pairClearAt = (t: number): boolean => {
            for (const pi of [i, j]) {
              const trial = shiftedRect(parts[pi], u * t, v * t);
              for (const ob of obstacles) if (overlaps(trial, ob)) return false;
              for (let k = 0; k < parts.length; k++) {
                if (k !== i && k !== j && overlaps(trial, rectOf(parts[k]))) return false;
              }
            }
            return true;
          };
          let lo = 0;
          if (pairClearAt(1)) lo = 1;
          else {
            let hi = 1;
            for (let bi = 0; bi < 8; bi++) {
              const mid = (lo + hi) / 2;
              if (pairClearAt(mid)) lo = mid; else hi = mid;
            }
          }
          if (lo * hyp(u, v) < 0.05) continue;
          for (const k of union.keys()) { pts[k][0] += u * lo; pts[k][1] += v * lo; }
          improved = true;
        }
      }
      if (!improved) break;
    }
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
