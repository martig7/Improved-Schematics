// Station label placement + rendering, ported from the game
// (dev/reference/placeLabels.js, renderLabel.js, estimateTextWidth.js,
// boxesOverlap.js, segmentIntersectsBox.js). Shared by both renderers.

import { envStr } from '../env';
import type { GraphNode, StopMark, Pixel } from './layout/types';
import { LINE_WIDTH, LABEL_FONT_SIZE, LABEL_CHAR_WIDTH, LABEL_OFFSET, LABEL_WRAP_W, MARK_R0 } from './constants';
import { escapeXml } from './escape';
import type { Prim } from './sceneIR';
import { obbFromLocalBox, obbAabb, obbOverlap, segmentIntersectsObb, tilt, type Obb } from './labelGeom';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placement {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** Screen rotation in degrees about the text origin; absent/0 = flat (today). */
  angle?: number;
  /** Two wrapped lines for a long name; absent/single = the one-line render. */
  lines?: string[];
}
export interface Segment {
  p1: Pixel;
  p2: Pixel;
}

export const estimateTextWidth = (s: string): number => s.length * LABEL_CHAR_WIDTH;

/**
 * Wrap a station name to at most two lines when it is estimated wider than
 * `maxWidth`, splitting only at a space (never mid-word) at the point that
 * minimizes the wider line. A name with no space, or one within the width, is
 * returned as a single line. Pure and deterministic.
 */
export function wrapLabel(label: string, maxWidth: number): string[] {
  if (estimateTextWidth(label) <= maxWidth) return [label];
  const words = label.split(' ');
  if (words.length < 2) return [label]; // no space to break on
  let bestSplit = 1;
  let bestMax = Infinity;
  for (let i = 1; i < words.length; i++) {
    const w1 = estimateTextWidth(words.slice(0, i).join(' '));
    const w2 = estimateTextWidth(words.slice(i).join(' '));
    const m = Math.max(w1, w2);
    if (m < bestMax) {
      bestMax = m;
      bestSplit = i;
    }
  }
  return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')];
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
}

/** Euclidean gap between two axis-aligned boxes (0 when they overlap/touch).
 *  sqrt-based so it is correctly rounded cross-V8 (engine-stable for the tie-break). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.sqrt(dx * dx + dy * dy);
}

/** Euclidean gap between an axis-aligned box and a segment (0 when they meet).
 *  The min distance of two disjoint convex shapes is realized vertex-to-edge, so
 *  it is the least of the box corners to the segment and the segment ends to the
 *  box. sqrt-based for cross-V8 stability. */
export function boxSegGap(box: Box, p1: Pixel, p2: Pixel): number {
  if (segmentIntersectsBox(p1, p2, box)) return 0;
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  const ptSeg = (px: number, py: number): number => {
    const vx = p2[0] - p1[0];
    const vy = p2[1] - p1[1];
    const c1 = vx * (px - p1[0]) + vy * (py - p1[1]);
    if (c1 <= 0) return Math.sqrt((px - p1[0]) ** 2 + (py - p1[1]) ** 2);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.sqrt((px - p2[0]) ** 2 + (py - p2[1]) ** 2);
    const t = c1 / c2;
    return Math.sqrt((px - (p1[0] + t * vx)) ** 2 + (py - (p1[1] + t * vy)) ** 2);
  };
  const ptBox = (px: number, py: number): number => {
    const dx = Math.max(box.x - px, 0, px - x2);
    const dy = Math.max(box.y - py, 0, py - y2);
    return Math.sqrt(dx * dx + dy * dy);
  };
  return Math.min(
    ptSeg(box.x, box.y), ptSeg(x2, box.y), ptSeg(x2, y2), ptSeg(box.x, y2),
    ptBox(p1[0], p1[1]), ptBox(p2[0], p2[1]),
  );
}

