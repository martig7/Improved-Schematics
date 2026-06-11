// Per-station markers, NYC-subway-map style: EVERY stopping line gets a dot
// on its own lane in all cases, and the capsule is an outline that SURROUNDS
// the dots (real-map Canal St model) rather than replacing them — so a
// capsule can never mislead about which lines actually stop. Capsule iff the
// station has multiple member stations (group) OR multiple stopping lines at
// one station (express/local pairs). Each dot prints its line's name (route
// bullet) inside, upright, toggled by the stations toggle.

import type { StopMark } from './layout/types';
import { LINE_WIDTH } from './constants';
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
    if (megaEligible && (degByNode?.get(nodeId) ?? 0) >= 9) {
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

    // Stadium hull SURROUNDING the dots: border line underneath, fill line on
    // top, dots drawn over the fill. Round caps extend the hull past the
    // extreme dots; widths leave the dots a 1.5px margin inside the fill.
    // Marks can sit off the axis chord (diverged-corridor stations keep dots
    // on their own lanes) — widen the hull by the lateral extent so every
    // dot always fits inside.
    const axLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / axLen;
    const ny = (b[0] - a[0]) / axLen;
    let lat = 0;
    for (const m of marks) {
      lat = Math.max(lat, Math.abs((m.pos[0] - a[0]) * nx + (m.pos[1] - a[1]) * ny));
    }
    const x1 = a[0].toFixed(1);
    const y1 = a[1].toFixed(1);
    const x2 = b[0].toFixed(1);
    const y2 = b[1].toFixed(1);
    out.push(wrap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + stroke + '" stroke-width="' + (2 * r + 6 + 2 * lat).toFixed(1) +
      '" stroke-linecap="round"/>' +
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + fill + '" stroke-width="' + (2 * r + 3 + 2 * lat).toFixed(1) +
      '" stroke-linecap="round"' + attrs + '/>' +
      dots,
    ));
  }
  return out;
}
