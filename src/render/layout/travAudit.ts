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

/** Zigzag census: a REVERSAL is a node where the line's incoming and outgoing
 *  directions oppose (dot < -0.5) — the user-facing "detour" classification
 *  (out-and-back to a stop, wishbones, down-up-down staircases). Genuine
 *  turnarounds exist in the GRAPH traversal too, so diff stages against the
 *  graph count: new reversals = manufactured artifacts. OCTI_AUDIT=1. */
export function auditZigzags(
  stage: string,
  traversals: ReadonlyMap<string, TraversalStep[]>,
  getEdge: (id: string) => AuditEdge | undefined,
  getPos: (nodeId: string) => readonly [number, number] | undefined,
  lineLabel?: (lineId: string) => string,
): void {
  const flag =
    typeof process !== 'undefined' ? (process as { env?: Record<string, string> }).env?.OCTI_AUDIT : undefined;
  if (!flag) return;
  let total = 0;
  const perLine: string[] = [];
  for (const [lineId, trav] of traversals) {
    if (flag !== '1' && !lineId.startsWith(flag)) continue;
    // node sequence along the traversal (chain breaks reset the window)
    const seq: Array<readonly [number, number] | null> = [];
    let prevEnd: string | null = null;
    for (const s of trav) {
      const e = getEdge(s.edgeId);
      if (!e) { seq.push(null); prevEnd = null; continue; }
      const a = s.reversed ? e.to : e.from;
      const b = s.reversed ? e.from : e.to;
      if (prevEnd !== null && prevEnd !== a) seq.push(null);
      if (prevEnd === null || prevEnd !== a) seq.push(getPos(a) ?? null);
      seq.push(getPos(b) ?? null);
      prevEnd = b;
    }
    let n = 0;
    const spots: string[] = [];
    for (let i = 1; i + 1 < seq.length; i++) {
      const p = seq[i - 1];
      const c = seq[i];
      const q = seq[i + 1];
      if (!p || !c || !q) continue;
      const ux = c[0] - p[0], uy = c[1] - p[1];
      const vx = q[0] - c[0], vy = q[1] - c[1];
      const lu = Math.sqrt(ux * ux + uy * uy), lv = Math.sqrt(vx * vx + vy * vy);
      if (lu < 1e-6 || lv < 1e-6) continue;
      if ((ux * vx + uy * vy) / (lu * lv) < -0.5) {
        n++;
        if (spots.length < 6) spots.push(`(${c[0].toFixed(0)},${c[1].toFixed(0)})`);
      }
    }
    if (n > 0) {
      total += n;
      const name = lineLabel ? lineLabel(lineId) : lineId.slice(0, 8);
      perLine.push(`${name}=${n}${spots.length ? '@' + spots.join(' ') : ''}`);
    }
  }
  console.error(`[audit:zigzag:${stage}] total=${total}  ${perLine.join('  ')}`);
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
