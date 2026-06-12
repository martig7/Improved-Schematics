// Per-station markers, NYC-subway-map style: EVERY stopping line gets a dot
// on its own lane in all cases, and the capsule is an outline that SURROUNDS
// the dots (real-map Canal St model) rather than replacing them — so a
// capsule can never mislead about which lines actually stop. Capsule iff the
// station has multiple member stations (group) OR multiple stopping lines at
// one station (express/local pairs). Each dot prints its line's name (route
// bullet) inside, upright, toggled by the stations toggle.

import type { Pixel, StopMark } from './layout/types';
import { LINE_WIDTH, MEGA_BOXES } from './constants';
import { escapeXml } from './escape';

export function renderStops(
  stopsByNode: Map<string, StopMark[]>,
  dark: boolean,
  membersByNode?: Map<string, number>,
  degByNode?: Map<string, number>,
  showNames?: boolean,
): string[] {
  const out: string[] = [];
  const r = LINE_WIDTH * 0.7;
  const fill = dark ? '#18181b' : '#ffffff';
  const stroke = dark ? '#e4e4e7' : '#111111';
  const nameFill = dark ? '#ffffff' : '#111111';

  // Each marker is wrapped in an anchored group (class imp-stop, data-ax/-ay
  // = the marker's anchor point); markers are pure map objects (no panel
  // counter-scaling) but the class also excludes them from stroke scaling.
  const wrap = (ax: number, ay: number, inner: string): string =>
    '<g class="imp-stop" data-ax="' + ax.toFixed(1) + '" data-ay="' + ay.toFixed(1) + '">' +
    inner + '</g>';

  // One dot per stopping line: hollow disc on the line's own lane, ring in
  // the line's color, route bullet centered inside (always upright/north-up).
  const dotOf = (mk: StopMark): string => {
    let s =
      '<circle cx="' + mk.pos[0].toFixed(1) + '" cy="' + mk.pos[1].toFixed(1) +
      '" r="' + r.toFixed(1) + '" fill="' + fill + '" stroke="' + escapeXml(mk.color) +
      '" stroke-width="1.5" data-line="' + escapeXml(mk.lineId) + '"/>';
    if (showNames && mk.name) {
      const fs = mk.name.length <= 1 ? r * 1.7 : Math.min(r * 1.7, (2 * r * 0.92) / (0.6 * mk.name.length));
      s +=
        '<text x="' + mk.pos[0].toFixed(1) + '" y="' + (mk.pos[1] + fs * 0.36).toFixed(1) +
        '" text-anchor="middle" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif"' +
        ' font-size="' + fs.toFixed(2) + '" font-weight="bold" fill="' + nameFill + '">' +
        escapeXml(mk.name) + '</text>';
    }
    return s;
  };

  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    const members = membersByNode?.get(nodeId);
    const capsule = marks.length > 1 || (members !== undefined && members > 1);

    // Farthest pair of marks defines the marker axis (marks per station are
    // the lane fan across a bundle, so they are near-collinear).
    let ai = 0;
    let bi = 0;
    let best = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const d = Math.hypot(
          marks[i].pos[0] - marks[j].pos[0],
          marks[i].pos[1] - marks[j].pos[1],
        );
        if (d > best) { best = d; ai = i; bi = j; }
      }
    }
    const a = marks[ai].pos;
    const b = marks[bi].pos;
    const lineIds = marks.map((m) => m.lineId).join(',');
    const attrs =
      ' data-stops="' + escapeXml(lineIds) + '" data-station-id="' + escapeXml(nodeId) + '"';
    const dots = marks.map(dotOf).join('');

    if (!capsule) {
      // single line at a single station: just its dot
      out.push(wrap(a[0], a[1],
        '<g' + attrs + '>' + dots + '</g>',
      ));
      continue;
    }

    // mega eligibility mirrors the pre-dots rule exactly: group-driven
    // capsules (members known) need >1 members; legacy callers need >1 marks
    const megaEligible = members !== undefined ? members > 1 : marks.length > 1;
    if (MEGA_BOXES && megaEligible && (degByNode?.get(nodeId) ?? 0) >= 12) {
      // Mega capsule for huge interchanges (user rule): the junction's whole
      // footprint becomes the marker — a rounded rectangle covering the
      // marks with padding — so lines may reverse/cross/weave freely
      // underneath it and read as passing straight through the station.
      // generous padding: connector chords and lane reversals at the junction
      // happen within ~half a grid cell of the marks — cover them
      const pad = r + 7;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const mk of marks) {
        x0 = Math.min(x0, mk.pos[0]); y0 = Math.min(y0, mk.pos[1]);
        x1 = Math.max(x1, mk.pos[0]); y1 = Math.max(y1, mk.pos[1]);
      }
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      const minSide = 2 * r + 3;
      if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
      if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
      out.push(wrap((x0 + x1) / 2, (y0 + y1) / 2,
        '<rect x="' + x0.toFixed(1) + '" y="' + y0.toFixed(1) +
        '" width="' + (x1 - x0).toFixed(1) + '" height="' + (y1 - y0).toFixed(1) +
        '" rx="' + (r + 1.5).toFixed(1) + '" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="3"' + attrs + '/>' + dots,
      ));
      continue;
    }

    if (best < 1e-3) {
      // marks coincide: capsule degenerates to a ring around the (stacked) dot
      out.push(wrap(a[0], a[1],
        '<circle cx="' + a[0].toFixed(1) + '" cy="' + a[1].toFixed(1) + '" r="' + (r + 3).toFixed(1) +
        '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' + attrs + '/>' +
        dots,
      ));
      continue;
    }

    // Multi-angle capsule (real-NYC Atlantic Av–Barclays style): one stadium
    // SEGMENT per entry-direction bundle (marks carry seg indexes), drawn as
    // one connected marker — every border first, every fill second, so fills
    // merge across overlapping segments; a joint bridges segment centroids
    // that don't touch. Single-segment stations reduce to the classic pill.
    const segIds = [...new Set(marks.map((m) => m.seg ?? 0))];
    interface SegGeom { a: Pixel; b: Pixel; w: number; c: Pixel }
    const segGeoms: SegGeom[] = [];
    for (const sid of segIds) {
      const sm = marks.filter((m) => (m.seg ?? 0) === sid);
      let sa = sm[0].pos;
      let sb = sm[0].pos;
      let span = 0;
      for (let i = 0; i < sm.length; i++) {
        for (let j = i + 1; j < sm.length; j++) {
          const d = Math.hypot(sm[i].pos[0] - sm[j].pos[0], sm[i].pos[1] - sm[j].pos[1]);
          if (d > span) { span = d; sa = sm[i].pos; sb = sm[j].pos; }
        }
      }
      // lateral widening: dots off the axis chord must still fit inside
      let lat = 0;
      if (span > 1e-6) {
        const nx = -(sb[1] - sa[1]) / span;
        const ny = (sb[0] - sa[0]) / span;
        for (const m of sm) {
          lat = Math.max(lat, Math.abs((m.pos[0] - sa[0]) * nx + (m.pos[1] - sa[1]) * ny));
        }
      }
      segGeoms.push({
        a: sa,
        b: sb,
        w: 2 * r + 3 + 2 * lat,
        c: [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2],
      });
    }
    // Tip-to-tip elbows (user design): each segment pairs with its nearest
    // predecessor (by centroid — mirrors the layout solver); their
    // octilinear axes intersect at the elbow point P, and both segments'
    // nearer tips EXTEND to P so the round caps meet there — joints only
    // ever touch segments at their ends. Parallel collinear rows extend to
    // meet halfway; anything else (parallel offset rows, an absurdly far
    // P) falls back to a short bridge.
    const joints: Array<{ p: Pixel; q: Pixel; w: number }> = [];
    const axisDirOf = (g: SegGeom, marks0: StopMark): Pixel => {
      const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
      if (len > 1e-6) return [(g.b[0] - g.a[0]) / len, (g.b[1] - g.a[1]) / len];
      const d = marks0.dir ?? [1, 0];
      const snap = Math.round(Math.atan2(d[0], -d[1]) / (Math.PI / 4)) * (Math.PI / 4);
      return [Math.cos(snap), Math.sin(snap)];
    };
    const maxExt = (LINE_WIDTH + 2) * 4; // ~4 lane spacings
    for (let i = 1; i < segGeoms.length; i++) {
      let bestJ = 0;
      let bestD = Infinity;
      for (let j = 0; j < i; j++) {
        const d = Math.hypot(segGeoms[i].c[0] - segGeoms[j].c[0], segGeoms[i].c[1] - segGeoms[j].c[1]);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      const A = segGeoms[bestJ];
      const B = segGeoms[i];
      const mA = marks.find((m) => (m.seg ?? 0) === segIds[bestJ])!;
      const mB = marks.find((m) => (m.seg ?? 0) === segIds[i])!;
      const uA = axisDirOf(A, mA);
      const uB = axisDirOf(B, mB);
      const denom = uA[0] * uB[1] - uA[1] * uB[0];
      if (Math.abs(denom) >= 0.05) {
        const t = ((B.c[0] - A.c[0]) * uB[1] - (B.c[1] - A.c[1]) * uB[0]) / denom;
        const px = A.c[0] + uA[0] * t;
        const py = A.c[1] + uA[1] * t;
        const sB = (px - B.c[0]) * uB[0] + (py - B.c[1]) * uB[1];
        // Corner openness: the angle between the directions the two rows
        // RETREAT from P. Open (135°, Atlantic Av) and right corners look
        // clean with tips extended to P; at an ACUTE corner (45° V) the
        // extension makes one row's body ride over the other (the dots'
        // lanes force both rows onto the tight side of the axes crossing),
        // so there the rows just fuse where their hulls already overlap.
        // Degenerate/single-dot segments are exempt: for them the extension
        // IS the marker body (it builds the pill), and skipping it leaves a
        // pinched snowman.
        const retreatDot =
          Math.sign(t) * Math.sign(sB) * (uA[0] * uB[0] + uA[1] * uB[1]);
        const halfA = Math.hypot(A.b[0] - A.a[0], A.b[1] - A.a[1]) / 2;
        const halfB = Math.hypot(B.b[0] - B.a[0], B.b[1] - B.a[1]) / 2;
        if (retreatDot > 0.5 && halfA > r && halfB > r) {
          // The bodies meet cap-against-side here (no extension) — but the
          // fills only overlap in a small lens, so border ink pinches
          // through as a seam between the two pills. Joint = stadium from
          // the nearest TIP of one to the nearest END-CAP CENTER of the
          // other: its edges are then the common tangents of the two round
          // caps, so the union outline gets a straight flush chamfer (a
          // tip-to-axis joint leaves a concave dimple beside the far cap).
          let best: { p: Pixel; q: Pixel; d: number } | null = null;
          for (const tip of [A.a, A.b]) {
            for (const end of [B.a, B.b]) {
              const d = Math.hypot(tip[0] - end[0], tip[1] - end[1]);
              if (!best || d < best.d) best = { p: tip, q: end, d };
            }
          }
          joints.push({ p: best!.p, q: best!.q, w: Math.min(A.w, B.w) });
          continue;
        }
        const extend = (g: SegGeom, u: Pixel, along: number): boolean => {
          const halfLen = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) / 2;
          const ext = Math.abs(along) - halfLen;
          if (ext > maxExt) return false;
          if (ext <= 0) return true; // P inside the row: hulls already meet
          const tip: Pixel = [px, py];
          // move the endpoint nearer P onto P — the round caps of both
          // segments meet there (smooth ends; no filled corner, per user)
          const dA = Math.hypot(g.a[0] - px, g.a[1] - py);
          const dB = Math.hypot(g.b[0] - px, g.b[1] - py);
          if (dA <= dB) g.a = tip;
          else g.b = tip;
          return true;
        };
        // tentatively extend both; roll back to a bridge if either is too far
        const aSnap: [Pixel, Pixel] = [A.a, A.b];
        const bSnap: [Pixel, Pixel] = [B.a, B.b];
        if (extend(A, uA, t) && extend(B, uB, sB)) continue;
        A.a = aSnap[0]; A.b = aSnap[1];
        B.a = bSnap[0]; B.b = bSnap[1];
      } else {
        // parallel: collinear rows (small lateral offset) meet halfway
        const lat = Math.abs((B.c[0] - A.c[0]) * -uA[1] + (B.c[1] - A.c[1]) * uA[0]);
        if (lat < 2) {
          const dEnds = (p: Pixel, q: Pixel) => Math.hypot(p[0] - q[0], p[1] - q[1]);
          let ea: 'a' | 'b' = 'a';
          let eb: 'a' | 'b' = 'a';
          let best = Infinity;
          for (const x of ['a', 'b'] as const) {
            for (const y of ['a', 'b'] as const) {
              const d = dEnds(A[x], B[y]);
              if (d < best) { best = d; ea = x; eb = y; }
            }
          }
          if (best <= maxExt * 2) {
            const mid: Pixel = [(A[ea][0] + B[eb][0]) / 2, (A[ea][1] + B[eb][1]) / 2];
            A[ea] = mid;
            B[eb] = mid;
            continue;
          }
        }
      }
      // fallback: short bridge between centroids' closest approach
      joints.push({ p: A.c, q: B.c, w: 2 * r + 3 });
    }
    const lineSvg = (p: Pixel, q: Pixel, color: string, w: number, withAttrs: boolean): string =>
      '<line x1="' + p[0].toFixed(1) + '" y1="' + p[1].toFixed(1) +
      '" x2="' + q[0].toFixed(1) + '" y2="' + q[1].toFixed(1) +
      '" stroke="' + color + '" stroke-width="' + w.toFixed(1) +
      '" stroke-linecap="round"' + (withAttrs ? attrs : '') + '/>';
    let inner = '';
    for (const g of segGeoms) inner += lineSvg(g.a, g.b, stroke, g.w + 3, false);
    for (const j of joints) inner += lineSvg(j.p, j.q, stroke, j.w + 3, false);
    let first = true;
    for (const g of segGeoms) {
      inner += lineSvg(g.a, g.b, fill, g.w, first);
      first = false;
    }
    for (const j of joints) inner += lineSvg(j.p, j.q, fill, j.w, false);
    const cx = segGeoms.reduce((acc, g) => acc + g.c[0], 0) / segGeoms.length;
    const cy = segGeoms.reduce((acc, g) => acc + g.c[1], 0) / segGeoms.length;
    out.push(wrap(cx, cy, inner + dots));
  }
  return out;
}
