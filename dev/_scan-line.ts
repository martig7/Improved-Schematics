// Dump a line's path geometry from the rendered SVG within a window.
// Usage: npx tsx dev/_scan-line.ts <lineIdPrefix> x0 y0 x1 y1
import { readFileSync } from 'fs';
const [pref = '1bef2cd7', x0s = '1040', y0s = '980', x1s = '1240', y1s = '1130'] = process.argv.slice(2);
const win = { x0: +x0s, y0: +y0s, x1: +x1s, y1: +y1s };
const svg = readFileSync('dev/_dump.svg', 'utf-8');
const re = /<path([^>]*)\sd="([^"]+)"([^>]*)\/>/g;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const attrs = m[1] + ' ' + m[3];
  const idm = attrs.match(/data-line-id="([^"]+)"/);
  if (!idm || !idm[1].startsWith(pref)) continue;
  // split into subpaths on M
  const subs = m[2].split(/(?=M)/);
  for (const sub of subs) {
    const nums = sub.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const pts: string[] = [];
    let inWin = false;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1) inWin = true;
      pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
    }
    if (inWin && pts.length > 1) console.log(sub.slice(0, 1) + ' ' + pts.join(' '));
  }
}
