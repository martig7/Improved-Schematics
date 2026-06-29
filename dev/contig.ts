/**
 * Contiguity checker for DRAWN smoothed routes, operating on the NEW v2 dump
 * format (improvedschematics-input-*.json — a serialized MapBundle).
 *
 * The dump already carries `pre.geometry` (the toggle-independent RibbonGeometry
 * computed by computeRibbonGeometry), whose `dByLine` is the EXACT per-line set
 * of SVG path `d` fragments the renderer paints. This is the LAST step of the
 * pipeline. A drawn route is contiguous iff the union of its sub-paths forms a
 * single connected component (sub-paths share endpoints, which the join/miter/
 * taper/dogleg passes pin to identical, toFixed(1)-rounded points). A declined
 * bridge leaves two sub-paths with a gap → 2+ components → non-contiguous.
 *
 * Usage:
 *   tsx dev/contig.ts [dump.json]
 *   tsx dev/contig.ts [dump.json] --line Q     # detail one route bullet
 */

import { readFileSync } from 'fs';
import { deserializeMap } from '../src/render/persist';
import type { SmoothedPrecomputed } from '../src/render/schematic';
import type { Pixel } from '../src/render/layout/types';

const path = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'improvedschematics-input-nyc-difficult-NEW.json';
const lineFilter = (() => {
  const i = process.argv.indexOf('--line');
  return i >= 0 ? process.argv[i + 1] : null;
})();

export interface SubPath {
  pts: Pixel[];
  start: Pixel;
  end: Pixel;
}

// Coincidence epsilon (px). The renderer treats consecutive lane ends closer
// than 0.5px as already-joined (no bridge emitted: see the `gap < 0.5` continue
// in computeRibbonGeometry). So endpoints within EPS are a sub-pixel SEAM, not a
// visible gap — collapse them before counting components. Override with --eps.
const EPS = (() => {
  const i = process.argv.indexOf('--eps');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : 0.6;
})();

/** Parse a line's dByLine fragment array into discrete sub-paths (split on M).
 *  Handles every command the ribbon renderer emits: M/L (1 pair), Q (control +
 *  endpoint), C (2 controls + endpoint — the node-connector cubic). The endpoint
 *  is always the LAST coordinate pair; controls don't break contiguity. */
export function parseSubPaths(dFrags: string[]): SubPath[] {
  const full = dFrags.join(' ');
  const subs: SubPath[] = [];
  let cur: Pixel[] | null = null;
  const cmdRe = /([MLQCZ])([^MLQCZ]*)/gi;
  let m: RegExpExecArray | null;
  const last2 = (nums: number[]): Pixel | null => (nums.length >= 2 ? [nums[nums.length - 2], nums[nums.length - 1]] : null);
  while ((m = cmdRe.exec(full))) {
    const cmd = m[1].toUpperCase();
    const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (cmd === 'M') {
      if (cur && cur.length >= 2) subs.push({ pts: cur, start: cur[0], end: cur[cur.length - 1] });
      const p = last2(nums);
      cur = p ? [p] : [];
    } else if (cmd === 'L' || cmd === 'Q' || cmd === 'C') {
      const p = last2(nums); // endpoint = final pair regardless of command
      if (cur && p) cur.push(p);
    }
  }
  if (cur && cur.length >= 2) subs.push({ pts: cur, start: cur[0], end: cur[cur.length - 1] });
  return subs;
}

/** Index-based union-find. */
class UF {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(a: number): number { while (this.parent[a] !== a) a = this.parent[a] = this.parent[this.parent[a]]; return a; }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

export interface Gap {
  dist: number;  // gap size (px) bridging two otherwise-disconnected drawn pieces
  at: Pixel;     // midpoint of the gap
}

export interface LineReport {
  lineId: string;
  label: string;
  color: string;
  subCount: number;
  numComponents: number;       // after collapsing sub-pixel seams (EPS)
  gaps: Gap[];                 // real inter-component gaps, descending by size
}

/**
 * Connect sub-paths into components where endpoints lie within EPS (collapsing
 * sub-pixel seams), then report the remaining REAL gaps — the minimum-distance
 * bridge from each component to its nearest neighbour component.
 */
export function analyzeLine(lineId: string, label: string, color: string, dFrags: string[]): LineReport {
  const subs = parseSubPaths(dFrags);
  // one node per sub-path endpoint (2 per sub-path)
  const pts: Pixel[] = [];
  for (const s of subs) { pts.push(s.start, s.end); }
  const uf = new UF(pts.length);
  for (let i = 0; i < subs.length; i++) uf.union(2 * i, 2 * i + 1); // a sub-path's own ends
  // union any two endpoints within EPS (sub-pixel seam between abutting pieces)
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      if (dx * dx + dy * dy <= EPS * EPS) uf.union(i, j);
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < pts.length; i++) roots.add(uf.find(i));
  const numComponents = roots.size;
  // For each component, the smallest distance to a DIFFERENT component = the gap
  // that, if bridged, would reconnect it. Dedup symmetric pairs.
  const gaps: Gap[] = [];
  const rootList = [...roots];
  const seenPair = new Set<string>();
  for (const r of rootList) {
    let best = Infinity, bestAt: Pixel = [0, 0], bestOther = -1;
    for (let i = 0; i < pts.length; i++) {
      if (uf.find(i) !== r) continue;
      for (let j = 0; j < pts.length; j++) {
        const oj = uf.find(j);
        if (oj === r) continue;
        const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bestAt = [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2]; bestOther = oj; }
      }
    }
    if (bestOther >= 0) {
      const pairKey = r < bestOther ? r + '|' + bestOther : bestOther + '|' + r;
      if (!seenPair.has(pairKey)) { seenPair.add(pairKey); gaps.push({ dist: Math.sqrt(best), at: bestAt }); }
    }
  }
  gaps.sort((a, b) => b.dist - a.dist);
  return { lineId, label, color, subCount: subs.length, numComponents, gaps };
}

