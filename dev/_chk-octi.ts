// Gate: spine octilinearity (rigid-row spec v2 §5 / R1, amended). Every
// imp-stop FILL path segment longer than 1px must lie within the length-aware
// bar max(1deg, asin(0.85/len)) of a 45-degree multiple — rows are octilinear
// by construction; the bar admits the spec'd sub-pixel tolerances (parallel-
// row join lateral offset < 0.75px plus 0.1px coordinate quantization), so a
// short joined chord may tilt a few degrees invisibly while anything beyond
// the envelope is a solver/renderer bug. <rect> markers (mega boxes) are
// exempt: they carry no spine path at all.
// Usage: npx tsx dev/_chk-octi.ts [render.svg]
import { readFileSync } from 'fs';

const file = process.argv[2] ?? 'dev/_dumpnyc.svg';
const svg = readFileSync(file, 'utf-8');

// octOff ported from chainPlace.ts, in radians: distance to nearest 45° step
const QUARTER = Math.PI / 4;
const octOffRad = (rad: number): number => {
  const m = ((rad % QUARTER) + QUARTER) % QUARTER; // ∈ [0, π/4)
  return Math.min(m, QUARTER - m);
};
const DEG = 180 / Math.PI;

// The spine is emitted twice (border + fill, same d); the FILL pass carries
// the data attributes — match only it so each segment is checked once.
const re = /<g class="imp-stop"[^>]*>(.*?)<\/g>/g;
let segments = 0;
let bad = 0;
let m: RegExpExecArray | null;
while ((m = re.exec(svg))) {
  const inner = m[1];
  for (const pm of inner.matchAll(/<path d="M ([-\d. L]+)"[^>]*data-station-id="([^"]+)"/g)) {
    const nums = pm[1].split(/[ L]+/).filter((x) => x.length).map(Number);
    const station = pm[2];
    for (let i = 3; i < nums.length; i += 2) {
      const dx = nums[i - 1] - nums[i - 3];
      const dy = nums[i] - nums[i - 2];
      const len = Math.hypot(dx, dy);
      if (len <= 1) continue; // sub-pixel stubs carry no shape
      segments++;
      const off = octOffRad(Math.atan2(dy, dx));
      // length-aware bar: 0.85px lateral slack (0.75 join + 0.1 quantization)
      // subtends asin(0.85/len) on a chord of this length; never below 1deg
      const bar = Math.max(1 / DEG, Math.asin(Math.min(1, 0.85 / len)));
      if (off > bar) {
        bad++;
        console.log(
          `NON-OCTI ${(off * DEG).toFixed(2)}deg off (bar ${(bar * DEG).toFixed(2)}deg, len ${len.toFixed(1)}px) ` +
          `at station=${station} seg (${nums[i - 3]},${nums[i - 2]})->(${nums[i - 1]},${nums[i]})`,
        );
      }
    }
  }
}
console.log(`${segments} spine segments, ${bad} non-octilinear`);
if (bad > 0) console.log('FAIL');
