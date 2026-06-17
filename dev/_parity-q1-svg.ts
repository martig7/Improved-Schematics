// Throwaway: extract blue/pink paths from dev/_dump.svg, find where they run conjoined.
import { readFileSync } from 'fs';

const svg = readFileSync('dev/_dump.svg', 'utf8');

type Poly = { color: string; pts: [number, number][] };

function parsePaths(svgText: string, color: string): Poly[] {
  const out: Poly[] = [];
  const re = /<path[^>]*\bd="([^"]+)"[^>]*\bstroke="(#[0-9a-fA-F]{6})"[^>]*>|<path[^>]*\bstroke="(#[0-9a-fA-F]{6})"[^>]*\bd="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgText))) {
    const d = m[1] ?? m[4];
    const c = (m[2] ?? m[3]).toLowerCase();
    if (c !== color.toLowerCase()) continue;
    // parse d: M x y L x y ... possibly C curves; take all numeric coord pairs after commands
    const pts: [number, number][] = [];
    const tok = d.match(/[MLCQTAZHVmlcqtazhv]|-?\d+\.?\d*(?:e-?\d+)?/g) ?? [];
    let i = 0;
    let cmd = '';
    let cur: [number, number] = [0, 0];
    while (i < tok.length) {
      const t = tok[i];
      if (/[A-Za-z]/.test(t)) { cmd = t; i++; continue; }
      const read = () => parseFloat(tok[i++]);
      if (cmd === 'M' || cmd === 'L') { cur = [read(), read()]; pts.push(cur); }
      else if (cmd === 'C') { read(); read(); read(); read(); cur = [read(), read()]; pts.push(cur); }
      else if (cmd === 'Q') { read(); read(); cur = [read(), read()]; pts.push(cur); }
      else if (cmd === 'H') { cur = [read(), cur[1]]; pts.push(cur); }
      else if (cmd === 'V') { cur = [cur[0], read()]; pts.push(cur); }
      else i++;
    }
    if (pts.length >= 2) out.push({ color: c, pts });
  }
  return out;
}

const blue = parsePaths(svg, '#0039a6');
const pink = parsePaths(svg, '#b933ad');
console.log(`blue paths: ${blue.length}, pink paths: ${pink.length}`);
for (const [name, set] of [['blue', blue], ['pink', pink]] as const) {
  for (let k = 0; k < set.length; k++) {
    const p = set[k].pts;
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    console.log(`  ${name}[${k}]: ${p.length} pts bbox x[${Math.min(...xs).toFixed(0)},${Math.max(...xs).toFixed(0)}] y[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}]`);
  }
}

// sample blue densely, compute distance to nearest pink segment
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}
function* samples(poly: [number, number][], step: number): Generator<[number, number]> {
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) yield [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
  }
}

const allPink: [number, number][][] = pink.map((p) => p.pts);
const close: [number, number, number][] = []; // x,y,dist
for (const bp of blue) {
  for (const s of samples(bp.pts, 4)) {
    let dmin = Infinity;
    for (const pp of allPink) for (let i = 1; i < pp.length; i++) dmin = Math.min(dmin, segDist(s, pp[i - 1], pp[i]));
    if (dmin < 12) close.push([s[0], s[1], dmin]);
  }
}
console.log(`\nblue samples within 12px of pink: ${close.length}`);
// cluster by rounding to 50px cells
const cells = new Map<string, { n: number; minD: number; sx: number; sy: number }>();
for (const [x, y, d] of close) {
  const k = `${Math.round(x / 50)},${Math.round(y / 50)}`;
  const c = cells.get(k) ?? { n: 0, minD: Infinity, sx: 0, sy: 0 };
  c.n++; c.minD = Math.min(c.minD, d); c.sx += x; c.sy += y;
  cells.set(k, c);
}
const sorted = [...cells.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [k, c] of sorted.slice(0, 40)) {
  console.log(`  cell ${k}: n=${c.n} minD=${c.minD.toFixed(1)} centroid=(${(c.sx / c.n).toFixed(0)},${(c.sy / c.n).toFixed(0)})`);
}
