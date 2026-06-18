/** Dump the number-stripped SVG element multiset (the ulpRun 'skel' fingerprint
 *  ingredients) so baseline vs SORT_PERTURB can be diffed to see WHICH structural
 *  elements diverge. Run twice (with/without SORT_PERTURB=1) and diff the output.
 *  Must be imported AFTER the SORT_PERTURB patch — same pattern as ulpRun.ts. */
import { readFileSync } from 'fs';
if (process.env.SORT_PERTURB) {
  const origSort = Array.prototype.sort;
  // eslint-disable-next-line no-extend-native
  Array.prototype.sort = function (this: unknown[], cmp?: (a: unknown, b: unknown) => number) {
    this.reverse();
    return origSort.call(this, cmp as never);
  } as typeof Array.prototype.sort;
}
(async () => {
  const { generateSchematicSVG } = await import('../src/render/schematic');
  const raw = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
  const dump = raw['debug-render-input'] ?? raw;
  const svg = generateSchematicSVG({
    routes: dump.routes, tracks: dump.tracks, stations: dump.stations, stationGroups: dump.stationGroups,
    geography: dump.geography,
    options: { mode: 'smoothed', width: 2700, height: 2700, showStations: true, showLabels: false },
  });
  const elems = svg.replace(/-?[0-9]*\.?[0-9]+(e-?[0-9]+)?/gi, '#').split('>');
  const counts = new Map<string, number>();
  for (const e of elems) counts.set(e, (counts.get(e) ?? 0) + 1);
  for (const [k, v] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) console.log(v + '\t' + k);
})();
