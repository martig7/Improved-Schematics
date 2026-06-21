/**
 * Octi performance benchmark. Loads the NYC input dump and times the heavy
 * smoothed precompute (which is dominated by the octi() pass). Prints octi's
 * own self-reported timing via OCTI_DEBUG plus a wall-clock total.
 *
 * Usage: tsx dev/_bench-octi.ts [dump.json] [runs]
 *   OCTI_DEBUG=1 is forced on so octi logs its sweep timing.
 */
import { readFileSync } from 'fs';
import { precomputeSmoothed } from '../src/render/renderGeographic';

const dumpPath = process.argv[2] ?? 'improvedschematics-input-nyc.json';
const runs = Number(process.argv[3] ?? 1);

const raw = JSON.parse(readFileSync(dumpPath, 'utf-8'));
const dump = raw['debug-render-input'] ?? raw;
const { routes, tracks, stations, stationGroups } = dump;
console.error(
  `dump: routes=${routes?.length} tracks=${tracks?.length} ` +
    `stations=${stations?.length} groups=${stationGroups?.length ?? 'none'}`,
);

const input = {
  routes,
  tracks,
  stations,
  stationGroups,
  smooth: true as const,
  options: { mode: 'smoothed' as const, width: 2700, height: 2700, showStations: true, showLabels: false },
};

// Deterministic checksum of the layout (node placements + edge path geometry)
// so an optimization can be proven output-identical, not just faster.
function checksum(res: unknown): string {
  if (typeof res === 'string') return `str:${res.length}`;
  const r = res as {
    nodePx: Map<string, [number, number]>;
    layout: { edges: { id: string; path: [number, number][]; lineOrder?: string[] }[] };
  };
  const nodes = [...r.nodePx.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, p]) => `${id}:${p[0].toFixed(3)},${p[1].toFixed(3)}`)
    .join('|');
  const edges = [...r.layout.edges]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => `${e.id}:${(e.lineOrder ?? []).join(',')}:${e.path.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(';')}`)
    .join('|');
  // FNV-1a over the serialized layout
  let h = 0x811c9dc5;
  const s = nodes + '#' + edges;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `len=${s.length} fnv=${(h >>> 0).toString(16)}`;
}

const times: number[] = [];
let sig = '';
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const res = precomputeSmoothed(input as never);
  const dt = performance.now() - t0;
  times.push(dt);
  sig = checksum(res);
  const kind = typeof res === 'string' ? 'string' : `layout(edges=${(res as { layout: { edges: unknown[] } }).layout.edges.length})`;
  console.error(`run ${i + 1}/${runs}: ${dt.toFixed(0)}ms  -> ${kind}`);
}
console.error(`checksum: ${sig}`);
times.sort((a, b) => a - b);
const median = times[times.length >> 1];
const min = times[0];
console.error(`\nprecomputeSmoothed: min=${min.toFixed(0)}ms median=${median.toFixed(0)}ms (n=${runs})`);
