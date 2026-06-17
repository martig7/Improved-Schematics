// Throwaway: diff imp-stop marker groups between two SVG dumps; report
// markers whose inner SVG changed (keyed by data-ax/ay rounded to 2px).
import { readFileSync } from 'fs';

const [fa, fb] = process.argv.slice(2);
const load = (f: string): Map<string, string> => {
  const svg = readFileSync(f, 'utf-8');
  const m = new Map<string, string>();
  const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(svg))) {
    const key = (Math.round(+x[1] / 2) * 2) + ',' + (Math.round(+x[2] / 2) * 2);
    m.set(key, x[3]);
  }
  return m;
};
const a = load(fa);
const b = load(fb);
let changed = 0;
for (const [k, v] of a) {
  const w = b.get(k);
  if (w === undefined) { console.log('only-in-A @ ' + k); changed++; }
  else if (w !== v) { console.log('changed @ ' + k); changed++; }
}
for (const k of b.keys()) if (!a.has(k)) { console.log('only-in-B @ ' + k); changed++; }
console.log(`${changed} differing markers (A=${a.size}, B=${b.size})`);
