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
  edgeById: Map<string, { id: string; from: string; to: string }>;
  pairs?: Array<{ eA: string; eB: string; d0: number; sign: number }>;
  basePoly?: (edgeId: string) => Pixel[] | undefined;
  halfWidthOf?: (edgeId: string) => number;
  spacing?: number;
}): void {
  if (envStr('OCTI_CHAIN_DUMP') !== '1') return;
  const f1 = (v: number | undefined): string => (v === undefined ? '-' : v.toFixed(1));
  let runsTotal = 0;
  let conflictsTotal = 0;
  let maxDistort = 0;
  let maxDistortAt = '';
  for (const r of d.report) {
    const first = d.edgeById.get(r.edgeIds[0]);
    const p = first ? d.nodePx.get(first.from) : undefined;
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
  for (const p of d.pairs ?? []) {
    console.warn('[chainseat] PAIR ' + p.eA + 'x' + p.eB + ' d0=' + p.d0.toFixed(1) + ' sign=' + p.sign);
  }
  console.warn('[chainseat] ' + (d.pairs?.length ?? 0) + ' cross-chain parallel pairs');
  // Near-miss survey: cross-group covered-edge pairs whose midpoints sit
  // within twice the qualify distance, with the measured separation and
  // threshold, so a detector that stays silent shows WHY.
  if (d.basePoly && d.halfWidthOf && d.spacing !== undefined) {
    const groupOfEdge = new Map<string, number>();
    d.report.forEach((r, gi) => { for (const e of r.edgeIds) if (!groupOfEdge.has(e)) groupOfEdge.set(e, gi); });
    const edges = [...groupOfEdge.keys()].sort();
    const mid = (pts: Pixel[]): Pixel => pts[Math.floor(pts.length / 2)];
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        if (groupOfEdge.get(edges[a]) === groupOfEdge.get(edges[b])) continue;
        const pa = d.basePoly(edges[a]);
        const pb = d.basePoly(edges[b]);
        if (!pa || pa.length < 2 || !pb || pb.length < 2) continue;
        const ma = mid(pa);
        const mb = mid(pb);
        const dist = Math.sqrt((ma[0] - mb[0]) ** 2 + (ma[1] - mb[1]) ** 2);
        const thresh = d.halfWidthOf(edges[a]) + d.halfWidthOf(edges[b]) + d.spacing * 0.75;
        if (dist < Math.max(thresh * 2, 160)) {
          // replicate the projection pair test to show which gate fails
          const arcOf = (pts: Pixel[]): number => {
            let s = 0;
            for (let k = 1; k < pts.length; k++) s += Math.sqrt((pts[k][0] - pts[k - 1][0]) ** 2 + (pts[k][1] - pts[k - 1][1]) ** 2);
            return s;
          };
          const [lp, sp] = arcOf(pa) >= arcOf(pb) ? [pa, pb] : [pb, pa];
          const sm = mid(sp);
          const sd: Pixel = [sp[sp.length - 1][0] - sp[0][0], sp[sp.length - 1][1] - sp[0][1]];
          const sl = Math.sqrt(sd[0] ** 2 + sd[1] ** 2) || 1;
          let best = Infinity;
          let bq: Pixel = lp[0];
          let bdir: Pixel = [1, 0];
          for (let k = 1; k < lp.length; k++) {
            const vx = lp[k][0] - lp[k - 1][0], vy = lp[k][1] - lp[k - 1][1];
            const len2 = vx * vx + vy * vy;
            if (len2 === 0) continue;
            let t = ((sm[0] - lp[k - 1][0]) * vx + (sm[1] - lp[k - 1][1]) * vy) / len2;
            t = Math.min(1, Math.max(0, t));
            const q: Pixel = [lp[k - 1][0] + vx * t, lp[k - 1][1] + vy * t];
            const dd = Math.sqrt((sm[0] - q[0]) ** 2 + (sm[1] - q[1]) ** 2);
            if (dd < best) { best = dd; bq = q; const l = Math.sqrt(len2); bdir = [vx / l, vy / l]; }
          }
          const endGap = Math.min(
            Math.sqrt((bq[0] - lp[0][0]) ** 2 + (bq[1] - lp[0][1]) ** 2),
            Math.sqrt((bq[0] - lp[lp.length - 1][0]) ** 2 + (bq[1] - lp[lp.length - 1][1]) ** 2),
          );
          const dot = Math.abs((sd[0] / sl) * bdir[0] + (sd[1] / sl) * bdir[1]);
          console.warn(
            '[chainseat] NEARMISS ' + edges[a] + 'x' + edges[b] +
            ' dist=' + dist.toFixed(1) + ' thresh=' + thresh.toFixed(1) +
            ' proj=' + best.toFixed(1) + ' dot=' + dot.toFixed(2) + ' endGap=' + endGap.toFixed(1) +
            ' at=(' + ma[0].toFixed(0) + ',' + ma[1].toFixed(0) + ')',
          );
        }
      }
    }
  }
}
