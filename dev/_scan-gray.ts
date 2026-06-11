// Which gray (#808183) paths have points in a window? (SW of Court check)
import { readFileSync } from 'fs';
const svg = readFileSync('dev/_dump.svg', 'utf-8');
const re = /<path([^>]*)\sd="([^"]+)"([^>]*)\/>/g;
const win = { x0: 755, y0: 2010, x1: 815, y1: 2050 };
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const attrs = m[1] + ' ' + m[3];
  if (!attrs.includes('#808183')) continue;
  const idm = attrs.match(/data-line-id="([^"]+)"/);
  const id = idm ? idm[1].slice(0, 8) : '(no id)';
  const nums = m[2].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  let hits = 0;
  const pts: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    if (x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1) {
      hits++;
      if (pts.length < 8) pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
    }
  }
  if (hits) console.log(`${id} hits=${hits}: ${pts.join(' ')}`);
}
