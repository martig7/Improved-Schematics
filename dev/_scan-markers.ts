// Throwaway: survey imp-stop markers in the NYC dump render.
import { readFileSync } from 'fs';

const s = readFileSync(process.argv[2] ?? 'dev/_dumpnyc.svg', 'utf-8');
const re = /<g class="imp-stop" data-ax="([\d.]+)" data-ay="([\d.]+)">(.*?)<\/g>/g;
let m: RegExpExecArray | null;
let caps = 0, dots = 0, megas = 0, texts = 0;
const bigCaps: Array<[string, string, number]> = [];
while ((m = re.exec(s))) {
  const inner = m[3];
  texts += (inner.match(/<text/g) ?? []).length;
  if (inner.includes('<rect')) megas++;
  else if (inner.includes('<line')) {
    caps++;
    const ids = (inner.match(/data-stops="([^"]+)"/) ?? [])[1]?.split(',') ?? [];
    if (ids.length >= 3 && bigCaps.length < 14) bigCaps.push([m[1], m[2], ids.length]);
  } else dots++;
}
console.log({ caps, dots, megas, texts });
console.log(bigCaps);
