// Piecewise-octilinear path between two real pixel positions: each segment runs
// in one of the 8 octilinear directions, but the overall polyline lands exactly
// at the target position. Built by decomposing the displacement onto the two
// adjacent octilinear unit vectors that bracket its direction, then splitting
// each component into N alternating short segments.

import type { Pixel } from './types';

/**
 * @param from start position
 * @param to   end position
 * @param segments how many alternating "u1+u2" cycles to use; 1 = simple L,
 *                 2 = three bends (matches a 4-step staircase), etc.
 *                 Pass 0 for a straight line.
 */
export function octilinearPath(from: Pixel, to: Pixel, segments = 2): Pixel[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6 || segments < 1) return [from, to];

  // Bracket the displacement direction by two adjacent octilinear unit vectors.
  // Octilinear angles are k·45° for k=0..7.
  const TAU = 2 * Math.PI;
  const angle = ((Math.atan2(dy, dx) % TAU) + TAU) % TAU; // [0, 2π)
  const step = Math.PI / 4;
  const sector = Math.floor(angle / step); // 0..7
  const a1 = sector * step;
  const a2 = a1 + step;
  const u1: Pixel = [Math.cos(a1), Math.sin(a1)];
  const u2: Pixel = [Math.cos(a2), Math.sin(a2)];

  // Solve  a·u1 + b·u2 = (dx, dy)  for non-negative a, b.
  const det = u1[0] * u2[1] - u1[1] * u2[0];
  if (Math.abs(det) < 1e-9) return [from, to];
  const a = (dx * u2[1] - dy * u2[0]) / det;
  const b = (u1[0] * dy - u1[1] * dx) / det;

  // If the displacement is already along a single octilinear direction, one
  // straight segment is the right answer.
  if (Math.abs(a) < 1e-6 || Math.abs(b) < 1e-6) return [from, to];

  const da = a / segments;
  const db = b / segments;
  // Lead with whichever component is longer so the first bend looks natural.
  const aFirst = Math.abs(a) >= Math.abs(b);

  const path: Pixel[] = [from];
  let x = from[0];
  let y = from[1];
  for (let i = 0; i < segments; i++) {
    const first = aFirst ? u1 : u2;
    const firstMag = aFirst ? da : db;
    const second = aFirst ? u2 : u1;
    const secondMag = aFirst ? db : da;
    x += firstMag * first[0];
    y += firstMag * first[1];
    path.push([x, y]);
    x += secondMag * second[0];
    y += secondMag * second[1];
    path.push([x, y]);
  }
  // Snap the final vertex to the exact target to absorb any rounding error.
  path[path.length - 1] = [to[0], to[1]];
  return path;
}
