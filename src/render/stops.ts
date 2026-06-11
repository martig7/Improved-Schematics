// Per-station markers. The capsule rule is DATA-driven (user-set): a station
// group with multiple member stations renders as an oriented capsule
// (stadium hull along its lane-fan axis, LOOM transitmap style); a single
// station renders as a dot — never a capsule — even when several lines stop
// at it (the dot sits at the centre of its marks). Legacy callers without
// member data fall back to the old geometric rule (2+ marks = capsule).

import type { StopMark } from './layout/types';
import { LINE_WIDTH } from './constants';
import { escapeXml } from './escape';

export function renderStops(
  stopsByNode: Map<string, StopMark[]>,
  dark: boolean,
  membersByNode?: Map<string, number>,
): string[] {
  const out: string[] = [];
  const r = LINE_WIDTH * 0.7;
  const fill = dark ? '#18181b' : '#ffffff';
  const stroke = dark ? '#e4e4e7' : '#111111';

  // Each marker is wrapped in an anchored group (class imp-stop, data-ax/-ay
  // = the marker's anchor point); markers are pure map objects (no panel
  // counter-scaling) but the class also excludes them from stroke scaling.
  const wrap = (ax: number, ay: number, inner: string): string =>
    '<g class="imp-stop" data-ax="' + ax.toFixed(1) + '" data-ay="' + ay.toFixed(1) + '">' +
    inner + '</g>';

  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    const members = membersByNode?.get(nodeId);
    const capsule = members !== undefined ? members > 1 : marks.length > 1;

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

    if (!capsule) {
      // single station: one dot at the centre of its marks
      const cx = (a[0] + b[0]) / 2;
      const cy = (a[1] + b[1]) / 2;
      const ring = marks.length === 1 ? escapeXml(marks[0].color) : stroke;
      out.push(wrap(cx, cy,
        '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) +
        '" fill="' + fill + '" stroke="' + ring + '" stroke-width="1.5"' + attrs + '/>',
      ));
      continue;
    }

    if (best < 1e-3) {
      // interchange whose marks coincide: capsule degenerates to a circle
      out.push(wrap(a[0], a[1],
        '<circle cx="' + a[0].toFixed(1) + '" cy="' + a[1].toFixed(1) + '" r="' + r.toFixed(1) +
        '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' + attrs + '/>',
      ));
      continue;
    }

    // Stadium: border line underneath, fill line on top. Round caps extend the
    // hull by r past the extreme marks, mirroring the single-stop radius.
    const x1 = a[0].toFixed(1);
    const y1 = a[1].toFixed(1);
    const x2 = b[0].toFixed(1);
    const y2 = b[1].toFixed(1);
    out.push(wrap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + stroke + '" stroke-width="' + (2 * r + 3).toFixed(1) +
      '" stroke-linecap="round"/>' +
      '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + fill + '" stroke-width="' + (2 * r).toFixed(1) +
      '" stroke-linecap="round"' + attrs + '/>',
    ));
  }
  return out;
}
