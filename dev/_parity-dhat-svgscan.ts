// Throwaway (dHat sweep): scan per-dHat SVGs for blue (#0039a6) and pink
// (#b933ad) stroked paths passing near the center diagonal midpoint
// (~1050,1330) — distinguishes "blue not drawn there" from "blue hidden
// under pink" (coincident lanes).
import { readFileSync } from 'fs';

const BOX = { x0: 990, x1: 1110, y0: 1270, y1: 1400 };

for (const d of [16, 12, 8, 6, 4]) {
  const svg = readFileSync(`dev/_parity-dhat${d}.svg`, 'utf-8');
  const re = /<path[^>]*stroke="(#0039a6|#b933ad)"[^>]*\sd="([^"]+)"|<path[^>]*\sd="([^"]+)"[^>]*stroke="(#0039a6|#b933ad)"/gi;
  const hits: { color: string; pts: [number, number][] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const color = (m[1] ?? m[4])!;
    const dStr = (m[2] ?? m[3])!;
    const nums = dStr.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    const inBox = pts.filter((p) => p[0] >= BOX.x0 && p[0] <= BOX.x1 && p[1] >= BOX.y0 && p[1] <= BOX.y1);
    if (inBox.length) hits.push({ color, pts: inBox });
  }
  console.log(`dHat=${d}:`);
  for (const h of hits) {
    console.log(`  ${h.color} pts in box: ${h.pts.slice(0, 5).map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(' ')}${h.pts.length > 5 ? ` +${h.pts.length - 5}` : ''}`);
  }
  if (!hits.length) console.log('  (none)');
}
