/**
 * Cross-V8 determinism probe. Runs the smoothed schematic pipeline once and
 * prints a DISCRETE fingerprint (node→grid-cell map + per-edge lane orders +
 * number-stripped SVG skeleton, each sha256'd). When ULP_MODE is set, the
 * non-correctly-rounded Math functions (hypot/atan2/trig/log/exp/pow/…) are
 * monkeypatched BEFORE the pipeline imports to nudge their result by ±1 ULP —
 * a faithful proxy for "the same code on the game's V8/Chromium libm rounds
 * these a hair differently". Math.sqrt/round/floor/… and the constants
 * PI/SQRT1_2/SQRT2 are NEVER patched (those are correctly-rounded / exact).
 *
 * Usage: ULP_MODE=<''|plus|minus|parity|seeded> npx tsx dev/ulpRun.ts [dump.json]
 * Output: one JSON line {mode, hash, cell, lane, skel} on stdout.
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const MODE = process.env.ULP_MODE ?? '';
const dumpPath = process.argv[2] ?? 'improvedschematics-input-dump-current-seattle.json';

// ---- 1-ULP nudges via raw bit manipulation (exact, engine-independent) ----
const _buf = new DataView(new ArrayBuffer(8));
function nextUp(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return Number.MIN_VALUE;
  _buf.setFloat64(0, x);
  let bits = _buf.getBigUint64(0);
  bits += x > 0 ? 1n : -1n;
  _buf.setBigUint64(0, bits);
  return _buf.getFloat64(0);
}
function nextDown(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return -Number.MIN_VALUE;
  _buf.setFloat64(0, x);
  let bits = _buf.getBigUint64(0);
  bits += x > 0 ? -1n : 1n;
  _buf.setBigUint64(0, bits);
  return _buf.getFloat64(0);
}

if (MODE) {
  let n = 0;
  let lcg = 0x2545f4914f6cdd1d >>> 0;
  const rndSign = () => { lcg = (lcg * 1103515245 + 12345) >>> 0; return (lcg & 0x10000) ? 1 : -1; };
  const N = Math.max(1, +(process.env.ULP_N ?? 1)); // # of ULPs to nudge (stress margin)
  const up = (x: number) => { let v = x; for (let i = 0; i < N; i++) v = nextUp(v); return v; };
  const down = (x: number) => { let v = x; for (let i = 0; i < N; i++) v = nextDown(v); return v; };
  const nudge = (x: number): number => {
    if (!Number.isFinite(x) || x === 0) return x;
    n++;
    if (MODE === 'plus') return up(x);
    if (MODE === 'minus') return down(x);
    if (MODE === 'parity') return (n & 1) ? up(x) : down(x);
    if (MODE === 'seeded') return rndSign() > 0 ? up(x) : down(x);
    return x;
  };
  const fns = ['hypot', 'atan2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'log', 'log2', 'log10', 'exp', 'expm1', 'pow', 'cbrt', 'sinh', 'cosh'] as const;
  for (const f of fns) {
    const orig = (Math as unknown as Record<string, (...a: number[]) => number>)[f];
    (Math as unknown as Record<string, (...a: number[]) => number>)[f] = (...a: number[]) => nudge(orig(...a));
  }
}

// Simulate a DIFFERENT sort tie order (e.g. a V8 build with unstable sort, or
// just different internals): reverse before a stable sort so equal-key runs
// come out reversed. If the fingerprint changes under this, some sort lacks a
// total tie-break and is a real cross-engine divergence source the ULP modes
// (running on Node's stable sort) cannot detect.
if (process.env.SORT_PERTURB) {
  const onlyFile = process.env.SORT_FILE; // optional: only perturb sorts called from this file (bisect)
  const origSort = Array.prototype.sort;
  // eslint-disable-next-line no-extend-native
  Array.prototype.sort = function (this: unknown[], cmp?: (a: unknown, b: unknown) => number) {
    if (!onlyFile || (new Error().stack ?? '').includes(onlyFile)) this.reverse();
    return origSort.call(this, cmp as never);
  } as typeof Array.prototype.sort;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

(async () => {
  // dynamic import AFTER patching so module-load Math (constants.ts OCT_UNIT) is perturbed
  const { generateSchematicSVG, precomputeSmoothedSchematic } = await import('../src/render/schematic');
  const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
  const dump = raw['debug-render-input'] ?? raw;
  let { routes, tracks, stations, stationGroups } = dump;
  // Perturb the INPUT ARRAY ORDER (a proxy for the game iterating its live data
  // in a different order than the dump's serialized order). If the fingerprint
  // changes, the layout depends on input order — a real cross-source divergence.
  if (process.env.INPUT_PERTURB) {
    routes = [...routes].reverse();
    tracks = [...tracks].reverse();
    stations = [...stations].reverse();
    stationGroups = stationGroups ? [...stationGroups].reverse() : stationGroups;
  }
  // Proposed FIX: canonicalize input order by id (simulates what the pipeline
  // would do). If this makes INPUT_PERTURB a no-op, sorting by id is the fix.
  if (process.env.INPUT_SORT) {
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    routes = [...routes].sort(byId);
    tracks = [...tracks].sort(byId);
    stations = [...stations].sort(byId);
    stationGroups = stationGroups ? [...stationGroups].sort(byId) : stationGroups;
  }
  const input = {
    routes, tracks, stations, stationGroups,
    geography: dump.geography, // projection bounds — must match the game's input
    options: { mode: 'smoothed' as const, width: 2700, height: 2700, showStations: true, showLabels: false },
  };
  const pre = precomputeSmoothedSchematic(input);
  if (typeof pre === 'string') { console.log(JSON.stringify({ mode: MODE, hash: 'DEGENERATE' })); return; }

  const cellMap = [...pre.layout.nodes.values()]
    .map((nd) => `${nd.id}:${nd.cell[0]},${nd.cell[1]}`).sort().join('\n');
  const laneOrders = pre.layout.edges
    .map((e) => `${e.id}|${e.lineOrder.join(',')}`).sort().join('\n');
  const svg = generateSchematicSVG(input);
  const skel = svg
    .replace(/-?[0-9]*\.?[0-9]+(e-?[0-9]+)?/gi, '#')
    .split('>').sort().join('>');

  const cell = sha(cellMap), lane = sha(laneOrders), skelH = sha(skel);
  const hash = sha(cell + '\n##\n' + lane + '\n##\n' + skelH);
  console.log(JSON.stringify({ mode: MODE || 'baseline', hash, cell, lane, skel: skelH }));
})();
