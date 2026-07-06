// Per-station marker diagnostics (env-gated, dev only). Extracted from stops
// so the marker routine keeps only the call site. Enable with
// OCTI_PLACE_DEBUG=1 (mega-box centroid-distance census).
import { envStr } from '../../env';
import type { StopMark } from '../layout/types';

/** OCTI_PLACE_DEBUG=1: mega-box centroid-distance census (one line per boxed
 *  station). Reports the box size and the med/p90/max distance of the marks
 *  from their centroid, so a ballooning box's stray far stops are visible. */
export function debugMegaBox(
  nodeId: string,
  marks: StopMark[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  let cx = 0, cy = 0; for (const m of marks) { cx += m.pos[0]; cy += m.pos[1]; }
  cx /= marks.length; cy /= marks.length;
  const ds = marks.map((m) => Math.sqrt((m.pos[0] - cx) ** 2 + (m.pos[1] - cy) ** 2)).sort((a, b) => a - b);
  console.error(`[megabox] ${nodeId} marks=${marks.length} box=${(x1 - x0).toFixed(0)}x${(y1 - y0).toFixed(0)} centroidDist med=${ds[ds.length >> 1].toFixed(0)} p90=${ds[Math.floor(ds.length * 0.9)].toFixed(0)} max=${ds[ds.length - 1].toFixed(0)}`);
}
