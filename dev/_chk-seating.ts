// Gate: dot-vs-lane seating error across ALL station markers in an SVG dump.
// For every imp-stop dot, distance from dot center to the nearest path of its
// line (data-line vs data-line-id). Reports count of dots >2px off and the
// worst offenders. Usage: npx tsx dev/_chk-seating.ts <dump.svg> [top]
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dev/_dumpnyc.svg';
const top = +(process.argv[3] ?? 10);
const svg = readFileSync(file, 'utf-8');

// lane polylines per line id — Q/C commands are SAMPLED (16 steps), not read
// as control-point vertices: a dot exactly ON a join curve's midpoint reads
// ~2px off the control polygon otherwise (false failure)
const lanes = new Map<string, Array<Array<[number, number]>>>();
for (const pm of svg.matchAll(/<path[^>]*data-line-id="([^"]+)"[^>]*>/g)) {
  const dd = pm[0].match(/ d="([^"]+)"/)?.[1] ?? '';
  const toks = dd.match(/[MLQC]|-?\d+\.?\d*/g) ?? [];
  const polys: Array<Array<[number, number]>> = [];
  let pts: Array<[number, number]> = [];
  const flush = () => { if (pts.length > 1) polys.push(pts); pts = []; };
  for (let i = 0; i < toks.length; ) {
    if (toks[i] === 'M') { flush(); pts = [[+toks[i + 1], +toks[i + 2]]]; i += 3; }
    else if (toks[i] === 'L') { pts.push([+toks[i + 1], +toks[i + 2]]); i += 3; }
    else if (toks[i] === 'Q') {
      const p0 = pts[pts.length - 1] ?? [+toks[i + 1], +toks[i + 2]];
      const c: [number, number] = [+toks[i + 1], +toks[i + 2]];
      const p1: [number, number] = [+toks[i + 3], +toks[i + 4]];
      for (let k = 1; k <= 16; k++) {
        const u = k / 16;
        pts.push([
          (1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0],
          (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1],
        ]);
      }
      i += 5;
    } else if (toks[i] === 'C') {
      const p0 = pts[pts.length - 1] ?? [+toks[i + 1], +toks[i + 2]];
      const c1: [number, number] = [+toks[i + 1], +toks[i + 2]];
      const c2: [number, number] = [+toks[i + 3], +toks[i + 4]];
      const p1: [number, number] = [+toks[i + 5], +toks[i + 6]];
      for (let k = 1; k <= 16; k++) {
        const u = k / 16, v = 1 - u;
        pts.push([
          v * v * v * p0[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * p1[0],
          v * v * v * p0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * p1[1],
        ]);
      }
      i += 7;
    } else { // bare pair without command (continuation): treat as L
      pts.push([+toks[i], +toks[i + 1]]); i += 2;
    }
  }
  flush();
  if (polys.length === 0) continue;
  let arr = lanes.get(pm[1]);
  if (!arr) { arr = []; lanes.set(pm[1], arr); }
  arr.push(...polys);
}

const ptSeg = (px: number, py: number, a: [number, number], b: [number, number]) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + dx * u), py - (a[1] + dy * u));
};

let dots = 0;
let off2 = 0;
let sum = 0;
const worst: Array<{ d: number; x: number; y: number; id: string }> = [];
for (const m of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*data-line="([^"]+)"/g)) {
  const x = +m[1], y = +m[2], id = m[3];
  const polys = lanes.get(id);
  if (!polys) continue;
  let best = Infinity;
  for (const pts of polys) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = ptSeg(x, y, pts[i], pts[i + 1]);
      if (d < best) best = d;
      if (best < 0.05) break;
    }
    if (best < 0.05) break;
  }
  dots++;
  sum += best;
  if (best > 2) off2++;
  if (best > 1) worst.push({ d: best, x, y, id });
}
worst.sort((a, b) => b.d - a.d);
console.log(`${file}: ${dots} dots, mean err ${(sum / dots).toFixed(2)}px, ${off2} dots >2px off-lane`);
for (const w of worst.slice(0, top)) {
  console.log(`  ${w.d.toFixed(1)}px @ (${w.x.toFixed(0)},${w.y.toFixed(0)}) line ${w.id.slice(0, 8)}`);
}
if (off2 > 0) console.log(`FAIL: ${off2} dots >2px off-lane`);
