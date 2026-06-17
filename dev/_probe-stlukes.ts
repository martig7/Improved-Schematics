// Probe: St Lukes Pl marker (F,G,H,E + 6,7) — dump dot positions and each
// line's lane points near the dots, plus distance from dot to its lane.
import { readFileSync } from 'fs';

const d = JSON.parse(readFileSync('improvedschematics-input-nyc.json', 'utf-8'));
const idOf = new Map<string, string>();
for (const r of d.routes) if (!r.tempParentId) idOf.set(r.bullet, r.id);
const bulletOf = new Map<string, string>();
for (const [b, id] of idOf) bulletOf.set(id, b);

const svg = readFileSync('dev/_dumpnyc.svg', 'utf-8');
const need = ['F', 'G', 'H', 'E'].map((b) => idOf.get(b)!);

const ptSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
};

const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const inner = m[3];
  const dots = [...inner.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*data-line="([^"]+)"/g)];
  const ids = new Set(dots.map((c) => c[3]));
  if (!need.every((id) => ids.has(id))) continue;
  if (Math.abs(+m[2] - 1545) > 40 || Math.abs(+m[1] - 878) > 40) continue; // St Lukes Pl label at (878.4,1544.8)
  console.log(`St Lukes marker @ (${m[1]},${m[2]}):`);
  for (const c of dots) {
    const b = bulletOf.get(c[3]) ?? c[3].slice(0, 6);
    const x = +c[1], y = +c[2];
    // nearest distance from the dot to ANY path of its line
    let bestD = Infinity;
    let bestNear: string[] = [];
    for (const pm of svg.matchAll(new RegExp(`<path[^>]*data-line-id="${c[3]}"[^>]*/?>`, 'g'))) {
      const dd = pm[0].match(/ d="([^"]+)"/)?.[1] ?? '';
      const nums = dd.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
      const pts: Array<[number, number]> = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
      for (let i = 0; i + 1 < pts.length; i++) {
        const dist = ptSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (dist < bestD) bestD = dist;
      }
      for (const p of pts) {
        if (Math.hypot(p[0] - x, p[1] - y) < 25) bestNear.push(`(${p[0].toFixed(1)},${p[1].toFixed(1)})`);
      }
    }
    console.log(
      `  dot ${b} at (${x.toFixed(1)},${y.toFixed(1)})  dist-to-lane=${bestD.toFixed(1)}px` +
      (bestNear.length ? `  lane pts near: ${bestNear.slice(0, 6).join(' ')}` : ''),
    );
  }
  break;
}
