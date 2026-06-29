/**
 * Decisive table: for EVERY line, GRAPH-level traversal breaks vs DRAWN visible
 * gaps. If a line has drawn gaps but 0 graph breaks, its traversal is a valid
 * connected walk and the gap is a pure LAST-STEP rendering decline. If it has
 * graph breaks, the non-contiguity originates upstream (merge/octi/traversal).
 *
 *   tsx dev/contig-summary.ts [dump.json]
 */

import { readFileSync } from 'fs';
import { deserializeMap } from '../src/render/persist';
import type { SmoothedPrecomputed } from '../src/render/schematic';
import type { LayoutEdge } from '../src/render/layout/types';
import { analyzeLine } from './contig';

const path = process.argv[2] ?? 'improvedschematics-input-nyc-difficult-NEW.json';
const bundle = deserializeMap(readFileSync(path, 'utf8'));
const pre = bundle.pre as SmoothedPrecomputed;
const geom = pre.geometry!;
const { layout } = pre;
const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
const travEnd = (e: LayoutEdge, rev: boolean): string => (rev ? e.from : e.to);
const travStart = (e: LayoutEdge, rev: boolean): string => (rev ? e.to : e.from);

const VIS = 2;
console.log('label    steps  graphBreaks  drawnGaps(>=2px)  maxGap');
const rows: Array<{ label: string; steps: number; breaks: number; gaps: number; maxGap: number }> = [];
for (const [lineId, l] of geom.lineById) {
  const trav = layout.lineTraversals.get(lineId) ?? [];
  let breaks = 0;
  for (let i = 1; i < trav.length; i++) {
    const pe = edgeById.get(trav[i - 1].edgeId);
    const ce = edgeById.get(trav[i].edgeId);
    if (!pe || !ce) continue;
    if (travEnd(pe, trav[i - 1].reversed) !== travStart(ce, trav[i].reversed)) breaks++;
  }
  const lr = analyzeLine(lineId, l.label ?? '?', l.color ?? '?', geom.dByLine.get(lineId) ?? []);
  const big = lr.gaps.filter((g) => g.dist >= VIS);
  rows.push({ label: l.label ?? lineId.slice(0, 6), steps: trav.length, breaks, gaps: big.length, maxGap: big[0]?.dist ?? 0 });
}
rows.sort((a, b) => b.gaps - a.gaps || b.breaks - a.breaks);
for (const r of rows) {
  console.log(`${r.label.padEnd(8)} ${String(r.steps).padStart(5)}  ${String(r.breaks).padStart(11)}  ${String(r.gaps).padStart(16)}  ${r.maxGap.toFixed(1).padStart(6)}`);
}
const totBreaks = rows.reduce((s, r) => s + r.breaks, 0);
const withGaps = rows.filter((r) => r.gaps > 0);
const gapsButNoBreaks = withGaps.filter((r) => r.breaks === 0);
console.log(`\ntotal graph breaks across all lines: ${totBreaks}`);
console.log(`lines with drawn gaps: ${withGaps.length}; of those with ZERO graph breaks (pure last-step): ${gapsButNoBreaks.length}`);
console.log(`lines with drawn gaps AND graph breaks (upstream): ${withGaps.filter((r) => r.breaks > 0).map((r) => r.label).join(' ') || '(none)'}`);
