// Per-line stop markers (single circle, or an oriented capsule for
// interchanges). The capsule follows LOOM's transitmap station style: a
// stadium hull along the axis of the stop marks, instead of an axis-aligned
// bounding box (which ballooned into huge blobs whenever a node's lane fan
// spread out or marks landed on more than one corridor).

import type { StopMark } from './layout/types';
import { LINE_WIDTH } from './constants';
import { escapeXml } from './escape';

export function renderStops(stopsByNode: Map<string, StopMark[]>, dark: boolean): string[] {
  const out: string[] = [];
  const r = LINE_WIDTH * 0.7;
  const fill = dark ? '#18181b' : '#ffffff';
  const stroke = dark ? '#e4e4e7' : '#111111';

  // Each marker is wrapped in an anchored group (class imp-stop, data-ax/-ay
  // = the marker's anchor point) so the panel can counter-scale the WHOLE
  // marker on zoom — geometry included, like the labels — instead of only
  // its stroke width (which left capsule length in world units: zooming out
  // squashed interchanges into blobs).
  const wrap = (ax: number, ay: number, inner: string): string =>
    '<g class="imp-stop" data-ax="' + ax.toFixed(1) + '" data-ay="' + ay.toFixed(1) + '">' +
    inner + '</g>';

  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 1) {
      const [x, y] = marks[0].pos;
      out.push(wrap(x, y,
        '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) +
        '" fill="' + fill + '" stroke="' + escapeXml(marks[0].color) +
        '" stroke-width="1.5" data-stops="' + escapeXml(marks[0].lineId) +
        '" data-station-id="' + escapeXml(nodeId) + '"/>',
      ));
      continue;
    }

    // Farthest pair of marks defines the capsule axis (marks per node are the
    // lane fan across a bundle, so they are near-collinear).
    let ai = 0;
    let bi = 0;
    let best = -1;
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

    if (best < 1e-3) {
      // all marks coincide: plain interchange circle
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
