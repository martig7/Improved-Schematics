// LOOM topo diagnostics (env-gated, dev only). Extracted from topo.ts so the
// support-graph builder keeps only the call sites. Enable with OCTI_TRACE_LINE
// (per-line merge/walk/traversal trace), OCTI_DEBUG (absorb + support summary),
// or OCTI_AUDIT (stub-weld / junction-absorb / heal-ladder census).
import { envStr } from '../../../env';
import type { Pixel } from '../types';

/** OCTI_TRACE_LINE: report a STALE adjacency entry during degree-2 contraction.
 *  Returns true when the trace fired (the caller must then `continue`, matching
 *  the original guard); false leaves control flow untouched. */
export function traceContractStale(nid: string, eids: Iterable<string>, e1: unknown, e2: unknown): boolean {
  if (!envStr('OCTI_TRACE_LINE')) return false;
  if (e1 && e2) return false;
  console.error(`[topo] contract: STALE adj at ${nid}: ${[...eids]} -> ${!!e1},${!!e2}`);
  return true;
}

/** OCTI_TRACE_LINE: per-edge walk summary (endpoints, unions, early break).
 *  Fires only for edges carrying the traced line. */
export function traceWalk(
  lineIds: Set<string>,
  fromId: string,
  toId: string,
  edgeLen: number,
  sampleCount: number,
  unions: number,
  broke: boolean,
  nodePos: (id: string) => Pixel,
  fromNd: string | undefined,
  toNd: string | undefined,
  front: string | null,
  last: string | null,
): void {
  const trace2 = envStr('OCTI_TRACE_LINE');
  if (!trace2 || !lineIds.has(trace2)) return;
  const at = (nid: string | undefined | null): string => {
    if (!nid) return '?';
    const p = nodePos(nid);
    return `${nid}(${p[0].toFixed(0)},${p[1].toFixed(0)})`;
  };
  console.error(
    `[walk] edge ${fromId.slice(0, 6)}->${toId.slice(0, 6)} ` +
    `len=${edgeLen.toFixed(0)} samples=${sampleCount} ` +
    `unions=${unions} earlyBreak=${broke} ` +
    `ends: ${at(fromNd)} -> ${at(toNd)} first=${at(front)} last=${at(last)}`,
  );
}

/** OCTI_TRACE_LINE: trace-line edge count before/after degree-2 contraction.
 *  `edges` is read lazily so the edge list is only materialised when tracing. */
export function traceContractCount(
  phase: 'pre' | 'post',
  edges: () => { lineIds: Set<string> }[],
): void {
  const trace = envStr('OCTI_TRACE_LINE');
  if (!trace) return;
  const all = edges();
  const n = all.filter((e) => e.lineIds.has(trace)).length;
  console.error(`[topo] ${phase}-contract: trace line on ${n}/${all.length} edges`);
}

/** OCTI_AUDIT: fire count for weldRedundantStubs. */
export function auditWeldStubs(stubWelds: number): void {
  if (stubWelds > 0 && envStr('OCTI_AUDIT')) {
    console.error(`[audit:fire] weldRedundantStubs=${stubWelds}`);
  }
}

/** OCTI_DEBUG: whether the absorbJunctionStubs per-absorb trace is enabled. */
export function absorbDebugEnabled(): boolean {
  return typeof process !== 'undefined' && !!envStr('OCTI_DEBUG');
}

/** OCTI_DEBUG: one absorbed junction stub. */
export function debugAbsorb(enabled: boolean, eid: string, a: string, b: string, span: number): void {
  if (enabled) console.error(`[topo] absorb ${eid} ${a} -> ${b} (span ${span.toFixed(1)})`);
}

/** OCTI_AUDIT: fire count for absorbJunctionStubs. */
export function auditAbsorb(absorbed: number): void {
  if (absorbed > 0 && envStr('OCTI_AUDIT')) {
    console.error(`[audit:fire] absorbJunctionStubs=${absorbed}`);
  }
}

/** OCTI_TRACE_LINE: per-line traversal reconstruction summary. */
export function traceTraversal(
  lineId: string,
  graphNodeCount: number,
  supportNodes: (string | null)[],
  stepCount: number,
): void {
  if (envStr('OCTI_TRACE_LINE') !== lineId) return;
  console.error(
    `[trav] line ${lineId.slice(0, 8)}: graphNodes=${graphNodeCount} ` +
    `supportNodes=[${supportNodes.map((s) => s.slice(0, 6)).join(',')}] steps=${stepCount}`,
  );
}

/** OCTI_AUDIT: heal-ladder census (line-constrained BFS vs any-path fallback). */
export function auditHealLadder(healStats: { bfs: number; anyPath: number; miss: number; stallJump: number }): void {
  if (!envStr('OCTI_AUDIT')) return;
  console.error(
    `[audit:heal-ladder] path=${healStats.bfs} ` +
    `anyPath(paint)=${healStats.anyPath} miss=${healStats.miss} stallJump=${healStats.stallJump}`,
  );
}

