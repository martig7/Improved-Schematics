// Probe: are the lanes of the remaining STACKED pairs coincident or separable?
// Extracts route <path> polylines per line id near the station and reports the
// min/max separation of the two lanes within a +-40px window of the collision.
import { readFileSync } from 'fs';

const svg = readFileSync('dev/_dumpnyc.svg', 'utf-8');
const pairs: Array<{ st: string; at: [number, number]; a: string; b: string }> = [
  { st: 'mn116', at: [1203.5, 1249.1], a: 'd12974df-71a2-46b2-b330-3683fb97516b', b: 'f24ceca4-e310-43d2-8cd1-ea1970f7a3b0' },
  { st: 'mn116', at: [1201.0, 1244.3], a: 'e57f33b3-ec56-4f05-b103-8638dd59bd2c', b: 'ef28182f-0052-4d15-8ebf-f596517f6731' },
  { st: 'mn32', at: [998.4, 1460.9], a: '98c24ce0-acd7-44bd-ace5-eedaa7335c4f', b: '2127bc40-f2ed-4f78-b343-da30d5a5baa7' },
];

// collect every path polyline per line id (split on M into subpaths)
const byLine = new Map<string, Array<Array<[number, number]>>>();
for (const m of svg.matchAll(/<path([^>]*)\/?>/g)) {
  const attrs = m[1];
  const lid = (attrs.match(/data-line-id="([^"]+)"/) ?? [])[1];
  const d = (attrs.match(/ d="([^"]+)"/) ?? [])[1];
  if (!lid || !d) continue;
  let arr = byLine.get(lid);
  if (!arr) { arr = []; byLine.set(lid, arr); }
  for (const sub of d.split('M')) {
    const nums = sub.match(/[-\d.]+/g)?.map(Number) ?? [];
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (pts.length >= 2) arr.push(pts);
  }
}
console.log('lines parsed:', byLine.size);

const ptSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
};

for (const pr of pairs) {
  const near = (polys: Array<Array<[number, number]>>) =>
    polys.filter((pts) => pts.some((p) => Math.hypot(p[0] - pr.at[0], p[1] - pr.at[1]) < 60));
  const pa = near(byLine.get(pr.a) ?? []);
  const pb = near(byLine.get(pr.b) ?? []);
  console.log(`\n=== ${pr.st} pair ${pr.a.slice(0, 8)} vs ${pr.b.slice(0, 8)}: ${pa.length}/${pb.length} nearby subpaths`);
  // sample points of lane A within 40px of collision; report distance to lane B
  let minD = Infinity, maxD = -Infinity, nSamp = 0;
  for (const pts of pa) {
    for (let i = 1; i < pts.length; i++) {
      // sample along segment
      for (let s = 0; s <= 10; s++) {
        const q: [number, number] = [
          pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * s / 10,
          pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * s / 10,
        ];
        if (Math.hypot(q[0] - pr.at[0], q[1] - pr.at[1]) > 40) continue;
        let d = Infinity;
        for (const pb2 of pb) for (let j = 1; j < pb2.length; j++) d = Math.min(d, ptSeg(q, pb2[j - 1], pb2[j]));
        if (d === Infinity) continue;
        nSamp++;
        minD = Math.min(minD, d);
        maxD = Math.max(maxD, d);
      }
    }
  }
  console.log(`  samples=${nSamp} laneA->laneB dist min=${minD.toFixed(2)} max=${maxD.toFixed(2)} (within 40px of collision)`);
}