function main(): void {
  const bundle = deserializeMap(readFileSync(path, 'utf8'));
  const pre = bundle.pre as SmoothedPrecomputed;
  const geom = pre.geometry;
  console.log(`dump: ${path}`);
  console.log(`pre: ${pre.width}x${pre.height} dark=${pre.dark}`);
  console.log(`layout: ${pre.layout.nodes.size} nodes, ${pre.layout.edges.length} edges, ${pre.layout.lineTraversals.size} traversals`);
  if (!geom) { console.log('NO pre.geometry in dump — cannot check drawn routes.'); return; }
  console.log(`geometry: dByLine=${geom.dByLine.size} lines, segments=${geom.segments.length}, lineById=${geom.lineById.size}`);
  console.log('');

  // nearest station label to a pixel, for locating gaps
  const stationLabels: Array<{ pos: Pixel; label: string }> = [];
  for (const st of pre.stations) {
    const pos = pre.nodePx.get(st.nodeId);
    const label = pre.layout.nodes.get(st.nodeId)?.label ?? st.nodeId;
    if (pos) stationLabels.push({ pos, label });
  }
  const nearest = (p: Pixel): string => {
    let best = '?', bd = Infinity;
    for (const s of stationLabels) {
      const d = (s.pos[0] - p[0]) ** 2 + (s.pos[1] - p[1]) ** 2;
      if (d < bd && s.label) { bd = d; best = s.label; }
    }
    return `${best} (${Math.sqrt(bd).toFixed(0)}px away)`;
  };

  const reports: LineReport[] = [];
  for (const [lineId, dFrags] of geom.dByLine) {
    const lr = geom.lineById.get(lineId);
    reports.push(analyzeLine(lineId, lr?.label ?? '?', lr?.color ?? '?', dFrags));
  }
  // "real" gap threshold (px): below this, an unbridged seam is invisible at
  // lineWidth 3.5. A gap >= VIS is a visible break in the drawn route.
  const VIS = (() => {
    const i = process.argv.indexOf('--vis');
    const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
    return Number.isFinite(v) ? v : 2.0;
  })();
  const bigGaps = (r: LineReport): Gap[] => r.gaps.filter((g) => g.dist >= VIS);
  reports.sort((a, b) => bigGaps(b).length - bigGaps(a).length || (bigGaps(b)[0]?.dist ?? 0) - (bigGaps(a)[0]?.dist ?? 0));

  if (lineFilter) {
    const r = reports.find((x) => x.label === lineFilter || x.lineId === lineFilter);
    if (!r) { console.log(`no line with label/id "${lineFilter}"`); return; }
    console.log(`=== line ${r.label} (${r.lineId}) color=${r.color} ===`);
    console.log(`sub-paths: ${r.subCount}, components (eps=${EPS}): ${r.numComponents}`);
    console.log(`visible gaps (>= ${VIS}px): ${bigGaps(r).length}`);
    for (const g of r.gaps) {
      const flag = g.dist >= VIS ? ' <== VISIBLE' : '';
      console.log(`  gap ${g.dist.toFixed(1).padStart(6)}px at (${g.at[0].toFixed(0)},${g.at[1].toFixed(0)}) — near ${nearest(g.at)}${flag}`);
    }
    return;
  }

  const broken = reports.filter((r) => bigGaps(r).length > 0);
  console.log(`Routes with VISIBLE gaps (>= ${VIS}px, seams collapsed at eps=${EPS}): ${broken.length} of ${reports.length}\n`);
  console.log('label   #gaps  maxGap   gap locations (largest first)');
  for (const r of broken) {
    const bg = bigGaps(r);
    const locs = bg.slice(0, 4).map((g) => `${g.dist.toFixed(0)}px@${nearest(g.at)}`).join('; ');
    console.log(`${(r.label || '?').padEnd(7)} ${String(bg.length).padStart(4)}  ${bg[0].dist.toFixed(1).padStart(6)}  ${locs}`);
  }
  const clean = reports.filter((r) => bigGaps(r).length === 0);
  console.log('\nNO visible gaps:', clean.map((r) => r.label || r.lineId.slice(0, 4)).join(' '));

  // gap-size distribution across all lines
  const all = reports.flatMap((r) => r.gaps.map((g) => g.dist));
  const buckets = [0.6, 1, 2, 4, 8, 16, 32, 64, Infinity];
  const hist = new Array(buckets.length).fill(0);
  for (const d of all) { for (let i = 0; i < buckets.length; i++) if (d < buckets[i]) { hist[i]++; break; } }
  console.log('\ngap-size histogram (all components, px):');
  let lo = EPS;
  for (let i = 0; i < buckets.length; i++) { console.log(`  [${lo.toString().padStart(4)}, ${buckets[i] === Infinity ? '  ∞' : buckets[i].toString().padStart(3)}): ${hist[i]}`); lo = buckets[i]; }
}

// Only run the CLI when invoked directly (not when imported by trace-line.ts).
if (process.argv[1] && /contig\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) main();
