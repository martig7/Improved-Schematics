/**
 * Toronto "direct intersection" detection. A perfect crossing is a node whose
 * stopping lines run on at least two different octilinear axes AND meet at one
 * point that each line can reach by sliding its stop a short way ALONG the line.
 * The crossing dot is placed at that exact intersection (found from each line's
 * exact tangent, so it lands where the drawn ribbons actually cross, not on the
 * quantized-axis estimate). A parallel bundle (one axis), a spread junction (a
 * parallel pair forcing the cover wide), or a shallow convergence whose meeting
 * point is out of slide range is NOT collapsed and is left to the pill capsule.
 * Reuses the London coverCenter test; design-agnostic, computed once at compute
 * time.
 */
import { coverCenter, axisUnit, type Line } from './londonBubbles';
import { LINE_WIDTH, LINE_GAP } from '../constants';

/** The mark fields the crossing test needs: run-axis, exact tangent, position,
 *  mega flag. The exact tangent (unquantized) locates the true intersection; the
 *  axis keys the parallel-bundle gate. */
interface CrossMark { axis?: number; dir?: [number, number]; pos: [number, number]; mega?: boolean }

export interface TorontoCross { cx: number; cy: number }

export function computeTorontoByNode(stops: Map<string, CrossMark[]>): Map<string, TorontoCross> {
  // Tighter than half the lane spacing, so two parallel lanes (a slot apart)
  // never collapse; only lines that truly cross at a point do.
  const cover = (LINE_WIDTH + LINE_GAP) * 0.35;
  // Farthest a stop may slide along its line to reach the meeting point; past
  // this the convergence is too shallow to read as a crossing, so use a pill.
  const maxSlide = (LINE_WIDTH + LINE_GAP) * 3.5;
  const out = new Map<string, TorontoCross>();
  for (const [nodeId, marks] of stops) {
    const ms = marks.filter((m) => !m.mega);
    if (ms.length <= 1) continue;
    const axes = new Set(ms.map((m) => (m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4))));
    if (axes.size < 2) continue; // one run-axis = a parallel bundle, not a crossing
    // Use each line's EXACT tangent (falling back to the quantized axis only when
    // it is absent), so the intersection lands on the drawn ribbons.
    const lines: Line[] = ms.map((m) => {
      const key = m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4);
      const [ux, uy] = m.dir ?? axisUnit(key === -1 ? 0 : key);
      return { ux, uy, px: m.pos[0], py: m.pos[1], axisKey: key };
    });
    const c = coverCenter(lines, cover, maxSlide);
    if (!c) continue;
    // Slide budget: the dot must be reachable by sliding each stop a short way to
    // the meeting point (the intersection sits on each line, so the straight-line
    // gap is that slide). Too far to slide -> fall back to the pill capsule.
    let slide = 0;
    for (const m of ms) slide = Math.max(slide, Math.sqrt((c.x - m.pos[0]) ** 2 + (c.y - m.pos[1]) ** 2));
    if (slide > maxSlide) continue;
    out.set(nodeId, { cx: c.x, cy: c.y });
  }
  return out;
}
