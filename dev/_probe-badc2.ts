// Probe v2: find the 22 St marker (contains B+A+D+C dots), dump dot
// positions and each line's lane points within 25px of the dots.
import { readFileSync } from 'fs';

const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const idOf = new Map<string, string>();
for (const r of d.routes) if (!r.tempParentId) idOf.set(r.bullet, r.id);
const bulletOf = new Map<string, string>();
for (const [b, id] of idOf) bulletOf.set(id, b);

const svg = readFileSync('dev/_dumpnyc.svg', 'utf-8');
const need = ['B', 'A', 'D', 'C'].map((b) => idOf.get(b)!);

const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const inner = m[3];
  const dots = [...inner.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*data-line="([^"]+)"/g)];
  const ids = new Set(dots.map((c) => c[3]));
  if (!need.every((id) => ids.has(id))) continue;
  if (dots.length < 8) continue; // the central 22 St junction marker
  console.log(`22 St marker @ (${m[1]},${m[2]}):`);
  const ds: Array<{ b: string; x: number; y: number }> = [];
  for (const c of dots) {
    const b = bulletOf.get(c[3]) ?? c[3].slice(0, 6);
    ds.push({ b, x: +c[1], y: +c[2] });
    console.log(`  dot ${b} at (${(+c[1]).toFixed(1)}, ${(+c[2]).toFixed(1)})`);
  }
  // lane points near the BADC dots
  for (const b of ['B', 'A', 'D', 'C']) {
    const dot = ds.find((q) => q.b === b)!;
    const pm = svg.match(new RegExp(`<path[^>]*data-line-id="${idOf.get(b)}"[^>]*>`));
    const dd = pm?.[0].match(/ d="([^"]+)"/)?.[1] ?? '';
    const nums = dd.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    const pts: string[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (Math.hypot(x - dot.x, y - dot.y) < 22) pts.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
    }
    console.log(`  ${b} lane pts within 22px of its dot: ${pts.slice(0, 8).join(' ')}`);
  }
  break;
}
