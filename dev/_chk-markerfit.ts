// Gate: every stop dot (and its ring) must sit fully inside its station's
// capsule hull (stadium line / mega rect). Reports markers whose dots poke
// out — the "capsule doesn't fit its labels" class.
// Usage: npx tsx dev/_chk-markerfit.ts [render.svg]
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dev/_dumpnyc.svg';
const svg = readFileSync(file, 'utf-8');

// spine-capsule markers: ONE <path d="M x y L x y ..."> per marker, stroked
// twice (border 2r+6, fill 2r+3). Parse each path into stadium segments with
// half = stroke-width/2 — same containment arithmetic as the old <line> hulls.
const pathSegs = (innerSvg: string) => {
  const segs: Array<{ a: [number, number]; b: [number, number]; half: number }> = [];
  for (const pm of innerSvg.matchAll(/<path d="M ([-\d. L]+)"[^>]*stroke-width="([\d.-]+)"/g)) {
    const nums = pm[1].split(/[ L]+/).filter((x) => x.length).map(Number);
    const half = +pm[2] / 2;
    if (nums.length === 2) segs.push({ a: [nums[0], nums[1]], b: [nums[0], nums[1]], half });
    for (let i = 3; i < nums.length; i += 2) {
      segs.push({ a: [nums[i - 3], nums[i - 2]], b: [nums[i - 1], nums[i]], half });
    }
  }
  return segs;
};

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
  const lineSegs = lines.map((b) => ({ a: [+b[1], +b[2]] as [number, number], b: [+b[3], +b[4]] as [number, number], half: +b[5] / 2 }));
  const allSegs = [...lineSegs, ...pathSegs(inner)];
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
  } else if (allSegs.length > 0) {
    // multi-angle capsules: a dot fits if it sits inside ANY of the
    // marker's stadium segments (each line/path segment, own half-width)
    for (const d of dots) {
      let bestOver = Infinity;
      for (const sg of allSegs) {
        const ax = sg.a[0], ay = sg.a[1], bx = sg.b[0], by = sg.b[1], half = sg.half;
        const vx = bx - ax, vy = by - ay;
        const len2 = vx * vx + vy * vy;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((d.x - ax) * vx + (d.y - ay) * vy) / len2)) : 0;
        const dist = Math.hypot(d.x - (ax + vx * t), d.y - (ay + vy * t));
        bestOver = Math.min(bestOver, dist + d.out - half);
      }
      worst = Math.max(worst, bestOver);
    }
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

// ---- station-vs-station marker overlap ------------------------------------
{
  const svg2 = readFileSync(file, 'utf-8');
  const re2 = /<g class="imp-stop" data-ax="([\d.-]+)" data-ay="([\d.-]+)">(.*?)<\/g>/g;
  interface Hull { ax: number; ay: number; lines: Array<{ a: [number, number]; b: [number, number]; half: number }>; dots: Array<{ x: number; y: number; r: number }> }
  const hulls: Hull[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = re2.exec(svg2))) {
    const inner = mm[3];
    const lines = [
      ...[...inner.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)" stroke="[^"]*" stroke-width="([\d.-]+)"/g)]
        .map((l) => ({ a: [+l[1], +l[2]] as [number, number], b: [+l[3], +l[4]] as [number, number], half: +l[5] / 2 })),
      ...pathSegs(inner),
    ];
    const dots = [...inner.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)"/g)]
      .map((c) => ({ x: +c[1], y: +c[2], r: +c[3] + 0.75 }));
    hulls.push({ ax: +mm[1], ay: +mm[2], lines, dots });
  }
  const segDist = (p1: [number, number], q1: [number, number], p2: [number, number], q2: [number, number]): number => {
    const ptSeg = (p: [number, number], a: [number, number], b: [number, number]): number => {
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const l2 = vx * vx + vy * vy;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
      return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
    };
    return Math.min(ptSeg(p1, p2, q2), ptSeg(q1, p2, q2), ptSeg(p2, p1, q1), ptSeg(q2, p1, q1));
  };
  let overlaps = 0;
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const A = hulls[i], B = hulls[j];
      if (Math.abs(A.ax - B.ax) > 80 || Math.abs(A.ay - B.ay) > 80) continue;
      let pen = 0;
      for (const la of A.lines.length ? A.lines : A.dots.map((d) => ({ a: [d.x, d.y] as [number, number], b: [d.x, d.y] as [number, number], half: d.r }))) {
        for (const lb of B.lines.length ? B.lines : B.dots.map((d) => ({ a: [d.x, d.y] as [number, number], b: [d.x, d.y] as [number, number], half: d.r }))) {
          pen = Math.max(pen, la.half + lb.half - segDist(la.a, la.b, lb.a, lb.b));
        }
      }
      if (pen > 0.5) {
        overlaps++;
        console.log(`MARKER OVERLAP ${pen.toFixed(1)}px: (${A.ax},${A.ay}) vs (${B.ax},${B.ay})`);
      }
    }
  }
  console.log(`${overlaps} station-vs-station marker overlaps`);
}
