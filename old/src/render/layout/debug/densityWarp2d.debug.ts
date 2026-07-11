// 2D density-warp diagnostics (env-gated, dev only). Extracted from
// densityWarp2d so the warp routine keeps only the call site. Enable with
// OCTI_WARP_DEBUG (one-line flow summary).
import { envStr } from '../../../env';

/** OCTI_WARP_DEBUG: one-line summary of the density-warp flow. */
export function debugWarp2d(
  steps: readonly { alpha: number }[],
  iters: number,
  sigmaPx: number,
): void {
  if (!envStr('OCTI_WARP_DEBUG')) return;
  const a0 = steps[0]?.alpha ?? 0;
  const aN = steps[steps.length - 1]?.alpha ?? 0;
  console.error(`[warp2d] iters=${steps.length}/${iters} sigmaPx=${sigmaPx.toFixed(0)} alpha[0]=${a0.toExponential(2)} alpha[last]=${aN.toExponential(2)}`);
}
