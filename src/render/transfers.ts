// Transfer connectors: short lines drawn between distinct station groups that
// are close enough to walk between (NYC-map-style). The game's
// MAX_TRANSFER_WALKING_TIME / WALKING_SPEED gives ~900m which is too loose for
// a visual cue, so we use a tighter default threshold.

import type { Coordinate } from '../types/core';
import type { StationGroup, TransitGraph } from './layout/types';

/**
 * Pairs of station groups within `maxMeters` of each other (by their center
 * lng/lat). Symmetric pairs are returned once. Pairs that already share an
 * edge in the transit graph should be filtered by the caller (those are
 * normal connected stops, not visual transfers).
 */
export interface TransferPair {
  fromId: string;
  toId: string;
  fromCenter: Coordinate;
  toCenter: Coordinate;
  meters: number;
}

/** Default visual-transfer threshold; a couple of NYC blocks. */
export const DEFAULT_TRANSFER_METERS = 400;

/**
 * Filter station groups to only those that appear as nodes in the transit
 * graph (i.e., have at least one route through them). Stations not on any
 * route should never participate in transfer connectors.
 */
export function routedGroupsOnly(groups: StationGroup[], graph: TransitGraph): StationGroup[] {
  return groups.filter((g) => graph.nodes.has(g.id));
}

/** Approximate metres between two lng/lat points (cosine-corrected). */
function metresBetween(a: Coordinate, b: Coordinate): number {
  const meanLat = (a[1] + b[1]) / 2;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const R = 6371e3;
  const dx = ((b[0] - a[0]) * Math.PI) / 180 * k * R;
  const dy = ((b[1] - a[1]) * Math.PI) / 180 * R;
  return Math.hypot(dx, dy);
}

export function findTransferPairs(
  groups: StationGroup[],
  maxMeters: number = DEFAULT_TRANSFER_METERS,
): TransferPair[] {
  const pairs: TransferPair[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const m = metresBetween(groups[i].center, groups[j].center);
      if (m <= maxMeters && m > 0.1) {
        pairs.push({
          fromId: groups[i].id,
          toId: groups[j].id,
          fromCenter: groups[i].center,
          toCenter: groups[j].center,
          meters: m,
        });
      }
    }
  }
  return pairs;
}

/**
 * Render transfer connector lines in projected pixel space. Skips pairs whose
 * groups are already joined by a direct route edge (those are not transfers).
 */
export function renderTransferConnectors(
  pairs: TransferPair[],
  toPx: (coord: Coordinate) => [number, number],
  excludeKeys: Set<string>,
  dark: boolean,
  strokeWidth: number,
): string {
  const stroke = dark ? '#9ca3af' : '#374151';
  const lines: string[] = [];
  for (const p of pairs) {
    const k1 = p.fromId + '|' + p.toId;
    const k2 = p.toId + '|' + p.fromId;
    if (excludeKeys.has(k1) || excludeKeys.has(k2)) continue;
    const [x1, y1] = toPx(p.fromCenter);
    const [x2, y2] = toPx(p.toCenter);
    lines.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
        `stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${(strokeWidth * 1.5).toFixed(1)},${(strokeWidth * 1.2).toFixed(1)}" opacity="0.7"/>`,
    );
  }
  if (lines.length === 0) return '';
  return `<g class="transfers">${lines.join('')}</g>`;
}

/** Build a set of `from|to` keys for direct graph edges, used to exclude them. */
export function edgeKeysFromGraph(edges: Array<{ from: string; to: string }>): Set<string> {
  const s = new Set<string>();
  for (const e of edges) s.add(e.from + '|' + e.to);
  return s;
}
