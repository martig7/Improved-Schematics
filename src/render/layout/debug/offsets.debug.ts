// Offset-bundling diagnostics (env-gated, dev only). Extracted from offsets so
// computeCanonicalOffsets keeps only the call site. Enable with OCTI_DEBUG
// (per-line offsets + residual-coincidence audit).
import { envStr } from '../../../env';

/** OCTI_DEBUG: dump each line's resolved lane offset, then audit for any
 *  co-running pair still landing within `coincident` px of each other. */
export function debugCanonicalOffsets(
  offsets: Map<string, number>,
  neighbors: Map<string, Set<string>>,
  coincident: number,
): void {
  if (!envStr('OCTI_DEBUG')) return;
  for (const [lineId, off] of offsets) {
    console.error(`[offsets] ${lineId.slice(0, 6)} -> ${off}`);
  }
  for (const [a, ns] of neighbors) {
    for (const b of ns) {
      if (a < b && Math.abs(offsets.get(a)! - offsets.get(b)!) < coincident) {
        console.error(`[offsets] RESIDUAL COINCIDENCE ${a.slice(0, 6)} ~ ${b.slice(0, 6)} @ ${offsets.get(a)}`);
      }
    }
  }
}
