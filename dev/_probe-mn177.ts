// Probe: mn177 (Wahkiakum Ln) residual non-octi chord after collision slide.
// Prints the marker spine segments/angles and the local tangent of each
// incident lane polyline near the two dots, to decide quantization vs
// real geometry (diverging lanes under the same-arc-distance slide).
import { readFileSync } from 'fs';

const svg = readFileSync('dev/_dumpsea-after.svg', 'utf-8');

const dots: Array<{ p: [number, number]; line: string }> = [
  { p: [1283.4, 938.6], line: '6b681564-4446-4daa-96be-17f7620b8d5c' },
  { p: [1286.4, 933.0], line: 'ecd990e1-eeed-4596-bdbc-f1eba050123d' },
];

const dx = dots[1].p[0] - dots[0].p[0];
const dy = dots[1].p[1] - dots[0].p[1];
const chordAng = (Math.atan2(dy, dx) * 180) / Math.PI;
console.log(`chord len=${Math.hypot(dx, dy).toFixed(2)} angle=${chordAng.toFixed(2)}deg`);

// scan every path for polyline points; report segments passing within 8px of
// either dot, with their direction
const pathRe = /<path d="M ([^"]+)"([^>]*)>/g;
let m: RegExpExecArray | null;
while ((m = pathRe.exec(svg))) {
  const d = m[1];
  const attrs = m[2];
  if (!/[-\d. LM]+$/.test(d)) continue;
  const nums = d.split(/[ LM]+/).filter((x) => x.length).map(Number);
  if (nums.some((n) => Number.isNaN(n)) || nums.length < 4) continue;
  for (let i = 3; i < nums.length; i += 2) {
    const a: [number, number] = [nums[i - 3], nums[i - 2]];
    const b: [number, number] = [nums[i - 1], nums[i]];
    for (const dot of dots) {
      const da = Math.hypot(a[0] - dot.p[0], a[1] - dot.p[1]);
      const db = Math.hypot(b[0] - dot.p[0], b[1] - dot.p[1]);
      if (Math.min(da, db) > 8) continue;
      const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const stroke = /stroke="([^"]+)"/.exec(attrs)?.[1] ?? '?';
      const sid = /data-station-id="([^"]+)"/.exec(attrs)?.[1] ?? '';
      console.log(
        `near dot(${dot.p}) seg (${a})->(${b}) len=${len.toFixed(1)} ang=${ang.toFixed(2)} ` +
        `stroke=${stroke}${sid ? ' station=' + sid : ''}`,
      );
      break;
    }
  }
}
