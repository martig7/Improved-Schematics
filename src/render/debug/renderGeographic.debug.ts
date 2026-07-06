// Smoothed-pipeline diagnostics (env-gated, dev only). Extracted from
// renderGeographic so the renderer keeps only the call sites. Every function
// self-gates on its env flag and returns early when unset, so moving the code
// out cannot change normal output. Enable with OCTI_PERF (stage timing),
// OCTI_TRACE (cellSize + weld + hooks traces), OCTI_AUDIT (short-edge census,
// spur/weld traces), OCTI_AUDIT_BOX (transit + support box dumps),
// OCTI_AUDIT_LINE (per-line octi placement), OCTI_PLACE_DEBUG (hooks trace).
import { envStr } from '../../env';
import type { Pixel, TransitGraph, SupportGraph, Image } from '../layout/types';

/** OCTI_PERF: per-stage wall-clock trace. Factory: returns a `lap(label)`
 *  closure that logs the ms since the previous lap. Self-gates — when OCTI_PERF
 *  is unset the closure is a no-op and never reads the clock. */
export function makePerfLap(): (label: string) => void {
  const PERF = typeof process !== 'undefined' && !!envStr('OCTI_PERF');
  let _perfT = PERF ? performance.now() : 0;
  return (label: string): void => {
    if (!PERF) return;
    const now = performance.now();
    console.error(`[perf] ${label}: ${(now - _perfT).toFixed(0)}ms`);
    _perfT = now;
  };
}

/** OCTI_AUDIT_BOX: dump the pre-merge TRANSIT graph inside the box —
 *  original node ids, stop flags, and each incident edge's lines + geometry. */
export function auditBoxTransit(graph: TransitGraph, boxStr: string): void {
  if (!boxStr) return;
  const [bx0, by0, bx1, by1] = boxStr.split(',').map(Number);
  const lbl = (lid: string) => { for (const e of graph.edges) { const l = e.lines.find((x) => x.id === lid); if (l?.label) return l.label; } return lid.slice(0, 8); };
  for (const [nid, n] of graph.nodes) {
    if (!n.pos || n.pos[0] < bx0 || n.pos[0] > bx1 || n.pos[1] < by0 || n.pos[1] > by1) continue;
    console.error(`[graphbox] ${nid.slice(0, 12)} (${n.pos[0].toFixed(1)},${n.pos[1].toFixed(1)})${n.label ? ` "${n.label}"` : ''}`);
    for (const e of graph.edges) {
      if (e.from !== nid && e.to !== nid) continue;
      const other = e.from === nid ? e.to : e.from;
      const on = graph.nodes.get(other);
      const chord = on ? Math.hypot(on.pos[0] - n.pos[0], on.pos[1] - n.pos[1]) : NaN;
      const stops = [...e.stops.entries()].map(([l, f]) => `${lbl(l)}${f.atFrom ? (e.from === nid ? '@this' : '@far') : ''}${f.atTo ? (e.to === nid ? '@this' : '@far') : ''}`).join(' ');
      console.error(`[graphbox]    ${e.id.slice(0, 10)} -> ${other.slice(0, 12)}"${on?.label ?? ''}"(${on ? on.pos.map((v) => v.toFixed(0)).join(',') : '?'}) chord=${chord.toFixed(1)} geo=${e.geo?.length ?? 0}pts lines=[${e.lines.map((l) => l.label ?? l.id.slice(0, 6)).join(',')}] stops:{${stops}}`);
    }
  }
}

/** OCTI_TRACE: the chosen octi grid cell + its contraction threshold. */
export function traceCellSize(cellSize: number, medLen: number, divisor: number): void {
  if (!envStr('OCTI_TRACE')) return;
  console.error(`[trace] cellSize=${cellSize.toFixed(1)} (medLen=${medLen.toFixed(1)} divisor=${divisor}) contract<${(cellSize / 2).toFixed(1)}`);
}

/** OCTI_AUDIT: short-edge census at the octi seam. Factory: captures the
 *  support graph (read LIVE, so a post-weld call sees the fused graph) and the
 *  finalized cell size, returns a `census(tag)` reporter. Self-gates. */
export function makeShortEdgeCensus(support: SupportGraph, cellSize: number): (tag: string) => void {
  return (tag: string): void => {
    if (!envStr('OCTI_AUDIT')) return;
    const half = cellSize / 2;
    let subHalf = 0;
    let subCell = 0;
    for (const e of support.edges.values()) {
      const a = support.nodes.get(e.from)?.pos;
      const b = support.nodes.get(e.to)?.pos;
      if (!a || !b) continue;
      const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
      if (d < half) {
        subHalf++;
        const kind = (nid: string): string => {
          if (support.stations.size) {
            for (const sp of support.stations.values()) if (sp.nodeId === nid) return 'STN';
          }
          return nid.replace(/\d+$/, '');
        };
        console.error(`[audit:octi-seam ${tag}]   ${e.id} ${e.from}(${kind(e.from)})<->${e.to}(${kind(e.to)}) ${d.toFixed(1)}px`);
      }
      if (d < cellSize) subCell++;
    }
    console.error(`[audit:octi-seam ${tag}] edges<cell/2(${half.toFixed(1)}px)=${subHalf} edges<cell=${subCell} total=${support.edges.size}`);
  };
}

