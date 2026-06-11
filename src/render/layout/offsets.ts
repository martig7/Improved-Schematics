// Parallel-line offset bundling: place co-running lines side by side along each
// edge. Ported from the game (dev/reference/computeCanonicalOffsets.js,
// offsetPolyline.js, unit.js, perp.js).

import type { Layout, Pixel } from './types';
import { LINE_WIDTH, LINE_GAP } from '../constants';

function unit(a: Pixel, b: Pixel): Pixel {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function perp(v: Pixel): Pixel {
  return [-v[1], v[0]];
}

export interface LaneJoin {
  apex: Pixel; // the sharp corner the two lane lines would meet at
  a: Pixel;    // lane A's new (trimmed) endpoint
  b: Pixel;    // lane B's new (trimmed) endpoint
}

/**
 * Curve-join two lane polylines that meet at a node: trim both ends back
 * from the intersection of their end segments and report the apex, so the
 * renderer can bridge them with a quadratic through the corner — a lane
 * continuing around a corner sweeps like an interior fillet instead of
 * snapping to a sharp miter point. Mutates the endpoint points in place.
 * Returns null (and leaves both untouched) when the segments are
 * near-parallel (a genuine lateral lane jog — the S connector is right),
 * when the apex lies beyond `limit` from either endpoint (too-sharp
 * corner), or when trimming would fold a segment back on itself.
 */
export function curveLaneJoin(
  polyA: Pixel[],
  aAtStart: boolean,
  polyB: Pixel[],
  bAtStart: boolean,
  radius: number,
  limit: number,
): LaneJoin | null {
  if (polyA.length < 2 || polyB.length < 2) return null;
  const qa = aAtStart ? polyA[0] : polyA[polyA.length - 1];
  const qa1 = aAtStart ? polyA[1] : polyA[polyA.length - 2];
  const qb = bAtStart ? polyB[0] : polyB[polyB.length - 1];
  const qb1 = bAtStart ? polyB[1] : polyB[polyB.length - 2];

  const d1: Pixel = [qa[0] - qa1[0], qa[1] - qa1[1]];
  const d2: Pixel = [qb[0] - qb1[0], qb[1] - qb1[1]];
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  const scale = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
  if (scale < 1e-9 || Math.abs(denom) < 1e-3 * scale) return null; // parallel
  // regressive turn (> ~107°): the lane-line intersection lies BEHIND the
  // corner and the "join" would loop out and back (the Republican St yellow
  // hook). d1 points INTO the node, d2 points INTO the node from the other
  // side — alignment means the line nearly reverses. Leave it to the chord.
  if (d1[0] * d2[0] + d1[1] * d2[1] > 0.3 * scale) return null;

  const t = ((qb1[0] - qa1[0]) * d2[1] - (qb1[1] - qa1[1]) * d2[0]) / denom;
  const x = qa1[0] + t * d1[0];
  const y = qa1[1] + t * d1[1];

  if (Math.hypot(x - qa[0], y - qa[1]) > limit) return null;
  if (Math.hypot(x - qb[0], y - qb[1]) > limit) return null;

  // Inner-corner overshoot: a lane drawn PAST the corner leaves the apex
  // behind its end (possibly behind several vertices) — rejecting here
  // drops the join to the connector bezier, which balloons 270 degrees
  // (the 13 St "5 loop"). If the apex lies ON the lane behind the end, cut
  // the lane back so it ends at the apex, then join normally. Apexes that
  // are NOT on the lane (genuine reversals) still bail to the chord.
  // (Reintroduced for v0.2.23: its v0.2.21 spike side-effects came from
  // sliver/spur edges that traversal pruning + sliver suppression now
  // remove upstream.)
  const cutBackTo = (poly: Pixel[], atStart: boolean, px: number, py: number): boolean => {
    const n = poly.length;
    const maxSegs = Math.min(4, n - 1);
    for (let s = 0; s < maxSegs; s++) {
      const i = atStart ? s : n - 1 - s; // outer vertex of this segment
      const j = atStart ? s + 1 : n - 2 - s; // inner vertex
      const ax = poly[j][0], ay = poly[j][1];
      const vx = poly[i][0] - ax, vy = poly[i][1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-12) continue;
      const u = ((px - ax) * vx + (py - ay) * vy) / len2;
      if (u < -0.001 || u > 1.001) continue;
      if (Math.hypot(px - (ax + vx * u), py - (ay + vy * u)) > 1.5) return false; // off the lane
      if (atStart) poly.splice(0, s + 1, [px, py]);
      else poly.splice(n - 1 - s, s + 1, [px, py]);
      return true;
    }
    return false;
  };
  if ((x - qa1[0]) * d1[0] + (y - qa1[1]) * d1[1] <= 0) {
    if (!cutBackTo(polyA, aAtStart, x, y) || polyA.length < 2) return null;
  }
  if ((x - qb1[0]) * d2[0] + (y - qb1[1]) * d2[1] <= 0) {
    if (!cutBackTo(polyB, bAtStart, x, y) || polyB.length < 2) return null;
  }
  // re-resolve ends after any cutback (the polylines may have been mutated)
  const ra = aAtStart ? polyA[0] : polyA[polyA.length - 1];
  const ra1 = aAtStart ? polyA[1] : polyA[polyA.length - 2];
  const rb = bAtStart ? polyB[0] : polyB[polyB.length - 1];
  const rb1 = bAtStart ? polyB[1] : polyB[polyB.length - 2];

  // directions along each lane toward the apex
  const la = Math.hypot(x - ra1[0], y - ra1[1]);
  const lb = Math.hypot(x - rb1[0], y - rb1[1]);
  if (la < 1e-6 || lb < 1e-6) return null;
  const ua: Pixel = [(x - ra1[0]) / la, (y - ra1[1]) / la];
  const ub: Pixel = [(x - rb1[0]) / lb, (y - rb1[1]) / lb];

  // symmetric trim, never eating a whole end segment
  const f = Math.min(radius, la * 0.6, lb * 0.6);
  const a: Pixel = [x - ua[0] * f, y - ua[1] * f];
  const b: Pixel = [x - ub[0] * f, y - ub[1] * f];
  ra[0] = a[0];
  ra[1] = a[1];
  rb[0] = b[0];
  rb[1] = b[1];
  return { apex: [x, y], a: [a[0], a[1]], b: [b[0], b[1]] };
}

/**
 * Drift a lane's end to `target`, fading the lateral shift to zero over
 * `taperLen` of arc back along the polyline (smoothstep). Where a line's lane
 * slot changes across a node (bundle composition shifts), this absorbs the
 * jog into a long gentle slant along the edge instead of a localized S-wiggle
 * at the node. Mutates the polyline in place.
 */
export function taperLaneEnd(
  poly: Pixel[],
  atStart: boolean,
  target: Pixel,
  taperLen: number,
): void {
  if (poly.length < 2 || taperLen <= 0) return;
  const end = atStart ? poly[0] : poly[poly.length - 1];
  const dx = target[0] - end[0];
  const dy = target[1] - end[1];
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  let acc = 0;
  let prev = end;
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p = atStart ? poly[k] : poly[n - 1 - k];
    acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = [p[0], p[1]];
    const w = 1 - acc / taperLen;
    if (w <= 0) break;
    const s = w * w * (3 - 2 * w); // smoothstep
    p[0] += dx * s;
    p[1] += dy * s;
  }
}

