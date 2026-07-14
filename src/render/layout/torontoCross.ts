/**
 * Toronto "perfect crossing" detection. A crossing is a node where two lines
 * genuinely CROSS: their drawn ribbons meet (a near-zero gap) at a wide angle.
 * Lines that merely converge and run parallel (a wide gap, near-zero angle) are
 * NOT a crossing and keep the pill capsule, as do meetings out of slide range.
 *
 * The dot is placed on the DRAWN ribbons (the pipeline's own lane polylines, so
 * nothing is re-derived here) via the segment helpers in segGeom. A three-plus
 * line star has no single pair to cross, so it uses the London coverCenter test
 * on the marks' tangents.
 */
import { polylinesClosest } from './segGeom';
import { coverCenter, axisUnit, type Line } from './londonBubbles';
import { LINE_WIDTH, LINE_GAP } from '../constants';
import type { Pixel } from './types';

/** Drawn incident lane polylines per stop (nodeId|lineId -> polylines), from the
 *  pipeline's lanePolysAt. */
export type LaneByStop = Map<string, Pixel[][]>;

/** The mark fields the crossing test needs: run-axis (parallel-bundle gate),
 *  exact tangent (three-plus-line intersection), position, mega flag, lineId
 *  (fetches the drawn lanes). */
interface CrossMark { lineId: string; axis?: number; dir?: [number, number]; pos: Pixel; mega?: boolean }

export interface TorontoCross { cx: number; cy: number }

const DEG = Math.PI / 180;

export function computeTorontoByNode(stops: Map<string, CrossMark[]>, laneByStop?: LaneByStop): Map<string, TorontoCross> {
  const spacing = LINE_WIDTH + LINE_GAP;
  const cover = spacing * 0.35;        // tight perp tolerance for the 3+ line test
  const maxSlide = spacing * 3.5;      // farthest the dot may sit from a stop
  const meetGap = spacing * 0.5;       // ribbons must nearly touch to count as crossing
  const minAngle = 30 * DEG;           // and cross at a wide angle, not run parallel
  const out = new Map<string, TorontoCross>();
  for (const [nodeId, marks] of stops) {
    const ms = marks.filter((m) => !m.mega);
    if (ms.length <= 1) continue;
    const axes = new Set(ms.map((m) => (m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4))));
    if (axes.size < 2) continue; // one run-axis = a parallel bundle, not a crossing

    // Two lines: they cross only where the drawn ribbons meet at a wide angle.
    if (ms.length === 2 && laneByStop) {
      const A = laneByStop.get(nodeId + '|' + ms[0].lineId);
      const B = laneByStop.get(nodeId + '|' + ms[1].lineId);
      if (A && B) {
        const c = polylinesClosest(A, B);
        if (c && c.gap <= meetGap && c.angle >= minAngle) {
          const sA = Math.sqrt((c.mid[0] - ms[0].pos[0]) ** 2 + (c.mid[1] - ms[0].pos[1]) ** 2);
          const sB = Math.sqrt((c.mid[0] - ms[1].pos[0]) ** 2 + (c.mid[1] - ms[1].pos[1]) ** 2);
          if (Math.max(sA, sB) <= maxSlide) out.set(nodeId, { cx: c.mid[0], cy: c.mid[1] });
        }
      }
      continue; // drawn geometry is authoritative for a pair
    }

    // Three or more lines: the exact-tangent intersection covered by one dot.
    const lines: Line[] = ms.map((m) => {
      const key = m.axis === undefined ? -1 : (((m.axis % 4) + 4) % 4);
      const [ux, uy] = m.dir ?? axisUnit(key === -1 ? 0 : key);
      return { ux, uy, px: m.pos[0], py: m.pos[1], axisKey: key };
    });
    const c = coverCenter(lines, cover, maxSlide);
    if (!c) continue;
    let slide = 0;
    for (const m of ms) slide = Math.max(slide, Math.sqrt((c.x - m.pos[0]) ** 2 + (c.y - m.pos[1]) ** 2));
    if (slide > maxSlide) continue;
    out.set(nodeId, { cx: c.x, cy: c.y });
  }
  return out;
}
