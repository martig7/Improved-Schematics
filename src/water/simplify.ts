// Polyline simplification + smoothing for coastline rings.

export type Pt = [number, number];

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Ramer–Douglas–Peucker on an open polyline. */
export function douglasPeucker(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = douglasPeucker(pts.slice(0, idx + 1), eps);
  const right = douglasPeucker(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Chaikin corner-cutting. `closed` keeps the loop; open keeps endpoints. */
export function chaikin(pts: Pt[], iterations: number, closed: boolean): Pt[] {
  let out = pts.slice();
  for (let it = 0; it < iterations; it++) {
    const next: Pt[] = [];
    if (!closed) next.push(out[0]);
    const n = out.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = out[i];
      const b = out[(i + 1) % n];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(out[n - 1]);
    out = next;
  }
  return out;
}