/**
 * Assign each line a stable signed lane offset, taken from its index in the
 * line order of its most-canonical (longest, then lowest-id) edge.
 * Returns lineId -> offset (pixels).
 */
export function computeCanonicalOffsets(layout: Layout): Map<string, number> {
  const spacing = LINE_WIDTH + LINE_GAP;
  const byLine = new Map<string, Layout['edges']>();
  for (const edge of layout.edges) {
    for (const line of edge.lines) {
      if (!byLine.has(line.id)) byLine.set(line.id, []);
      byLine.get(line.id)!.push(edge);
    }
  }
  const offsets = new Map<string, number>();
  const authority = new Map<string, number>(); // canonical edge's lineOrder length
  for (const [lineId, edges] of byLine) {
    const canonical = [...edges].sort((a, b) => {
      if (b.lineOrder.length !== a.lineOrder.length) return b.lineOrder.length - a.lineOrder.length;
      return a.id.localeCompare(b.id);
    })[0];
    const idx = canonical.lineOrder.indexOf(lineId);
    const center = (canonical.lineOrder.length - 1) / 2;
    offsets.set(lineId, (idx - center) * spacing);
    authority.set(lineId, canonical.lineOrder.length);
  }

  // De-collision: two lines that co-run on SOME edge but take their offsets
  // from DIFFERENT canonical edges can land on the same global offset — they
  // then draw at identical coordinates and one hides the other entirely.
  // Process lines from most- to least-authoritative; each line keeps its slot
  // unless it sits (effectively) on top of an already-fixed co-running line,
  // in which case it shifts by whole lane spacings to the nearest free slot.
  const neighbors = new Map<string, Set<string>>();
  for (const edge of layout.edges) {
    for (const a of edge.lines) {
      for (const b of edge.lines) {
        if (a.id === b.id) continue;
        let s = neighbors.get(a.id);
        if (!s) neighbors.set(a.id, (s = new Set()));
        s.add(b.id);
      }
    }
  }
  const order = [...offsets.keys()].sort((a, b) => {
    const d = (authority.get(b) ?? 0) - (authority.get(a) ?? 0);
    return d !== 0 ? d : a.localeCompare(b);
  });
  const fixed = new Set<string>();
  const COINCIDENT = 1.0; // px — only true overdraw counts as a collision
  for (const lineId of order) {
    const base = offsets.get(lineId)!;
    const taken: number[] = [];
    for (const n of neighbors.get(lineId) ?? []) {
      if (fixed.has(n)) taken.push(offsets.get(n)!);
    }
    let chosen = base;
    if (taken.some((t) => Math.abs(t - base) < COINCIDENT)) {
      for (let step = 1; step < 32; step++) {
        for (const cand of [base + step * spacing, base - step * spacing]) {
          if (!taken.some((t) => Math.abs(t - cand) < COINCIDENT)) {
            chosen = cand;
            break;
          }
        }
        if (chosen !== base) break;
      }
    }
    offsets.set(lineId, chosen);
    fixed.add(lineId);
  }
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
  ) {
    for (const [lineId, off] of offsets) {
      console.error(`[offsets] ${lineId.slice(0, 6)} -> ${off}`);
    }
    for (const [a, ns] of neighbors) {
      for (const b of ns) {
        if (a < b && Math.abs(offsets.get(a)! - offsets.get(b)!) < COINCIDENT) {
          console.error(`[offsets] RESIDUAL COINCIDENCE ${a.slice(0, 6)} ~ ${b.slice(0, 6)} @ ${offsets.get(a)}`);
        }
      }
    }
  }
  return offsets;
}

