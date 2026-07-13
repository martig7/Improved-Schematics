/**
 * Toronto "direct intersection" detection. A perfect crossing is a node whose
 * stopping lines run on at least two different octilinear axes AND all pass
 * within a tight radius of one point, so a single dot covers them. A parallel
 * bundle (one axis) or a spread junction (a parallel pair forcing the cover
 * wide) is not a crossing and is left to the pill capsule. Reuses the London
 * coverCenter test; design-agnostic geometry computed once at compute time.
 */
import { coverCenter, axisUnit, type Line } from './londonBubbles';
import { LINE_WIDTH, LINE_GAP } from '../constants';

/** The mark fields the crossing test needs: bundle axis, position, mega flag. */
interface CrossMark { axis?: number; pos: [number, number]; mega?: boolean }

export interface TorontoCross { cx: number; cy: number }

export function computeTorontoByNode(stops: Map<string, CrossMark[]>): Map<string, TorontoCross> {
  // Tighter than half the lane spacing, so two parallel lanes (a slot apart)
  // never collapse; only lines that truly cross at a point do.
  const cover = (LINE_WIDTH + LINE_GAP) * 0.35;
  const reach = LINE_WIDTH * 4;
  const out = new Map<string, TorontoCross>();
  for (const [nodeId, marks] of stops) {
    const ms = marks.filter((m) => !m.mega);
    if (ms.length <= 1) continue;
    const axes = new Set(ms.map((m) => (m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4))));
    if (axes.size < 2) continue; // one run-axis = a parallel bundle, not a crossing
    const lines: Line[] = ms.map((m) => {
      const key = m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4);
      const [ux, uy] = axisUnit(key === -1 ? 0 : key);
      return { ux, uy, px: m.pos[0], py: m.pos[1], axisKey: key };
    });
    const c = coverCenter(lines, cover, reach);
    if (c) out.set(nodeId, { cx: c.x, cy: c.y });
  }
  return out;
}
