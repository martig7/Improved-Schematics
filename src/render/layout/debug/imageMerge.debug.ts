// Coincident-path merge diagnostics (env-gated, dev only). Extracted from
// imageMerge so mergeCoincidentPaths keeps only the call site. Enable with
// OCTI_MERGEDBG=<edgeId,edgeId> (dumps each old edge's vertex list and its run
// chain after pass 4 — which runs cover it, in what order/orientation).
import { envStr } from '../../../env';
import type { Pixel } from '../types';

/** OCTI_MERGEDBG=<edgeId,edgeId>: dump an old edge's vertex list and its run
 *  chain after pass 4 (which runs cover it, in what order/orientation). */
/** OCTI_FOLD_TRACE=1: one line per collapsed manufactured fold stub - the
 *  removed tip node, the fold base it remapped onto, the stub edge, its
 *  lines, and arc length. */
export function traceFoldCollapse(
  tip: string,
  base: string,
  edgeId: string,
  lineIds: string[],
  arc: number,
): void {
  if (typeof process === 'undefined' || envStr('OCTI_FOLD_TRACE') !== '1') return;
  console.error(
    `[foldstub] ${tip} -> ${base} via ${edgeId} lines=[${lineIds.map((l) => l.slice(0, 6)).join(' ')}] arc=${arc.toFixed(1)}px`,
  );
}

/** OCTI_FOLD_TRACE=1: one line per stop-fold SPLICE candidate (a same-edge
 *  out-and-back pair), accepted or not, with every gate value, for diagnosing
 *  folds that survive the splice. */
export function traceSpliceCandidate(
  line: string,
  edgeId: string,
  tip: string,
  d: { arc: number; maxArc: number; inked: boolean; stopAtTip: boolean; gids: number; veto: boolean; taken: boolean },
): void {
  if (typeof process === 'undefined' || envStr('OCTI_FOLD_TRACE') !== '1') return;
  console.error(
    `[fold] SPLICE ${d.taken ? 'TAKE' : 'DECLINE'} ${line.slice(0, 8)} edge=${edgeId} tip=${tip} ` +
    `arc=${d.arc.toFixed(1)}/${d.maxArc.toFixed(1)} inked=${d.inked} stopAtTip=${d.stopAtTip} gids=${d.gids} veto=${d.veto}`,
  );
}

export function debugMergeChains(
  edgeVerts: Map<string, string[]>,
  vPos: Map<string, Pixel>,
  segKey: (a: string, b: string) => string,
  segToRun: Map<string, { run: number }>,
  ownersKeyOf: (sk: string) => string,
  chains: Map<string, Array<{ run: number; rev: boolean }>>,
  runs: { verts: string[] }[],
): void {
  const mergeDbg = typeof process !== 'undefined' ? envStr('OCTI_MERGEDBG') : undefined;
  if (!mergeDbg) return;
  for (const eid of mergeDbg.split(',')) {
    const verts = edgeVerts.get(eid);
    if (!verts) { console.error(`[mergedbg] ${eid}: no verts`); continue; }
    const at = (vk: string): string => { const p = vPos.get(vk); return p ? `(${p[0].toFixed(1)},${p[1].toFixed(1)})` : vk; };
    console.error(`[mergedbg] ${eid} verts: ${verts.map(at).join(' ')}`);
    for (let i = 1; i < verts.length; i++) {
      const sk = segKey(verts[i - 1], verts[i]);
      const hit = segToRun.get(sk);
      console.error(`[mergedbg]   seg ${at(verts[i - 1])}->${at(verts[i])} run=${hit ? hit.run : 'NONE'} owners=${ownersKeyOf(sk)}`);
    }
    const chain = chains.get(eid) ?? [];
    console.error(`[mergedbg] ${eid} chain: ${chain.map((c) => `me${c.run}${c.rev ? 'R' : ''}[${at(runs[c.run].verts[0])}->${at(runs[c.run].verts[runs[c.run].verts.length - 1])}]`).join(' ')}`);
  }
}
