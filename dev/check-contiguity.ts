/**
 * Subway-line CONTIGUITY checker for the octilinear hub-split.
 *
 * A subway line must render as one connected path. For each line, collect the
 * edges that CARRY it and count connected components by SHARED NODE ENDPOINTS.
 * A line is BROKEN when the split raises its component count above the baseline
 * (flag-off): flag-on has a gap the flag-off layout did not.
 *
 * Two checkpoints (captured by renderGeographic's OCTI_SPLIT_CAPTURE hook):
 *   afterSplit  — the support graph immediately AFTER splitHubs. Isolates the
 *                 graph surgery (does the spine carry every through-line?).
 *   finalLayout — the Layout after octi / mergeCoincidentPaths /
 *                 supportToLayout / untangle. Catches breaks introduced
 *                 downstream of the surgery (merge dropping the spine, etc.).
 *
 * Usage (one config per run; the smoothed pipeline runs once, ~2-4 min):
 *   # baseline (flag-off): write a sidecar of per-line component counts
 *   OCTI_WARP=1.6 OCTI_SPLIT_CAPTURE=1 \
 *     npx tsx dev/check-contiguity.ts <dump.json> --out dev/_contig-off.json
 *
 *   # flag-on cap=1 (default cap)
 *   OCTI_WARP=1.6 OCTI_SPLIT_HUBS=1 OCTI_SPLIT_CAPTURE=1 \
 *     npx tsx dev/check-contiguity.ts <dump.json> --out dev/_contig-on-cap1.json --baseline dev/_contig-off.json
 *
 *   # flag-on uncapped
 *   OCTI_WARP=1.6 OCTI_SPLIT_HUBS=1 OCTI_SPLIT_MAXHUBS=0 OCTI_SPLIT_CAPTURE=1 \
 *     npx tsx dev/check-contiguity.ts <dump.json> --out dev/_contig-on-unc.json --baseline dev/_contig-off.json
 *
 * --baseline <file> compares against an earlier sidecar and prints BROKEN lines
 * (component count rose), citing the disconnected node sets at each level.
 *
 * Importable: `runContiguity(dump)` returns the per-line component report so
 * other dev scripts / tests can assert on it.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { precomputeSmoothedSchematic, drawSmoothedSchematic } from '../src/render/schematic';
import { __splitDebug, type SplitCaptureEdge } from '../src/render/renderGeographic';
import { __ribbonDrawn } from '../src/render/renderOctilinear';
import { keepLargestWaterBodies } from '../src/water/bodies';
import type { WaterCollection } from '../src/render/types';

/** Connected components of the subgraph of `edges` that carry `lineId`, keyed by
 *  shared node endpoints (union-find over {from,to}). Returns the component
 *  groups as arrays of node ids (sorted) so callers can see WHERE a gap sits. */
