/**
 * Per-line pipeline tracer for the NEW v2 dump. Answers the central fork for a
 * drawn-route gap: is it a GRAPH-level traversal break (consecutive edges don't
 * share a node — an upstream merge/octi/traversal bug) or a LAST-STEP join
 * decline (edges share the node, but computeRibbonGeometry refused to bridge the
 * offset lane ends)?
 *
 *   tsx dev/trace-line.ts <label-or-lineId> [dump.json]
 *
 * Reports, for the line's layout traversal:
 *   - each step (edge, direction, from→to node labels)
 *   - each consecutive pair: endA node vs startB node → MATCH / **BREAK**
 *   - the node-pixel gap at each boundary
 * and cross-references the drawn gaps from contig.ts.
 */

import { readFileSync } from 'fs';
import { deserializeMap } from '../src/render/persist';
import type { SmoothedPrecomputed } from '../src/render/schematic';
import type { Pixel, LayoutEdge } from '../src/render/layout/types';
import { analyzeLine } from './contig';

const want = process.argv[2];
const path = process.argv[3] ?? 'improvedschematics-input-nyc-difficult-NEW.json';
if (!want) { console.log('usage: tsx dev/trace-line.ts <label-or-lineId> [dump.json]'); process.exit(1); }

const bundle = deserializeMap(readFileSync(path, 'utf8'));
const pre = bundle.pre as SmoothedPrecomputed;
const geom = pre.geometry!;
const { layout, nodePx } = pre;

// resolve line
let lineId = want;
let label = want;
for (const [id, l] of geom.lineById) {
  if (id === want || l.label === want) { lineId = id; label = l.label ?? id; break; }
}
const trav = layout.lineTraversals.get(lineId);
if (!trav) { console.log(`no traversal for ${want} (resolved ${lineId})`); process.exit(1); }

const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
const nlabel = (id: string): string => layout.nodes.get(id)?.label || id.slice(0, 8);
const px = (id: string): Pixel | undefined => nodePx.get(id);

const endNodeOf = (e: LayoutEdge, reversed: boolean, which: 'start' | 'end'): string => {
  // travel direction: reversed flips from/to
  const from = reversed ? e.to : e.from;
  const to = reversed ? e.from : e.to;
  return which === 'start' ? from : to;
};

console.log(`=== ${label} (${lineId}) — ${trav.length} traversal steps, ${layout.lineTraversals.get(lineId)!.length} ===`);
let breaks = 0;
for (let i = 0; i < trav.length; i++) {
  const s = trav[i];
  const e = edgeById.get(s.edgeId);
  if (!e) { console.log(`  [${i}] edge ${s.edgeId} MISSING`); continue; }
  const a = endNodeOf(e, s.reversed, 'start');
  const b = endNodeOf(e, s.reversed, 'end');
  if (i > 0) {
    const prev = trav[i - 1];
    const pe = edgeById.get(prev.edgeId);
    if (pe) {
      const prevEnd = endNodeOf(pe, prev.reversed, 'end');
      const curStart = a;
      const match = prevEnd === curStart;
      const pa = px(prevEnd), pb = px(curStart);
      const gap = pa && pb ? Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) : NaN;
      if (!match) {
        breaks++;
        console.log(`   |  BREAK: prevEnd=${nlabel(prevEnd)} != curStart=${nlabel(curStart)}  node-gap=${gap.toFixed(1)}px`);
      } else if (prev.edgeId !== s.edgeId) {
        console.log(`   |  join @ ${nlabel(curStart)} (same node, offset lanes bridged here)`);
      }
    }
  }
  const ep = px(e.from), eq = px(e.to);
  const epx = ep ? `(${ep[0].toFixed(0)},${ep[1].toFixed(0)})` : '??';
  const eqx = eq ? `(${eq[0].toFixed(0)},${eq[1].toFixed(0)})` : '??';
  console.log(`  [${i}] ${s.edgeId.slice(0, 10)} ${s.reversed ? 'REV' : '   '} ${nlabel(a)} ${epx} -> ${nlabel(b)} ${eqx}  lines=${e.lines.length} order=[${e.lineOrder.map((x) => geom.lineById.get(x)?.label ?? x.slice(0, 3)).join(',')}]`);
}
console.log(`\nGRAPH-level traversal breaks (consecutive edges not sharing a node): ${breaks}`);

// cross-reference drawn gaps
const lr = analyzeLine(lineId, label, geom.lineById.get(lineId)?.color ?? '?', geom.dByLine.get(lineId) ?? []);
const VIS = 2;
const big = lr.gaps.filter((g) => g.dist >= VIS);
console.log(`DRAWN visible gaps (>= ${VIS}px): ${big.length}`);
const stationLabels: Array<{ pos: Pixel; label: string }> = [];
for (const st of pre.stations) { const pos = nodePx.get(st.nodeId); const l = layout.nodes.get(st.nodeId)?.label; if (pos && l) stationLabels.push({ pos, label: l }); }
const nearest = (p: Pixel): string => { let best = '?', bd = Infinity; for (const s of stationLabels) { const d = (s.pos[0] - p[0]) ** 2 + (s.pos[1] - p[1]) ** 2; if (d < bd) { bd = d; best = s.label; } } return `${best} (${Math.sqrt(bd).toFixed(0)}px)`; };
for (const g of big) console.log(`  gap ${g.dist.toFixed(1)}px at (${g.at[0].toFixed(0)},${g.at[1].toFixed(0)}) — near ${nearest(g.at)}`);
