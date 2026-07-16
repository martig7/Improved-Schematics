// Density-box-warp diagnostics (env-gated, dev only). Extracted from
// densityBoxWarp so the warp routine keeps only the call sites. Enable with
// OCTI_BOX_PROBE (density surface + box provenance) or OCTI_WARP_DEBUG.
import { envStr } from '../../../env';
import type { Pixel } from '../types';
import type { DenseBox } from '../densityBoxWarp';

/** OCTI_BOX_PROBE: density surface and cutoff as a downsampled ASCII heatmap. */
export function probeDensity(B: number, e: number[], cutoff: number, emax: number, sampleCount: number): void {
  if (!envStr('OCTI_BOX_PROBE')) return;
  let above = 0;
  let pos = 0;
  for (let i = 0; i < B * B; i++) { if (e[i] > 0) pos++; if (e[i] >= cutoff && e[i] > 0) above++; }
  console.error(`[densprobe] bins=${B} cells+=${pos} emax=${emax.toFixed(2)} cutoff=${cutoff.toFixed(2)} above=${above} samples=${sampleCount}`);
  const D = 32; // downsampled ASCII heatmap, log scale, X = above cutoff
  for (let dy = 0; dy < D; dy++) {
    let row = '';
    for (let dx = 0; dx < D; dx++) {
      let m = 0;
      for (let yy = (dy * B / D) | 0; yy < Math.max((dy * B / D | 0) + 1, ((dy + 1) * B / D) | 0); yy++)
        for (let xx = (dx * B / D) | 0; xx < Math.max((dx * B / D | 0) + 1, ((dx + 1) * B / D) | 0); xx++)
          if (e[yy * B + xx] > m) m = e[yy * B + xx];
      row += m >= cutoff ? 'X' : m <= 0 ? '.' : String(Math.min(9, Math.max(0, Math.round((9 * Math.log(1 + m)) / Math.log(1 + emax)))));
    }
    console.error('[densprobe] ' + row);
  }
}

/** OCTI_BOX_PROBE: box provenance across discovery, merge, and split. `anisoOf`
 *  supplies each box's crowd anisotropy (kept private to the warp module). */
export function probeBoxes(
  density: DenseBox[],
  merged: DenseBox[],
  boxes: DenseBox[],
  nodes: Pixel[],
  anisoOf: (b: DenseBox) => number,
): void {
  if (!envStr('OCTI_BOX_PROBE')) return;
  const nIn = (b: DenseBox): number => {
    let n = 0;
    for (const p of nodes) if (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1) n++;
    return n;
  };
  const fmt = (b: DenseBox): string => `[${b.x0.toFixed(0)},${b.y0.toFixed(0)}..${b.x1.toFixed(0)},${b.y1.toFixed(0)} ${(b.x1 - b.x0).toFixed(0)}x${(b.y1 - b.y0).toFixed(0)} n=${nIn(b)}]`;
  console.error(`[boxprobe] density boxes: ${density.map(fmt).join(' ')}`);
  console.error(`[boxprobe] merged: ${merged.map((b) => b.kind[0] + fmt(b)).join(' ')}`);
  console.error(`[boxprobe] split:  ${boxes.map((b) => `${b.kind[0]}${fmt(b)} r=${anisoOf(b).toFixed(2)}`).join(' ')}`);
}

/** OCTI_WARP_DEBUG: one-line summary of the solved box warp. */
export function debugBoxWarp(d: {
  boxCount: number; densityCount: number; contractionCount: number; capsuleCount: number; corridorCount: number; mergedCount: number;
  cell: number; need: number; expands: number[]; rs: number[]; anisoAmt: number;
  growthX: number; growthY: number; maxGrowth: number;
}): void {
  if (!envStr('OCTI_WARP_DEBUG')) return;
  const ex = d.expands.map((e) => e.toFixed(2)).join(',');
  const an = d.rs.map((r) => r.toFixed(2)).join(',');
  console.error(
    `[boxwarp] boxes=${d.boxCount} (density=${d.densityCount} contraction=${d.contractionCount} capsule=${d.capsuleCount} corridor=${d.corridorCount} merged=${d.mergedCount}) ` +
    `cell=${d.cell.toFixed(1)} need=${d.need.toFixed(1)} expands=[${ex}] aniso=[${an}] (amt=${d.anisoAmt}) growth=${d.growthX.toFixed(2)},${d.growthY.toFixed(2)} (cap=${d.maxGrowth})`,
  );
}
