// probe: replicate rowPlace pairEval for two single-dot bundles with
// failure-reason counters (which clause kills every pairing?)
import { readFileSync } from 'fs';
import type { Pixel } from '../src/render/layout/types';
import { type LaneCurve, curvePoint } from '../src/render/layout/chainPlace';

const file = process.argv[2];
const wantId = process.argv[3];
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('MEGADUMP'));
const AXES: Pixel[] = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2]];

const arcCum = (pts: Pixel[]): number[] => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
};

for (const ln of lines) {
  const j = JSON.parse(ln.slice(ln.indexOf('{')));
  if (wantId && j.nodeId !== wantId) continue;
  if (j.groups.length !== 2 || j.groups[0].length !== 1 || j.groups[1].length !== 1) continue;
  const curves: LaneCurve[] = j.curves.map((c: { pts: Pixel[]; anchorT: number }) => ({
    pts: c.pts, cum: arcCum(c.pts), anchorT: c.anchorT,
  }));
  const minGap: number = j.minGap;
  const extCap: number = j.extCap;
  console.log(`\n=== ${j.nodeId} minGap=${minGap.toFixed(2)} extCap=${extCap}`);
  // single-dot row states: dot = curvePoint(curve, anchorT + s), any axis
  const statesOf = (c: LaneCurve): Array<{ dot: Pixel; axis: number; u: Pixel; s: number }> => {
    const out: Array<{ dot: Pixel; axis: number; u: Pixel; s: number }> = [];
    for (let jj = -48; jj <= 48; jj++) {
      const dot = curvePoint(c, c.anchorT + jj * 0.5);
      for (let axis = 0; axis < 4; axis++) out.push({ dot, axis, u: AXES[axis], s: jj * 0.5 });
    }
    return out;
  };
  const S1 = statesOf(curves[0]);
  const S2 = statesOf(curves[1]);
  const reasons = { parLat: 0, parDir: 0, parGap: 0, vntD: 0, extcap: 0, cornerFloor: 0, postDotFloor: 0, OK: 0 };
  let bestOK: { d: number } | null = null;
  // replicate the DP objective: unary slide cost (rot needs the rest axis —
  // approximate rot=0 by restricting nothing; cost ranking still shows the
  // argmin's dot distance) + ext pair cost. Track argmin over pairEval-OK
  // combos WITHOUT the post dot floor — is the winner a post-check violator?
  let argmin: { cost: number; d: number } | null = null;
  for (const p of S1) {
    for (const q of S2) {
      for (let op = 0; op < 2; op++) {
        for (let oq = 0; oq < 2; oq++) {
          const e1 = p.dot; const e2 = q.dot;
          const o1x = (op ? -1 : 1) * p.u[0]; const o1y = (op ? -1 : 1) * p.u[1];
          const o2x = (oq ? 1 : -1) * q.u[0]; const o2y = (oq ? 1 : -1) * q.u[1];
          let corner: Pixel; let ext1: number; let ext2: number;
          if (p.axis === q.axis) {
            const lat = Math.abs((e2[0] - e1[0]) * -p.u[1] + (e2[1] - e1[1]) * p.u[0]);
            if (lat >= 0.75) { reasons.parLat++; continue; }
            if (o1x * o2x + o1y * o2y > -0.5) { reasons.parDir++; continue; }
            const gap = (e2[0] - e1[0]) * o1x + (e2[1] - e1[1]) * o1y;
            if (gap < 0) { reasons.parGap++; continue; }
            ext1 = gap / 2; ext2 = gap / 2;
            corner = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2];
          } else {
            const cross = p.u[0] * q.u[1] - p.u[1] * q.u[0];
            const t = ((e2[0] - e1[0]) * q.u[1] - (e2[1] - e1[1]) * q.u[0]) / cross;
            corner = [e1[0] + t * p.u[0], e1[1] + t * p.u[1]];
            const d1 = (corner[0] - e1[0]) * o1x + (corner[1] - e1[1]) * o1y;
            const d2 = (corner[0] - e2[0]) * o2x + (corner[1] - e2[1]) * o2y;
            if (d1 < -0.5 || d2 < -0.5) { reasons.vntD++; continue; }
            ext1 = Math.hypot(corner[0] - e1[0], corner[1] - e1[1]);
            ext2 = Math.hypot(corner[0] - e2[0], corner[1] - e2[1]);
          }
          if (ext1 > extCap || ext2 > extCap) { reasons.extcap++; continue; }
          if (Math.hypot(corner[0] - e1[0], corner[1] - e1[1]) < minGap ||
              Math.hypot(corner[0] - e2[0], corner[1] - e2[1]) < minGap) { reasons.cornerFloor++; continue; }
          const dd = Math.hypot(e1[0] - e2[0], e1[1] - e2[1]);
          const cost = ext1 + ext2 + 0.05 * (Math.abs(p.s) + Math.abs(q.s));
          if (!argmin || cost < argmin.cost) argmin = { cost, d: dd };
          if (dd < minGap - 1e-9) { reasons.postDotFloor++; continue; }
          reasons.OK++;
          if (!bestOK || dd < bestOK.d) bestOK = { d: dd };
        }
      }
    }
  }
  console.log('  pair reasons:', reasons, bestOK ? `bestOK dotdist=${bestOK.d.toFixed(2)}` : '');
  console.log('  argmin (rot ignored):', argmin ? `cost=${argmin.cost.toFixed(2)} dotdist=${argmin.d.toFixed(2)} violates=${argmin.d < minGap - 1e-9}` : 'none');
  console.log('  anchor dist:', Math.hypot(
    curvePoint(curves[0], curves[0].anchorT)[0] - curvePoint(curves[1], curves[1].anchorT)[0],
    curvePoint(curves[0], curves[0].anchorT)[1] - curvePoint(curves[1], curves[1].anchorT)[1]).toFixed(2));
  console.log('  curve0 total:', curves[0].cum[curves[0].cum.length - 1].toFixed(1), 'anchorT:', curves[0].anchorT.toFixed(1));
  console.log('  curve1 total:', curves[1].cum[curves[1].cum.length - 1].toFixed(1), 'anchorT:', curves[1].anchorT.toFixed(1));
}
