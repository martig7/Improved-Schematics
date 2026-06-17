// Throwaway: compare DOT POSITIONS (data-line + cx/cy) between two dumps,
// pairing markers by nearest anchor. Ignores colors/markup.
import { readFileSync } from 'fs';

const [fa, fb] = process.argv.slice(2);
const load = (f: string) => {
  const svg = readFileSync(f, 'utf-8');
  const out: Array<{ ax: number; ay: number; dots: Map<string, [number, number]> }> = [];
  const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const dots = new Map<string, [number, number]>();
    for (const c of m[3].matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*data-line="([^"]+)"/g)) {
      dots.set(c[3] + '|' + c[1] + ',' + c[2], [+c[1], +c[2]]);
    }
    out.push({ ax: +m[1], ay: +m[2], dots });
  }
  return out;
};
const A = load(fa);
const B = load(fb);
let moved = 0;
for (const a of A) {
  let best: (typeof B)[number] | null = null;
  let bd = Infinity;
  for (const b of B) {
    const d = Math.hypot(a.ax - b.ax, a.ay - b.ay);
    if (d < bd) { bd = d; best = b; }
  }
  if (!best) continue;
  // markers paired; compare dot sets (keys encode line+pos)
  const same = a.dots.size === best.dots.size && [...a.dots.keys()].every((k) => best!.dots.has(k));
  if (!same) {
    moved++;
    if (moved <= 12) {
      console.log(`marker @ (${a.ax},${a.ay}) -> paired (${best.ax},${best.ay}) anchorDist=${bd.toFixed(1)} dots ${a.dots.size}/${best.dots.size}`);
    }
  }
}
console.log(`${moved} markers with differing dot positions (A=${A.length}, B=${B.length})`);
