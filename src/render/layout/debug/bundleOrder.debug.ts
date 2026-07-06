// Bundle-blocks line-ordering diagnostics (env-gated, dev only). Extracted from
// bundleOrder so the ordering routine keeps only the call sites. Enable with
// OCTI_BLOCKS_TRACE=<lineId> (per-line derivation trace) or OCTI_DEBUG
// (per-run summary + straight-flip A/B measuring stick, OCTI_FLIP_DETAIL=1 for
// per-flip lines).
import { envStr } from '../../../env';
import type { Layout, LayoutEdge } from '../types';
import type { Corridor, CorridorSet, LineFlow } from '../bundleOrder';

/** OCTI_BLOCKS_TRACE=<lineId>: factory for the per-line derivation trace closure
 *  and its two formatting helpers. Returns `tlog` (logs every derivation event
 *  touching a corridor that carries the traced line) plus `cinfo`/`lbl`, which
 *  the call sites also use to build their message strings. The trace closure
 *  self-gates on the traced line, so a no-op factory is safe to wire in
 *  unconditionally. */
export function makeBlocksTrace(layout: Layout): {
  tlog: (c: Corridor, msg: string) => void;
  cinfo: (c: Corridor) => string;
  lbl: (nd: string) => string;
} {
  const traceLine =
    typeof process !== 'undefined'
      ? envStr('OCTI_BLOCKS_TRACE')
      : undefined;
  const lbl = (nd: string): string => layout.nodes.get(nd)?.label || '·';
  const cinfo = (c: Corridor): string =>
    `c${c.id}[${c.endA}"${lbl(c.endA)}"↔${c.endB}"${lbl(c.endB)}" ${c.lines.length}L via ${c.parts.map((p) => p.edge.id).join(',')}]`;
  const tlog = (c: Corridor, msg: string): void => {
    if (traceLine && c.lines.includes(traceLine)) console.error(`[btrace] ${cinfo(c)} ${msg}`);
  };
  return { tlog, cinfo, lbl };
}

/** OCTI_DEBUG: one-line per-run summary of the blocks solve, plus the
 *  straight-flip A/B measuring stick (reportStraightFlips). */
export function debugBlocks(
  layout: Layout,
  cs: CorridorSet,
  flows: Map<string, Map<string, LineFlow>>,
  plannedSwaps: number,
  residualSwaps: number,
): void {
  if (!envStr('OCTI_DEBUG')) return;
  console.error(
    `[blocks] corridors=${cs.corridors.length} planned-crossings=${plannedSwaps} cycle-residuals=${residualSwaps} (all at junctions by construction)`,
  );
  reportStraightFlips(layout, cs, flows);
}

/** A/B measuring stick (matches untangle's DBG line format): count
 *  same-segment pair FLIPS on the final written-back orders at nodes where
 *  the two edges continue near-collinear. `scored` = both lines genuinely
 *  flow between the two corridors at the node (a drawn through-braid);
 *  `diverge` = at least one line leaves the corridor pair there. free and
 *  interior classes don't exist in blocks mode (no freeCross concept;
 *  corridor interiors carry one order by construction) and print 0. */
function reportStraightFlips(
  layout: Layout,
  cs: CorridorSet,
  flows: Map<string, Map<string, LineFlow>>,
): void {
  const awayTangent = (e: LayoutEdge, nd: string): [number, number] | null => {
    const pts = e.from === nd ? e.path : [...e.path].reverse();
    let dx = 0;
    let dy = 0;
    for (let i = 1; i < pts.length && dx * dx + dy * dy < 0.25; i++) {
      dx = pts[i][0] - pts[0][0];
      dy = pts[i][1] - pts[0][1];
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    return len < 1e-9 ? null : [dx / len, dy / len];
  };
  let scored = 0;
  let diverge = 0;
  const detail =
    envStr('OCTI_FLIP_DETAIL') === '1';
  const edges = layout.edges.filter((e) => e.from !== e.to && e.lines.length > 0);
  const incAll = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    for (const n of [e.from, e.to]) {
      let arr = incAll.get(n);
      if (!arr) incAll.set(n, (arr = []));
      arr.push(e);
    }
  }
  for (const [nd, es] of incAll) {
    for (let i = 0; i < es.length; i++) {
      for (let j = i + 1; j < es.length; j++) {
        const e1 = es[i];
        const e2 = es[j];
        const t1 = awayTangent(e1, nd);
        const t2 = awayTangent(e2, nd);
        if (!t1 || !t2 || t1[0] * t2[0] + t1[1] * t2[1] >= -0.92) continue;
        const shared = e1.lineOrder.filter((l) => e2.lineOrder.includes(l));
        const rev = (e1.from !== nd) === (e2.from !== nd);
        const c1 = cs.byEdge.get(e1.id);
        const c2 = cs.byEdge.get(e2.id);
        const connects = (l: string): boolean => {
          if (!c1 || !c2) return false;
          if (c1 === c2) return true; // same corridor: interior continuation
          const f = flows.get(nd)?.get(l);
          if (!f) return false;
          return (
            (f.from === c1.id && f.to === c2.id) ||
            (f.from === c2.id && f.to === c1.id)
          );
        };
        for (let x = 0; x < shared.length; x++) {
          for (let y = x + 1; y < shared.length; y++) {
            const ia = e1.lineOrder.indexOf(shared[x]);
            const ib = e1.lineOrder.indexOf(shared[y]);
            const ra = rev ? e1.lineOrder.length - 1 - ia : ia;
            const rb = rev ? e1.lineOrder.length - 1 - ib : ib;
            if ((ra - rb) * (e2.lineOrder.indexOf(shared[x]) - e2.lineOrder.indexOf(shared[y])) < 0) {
              if (detail) {
                console.error(`[flip] @ ${nd}"${layout.nodes.get(nd)?.label ?? ''}" ${shared[x].slice(0, 8)}×${shared[y].slice(0, 8)} e1=${e1.id} e2=${e2.id}`);
              }
              if (connects(shared[x]) && connects(shared[y])) scored++;
              else diverge++;
            }
          }
        }
      }
    }
  }
  console.error(
    `[untangle] straight-node same-seg flips: total=${scored + diverge} free=0 interior=0 scored=${scored} diverge=${diverge}`,
  );
}
