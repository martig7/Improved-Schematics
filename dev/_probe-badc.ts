// Probe: 22 St BADC capsule seating — dot positions vs their lines' actual
// lane positions at the marker's height.
import { readFileSync } from 'fs';

const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const idOf = new Map<string, string>();
for (const r of d.routes) if (!r.tempParentId) idOf.set(r.bullet, r.id);

const svg = readFileSync('dev/_dumpnyc.svg', 'utf-8');

// find the marker containing exactly B,A,D,C in its data-stops near (1560,1350)
const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const ax = +m[1];
  const ay = +m[2];
  if (Math.abs(ax - 1565) > 60 || Math.abs(ay - 1370) > 60) continue;
  const inner = m[3];
  const dots = [...inner.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*data-line="([^"]+)"/g)];
  if (dots.length === 0) continue;
  console.log(`marker @ (${ax},${ay}):`);
  for (const c of dots) {
    const bullet = [...idOf.entries()].find(([, id]) => id === c[3])?.[0] ?? c[3].slice(0, 8);
    console.log(`  dot ${bullet} at (${(+c[1]).toFixed(1)}, ${(+c[2]).toFixed(1)})`);
  }
}

// lane positions: for each of B,A,D,C find path points with y in [1340,1365]
for (const bullet of ['B', 'A', 'D', 'C']) {
  const id = idOf.get(bullet)!;
  const pm = svg.match(new RegExp(`<path[^>]*data-line-id="${id}"[^>]*>`));
  if (!pm) continue;
  const dd = pm[0].match(/ d="([^"]+)"/)?.[1] ?? '';
  const nums = dd.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
  const pts: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    if (y > 1340 && y < 1372 && x > 1500 && x < 1650) pts.push(`(${x.toFixed(0)},${y.toFixed(0)})`);
  }
  console.log(`${bullet} lane pts near marker: ${pts.slice(0, 10).join(' ')}`);
}
