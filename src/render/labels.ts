// Station label placement + rendering, ported from the game
// (dev/reference/placeLabels.js, renderLabel.js, estimateTextWidth.js,
// boxesOverlap.js, segmentIntersectsBox.js). Shared by both renderers.

import type { GraphNode, StopMark, Pixel } from './layout/types';
import { LINE_WIDTH, LABEL_FONT_SIZE, LABEL_CHAR_WIDTH, LABEL_OFFSET } from './constants';
import { escapeXml } from './escape';

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
}
export interface Segment {
  p1: Pixel;
  p2: Pixel;
}

export const estimateTextWidth = (s: string): number => s.length * LABEL_CHAR_WIDTH;

export function boxesOverlap(a: Box, b: Box): boolean {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
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

interface Candidate {
  placement: Placement;
  box: Box;
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

export function placeLabels(
  graph: { nodes: Map<string, LabelNode> },
  nodePx: Map<string, Pixel>,
  stopsByNode: Map<string, StopMark[]>,
  segments: Segment[],
): Map<string, Placement> {
  const result = new Map<string, Placement>();
  const placedBoxes: Box[] = [];
  const stationBoxes: Box[] = [];
  const markerR = LINE_WIDTH * 0.7;

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

  const nodes = [...graph.nodes.values()]
    .filter((n) => stopsByNode.has(n.id))
    .sort((a, b) => b.label.length - a.label.length);

  for (const node of nodes) {
    const p = nodePx.get(node.id);
    if (!p) continue;
    const tw = estimateTextWidth(node.label);
    const fh = LABEL_FONT_SIZE + 2;
    const off = LABEL_OFFSET;
    const [cx, cy] = p;
    const candidates: Candidate[] = [
      { placement: { x: cx + off, y: cy + fh / 3, anchor: 'start' }, box: { x: cx + off, y: cy - fh / 2, w: tw, h: fh }, priority: 1 },
      { placement: { x: cx - off, y: cy + fh / 3, anchor: 'end' }, box: { x: cx - off - tw, y: cy - fh / 2, w: tw, h: fh }, priority: 1 },
      { placement: { x: cx, y: cy - off, anchor: 'middle' }, box: { x: cx - tw / 2, y: cy - off - fh, w: tw, h: fh }, priority: 2 },
      { placement: { x: cx, y: cy + off + fh - 2, anchor: 'middle' }, box: { x: cx - tw / 2, y: cy + off, w: tw, h: fh }, priority: 2 },
      { placement: { x: cx + off * 0.7, y: cy - off * 0.7, anchor: 'start' }, box: { x: cx + off * 0.7, y: cy - off * 0.7 - fh, w: tw, h: fh }, priority: 3 },
      { placement: { x: cx - off * 0.7, y: cy - off * 0.7, anchor: 'end' }, box: { x: cx - off * 0.7 - tw, y: cy - off * 0.7 - fh, w: tw, h: fh }, priority: 3 },
      { placement: { x: cx + off * 0.7, y: cy + off * 0.7 + fh - 2, anchor: 'start' }, box: { x: cx + off * 0.7, y: cy + off * 0.7, w: tw, h: fh }, priority: 3 },
      { placement: { x: cx - off * 0.7, y: cy + off * 0.7 + fh - 2, anchor: 'end' }, box: { x: cx - off * 0.7 - tw, y: cy + off * 0.7, w: tw, h: fh }, priority: 3 },
    ];

    let best = candidates[0];
    let bestCost = Infinity;
    for (const cand of candidates) {
      let cost = 0;
      for (const b of placedBoxes) if (boxesOverlap(cand.box, b)) cost += 100;
      for (const b of stationBoxes) if (boxesOverlap(cand.box, b)) cost += 30;
      for (const s of segments) if (segmentIntersectsBox(s.p1, s.p2, cand.box)) cost += 12;
      cost += cand.priority;
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    placedBoxes.push(best.box);
    result.set(node.id, best.placement);
  }

  return result;
}

/**
 * A label pinned to its dot. The outer group translates to the dot (so it moves
 * with the map under viewBox zoom); the inner `imp-lbl-s` group is counter-scaled
 * by the panel (transform=scale(1/zoom)) so the text AND its offset stay a
 * constant on-screen size — no drift as you zoom. `anchor` is the dot's pixel
 * position; the placement offset is emitted relative to it.
 */
export function renderLabel(
  node: GraphNode | { id: string; label: string },
  placement: Placement,
  anchor: Pixel,
  hasStops: boolean,
  dark: boolean,
): string {
  const fill = dark ? (hasStops ? '#f4f4f5' : '#71717a') : hasStops ? '#222' : '#888';
  const dx = placement.x - anchor[0];
  const dy = placement.y - anchor[1];
  return (
    '<g class="imp-lbl" data-station-id="' + escapeXml(node.id) +
    '" transform="translate(' + anchor[0].toFixed(1) + ',' + anchor[1].toFixed(1) + ')">' +
    '<g class="imp-lbl-s">' +
    '<text x="' + dx.toFixed(1) + '" y="' + dy.toFixed(1) +
    '" text-anchor="' + placement.anchor +
    '" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="' +
    LABEL_FONT_SIZE + '" fill="' + fill + '" font-weight="medium">' +
    escapeXml(node.label) + '</text></g></g>'
  );
}
