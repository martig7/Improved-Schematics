// Twist-rescue trace (dev, env-gated): one line per detected same-section
// twist, saying where its crossing was parked (branch or turn node, arc
// distance, edges swapped) or why it stayed put. Enable with
// OCTI_TWIST_DEBUG=1.

import { envStr } from '../../../env';
import type { LayoutEdge } from '../types';

export interface TwistRescueInfo {
  kind: 'branch' | 'turn';
  dist: number;
  swaps: LayoutEdge[];
  target: string;
}

/** Factory returning the per-twist trace closure; a no-op when the flag is
 *  off, so the rescue pass carries no logging branches of its own. */
export function makeTwistTrace(): (node: string, u: string, v: string, rescue: TwistRescueInfo | null) => void {
  const on = typeof process !== 'undefined' && envStr('OCTI_TWIST_DEBUG') === '1';
  if (!on) return () => {};
  return (node, u, v, rescue) => {
    const pair = u.slice(0, 8) + ' x ' + v.slice(0, 8);
    if (!rescue) {
      console.warn(`[twist] ${node} ${pair} UNRESCUED (blocked or no absorb site)`);
      return;
    }
    console.warn(
      `[twist] ${node} ${pair} -> ${rescue.kind.toUpperCase()} at ${rescue.target} dist=${rescue.dist.toFixed(0)}px swapped=${rescue.swaps.map((e) => e.id).join(',')}`,
    );
  };
}
