import { envStr } from '../../env';
import type { Pixel } from '../layout/types';
import type { ChainSeatReport } from '../chainSeats';

/** OCTI_CHAIN_DUMP: per-chain seat-ladder dump (chains C2 to C3 RCA).
 *  One line per seated chain (anchors, ladder center, position), one
 *  line per run (bounding seats, desired vs ladder seat), one line per
 *  first-write-wins key conflict between overlapping chains, then a
 *  summary with the worst ladder distortion (how far the pitch
 *  quantization moved a run off its anchor-frame wish). */
export function reportChainSeats(d: {
  report: ChainSeatReport[];
  nodePx: Map<string, Pixel>;
}): void {
  if (envStr('OCTI_CHAIN_DUMP') !== '1') return;
  const f1 = (v: number | undefined): string => (v === undefined ? '-' : v.toFixed(1));
  let runsTotal = 0;
  let conflictsTotal = 0;
  let maxDistort = 0;
  let maxDistortAt = '';
  for (const r of d.report) {
    const p = (r.anchorA && d.nodePx.get(r.anchorA)) || (r.anchorB && d.nodePx.get(r.anchorB)) || undefined;
    console.warn(
      '[chainseat] chain#' + r.chainIndex + ' ' + r.edgeIds.join('>') +
      ' anchors=' + (r.anchorA ?? 'terminus') + '..' + (r.anchorB ?? 'terminus') +
      ' c=' + r.c.toFixed(1) +
      (p ? ' at=(' + p[0].toFixed(0) + ',' + p[1].toFixed(0) + ')' : ''),
    );
    for (const run of r.runs) {
      runsTotal++;
      const distort = Math.abs(run.ladderSeat - run.desired);
      if (distort > maxDistort) {
        maxDistort = distort;
        maxDistortAt = 'chain#' + r.chainIndex + ' ' + run.lineId;
      }
      console.warn(
        '[chainseat]   run ' + run.lineId + ' ' + run.edgeIds.join('>') +
        ' entry=' + f1(run.entry) + ' exit=' + f1(run.exit) +
        ' desired=' + run.desired.toFixed(1) + ' seat=' + run.ladderSeat.toFixed(1),
      );
    }
    for (const c of r.conflicts) {
      conflictsTotal++;
      console.warn(
        '[chainseat]   CONFLICT ' + c.key +
        ' kept=' + c.kept.toFixed(1) + ' (chain#' + c.keptChain + ')' +
        ' discarded=' + c.discarded.toFixed(1) +
        ' delta=' + Math.abs(c.kept - c.discarded).toFixed(1),
      );
    }
  }
  console.warn(
    '[chainseat] ' + d.report.length + ' seated chains, ' + runsTotal + ' runs, ' +
    conflictsTotal + ' key conflicts, maxDistort=' + maxDistort.toFixed(1) +
    (maxDistortAt ? ' (' + maxDistortAt + ')' : ''),
  );
}
