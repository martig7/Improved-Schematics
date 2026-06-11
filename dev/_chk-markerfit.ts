// Gate: every stop dot (and its ring) must sit fully inside its station's
// capsule hull (stadium line / mega rect). Reports markers whose dots poke
// out — the "capsule doesn't fit its labels" class.
// Usage: npx tsx dev/_chk-markerfit.ts [render.svg]
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dev/_dumpnyc.svg';
const svg = readFileSync(file, 'utf-8');

const re = /<g class="imp-stop" data-ax="([\d.-]+)" data-ay="([\d.-]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
let checked = 0;
let bad = 0;
while ((m = re.exec(svg))) {
  const inner = m[3];
  const dots = [...inner.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)"[^>]*stroke-width="([\d.-]+)"[^>]*data-line/g)]
    .map((c) => ({ x: +c[1], y: +c[2], out: +c[3] + +c[4] / 2 }));
  if (dots.length === 0) continue;

  const rect = inner.match(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/);
  const lines = [...inner.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)" stroke="[^"]*" stroke-width="([\d.-]+)"/g)];
  const station = (inner.match(/data-station-id="([^"]+)"/) ?? [])[1] ?? '?';

  let worst = 0;
  if (rect) {
    const x0 = +rect[1], y0 = +rect[2], x1 = x0 + +rect[3], y1 = y0 + +rect[4];
    for (const d of dots) {
      worst = Math.max(
        worst,
        x0 + d.out - d.x, d.x - (x1 - d.out),
        y0 + d.out - d.y, d.y - (y1 - d.out),
      );
    }
  } else if (lines.length > 0) {
    // widest line = border stadium
    const b = lines.reduce((p, q) => (+p[5] >= +q[5] ? p : q));
    const ax = +b[1], ay = +b[2], bx = +b[3], by = +b[4], half = +b[5] / 2;
    const distToSeg = (px: number, py: number): number => {
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
      return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
    };
    for (const d of dots) worst = Math.max(worst, distToSeg(d.x, d.y) + d.out - half);
  } else {
    continue; // bare dot, nothing to fit
  }
  checked++;
  if (worst > 0.05) {
    bad++;
    console.log(`OVERFLOW ${worst.toFixed(2)}px at (${m[1]},${m[2]}) station=${station} dots=${dots.length}`);
  }
  // stacked bullets: dot centers closer than ~a dot diameter
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const d = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y);
      const min = dots[i].out + dots[j].out - 1.5 - 1.6; // ring overlap ok, glyphs must not collide
      if (d < min) {
        bad++;
        console.log(`STACKED ${d.toFixed(2)}px apart at (${m[1]},${m[2]}) station=${station}`);
      }
    }
  }
}
console.log(`${checked} capsules checked, ${bad} bad (overflow/stacked)`);
