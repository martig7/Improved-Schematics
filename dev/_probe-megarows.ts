// probe: why do specific stations return null from solveRows?
// Re-runs state building per bundle with failure-reason counters.
import { readFileSync } from 'fs';
import type { Pixel } from '../src/render/layout/types';
import { type LaneCurve, curvePoint, curveTangent } from '../src/render/layout/chainPlace';
import { solveRows } from '../src/render/layout/rowPlace';

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
  const curves: LaneCurve[] = j.curves.map((c: { pts: Pixel[]; anchorT: number }) => ({
    pts: c.pts, cum: arcCum(c.pts), anchorT: c.anchorT,
  }));
  const groups: number[][] = j.groups;
  const minGap: number = j.minGap;
  console.log(`\n=== ${j.nodeId} marks=${curves.length} groups=${JSON.stringify(groups)} minGap=${minGap.toFixed(2)}`);
  const anchorPos = curves.map((c) => curvePoint(c, c.anchorT));
  for (let b = 0; b < groups.length; b++) {
    const group = groups[b];
    const carrier = curves[group[0]];
    const reasons = { noCross: 0, order: 0, floor: 0, ok: 0 };
    let sampleGap = NaN;
    for (let jj = -48; jj <= 48; jj++) {
      const s = jj * 0.5;
      const A = curvePoint(carrier, carrier.anchorT + s);
      for (let axis = 0; axis < 4; axis++) {
        const u = AXES[axis];
        if (group.length === 1) { reasons.ok++; continue; }
        const nx = -u[1]; const ny = u[0];
        const dots: Pixel[] = [];
        let hit = true;
        for (const gi of group) {
          const c = curves[gi];
          let best: Pixel | null = null; let bestD = Infinity;
          let f1 = (c.pts[0][0] - A[0]) * nx + (c.pts[0][1] - A[1]) * ny;
          const consider = (p: Pixel) => {
            const d = Math.hypot(p[0] - anchorPos[gi][0], p[1] - anchorPos[gi][1]);
            if (d < bestD) { bestD = d; best = p; }
          };
          if (Math.abs(f1) < 1e-9) consider(c.pts[0]);
          for (let i = 1; i < c.pts.length; i++) {
            const f2 = (c.pts[i][0] - A[0]) * nx + (c.pts[i][1] - A[1]) * ny;
            if (Math.abs(f2) < 1e-9) consider(c.pts[i]);
            else if (f1 * f2 < 0) {
              const t = f1 / (f1 - f2);
              consider([c.pts[i - 1][0] + (c.pts[i][0] - c.pts[i - 1][0]) * t,
                c.pts[i - 1][1] + (c.pts[i][1] - c.pts[i - 1][1]) * t]);
            }
            f1 = f2;
          }
          if (!best) { hit = false; break; }
          dots.push(best);
        }
        if (!hit) { reasons.noCross++; continue; }
        const pr = dots.map((p) => p[0] * u[0] + p[1] * u[1]);
        const sgn = pr[1] - pr[0] > 0 ? 1 : -1;
        let bad: 'order' | 'floor' | null = null;
        for (let gi = 1; gi < dots.length; gi++) {
          const gap = (pr[gi] - pr[gi - 1]) * sgn;
          if (gap <= 0) { bad = 'order'; break; }
          if (gap < minGap) { bad = 'floor'; if (s === 0) sampleGap = gap; break; }
        }
        if (bad) reasons[bad]++; else reasons.ok++;
      }
    }
    console.log(`  bundle ${b} [${group}] states: ok=${reasons.ok} noCross=${reasons.noCross} order=${reasons.order} floor=${reasons.floor}` +
      (isNaN(sampleGap) ? '' : ` (gap@rest=${sampleGap.toFixed(2)})`));
    // anchor geometry: pairwise anchor distances within the bundle
    const ds: string[] = [];
    for (let i = 1; i < group.length; i++) {
      const p = anchorPos[group[i - 1]]; const q = anchorPos[group[i]];
      ds.push(Math.hypot(p[0] - q[0], p[1] - q[1]).toFixed(2));
    }
    console.log(`    anchor gaps: ${ds.join(', ')}`);
    const tg = group.map((gi) => {
      const t = curveTangent(curves[gi], curves[gi].anchorT);
      return (Math.atan2(t[1], t[0]) * 180 / Math.PI).toFixed(0);
    });
    console.log(`    anchor tangents(deg): ${tg.join(', ')}`);
  }
  const sol = solveRows(curves, groups, { minGap, arcLimit: 24, extCap: j.extCap });
  console.log(`  solveRows(24, no mask): ${sol ? 'SOLVES cost=' + sol.cost.toFixed(1) : 'null'}`);
}