/** OCTI_DEBUG: final support-graph size summary. */
export function debugSupportSummary(nodeIds: Iterable<string>, nodeCount: number, edgeCount: number): void {
  if (!envStr('OCTI_DEBUG')) return;
  let anchors = 0;
  for (const id of nodeIds) if (id.startsWith('ha')) anchors++;
  console.error(
    `[topo] support: ${nodeCount} nodes (${anchors} anchor splits), ${edgeCount} edges`,
  );
}

/** OCTI_SUPPORT_BOX=<x0,y0,x1,y1>: dump every support edge with an endpoint
 *  inside the px box - endpoints (id, pos, degree), line ids, and point count.
 *  Placement-stage structure questions (parallel per-service ladders, joint
 *  degrees) answer from this instead of guessing from the drawn layout. */
export function debugSupportBox(
  nodes: ReadonlyMap<string, { pos: [number, number] }>,
  edges: ReadonlyMap<string, { id: string; from: string; to: string; points: Array<[number, number]>; lineIds: Set<string> }>,
  adj: ReadonlyMap<string, string[]>,
  label: (lineId: string) => string,
  stations?: ReadonlyMap<string, { label?: string; nodeId: string; stopNodes?: Map<string, string> }>,
  lineTraversals?: ReadonlyMap<string, Array<{ edgeId: string; reversed: boolean }>>,
): void {
  const box = typeof process !== 'undefined' ? envStr('OCTI_SUPPORT_BOX') : undefined;
  if (!box) return;
  const [x0, y0, x1, y1] = box.split(',').map(Number);
  const nin = (nid: string): boolean => {
    const p = nodes.get(nid)?.pos;
    return !!p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  };
  const fmt = (nid: string): string => {
    const p = nodes.get(nid)?.pos;
    return `${nid}@${p ? p.map((v) => v.toFixed(0)) : '?'}(d${(adj.get(nid) ?? []).length})`;
  };
  for (const e of edges.values()) {
    if (!nin(e.from) && !nin(e.to)) continue;
    console.error(
      `[supportbox] ${e.id} ${fmt(e.from)} -> ${fmt(e.to)} pts=${e.points.length} lines=[${[...e.lineIds].map(label).join(' ')}]`,
    );
  }
  if (stations) {
    for (const st of stations.values()) {
      if (!nin(st.nodeId)) continue;
      const stops = st.stopNodes ? [...st.stopNodes].map(([l, n]) => label(l) + '->' + fmt(n)).join(' ') : '';
      console.error(`[supportbox] station "${st.label ?? ''}" anchor=${fmt(st.nodeId)} stops: ${stops}`);
    }
  }
  if (lineTraversals) {
    for (const [lid, trav] of lineTraversals) {
      const parts: string[] = [];
      for (let i = 0; i < trav.length; i++) {
        const e = edges.get(trav[i].edgeId);
        if (!e || (!nin(e.from) && !nin(e.to))) continue;
        const from = trav[i].reversed ? e.to : e.from;
        const to = trav[i].reversed ? e.from : e.to;
        const retrace = i > 0 && trav[i].edgeId === trav[i - 1].edgeId && trav[i].reversed !== trav[i - 1].reversed;
        parts.push(`${retrace ? 'RETRACE ' : ''}${trav[i].edgeId}(${from}->${to})@${i}`);
      }
      if (parts.length > 0) console.error(`[supportbox] trav ${label(lid)}: ${parts.join(' ')}`);
    }
  }
}

/** OCTI_WELD_TRACE=1: one line per service-ladder weld - the rung edge, its
 *  lines, endpoints, and the chain it fused onto (edges, interior nodes,
 *  deviations, arc ratio) - so an over-firing weld identifies itself. */
export function traceLadderWeld(d: {
  rungId: string;
  rungLines: string[];
  from: [number, number];
  to: [number, number];
  chainIds: string[];
  chainLines: string[];
  interior: Array<[number, number]>;
  devAtoC: number;
  devCtoA: number;
  arcRatio: number;
}): void {
  if (typeof process === 'undefined' || envStr('OCTI_WELD_TRACE') !== '1') return;
  console.error(
    `[weld] ${d.rungId}[${d.rungLines.join(',')}] ${d.from.map((v) => v.toFixed(0))}->${d.to.map((v) => v.toFixed(0))} ` +
    `onto [${d.chainIds.join('+')}][${d.chainLines.join(',')}] interior=${d.interior.map((p) => '(' + p.map((v) => v.toFixed(0)) + ')').join('')} ` +
    `dev=${d.devAtoC.toFixed(1)}/${d.devCtoA.toFixed(1)} arcRatio=${d.arcRatio.toFixed(2)}`,
  );
}
