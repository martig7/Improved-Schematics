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
  for (const [lineId, edges] of byLine) {
    const canonical = [...edges].sort((a, b) => {
      if (b.lineOrder.length !== a.lineOrder.length) return b.lineOrder.length - a.lineOrder.length;
      return a.id.localeCompare(b.id);
    })[0];
    const idx = canonical.lineOrder.indexOf(lineId);
    const center = (canonical.lineOrder.length - 1) / 2;
    offsets.set(lineId, (idx - center) * spacing);
  }
  return offsets;
}

/** Shift a pixel polyline perpendicular by `offset`, mitering at joints. */
export function offsetPolyline(points: Pixel[], offset: number): Pixel[] {
  if (points.length < 2) return points;
  const out: Pixel[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    let normal: Pixel;
    if (!prev) {
      normal = perp(unit(cur, next));
    } else if (!next) {
      normal = perp(unit(prev, cur));
    } else {
      const n1 = perp(unit(prev, cur));
      const n2 = perp(unit(cur, next));
      const sum: Pixel = [n1[0] + n2[0], n1[1] + n2[1]];
      const len = Math.hypot(sum[0], sum[1]) || 1;
      const miter = Math.max(0.3, (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2);
      normal = [sum[0] / len / Math.sqrt(miter), sum[1] / len / Math.sqrt(miter)];
    }
    out.push([cur[0] + normal[0] * offset, cur[1] + normal[1] * offset]);
  }
  return out;
}
