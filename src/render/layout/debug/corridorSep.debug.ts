// Joint-seating release diagnostics (env-gated, dev only). Enable with
// OCTI_JOINT_DUMP=1: before the apply pass of each seated pair, prints every
// lane sample in q-space (lateral offset from the local pair centerline):
// its own-frame position q, fade weight w, joint seat, and the blended final
// position. Crossings between lanes show up as sign flips of final-position
// differences along the span, so a transient weave in the release zone is
// visible directly in one dimension.
import { envStr } from '../../../env';
import type { Pixel } from '../types';

export interface JointLaneView {
  edge: string;
  line: string;
  samples: Array<{ p: Pixel; q: number; w: number }>;
}

export function debugJointRelease(
  pairKey: string,
  joint: JointLaneView[],
  center: number,
  spacing: number,
): void {
  if (envStr('OCTI_JOINT_DUMP') !== '1') return;
  for (let k = 0; k < joint.length; k++) {
    const lane = joint[k];
    const seat = (k - center) * spacing;
    let arc = 0;
    let prev: Pixel | null = null;
    for (const s of lane.samples) {
      if (prev) arc += Math.sqrt((s.p[0] - prev[0]) ** 2 + (s.p[1] - prev[1]) ** 2);
      prev = s.p;
      const fin = s.q + (seat - s.q) * s.w;
      console.warn(
        '[jointdump] ' + pairKey + ' k=' + k + ' ' + lane.line.slice(0, 4) +
        ' arc=' + arc.toFixed(1) +
        ' p=' + s.p[0].toFixed(1) + ',' + s.p[1].toFixed(1) +
        ' q=' + s.q.toFixed(2) + ' w=' + s.w.toFixed(3) +
        ' seat=' + seat.toFixed(1) + ' fin=' + fin.toFixed(2),
      );
    }
  }
}
