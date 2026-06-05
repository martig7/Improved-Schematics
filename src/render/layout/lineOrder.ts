// Order parallel lines on shared edges to reduce crossings at nodes.
// Ported from the game (dev/reference/orderLines.js).

import type { Layout, LayoutEdge } from './types';

export function orderLines(layout: Layout): void {
  for (const edge of layout.edges) {
    edge.lineOrder = [...edge.lines].map((l) => l.id).sort();
  }

  const incident = new Map<string, string[]>();
  for (const edge of layout.edges) {
    if (!incident.has(edge.from)) incident.set(edge.from, []);
    if (!incident.has(edge.to)) incident.set(edge.to, []);
    incident.get(edge.from)!.push(edge.id);
    incident.get(edge.to)!.push(edge.id);
  }

  const byId = new Map<string, LayoutEdge>(layout.edges.map((e) => [e.id, e]));

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [, edgeIds] of incident) {
      for (const edgeId of edgeIds) {
        const edge = byId.get(edgeId)!;
        const target = new Map<string, number>();
        for (const line of edge.lines) {
          let sum = 0;
          let count = 0;
          for (const otherId of edgeIds) {
            if (otherId === edgeId) continue;
            const other = byId.get(otherId)!;
            const idx = other.lineOrder.indexOf(line.id);
            if (idx >= 0) {
              const denom = Math.max(1, other.lineOrder.length - 1);
              sum += idx / denom;
              count++;
            }
          }
          const ownIdx = edge.lineOrder.indexOf(line.id);
          const ownNorm = ownIdx / Math.max(1, edge.lineOrder.length - 1);
          target.set(line.id, count > 0 ? sum / count : ownNorm);
        }
        const before = edge.lineOrder.join(',');
        edge.lineOrder = [...edge.lineOrder].sort((a, b) => {
          const ta = target.get(a) ?? 0;
          const tb = target.get(b) ?? 0;
          if (ta === tb) return a.localeCompare(b);
          return ta - tb;
        });
        if (edge.lineOrder.join(',') !== before) changed = true;
      }
    }
    if (!changed) break;
  }
}
