// Traversal-integrity audit (dev, env-gated): verify every line traversal
// references existing edges and that consecutive steps chain through a shared
// node. Prints one line per defect with positions, so a pipeline stage that
// breaks a traversal identifies itself. Enable with OCTI_AUDIT=1 (all lines)
// or OCTI_AUDIT=<lineId-prefix>.

import type { TraversalStep } from './types';

export interface AuditEdge {
  from: string;
  to: string;
}

export function auditTraversals(
  stage: string,
  traversals: ReadonlyMap<string, TraversalStep[]>,
  getEdge: (id: string) => AuditEdge | undefined,
  getPos: (nodeId: string) => readonly [number, number] | undefined,
  lineLabel?: (lineId: string) => string,
): void {
  const flag =
    typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env?.OCTI_AUDIT : undefined;
  if (!flag) return;
  const fmt = (nid: string): string => {
    const p = getPos(nid);
    return p ? `${nid}(${p[0].toFixed(0)},${p[1].toFixed(0)})` : nid;
  };
  let defects = 0;
  for (const [lineId, trav] of traversals) {
    if (flag !== '1' && !lineId.startsWith(flag)) continue;
    const name = lineLabel ? lineLabel(lineId) : lineId.slice(0, 8);
    let prevEnd: string | null = null;
    for (let i = 0; i < trav.length; i++) {
      const s = trav[i];
      const e = getEdge(s.edgeId);
      if (!e) {
        defects++;
        console.error(`[audit:${stage}] ${name} step[${i}] MISSING edge ${s.edgeId}`);
        prevEnd = null;
        continue;
      }
      const a = s.reversed ? e.to : e.from;
      const b = s.reversed ? e.from : e.to;
      if (prevEnd !== null && prevEnd !== a) {
        defects++;
        const pa = getPos(prevEnd);
        const pb = getPos(a);
        const gap = pa && pb ? Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2).toFixed(1) : '?';
        console.error(`[audit:${stage}] ${name} step[${i}] BREAK ${fmt(prevEnd)} -> ${fmt(a)} gap=${gap}px`);
      }
      prevEnd = b;
    }
  }
  console.error(`[audit:${stage}] defects=${defects}`);
}
