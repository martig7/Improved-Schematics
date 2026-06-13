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
import { rdpSimplify } from './layout/chainPlace';

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
    let best = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const d = Math.hypot(
          marks[i].pos[0] - marks[j].pos[0],
          marks[i].pos[1] - marks[j].pos[1],
        );
        if (d > best) { best = d; ai = i; }
      }
    }
    const a = marks[ai].pos;
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
    // mega fires per-station when the rigid-row solver found no feasible
    // configuration (spec v2 §3), or via the dormant global MEGA_BOXES rule
    if (marks.some((m) => m.mega) || (MEGA_BOXES && megaEligible && (degByNode?.get(nodeId) ?? 0) >= 12)) {
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
      // No internal bullet circles: a boxed station is a genuine crossing where
      // the stops converge at the crossing point, so the per-line dots overlap
      // into an unreadable cluster (user: "leave them as boxes but remove the
      // station circles"). The box alone marks the interchange; the crossing
      // lines read through it.
      out.push(wrap((x0 + x1) / 2, (y0 + y1) / 2,
        '<rect x="' + x0.toFixed(1) + '" y="' + y0.toFixed(1) +
        '" width="' + (x1 - x0).toFixed(1) + '" height="' + (y1 - y0).toFixed(1) +
        '" rx="' + (r + 1.5).toFixed(1) + '" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="3"' + attrs + '/>',
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

    // Spine capsule (dots-on-lanes model, spec 2026-06-12): the marker is
    // the chain of dots in solved order; the capsule is the RDP-simplified
    // polyline through the dot centers, stroked round — border then fill.
    // Dots are on the spine by construction (P3), so containment is
    // structural and lateral widening no longer exists.
    const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
    // rigid-row model: pair boundaries contribute a derived elbow vertex
    // between the facing end-dots; RDP keeps corners (genuine bends)
    const vertices: Pixel[] = [];
    for (const mk of ordered) {
      vertices.push(mk.pos);
      if (mk.cornerAfter) vertices.push(mk.cornerAfter);
    }
    const spine = rdpSimplify(vertices, 0.75);
    const dAttr = 'M ' + spine.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ');
    const pathSvg = (color: string, w: number, withAttrs: boolean): string =>
      '<path d="' + dAttr + '" fill="none" stroke="' + color +
      '" stroke-width="' + w.toFixed(1) +
      '" stroke-linecap="round" stroke-linejoin="round"' +
      (withAttrs ? attrs : '') + '/>';
    const inner = pathSvg(stroke, 2 * r + 6, false) + pathSvg(fill, 2 * r + 3, true);
    const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
    const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
    out.push(wrap(cx, cy, inner + dots));
  }
  return out;
}