function lineComponents(edges: SplitCaptureEdge[], lineId: string): string[][] {
  const carry = edges.filter((e) => e.lines.includes(lineId));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  for (const e of carry) {
    add(e.from); add(e.to);
    parent.set(find(e.from), find(e.to));
  }
  const groups = new Map<string, Set<string>>();
  for (const n of parent.keys()) {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r)!.add(n);
  }
  return [...groups.values()]
    .map((s) => [...s].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export interface LevelReport {
  /** lineId -> number of connected components carrying it (1 = contiguous). */
  components: Record<string, number>;
  /** lineId -> the node-id sets of each component (only for broken-ish lines). */
  componentNodes: Record<string, string[][]>;
}
/** DRAWN-level report: the graph can be connected while the rendered RIBBON has
 *  a gap, because renderRibbons' jog-dominated sliver suppression deletes an
 *  interior lane. A line is drawn-broken when, walking its traversal, a lane is
 *  suppressed/missing BETWEEN two drawn lanes (an interior hole), or the drawn
 *  lanes form more than one contiguous run. */
export interface DrawnReport {
  /** lineId -> number of contiguous DRAWN runs (1 = contiguous ribbon). */
  runs: Record<string, number>;
  /** lineId -> the edge ids of each suppressed/missing INTERIOR step (the gaps). */
  gaps: Record<string, string[]>;
  /** lineId -> true iff at least one suppressed interior gap is on a splitInternal edge. */
  splitGap: Record<string, boolean>;
}
export interface ContiguityReport {
  afterSplit: LevelReport;
  finalLayout: LevelReport;
  /** Present only when drawSmoothed ran with OCTI_SPLIT_CAPTURE=1. */
  drawn?: DrawnReport;
  splitGroupNodes: string[];
  lineIds: string[];
}

/** Count contiguous drawn runs and locate interior gaps from the captured
 *  post-suppression lane presence (renderOctilinear.__ribbonDrawn). */
function drawnReport(cap: NonNullable<typeof __ribbonDrawn>): DrawnReport {
  const runs: Record<string, number> = {};
  const gaps: Record<string, string[]> = {};
  const splitGap: Record<string, boolean> = {};
  for (const [lineId, steps] of Object.entries(cap.drawn)) {
    if (steps.length === 0) { runs[lineId] = 0; gaps[lineId] = []; splitGap[lineId] = false; continue; }
    // Trim leading/trailing absent steps (a terminus stub is not a GAP; only
    // an absent lane sandwiched between present lanes breaks the ribbon).
    let lo = 0; let hi = steps.length - 1;
    while (lo <= hi && !steps[lo].present) lo++;
    while (hi >= lo && !steps[hi].present) hi--;
    let runCount = steps[lo]?.present ? 1 : 0;
    let prevPresent = lo <= hi ? steps[lo].present : false;
    const lineGaps: string[] = [];
    let lineSplitGap = false;
    for (let i = lo + 1; i <= hi; i++) {
      const s = steps[i];
      if (!s.present) {
        // interior absent lane -> a gap
        lineGaps.push(s.edgeId);
        if (s.splitInternal) lineSplitGap = true;
      }
      if (s.present && !prevPresent) runCount++;
      prevPresent = s.present;
    }
    runs[lineId] = runCount;
    gaps[lineId] = lineGaps;
    splitGap[lineId] = lineSplitGap;
  }
  return { runs, gaps, splitGap };
}

function levelReport(edges: SplitCaptureEdge[]): LevelReport {
  const lineIds = new Set<string>();
  for (const e of edges) for (const l of e.lines) lineIds.add(l);
  const components: Record<string, number> = {};
  const componentNodes: Record<string, string[][]> = {};
  for (const lid of [...lineIds].sort()) {
    const comps = lineComponents(edges, lid);
    components[lid] = comps.length;
    componentNodes[lid] = comps;
  }
  return { components, componentNodes };
}

export function runContiguity(dump: {
  routes: unknown[]; tracks: unknown[]; stations: unknown[]; stationGroups?: unknown[];
  geography?: unknown; water?: WaterCollection;
}): ContiguityReport {
  // precomputeSmoothedSchematic drives the full smoothed layout once and
  // populates renderGeographic.__splitDebug (needs OCTI_SPLIT_CAPTURE=1).
  const pre = precomputeSmoothedSchematic({
    routes: dump.routes as never,
    tracks: dump.tracks as never,
    stations: dump.stations as never,
    stationGroups: dump.stationGroups as never,
    geography: dump.geography as never,
    water: dump.water,
    options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
  });
  if (!__splitDebug) {
    throw new Error('OCTI_SPLIT_CAPTURE=1 not set, or pipeline returned early (CAPTURE_ONLY / empty graph)');
  }
  // DRAWN level: drive the ribbon renderer so its jog-dominated sliver
  // suppression runs and populates renderOctilinear.__ribbonDrawn. The
  // graph-level capture above happens during precompute (before renderRibbons),
  // so it CANNOT see suppression — that is precisely the gap that slipped past.
  let drawn: DrawnReport | undefined;
  if (typeof pre !== 'string') {
    drawSmoothedSchematic(pre, { showStations: true, showLabels: false });
    if (__ribbonDrawn) drawn = drawnReport(__ribbonDrawn);
  }
  const afterSplit = levelReport(__splitDebug.afterSplit.edges);
  const finalLayout = levelReport(__splitDebug.finalLayout.edges);
  const lineIds = [...new Set([...Object.keys(afterSplit.components), ...Object.keys(finalLayout.components)])].sort();
  return { afterSplit, finalLayout, drawn, splitGroupNodes: __splitDebug.afterSplit.splitGroupNodes, lineIds };
}

// ---- CLI -----------------------------------------------------------------
function brokenCount(rep: ContiguityReport, base?: ContiguityReport): {
  afterSplit: number; finalLayout: number; drawn: number; details: string[];
} {
  const details: string[] = [];
  const count = (
    level: 'afterSplit' | 'finalLayout',
  ): number => {
    let n = 0;
    const cur = rep[level].components;
    for (const lid of Object.keys(cur)) {
      // baseline = the flag-off component count if a baseline sidecar is given,
      // else 1 (a healthy line is a single component).
      const expected = base ? base[level].components[lid] ?? 1 : 1;
      if (cur[lid] > expected) {
        n++;
        const comps = rep[level].componentNodes[lid];
        details.push(
          `  [${level}] line ${lid}: ${cur[lid]} components (baseline ${expected}) -> ` +
            comps.map((c) => `{${c.slice(0, 4).join(',')}${c.length > 4 ? ',…' : ''}}`).join('  |  '),
        );
      }
    }
    return n;
  };
  // DRAWN level: a line's rendered ribbon has an interior gap (a suppressed/
  // missing lane between two drawn lanes). This is the level that CATCHES the
  // hub-split bug — the graph stays connected through the spine EDGE but the
  // spine LANE was suppressed, so the drawn ribbon broke.
  //
  // The DRAWN break this gate fails on is precise and unambiguous: an interior
  // gap on a SPLIT-INTERNAL edge. That means a through-line lost the ONLY drawn
  // segment carrying it across the split (the + and - bundles are too far apart
  // for the node-connector bridge to close the gap), so the rendered ribbon is
  // visibly discontinuous even though the graph stays connected through the
  // spine edge. A healthy split has 0 of these.
  //
  // NOTE on the noisy `runs` metric: many lines render as several contiguous
  // drawn runs even flag-OFF, because the jog-dominated sliver suppression
  // intentionally drops short retrace/spur lanes that the node connectors then
  // bridge — a suppressed NON-split lane is NOT a visible gap. So a raw run
  // count is not a contiguity signal; only a suppressed SPLIT-INTERNAL lane is.
  // `runs`/`gaps` stay in the report (and details, with --verbose) for triage.
  const verbose = process.argv.includes('--verbose');
  const countDrawn = (): number => {
    let n = 0;
    if (!rep.drawn) return 0;
    for (const lid of Object.keys(rep.drawn.runs)) {
      const split = rep.drawn.splitGap[lid] === true;
      if (split) {
        n++;
        const g = rep.drawn.gaps[lid] ?? [];
        details.push(
          `  [drawn] line ${lid}: ${rep.drawn.runs[lid]} drawn runs SPLIT-INTERNAL gap(s) -> {${g.slice(0, 4).join(',')}${g.length > 4 ? ',…' : ''}}`,
        );
      } else if (verbose && rep.drawn.runs[lid] > 1) {
        details.push(
          `  [drawn] line ${lid}: ${rep.drawn.runs[lid]} drawn runs (non-split suppressed slivers, bridged by connectors)`,
        );
      }
    }
    return n;
  };
  return { afterSplit: count('afterSplit'), finalLayout: count('finalLayout'), drawn: countDrawn(), details };
}

function main(): void {
  const args = process.argv.slice(2);
  const dumpPath = args.find((a) => !a.startsWith('--')) ?? '';
  const outArg = args.indexOf('--out');
  const baseArg = args.indexOf('--baseline');
  const outPath = outArg >= 0 ? args[outArg + 1] : undefined;
  const basePath = baseArg >= 0 ? args[baseArg + 1] : undefined;
  if (!dumpPath) { console.error('usage: tsx dev/check-contiguity.ts <dump.json> [--out f] [--baseline f]'); process.exit(1); }

  const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
  const dump = raw['debug-render-input'] ?? raw;
  let water: WaterCollection | undefined;
  if (existsSync('sea_water.geojson')) {
    water = keepLargestWaterBodies(JSON.parse(readFileSync('sea_water.geojson', 'utf-8')), { minFracOfLargest: 0.01 });
  }
  const flagOn = process.env.OCTI_SPLIT_HUBS === '1';
  const cap = process.env.OCTI_SPLIT_MAXHUBS;
  console.log(`contiguity: ${dumpPath} | OCTI_SPLIT_HUBS=${flagOn ? 1 : 0} OCTI_SPLIT_MAXHUBS=${cap ?? '(default 1)'} OCTI_WARP=${process.env.OCTI_WARP ?? '(unset)'}`);

  const rep = runContiguity({ ...dump, water });

  const base: ContiguityReport | undefined =
    basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf-8')) : undefined;
  const broken = brokenCount(rep, base);
  console.log(`lines=${rep.lineIds.length} splitGroupNodes=${rep.splitGroupNodes.length}`);
  console.log(`BROKEN afterSplit=${broken.afterSplit}  finalLayout=${broken.finalLayout}  drawn=${rep.drawn ? broken.drawn : 'n/a'}` + (base ? ` (vs baseline ${basePath})` : ' (vs expected=1)'));
  for (const d of broken.details.slice(0, 60)) console.log(d);
  if (broken.details.length > 60) console.log(`  …and ${broken.details.length - 60} more`);

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(rep));
    console.log(`wrote ${outPath}`);
  }

  // Regression gate: with --assert, ANY broken line (graph component count above
  // the baseline / above 1, OR a DRAWN interior gap) fails the process so this is
  // wireable into CI. A healthy hub-split keeps every subway line contiguous both
  // at the graph level AND in the rendered ribbon => 0 broken at every level.
  if (args.includes('--assert')) {
    const total = broken.afterSplit + broken.finalLayout + broken.drawn;
    if (total > 0) {
      console.error(`CONTIGUITY REGRESSION: ${total} broken (afterSplit=${broken.afterSplit} finalLayout=${broken.finalLayout} drawn=${broken.drawn})`);
      process.exit(1);
    }
    console.log('CONTIGUITY OK: 0 broken lines (graph + drawn).');
  }
}

// run as CLI unless imported (entry file path ends with this module's name)
if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('check-contiguity.ts')) main();
