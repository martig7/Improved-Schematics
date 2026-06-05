// Per-line stop markers (single circle, or rounded rect for interchanges).
// Ported from the game (dev/reference/renderStops.js).

import type { StopMark } from './layout/types';
import { LINE_WIDTH } from './constants';
import { escapeXml } from './escape';

export function renderStops(stopsByNode: Map<string, StopMark[]>, dark: boolean): string[] {
  const out: string[] = [];
  const r = LINE_WIDTH * 0.7;
  const fill = dark ? '#18181b' : '#ffffff';
  const stroke = dark ? '#e4e4e7' : '#111111';

  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 1) {
      const [x, y] = marks[0].pos;
      out.push(
        '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) +
        '" fill="' + fill + '" stroke="' + escapeXml(marks[0].color) +
        '" stroke-width="1.5" data-stops="' + escapeXml(marks[0].lineId) +
        '" data-station-id="' + escapeXml(nodeId) + '"/>',
      );
      continue;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const m of marks) {
      if (m.pos[0] < minX) minX = m.pos[0];
      if (m.pos[0] > maxX) maxX = m.pos[0];
      if (m.pos[1] < minY) minY = m.pos[1];
      if (m.pos[1] > maxY) maxY = m.pos[1];
    }
    const x = minX - r;
    const y = minY - r;
    const w = maxX - minX + 2 * r;
    const h = maxY - minY + 2 * r;
    const rad = Math.min(w, h) / 2;
    const lineIds = marks.map((m) => m.lineId).join(',');
    out.push(
      '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
      '" height="' + h.toFixed(1) + '" rx="' + rad.toFixed(1) + '" ry="' + rad.toFixed(1) +
      '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" data-stops="' +
      escapeXml(lineIds) + '" data-station-id="' + escapeXml(nodeId) + '"/>',
    );
  }
  return out;
}
