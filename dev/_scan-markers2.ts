// Throwaway: list imp-stop markers within a window.
// Usage: npx tsx dev/_scan-markers2.ts <svg> x0 y0 x1 y1
import { readFileSync } from 'fs';
const [file, x0s, y0s, x1s, y1s] = process.argv.slice(2);
const s = readFileSync(file, 'utf-8');
const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(s))) {
  const x = +m[1];
  const y = +m[2];
  if (x < +x0s || x > +x1s || y < +y0s || y > +y1s) continue;
  const names = [...m[3].matchAll(/<text[^>]*>([^<]+)</g)].map((t) => t[1]).join('');
  console.log(`(${x},${y}) bullets=[${names}]`);
}