export function segmentIntersectsBox(p1: Pixel, p2: Pixel, box: Box): boolean {
  const x1 = box.x;
  const x2 = box.x + box.w;
  const y1 = box.y;
  const y2 = box.y + box.h;
  const minX = Math.min(p1[0], p2[0]);
  const maxX = Math.max(p1[0], p2[0]);
  const minY = Math.min(p1[1], p2[1]);
  const maxY = Math.max(p1[1], p2[1]);
  if (maxX < x1 || minX > x2 || maxY < y1 || minY > y2) return false;
  if (p1[0] >= x1 && p1[0] <= x2 && p1[1] >= y1 && p1[1] <= y2) return true;
  if (p2[0] >= x1 && p2[0] <= x2 && p2[1] >= y1 && p2[1] <= y2) return true;
  const cross = (o: Pixel, a: Pixel, b: Pixel) =>
    (b[1] - o[1]) * (a[0] - o[0]) - (a[1] - o[1]) * (b[0] - o[0]);
  const segIntersect = (a: Pixel, b: Pixel, c: Pixel, d: Pixel) => {
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
  };
  const corners: Pixel[] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  for (let i = 0; i < 4; i++) {
    if (segIntersect(p1, p2, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** A label footprint: an axis-aligned box (angle 0, the legacy path) or an OBB.
 *  Flat footprints keep the exact existing overlap code so the legacy path is
 *  byte-identical by construction; only a rotated candidate touches the OBB tests. */
interface Footprint {
  angle: number;
  box?: Box;
  obb?: Obb;
}

const boxToObb = (b: Box): Obb => obbFromLocalBox([b.x, b.y], 0, 0, b.w, b.h, 0);
const asObb = (f: Footprint): Obb => f.obb ?? boxToObb(f.box!);
/** Overlap of two label footprints; both flat uses boxesOverlap, else the OBB SAT. */
const fpOverlap = (a: Footprint, b: Footprint): boolean =>
  a.angle === 0 && b.angle === 0 ? boxesOverlap(a.box!, b.box!) : obbOverlap(asObb(a), asObb(b));
/** Overlap of a footprint with an axis-aligned box (station/marker boxes). */
const fpHitsBox = (f: Footprint, b: Box): boolean =>
  f.angle === 0 ? boxesOverlap(f.box!, b) : obbOverlap(asObb(f), boxToObb(b));
const fpSeg = (f: Footprint, s: Segment): boolean =>
  f.angle === 0 ? segmentIntersectsBox(s.p1, s.p2, f.box!) : segmentIntersectsObb(s.p1, s.p2, f.obb!);
const fpAabb = (f: Footprint): Box => f.box ?? obbAabb(f.obb!);

interface Candidate {
  placement: Placement;
  fp: Footprint;
  priority: number;
}

/**
 * Choose a non-overlapping label position for each node that has stops, scoring
 * 8 candidate placements against already-placed labels, station markers, and
 * line segments.
 */
/** Minimal node shape placeLabels needs (satisfied by GraphNode and LayoutNode). */
export interface LabelNode {
  id: string;
  label: string;
}

/** A capsule counts as "slid", with its centre stranded in empty space, only when
 *  its nearest dot is at least this far from the node centre. Below it the centre
 *  still sits on/among the dots, so the label hangs off the centre. Pitched above
 *  a normal capsule's half-dot-spacing (~LINE_WIDTH) so ordinary interchanges keep
 *  the centre anchor (and don't perturb the greedy label packer); only genuinely
 *  displaced capsules re-seat. */
const ANCHOR_SLID_DIST = LINE_WIDTH * 3;

/**
 * The pixel point a station's label should hang off. A SINGLE-dot stop hangs off
 * its one drawn dot: the node centre is only the abstract graph vertex, while the
 * dot sits on its line's lane (offset by the bundle slot) and may have slid, so
 * anchoring to the centre floats the label off the marker by up to a bundle
 * half-width. A MULTI-dot capsule keeps the cluster CENTRE (the label points at
 * the whole pill), re-anchoring to the dot CLOSEST to the centre only when the
 * dots have slid well off it, so an ordinary interchange doesn't churn the label
 * layout and only genuinely displaced capsules re-seat.
 * Closest by squared distance; first mark wins exact ties (deterministic).
 */
export function labelAnchor(center: Pixel, marks?: StopMark[]): Pixel {
  // Diagnostic switch: OCTI_NO_LABEL_REANCHOR=1 disables re-anchoring, so the
  // label always hangs off the bare node centre (the pre-fix behaviour).
  if (envStr('OCTI_NO_LABEL_REANCHOR') === '1') {
    return center;
  }
  if (!marks || marks.length === 0) return center;
  // Single dot IS the anchor. Reverted to the bare centre in the full-legacy mode
  // (OCTI_LABEL_NO_ROTATE, which turns off all new label behaviour) so that switch
  // still reproduces master byte-for-byte.
  if (marks.length === 1) return envStr('OCTI_LABEL_NO_ROTATE') === '1' ? center : marks[0].pos;
  let best = marks[0].pos;
  let bestD = Infinity;
  for (const m of marks) {
    const dx = m.pos[0] - center[0];
    const dy = m.pos[1] - center[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = m.pos;
    }
  }
  return bestD > ANCHOR_SLID_DIST * ANCHOR_SLID_DIST ? best : center;
}

/**
 * Placement order plus each node's on-bundle predecessor, derived from the stop
 * marks alone. Stations are walked line by line (lines in id order) in stop-seq
 * order, so a node's on-bundle neighbor is placed just before it; nodes without a
 * seq (e.g. the geographic caller's synthetic stops) tail the list longest-label
 * first, reproducing the previous global order for that caller. Deterministic:
 * lines sorted by id, seq ties broken by node id. Pure.
 */
export function bundleOrder(
  nodes: LabelNode[],
  stopsByNode: Map<string, StopMark[]>,
): { order: LabelNode[]; prevOnBundle: Map<string, string> } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const perLine = new Map<string, Array<{ nodeId: string; seq: number }>>();
  for (const n of nodes) {
    for (const m of stopsByNode.get(n.id) ?? []) {
      if (m.seq == null || !m.lineId) continue;
      let arr = perLine.get(m.lineId);
      if (!arr) perLine.set(m.lineId, (arr = []));
      arr.push({ nodeId: n.id, seq: m.seq });
    }
  }
  const order: LabelNode[] = [];
  const seen = new Set<string>();
  const prevOnBundle = new Map<string, string>();
  for (const lineId of [...perLine.keys()].sort()) {
    const seq = perLine.get(lineId)!.sort((a, b) => a.seq - b.seq || (a.nodeId < b.nodeId ? -1 : 1));
    let prev: string | null = null;
    for (const { nodeId } of seq) {
      if (prev != null && !prevOnBundle.has(nodeId)) prevOnBundle.set(nodeId, prev);
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        order.push(byId.get(nodeId)!);
      }
      prev = nodeId;
    }
  }
  for (const n of nodes.filter((n) => !seen.has(n.id)).sort((a, b) => b.label.length - a.label.length)) {
    order.push(n);
  }
  return { order, prevOnBundle };
}

export function placeLabels(
  graph: { nodes: Map<string, LabelNode> },
  nodePx: Map<string, Pixel>,
  stopsByNode: Map<string, StopMark[]>,
  segments: Segment[],
): Map<string, Placement> {
  const result = new Map<string, Placement>();
  const placed: Footprint[] = [];
  const stationBoxes: Box[] = [];
  const markerR = MARK_R0;
  // OCTI_LABEL_NO_ROTATE=1 restores the legacy path: no rotated candidates and the
  // old longest-label-first order, so the dumps render byte-identical to before.
  const noRotate = envStr('OCTI_LABEL_NO_ROTATE') === '1';
  // Soft clearance (position term). The hard costs fire only on ACTUAL overlap, so
  // labels pack shoulder-to-shoulder in crowded areas. This term adds a small
  // penalty for merely being CLOSE (within CLEAR_MARGIN) to already-placed labels,
  // station markers, and line segments, so a label drifts into the clearer of two
  // otherwise-equal spots. Weighted on the tilt scale (W_CLEAR), so it trades off
  // against rotation: a label near adjacent text may rotate to gain room. Gaps are
  // sqrt-based and the argmin is a total order, so deterministic.
  const CLEAR_MARGIN = LABEL_FONT_SIZE * 1.5; // proximity scale
  const W_CLEAR = 0.15; // per-unit-of-encroachment weight (tunable at the render checkpoint)
  const clearanceLM = (box: Box): number => {
    let c = 0;
    for (const f of placed) { const g = boxGap(box, fpAabb(f)); if (g < CLEAR_MARGIN) c += CLEAR_MARGIN - g; }
    for (const b of stationBoxes) { const g = boxGap(box, b); if (g < CLEAR_MARGIN) c += CLEAR_MARGIN - g; }
    return c;
  };

  for (const [, marks] of stopsByNode) {
    if (marks.length === 1) {
      const [x, y] = marks[0].pos;
      stationBoxes.push({ x: x - markerR, y: y - markerR, w: 2 * markerR, h: 2 * markerR });
    } else {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const m of marks) {
        if (m.pos[0] < minX) minX = m.pos[0];
        if (m.pos[0] > maxX) maxX = m.pos[0];
        if (m.pos[1] < minY) minY = m.pos[1];
        if (m.pos[1] > maxY) maxY = m.pos[1];
      }
      stationBoxes.push({
        x: minX - markerR,
        y: minY - markerR,
        w: maxX - minX + 2 * markerR,
        h: maxY - minY + 2 * markerR,
      });
    }
  }

  const nodesWithStops = [...graph.nodes.values()].filter((n) => stopsByNode.has(n.id));
  // Bundle-walk order so a station's on-bundle neighbour is placed first (the side
  // bonus below reads its offset). The legacy path keeps longest-label-first.
  const { order: placeOrder, prevOnBundle } = noRotate
    ? { order: nodesWithStops.sort((a, b) => b.label.length - a.label.length), prevOnBundle: new Map<string, string>() }
    : bundleOrder(nodesWithStops, stopsByNode);
  const chosenOffset = new Map<string, [number, number]>();
  const WSIDE = 5; // same-bundle side-mismatch penalty (tunable at the render checkpoint)

  for (const node of placeOrder) {
    const p = nodePx.get(node.id);
    if (!p) continue;
    const fh = LABEL_FONT_SIZE + 2;
    const off = LABEL_OFFSET;
    // Two-line wrap for long names (space split only, never mid-word). The legacy
    // path and short names stay one line, so tw === the single-line width and
    // extraH === 0, leaving their candidate boxes byte-identical. A wrapped label
    // is narrower (max line width) and taller (the box grows down by one line).
    const lines = noRotate ? [node.label] : wrapLabel(node.label, LABEL_WRAP_W);
    const tw = lines.length > 1 ? Math.max(...lines.map((l) => estimateTextWidth(l))) : estimateTextWidth(node.label);
    const extraH = (lines.length - 1) * fh;
    // Hang the label off the capsule dot nearest the node centre (not the bare
    // centre), so it tracks the markers when collision passes slide them.
    const [cx, cy] = labelAnchor(p, stopsByNode.get(node.id));
    // Same-bundle side coherence: sign of cross(lineDir, offset) is which side of
    // the line a label sits on; prefer the side the on-bundle predecessor took. The
    // predecessor is compared under THIS pair's line direction, so the first station
    // (no predecessor) simply seeds a side for the rest to follow.
    const prevId = prevOnBundle.get(node.id);
    const prevP = prevId ? nodePx.get(prevId) : undefined;
    const dirx = prevP ? p[0] - prevP[0] : 0;
    const diry = prevP ? p[1] - prevP[1] : 0;
    const crossSign = (ox: number, oy: number): number => {
      const cr = dirx * oy - diry * ox;
      return cr > 0 ? 1 : cr < 0 ? -1 : 0;
    };
    const prevOff = prevId ? chosenOffset.get(prevId) : undefined;
    const prevSide = prevOff ? crossSign(prevOff[0], prevOff[1]) : 0;
    // Side-aware anchor for a multi-dot capsule: a candidate offset toward a side
    // hangs off the OUTERMOST dot on that side (the near end of the pill), so as the
    // clearance term shifts a label to the clearer side it stays tied to a real
    // marker rather than the empty cluster centre. Single dots and the legacy path
    // use the one anchor (cx, cy) for every direction, so they are unchanged.
    const marks = stopsByNode.get(node.id);
    const multi = !noRotate && !!marks && marks.length >= 2;
    const anchorFor = (dux: number, duy: number): readonly [number, number] => {
      if (!multi) return [cx, cy] as const;
      let bx = marks![0].pos[0];
      let by = marks![0].pos[1];
      let bestProj = -Infinity;
      for (const m of marks!) {
        const proj = m.pos[0] * dux + m.pos[1] * duy;
        if (proj > bestProj) { bestProj = proj; bx = m.pos[0]; by = m.pos[1]; }
      }
      return [bx, by] as const;
    };
    const aE = anchorFor(1, 0), aW = anchorFor(-1, 0), aN = anchorFor(0, -1), aS = anchorFor(0, 1);
    const aNE = anchorFor(1, -1), aNW = anchorFor(-1, -1), aSE = anchorFor(1, 1), aSW = anchorFor(-1, 1);
    // Flat candidates (angle 0): geometry and priorities as before, each hung off
    // its side's anchor. A single dot / legacy makes every anchor (cx, cy), so the
    // boxes are byte-identical there.
    const flat: Candidate[] = [
      { placement: { x: aE[0] + off, y: aE[1] + fh / 3, anchor: 'start' }, fp: { angle: 0, box: { x: aE[0] + off, y: aE[1] - fh / 2, w: tw, h: fh + extraH } }, priority: 1 },
      { placement: { x: aW[0] - off, y: aW[1] + fh / 3, anchor: 'end' }, fp: { angle: 0, box: { x: aW[0] - off - tw, y: aW[1] - fh / 2, w: tw, h: fh + extraH } }, priority: 1 },
      { placement: { x: aN[0], y: aN[1] - off, anchor: 'middle' }, fp: { angle: 0, box: { x: aN[0] - tw / 2, y: aN[1] - off - fh, w: tw, h: fh + extraH } }, priority: 2 },
      { placement: { x: aS[0], y: aS[1] + off + fh - 2, anchor: 'middle' }, fp: { angle: 0, box: { x: aS[0] - tw / 2, y: aS[1] + off, w: tw, h: fh + extraH } }, priority: 2 },
      { placement: { x: aNE[0] + off * 0.7, y: aNE[1] - off * 0.7, anchor: 'start' }, fp: { angle: 0, box: { x: aNE[0] + off * 0.7, y: aNE[1] - off * 0.7 - fh, w: tw, h: fh + extraH } }, priority: 3 },
      { placement: { x: aNW[0] - off * 0.7, y: aNW[1] - off * 0.7, anchor: 'end' }, fp: { angle: 0, box: { x: aNW[0] - off * 0.7 - tw, y: aNW[1] - off * 0.7 - fh, w: tw, h: fh + extraH } }, priority: 3 },
      { placement: { x: aSE[0] + off * 0.7, y: aSE[1] + off * 0.7 + fh - 2, anchor: 'start' }, fp: { angle: 0, box: { x: aSE[0] + off * 0.7, y: aSE[1] + off * 0.7, w: tw, h: fh + extraH } }, priority: 3 },
      { placement: { x: aSW[0] - off * 0.7, y: aSW[1] + off * 0.7 + fh - 2, anchor: 'end' }, fp: { angle: 0, box: { x: aSW[0] - off * 0.7 - tw, y: aSW[1] + off * 0.7, w: tw, h: fh + extraH } }, priority: 3 },
    ];
    // Rotated candidates: octilinear text that slots into space the flat boxes
    // cannot, each hung off its side's anchor. The tilt penalty keeps these below
    // flat unless flat collides; 90 is the sideways last resort.
    const rot = (ox: number, oy: number, angle: number, anchor: Placement['anchor']): Candidate => {
      const x0 = anchor === 'end' ? -tw : anchor === 'middle' ? -tw / 2 : 0;
      return {
        placement: { x: ox, y: oy, anchor, angle },
        fp: { angle, obb: obbFromLocalBox([ox, oy], x0, -fh / 2, x0 + tw, fh / 2 + extraH, angle) },
        priority: 1,
      };
    };
    const rotated: Candidate[] = noRotate ? [] : [
      rot(aE[0] + off, aE[1], -90, 'start'),
      rot(aW[0] - off, aW[1], -90, 'start'),
      rot(aNE[0] + off * 0.7, aNE[1] - off * 0.7, -45, 'start'),
      rot(aSE[0] + off * 0.7, aSE[1] + off * 0.7, 45, 'start'),
      rot(aNW[0] - off * 0.7, aNW[1] - off * 0.7, 45, 'end'),
      rot(aSW[0] - off * 0.7, aSW[1] + off * 0.7, -45, 'end'),
    ];
    const candidates = [...flat, ...rotated];
    // Segments near this node's candidates, so the clearance term stays cheap in
    // the map's total segment count (candidates all live within ~R of the anchor).
    const R = CLEAR_MARGIN + tw + off + extraH;
    const nearSegs = noRotate ? [] : segments.filter((s) => {
      const lo = (a: number, b: number) => Math.min(a, b) - R;
      const hi = (a: number, b: number) => Math.max(a, b) + R;
      return cx >= lo(s.p1[0], s.p2[0]) && cx <= hi(s.p1[0], s.p2[0]) && cy >= lo(s.p1[1], s.p2[1]) && cy <= hi(s.p1[1], s.p2[1]);
    });

    let best = candidates[0];
    let bestCost = Infinity;
    for (const cand of candidates) {
      let cost = 0;
      for (const f of placed) if (fpOverlap(cand.fp, f)) cost += 100;
      for (const b of stationBoxes) if (fpHitsBox(cand.fp, b)) cost += 30;
      for (const s of segments) if (fpSeg(cand.fp, s)) cost += 12;
      cost += cand.priority;
      cost += tilt(cand.fp.angle);
      if (prevSide !== 0) {
        const side = crossSign(cand.placement.x - cx, cand.placement.y - cy);
        if (side !== 0 && side !== prevSide) cost += WSIDE;
      }
      if (!noRotate) {
        const aabb = fpAabb(cand.fp);
        let clr = clearanceLM(aabb); // adjacent labels + markers
        for (const s of nearSegs) { const g = boxSegGap(aabb, s.p1, s.p2); if (g < CLEAR_MARGIN) clr += CLEAR_MARGIN - g; } // + lines
        cost += W_CLEAR * clr;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    chosenOffset.set(node.id, [best.placement.x - cx, best.placement.y - cy]);
    placed.push(best.fp);
    result.set(node.id, lines.length > 1 ? { ...best.placement, lines } : best.placement);
  }

  return result;
}

/**
 * A label pinned to its dot. The outer group translates to the dot (so it moves
 * with the map under viewBox zoom); the inner `imp-lbl-s` group is counter-scaled
 * by the panel (transform=scale(1/zoom)) so the text AND its offset stay a
 * constant on-screen size, with no drift as you zoom. `anchor` is the dot's pixel
 * position; the placement offset is emitted relative to it.
 */
export function renderLabel(
  node: GraphNode | { id: string; label: string },
  placement: Placement,
  anchor: Pixel,
  hasStops: boolean,
  dark: boolean,
  prims?: Prim[],
): string {
  const fill = dark ? (hasStops ? '#f4f4f5' : '#71717a') : hasStops ? '#222' : '#888';
  const angle = placement.angle ?? 0;
  // Group transform: translate to the text origin, then rotate about it when the
  // placement is octilinear. Flat (angle 0) emits translate-only, byte-identical
  // to the pre-rotation renderer.
  const xf =
    'translate(' + placement.x.toFixed(1) + ',' + placement.y.toFixed(1) + ')' +
    (angle !== 0 ? ' rotate(' + angle + ')' : '');
  // Two wrapped lines stack as tspans one line-height apart; a single line renders
  // exactly as before (no tspan), so unwrapped labels stay byte-identical.
  const lines = placement.lines && placement.lines.length > 1 ? placement.lines : null;
  const LINE_DY = LABEL_FONT_SIZE + 2;
  const inner = lines
    ? '<tspan x="0">' + escapeXml(lines[0]) + '</tspan><tspan x="0" dy="' + LINE_DY + '">' + escapeXml(lines[1]) + '</tspan>'
    : escapeXml(node.label);
  // Translate the group to the TEXT position (placement) with the text at the
  // origin, so size scaling (panel/export/canvas) pivots around the text's own
  // anchor. The gap from the dot stays CONSTANT as label size changes; only the
  // glyphs grow. (Translating to the dot + offsetting the text would make a
  // larger label drift away from its station.)
  if (prims) {
    prims.push({
      kind: 'text',
      text: node.label,
      ax: placement.x,
      ay: placement.y,
      x: 0,
      y: 0,
      fontSize: LABEL_FONT_SIZE,
      // 500, not "medium": "medium" is NOT a valid CSS/canvas font-weight, so a
      // canvas ctx.font = "medium ..." is rejected (Chromium ignores the whole
      // assignment, leaving the prior tiny font), which makes canvas labels far
      // smaller than the SVG export. 500 is the numeric medium weight, valid in
      // canvas, CSS and SVG, so both backends render identically.
      fontWeight: '500',
      align: placement.anchor === 'middle' ? 'center' : placement.anchor === 'end' ? 'right' : 'left',
      fill,
      layer: 'stations',
      worldScale: false,
      // Carry the angle/lines only when set, so flat single-line prims are byte-identical.
      ...(angle !== 0 ? { angle } : {}),
      ...(lines ? { lines } : {}),
    });
  }
  return (
    '<g class="imp-lbl" data-station-id="' + escapeXml(node.id) +
    '" transform="' + xf + '">' +
    '<g class="imp-lbl-s">' +
    '<text x="0" y="0" text-anchor="' + placement.anchor +
    '" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="' +
    LABEL_FONT_SIZE + '" fill="' + fill + '" font-weight="500">' +
    inner + '</text></g></g>'
  );
}
