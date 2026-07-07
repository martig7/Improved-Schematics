// Per-node station numbering. Given the intake numbers (per line + station
// group, from the raw route stop order) and the support graph — which records,
// per group, the node each line's stop was placed on (stopNodes, re-homed and
// remapped as the topo merge moves things) — produce a Map keyed by
// `lineId|nodeId` -> the station number to render at that node. Intake-sourced,
// so it covers stops even after the merge fuses their nodes. Pure.

import type { SupportGraph } from './types';

export function nodeSeqFromSupport(
  h: SupportGraph,
  numberByGroup: Map<string, number> | undefined,
): Map<string, number> {
  const seq = new Map<string, number>();
  if (!numberByGroup) return seq;
  for (const st of h.stations.values()) {
    const set = (lineId: string, nodeId: string) => {
      const n = numberByGroup.get(lineId + '|' + st.id);
      if (n != null) seq.set(lineId + '|' + nodeId, n);
    };
    // The per-line stop node (re-homed / remapped as the merge moves things)...
    if (st.stopNodes) for (const [lineId, nodeId] of st.stopNodes) set(lineId, nodeId);
    // ...and the group's own anchor node, which a mark can land on when a fused
    // station is separated back out post-topo.
    for (const lineId of st.stopLines ?? []) set(lineId, st.nodeId);
  }
  return seq;
}
