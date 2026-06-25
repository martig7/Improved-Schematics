/**
 * Inspect a saved-map export JSON (the "Save map" file — a MapBundle with an
 * `inputDump` of the live routes/tracks/stations/groups). Prints a readable summary
 * of the bundle and the network, and — the reason this exists — groups the ROUTES by
 * (bullet, colour) so you can see which separate routes the renderer now collapses into
 * one line (e.g. the clockwise + counter-clockwise directions of a loop).
 *
 * Usage: npx tsx dev/parse-export.ts <export.json>
 *   e.g. npx tsx dev/parse-export.ts improvedschematics-map-DAL.json
 *
 * Reads only the file; no rendering. Pairs with dev/render-from-dump.ts (which renders
 * the same inputDump) — this one is the quick "what's in here / why two ribbons?" check.
 */
import { readFileSync } from 'fs';
import { getOrBuildStationGroups, buildTransitGraph } from '../src/render/layout/graph';
import type { Station, Route as GRoute, Track } from '../src/types/game-state';

const path = process.argv[2];
if (!path) {
  console.error('usage: npx tsx dev/parse-export.ts <export.json>');
  process.exit(1);
}

type Route = { id?: string; bullet?: string; color?: string; tempParentId?: string | null; stCombos?: unknown[]; stNodes?: unknown[] };
type Dump = {
  at?: string;
  routes?: Route[];
  tracks?: unknown[];
  stations?: unknown[];
  stationGroups?: unknown[];
  geography?: { water?: unknown[]; green?: unknown[] };
  options?: Record<string, unknown>;
};
type Bundle = {
  version?: number;
  city?: string;
  fp?: string;
  settings?: Record<string, unknown>;
  selections?: unknown[];
  modeSettings?: Record<string, unknown>;
  inputDump?: Dump;
};

const raw = JSON.parse(readFileSync(path, 'utf-8')) as Bundle & Dump;
// Accept either a full saved-map bundle or a bare input dump.
const bundle: Bundle = raw.inputDump ? raw : { inputDump: raw as Dump };
const dump: Dump = bundle.inputDump ?? {};
const routes = (dump.routes ?? []).filter((r) => !r.tempParentId);

const short = (id: string | undefined) => (id ?? '').slice(0, 8);
const normColor = (c: string | undefined) => (!c ? '#888888' : c.startsWith('#') ? c : '#' + c).toLowerCase();
const collapseKey = (r: Route) => {
  const label = String(r.bullet ?? '').trim();
  return label ? label + ' ' + normColor(r.color) : null; // blank bullet → never collapses
};

console.log('── ' + path);
console.log(`city=${bundle.city ?? '?'}  version=${bundle.version ?? '?'}  fp=${bundle.fp ?? '(none)'}  dumpedAt=${dump.at ?? '?'}`);
console.log(
  `network: routes=${routes.length} (raw ${dump.routes?.length ?? 0})  tracks=${dump.tracks?.length ?? 0}  ` +
    `stations=${dump.stations?.length ?? 0}  groups=${dump.stationGroups?.length ?? 0}  ` +
    `water=${dump.geography?.water?.length ?? 0}  green=${dump.geography?.green?.length ?? 0}`,
);
if (bundle.selections) console.log(`detail areas (selections): ${bundle.selections.length}`);

console.log('\nroutes (active, tempParentId=null):');
for (const r of routes) {
  console.log(
    `  ${short(r.id).padEnd(8)}  bullet=${JSON.stringify(r.bullet ?? '').padEnd(6)}  ` +
      `color=${normColor(r.color).padEnd(9)}  combos=${(r.stCombos?.length ?? 0)}  stNodes=${(r.stNodes?.length ?? 0)}`,
  );
}

// Routes sharing a (bullet, colour) are collapse CANDIDATES — but the renderer only collapses
// true LOOP directions (same undirected edge set); a BRANCH (shared trunk, divergent terminals)
// stays as separate lines. Run the real graph builder for the authoritative verdict.
const byKey = new Map<string, Route[]>();
for (const r of routes) {
  const k = collapseKey(r);
  if (!k) continue;
  (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
}
const shared = [...byKey.entries()].filter(([, rs]) => rs.length > 1);
console.log('\nshared (bullet, colour) groups — loop (collapses) vs branch (stays separate):');
if (shared.length === 0) {
  console.log('  (none — every active route already has a unique name+colour)');
} else if (!dump.stations || !dump.routes) {
  console.log('  (no inputDump network — cannot resolve the graph)');
} else {
  const groups = getOrBuildStationGroups(dump.stations as Station[], dump.stationGroups as never);
  const graph = buildTransitGraph(dump.stations as Station[], dump.routes as GRoute[], groups, dump.tracks as Track[]);
  const lineIds = new Set<string>();
  for (const e of graph.edges) for (const l of e.lines) lineIds.add(l.id);
  for (const [k, rs] of shared) {
    const distinct = rs.filter((r) => r.id && lineIds.has(r.id)).length; // resulting line count for this group
    const verdict = distinct <= 1 ? 'LOOP → 1 line (collapsed)' : `BRANCH → ${distinct} lines (kept separate)`;
    console.log(`  "${k}"  ×${rs.length}  ⇒ ${verdict}  [${rs.map((r) => short(r.id)).join(', ')}]`);
  }
  // Invariant: no line may carry an edge that's absent from its traversal (the branch-drop bug).
  let orphans = 0;
  for (const e of graph.edges) for (const l of e.lines) { const t = graph.lineTraversals.get(l.id); if (t && !t.some((s) => s.edgeId === e.id)) orphans++; }
  console.log(`  total active routes → ${lineIds.size} lines.  orphan edges (must be 0): ${orphans}`);
}