/** Drop consecutive points that sit within `eps` of the previous one. Also
 *  drop a middle vertex whose two adjacent edges undo each other (an A→B→A
 *  ping-pong) — these produce a zero-bisector at B and turn into visible
 *  spike artifacts when offset.
 *
 *  Co-linear vertices are deliberately KEPT: stops are placed at specific
 *  centerline vertices and downstream code relies on the input-to-output
 *  index correspondence holding (modulo U-turn/dup drops). Dropping straight-
 *  line vertices broke that mapping and caused station dots to land off the
 *  drawn line entirely. */
export function simplifyPolyline(points: Pixel[], eps = 0.5): Pixel[] {
  if (points.length < 2) return points.slice();
  const dedup: Pixel[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = dedup[dedup.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= eps) {
      dedup.push(points[i]);
    }
  }
  if (dedup.length < 3) return dedup;
  const out: Pixel[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1];
    const b = dedup[i];
    const c = dedup[i + 1];
    // U-turn: incoming and outgoing unit vectors are anti-parallel (dot ≈ -1).
    const u1 = unit(a, b);
    const u2 = unit(b, c);
    if (u1[0] * u2[0] + u1[1] * u2[1] < -0.95) continue; // drop B
    out.push(b);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

/** Shift a pixel polyline perpendicular by `offset`, mitering at joints.
 *  By default pre-simplifies the input so U-turns and consecutive duplicates
 *  don't collapse the bisector into a zero-length normal (which would
 *  otherwise produce visible "spike" artifacts on offset bundles). Pass
 *  `simplify=false` when the caller needs the output indices to correspond
 *  1:1 with the input indices — e.g. when computing stop positions that must
 *  sit on the same drawn ribbon. The miter floor caps the lateral overshoot
 *  at sharp turns so an acute corner can't extend the offset polyline more
 *  than ~sqrt(1/0.5) ≈ 1.41× the offset distance. */
export function offsetPolyline(points: Pixel[], offset: number, simplify = true): Pixel[] {
  const pts = simplify ? simplifyPolyline(points, 0.5) : points;
  if (pts.length < 2) return pts;
  const out: Pixel[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    let normal: Pixel;
    if (!prev) {
      normal = perp(unit(cur, next));
    } else if (!next) {
      normal = perp(unit(prev, cur));
    } else {
      const n1 = perp(unit(prev, cur));
      const n2 = perp(unit(cur, next));
      const sum: Pixel = [n1[0] + n2[0], n1[1] + n2[1]];
      const sumLen = Math.hypot(sum[0], sum[1]);
      if (sumLen < 1e-6) {
        // U-turn slipped past simplifyPolyline (degenerate after dedup).
        // Use the incoming normal directly — better than a NaN/0 vector.
        normal = n1;
      } else {
        // Miter floor raised from 0.3 → 0.5: limits the perpendicular over-
        // shoot at acute turns to ~sqrt(1/0.5) = 1.41× the offset distance.
        // The previous 0.3 floor allowed ~1.83× extension, which produced
        // visible spike/Z-triangle artifacts at bundle joints where yellow
        // and similar lines made sharp lateral transitions.
        const miter = Math.max(0.5, (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2);
        normal = [sum[0] / sumLen / Math.sqrt(miter), sum[1] / sumLen / Math.sqrt(miter)];
      }
    }
    out.push([cur[0] + normal[0] * offset, cur[1] + normal[1] * offset]);
  }
  return out;
}
