// Rigid-row placement diagnostics (env-gated, dev only). Extracted from
// rowPlace so the solver keeps only the call sites. Enable with
// OCTI_PLACE_DEBUG=1: per-box root-cause classification of why a station fell
// back to the mega box (no feasible bundle row, or no feasible pairing chain).
import { envStr } from '../../../env';
import type { Pixel } from '../types';

// OCTI_PLACE_DEBUG only: why a bundle's row states all failed (→ mega box).
export interface BundleStat {
  tried: number;      // (slide × axis) states enumerated
  noCross: number;    // states where a member lane never crossed the row line
  pinch: number;      // states where consecutive dots fell below minGap
  blocked: number;    // states vetoed by the §6 mask (already-placed dots)
  bestMinGap: number; // largest min gap among states that crossed all lanes
}

/** OCTI_PLACE_DEBUG: per-bundle classification when a station has no feasible
 *  row anywhere (→ mega box). `hyp` is the module-private cross-V8 hypot. */
export function debugNoFeasibleRow(
  groups: number[][],
  bundleStates: { length: number }[],
  statsArr: BundleStat[],
  anchorPos: Pixel[],
  g: number,
  minGap: number,
  dbgLabel: string | undefined,
  hyp: (a: number, b: number) => number,
): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  for (let i = 0; i < groups.length; i++) {
    if (bundleStates[i].length > 0) continue;
    const s = statsArr[i];
    const grp = groups[i];
    // Min pairwise separation of member stop-anchors. When two members
    // coincide here, their lanes are interlined on ONE drawn edge: the
    // COINCIDENT failure (no spacing can separate them), as opposed to a
    // PINCHED bundle whose lanes are distinct but merely seated too tight.
    let minAnchorSep = Infinity;
    for (let a = 0; a < grp.length; a++) {
      for (let b = a + 1; b < grp.length; b++) {
        const d = hyp(anchorPos[grp[a]][0] - anchorPos[grp[b]][0], anchorPos[grp[a]][1] - anchorPos[grp[b]][1]);
        if (d < minAnchorSep) minAnchorSep = d;
      }
    }
    // bestMinGap is the largest (over all all-lanes-crossing states) of the
    // min consecutive signed gap. A non-positive value means even the best
    // row has a coincident/order-reversed pair → lanes crossed/interlined,
    // which no positive spacing (minGap relaxation) can recover. That is
    // COINCIDENT; a positive-but-sub-minGap gap is the spacing-fixable PINCHED.
    const crossedAny = s.bestMinGap > -Infinity;
    const cls =
      s.noCross >= s.tried
        ? 'NO-CROSSING (lanes never admit a row-line crossing → divergent/coincident; NOT slide/spacing fixable)'
        : crossedAny && s.bestMinGap <= 0
          ? `COINCIDENT (best gap ${s.bestMinGap.toFixed(2)}px ≤ 0 → member lanes interlined/crossed on one drawn edge; NOT spacing-fixable — needs upstream octi/topo de-weld)`
          : crossedAny && s.bestMinGap < minGap
            ? `PINCHED (closest gap ${s.bestMinGap.toFixed(2)}px < minGap ${minGap.toFixed(2)}px → octi seated the lanes too tight; fixable UPSTREAM)`
            : s.blocked > 0
              ? 'MASKED (§6: every crossing state vetoed by an already-placed station → ordering-dependent)'
              : 'UNKNOWN';
    const gapStr = crossedAny ? `${s.bestMinGap.toFixed(2)}px` : 'never crossed';
    const sepStr = minAnchorSep === Infinity ? 'n/a' : `${minAnchorSep.toFixed(2)}px`;
    console.error(
      `[rowPlace] BOX ${dbgLabel ?? '?'} bundle ${i + 1}/${g} members=${groups[i].length}: ` +
        `${s.tried} states (noCross=${s.noCross} pinch=${s.pinch} blocked=${s.blocked}) ` +
        `closestGap=${gapStr} minAnchorSep=${sepStr} minGap=${minGap.toFixed(2)}px → ${cls}`,
    );
  }
}

/** OCTI_PLACE_DEBUG: classification when no feasible pairing/orientation chain
 *  exists (→ mega box). `dbgMinNonAdj` is the closest non-adjacent dot gap the
 *  station-floor check saw (Infinity when it never rejected on that count). */
export function debugNoPairing(
  dbgMinNonAdj: number,
  g: number,
  minGap: number,
  dbgLabel: string | undefined,
): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  const reason =
    dbgMinNonAdj < Infinity
      ? `NON-ADJACENT-FLOOR closest ${dbgMinNonAdj.toFixed(2)}px < minGap ${minGap.toFixed(2)}px → ` +
        `${dbgMinNonAdj < 1 ? 'COINCIDENT/structural (NOT fixable by spacing)' : 'near-miss'} ` +
        `— no pairing/orientation avoids it (idea ③ tried all g!·2^g)`
      : `NO-PAIRING (g=${g}; cross-row dot floor / corner clearance / ext-cap / V-not-T; ` +
        `minGap ${minGap.toFixed(2)}px)`;
  console.error(`[rowPlace] BOX ${dbgLabel ?? '?'}: ${reason}`);
}