/** OCTI_TRACE || OCTI_AUDIT: the sub-cell weld count. Mirrors the core's
 *  `welds > 0 && (OCTI_TRACE || OCTI_AUDIT)` guard. */
export function traceWeld(welds: number, weldDist: number): void {
  if (!(welds > 0 && (envStr('OCTI_TRACE') || envStr('OCTI_AUDIT')))) return;
  console.error(`[weld] sub-cell welds=${welds} (dist=${weldDist.toFixed(1)})`);
}

/** OCTI_AUDIT_BOX: dump the pre-octi SUPPORT nodes inside the box (id, pos,
 *  degree, station?) plus every sub-cell node pair — the router congestion
 *  picture octi actually faces. */
export function auditBoxSupport(support: SupportGraph, cellSize: number, boxStr: string): void {
  if (!boxStr) return;
  const [bx0, by0, bx1, by1] = boxStr.split(',').map(Number);
  const stationNode = new Map<string, string>();
  for (const [gid, sp] of support.stations) stationNode.set(sp.nodeId, sp.label || gid);
  const inBox: Array<{ id: string; pos: Pixel }> = [];
  for (const [id, n] of support.nodes) {
    if (n.pos[0] >= bx0 && n.pos[0] <= bx1 && n.pos[1] >= by0 && n.pos[1] <= by1) inBox.push({ id, pos: n.pos });
  }
  inBox.sort((a, b) => (a.id < b.id ? -1 : 1));
  const lineLabel = (lid: string) => support.lineRefs.get(lid)?.label ?? lid.slice(0, 6);
  for (const { id, pos } of inBox) {
    const deg = (support.adj.get(id) ?? []).length;
    const st = stationNode.get(id);
    console.error(`[boxdbg] ${id} (${pos[0].toFixed(1)},${pos[1].toFixed(1)}) deg=${deg}${st ? ` STATION "${st}"` : ''}`);
    for (const eid of support.adj.get(id) ?? []) {
      const e = support.edges.get(eid);
      if (!e) continue;
      const other = e.from === id ? e.to : e.from;
      const op = support.nodes.get(other)?.pos;
      const len = op ? Math.hypot(op[0] - pos[0], op[1] - pos[1]) : NaN;
      console.error(`[boxdbg]    ${eid} -> ${other}(${op ? op.map((v) => v.toFixed(0)).join(',') : '?'}) ${len.toFixed(1)}px lines=[${[...e.lineIds].map(lineLabel).sort().join(',')}]`);
    }
  }
  const cell = cellSize ?? 0;
  for (let i = 0; i < inBox.length; i++) {
    for (let j = i + 1; j < inBox.length; j++) {
      const d = Math.sqrt((inBox[i].pos[0] - inBox[j].pos[0]) ** 2 + (inBox[i].pos[1] - inBox[j].pos[1]) ** 2);
      if (d < cell) console.error(`[boxdbg] SUB-CELL pair ${inBox[i].id} <-> ${inBox[j].id}: ${d.toFixed(1)}px (cell=${cell.toFixed(1)})`);
    }
  }
}

/** OCTI_AUDIT_LINE=<label>: dump a line's support traversal with octi
 *  placement/path status per edge (which edge lost its grid path, and where). */
export function auditLine(support: SupportGraph, imageRaw: Image, label: string | undefined): void {
  if (!label) return;
  for (const [lid, steps] of support.lineTraversals) {
    if (support.lineRefs.get(lid)?.label !== label) continue;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const e = support.edges.get(s.edgeId);
      if (!e) { console.error(`[octidbg] [${i}] ${s.edgeId} MISSING-EDGE`); continue; }
      const a = s.reversed ? e.to : e.from;
      const b = s.reversed ? e.from : e.to;
      const pa = imageRaw.placement.get(a);
      const pb = imageRaw.placement.get(b);
      const path = imageRaw.paths.get(e.id);
      const at = (p?: readonly number[]): string => (p ? `(${p[0].toFixed(0)},${p[1].toFixed(0)})` : '(unplaced)');
      console.error(`[octidbg] [${i}] ${e.id} ${s.reversed ? 'REV' : '   '} ${a}${at(pa)} -> ${b}${at(pb)} path=${path ? path.length : 'NONE'} lines=${e.lineIds.size}`);
    }
  }
}

/** OCTI_AUDIT: mid-route spur-step drop count from the traversal cleanup. */
export function auditSpurDrops(spurDrops: number): void {
  if (!(spurDrops > 0 && envStr('OCTI_AUDIT'))) return;
  console.error(`[audit:fire] spurStepDrops=${spurDrops}`);
}

/** OCTI_TRACE || OCTI_PLACE_DEBUG: the count of synthetic hooks spliced. Also
 *  fires unconditionally when any were spliced (spliced > 0), matching the core. */
export function traceHooks(spliced: number): void {
  const trace = envStr('OCTI_TRACE') === '1' || envStr('OCTI_PLACE_DEBUG') === '1';
  if (!(spliced > 0 || trace)) return;
  console.log(`[hooks] spliced=${spliced}`);
}
