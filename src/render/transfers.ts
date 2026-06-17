// Transfer connectors: short U-brackets drawn between distinct station groups that
// are close enough to walk between (NYC-map-style). The game's
// MAX_TRANSFER_WALKING_TIME / WALKING_SPEED gives ~900m which is too loose for
// a visual cue, so we use a tighter default threshold.

import type { Coordinate } from '../types/core';
import type { StationGroup, TransitGraph } from './layout/types';

/**
 * Pairs of station groups within `maxMeters` of each other (by their center
 * lng/lat). Symmetric pairs are returned once. Pairs that already share an
 * edge in the transit graph should be filtered by the caller (those are
 * normal connected stops, not transfers).
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

/** How far (px) the staple crossbar sits beyond the dot edge so it hugs without touching. */
export const BRACKET_LEG_EXTRA = 2;

type Pixel = [number, number];

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
  const k = Math.round(Math.cos((meanLat * Math.PI) / 180) * 1e9) / 1e9; // quantize cos (cross-V8)
  const R = 6371e3;
  const dx = ((b[0] - a[0]) * Math.PI) / 180 * k * R;
  const dy = ((b[1] - a[1]) * Math.PI) / 180 * R;
  return Math.sqrt(dx * dx + dy * dy); // correctly-rounded cross-V8 (hypot is not)
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
 * Build an orthogonal staple path between two nearby station dots. The path runs
 * from one dot center, straight out along a horizontal/vertical axis, across to
 * the other leg, then into the other dot center. Endpoints sit at the centers so
 * the dots (drawn on top) hide the segments running through them; the crossbar is
 * pushed `radius + legExtra` past the dots so it stays clearly visible even when
 * the dots overlap.
 */
export function bracketTransferPath(
  from: Pixel,
  to: Pixel,
  radius: number,
  legExtra: number = BRACKET_LEG_EXTRA,
): Pixel[] {
  const [ax, ay] = from;
  const [bx, by] = to;
  const dx = bx - ax;
  const dy = by - ay;
  const depth = radius + legExtra;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Side-by-side dots → staple opens vertically (legs run up/down).
    const dir = dy >= 0 ? 1 : -1;
    const edge = dir > 0 ? Math.max(ay, by) : Math.min(ay, by);
    const yCross = edge + dir * depth;
    return [
      [ax, ay],
      [ax, yCross],
      [bx, yCross],
      [bx, by],
    ];
  }

  // Stacked dots → staple opens horizontally (legs run left/right).
  const dir = dx >= 0 ? 1 : -1;
  const edge = dir > 0 ? Math.max(ax, bx) : Math.min(ax, bx);
  const xCross = edge + dir * depth;
  return [
    [ax, ay],
    [xCross, ay],
    [xCross, by],
    [bx, by],
  ];
}

export interface TransferRenderOptions {
  dark: boolean;
  strokeWidth: number;
  legExtra?: number;
}

/** Resolved pixel geometry for a transfer pair's two dots. */
export interface ResolvedTransfer {
  from: Pixel;
  to: Pixel;
  /** Visible dot radius to clear; the larger of the two dots. */
  radius: number;
}

/**
 * Render transfer connector staples in projected pixel space. Skips pairs whose
 * groups are already joined by a direct route edge (those are not transfers).
 * `resolvePx` returns the actual drawn dot centers + radius so the staple hugs
 * what the viewer sees rather than the underlying graph node.
 */
export function renderTransferConnectors(
  pairs: TransferPair[],
  resolvePx: (pair: TransferPair) => ResolvedTransfer | null,
  excludeKeys: Set<string>,
  opts: TransferRenderOptions,
): string {
  const stroke = opts.dark ? '#9ca3af' : '#374151';
  const { strokeWidth } = opts;
  const legExtra = opts.legExtra ?? BRACKET_LEG_EXTRA;
  const paths: string[] = [];

  for (const p of pairs) {
    const k1 = p.fromId + '|' + p.toId;
    const k2 = p.toId + '|' + p.fromId;
    if (excludeKeys.has(k1) || excludeKeys.has(k2)) continue;

    const px = resolvePx(p);
    if (!px) continue;

    const pts = bracketTransferPath(px.from, px.to, px.radius, legExtra);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += `L${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    }
    paths.push(
      `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ` +
        `stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`,
    );
  }

  if (paths.length === 0) return '';
  return `<g class="transfers">${paths.join('')}</g>`;
}

/** Build a set of `from|to` keys for direct graph edges, used to exclude them. */
export function edgeKeysFromGraph(edges: Array<{ from: string; to: string }>): Set<string> {
  const s = new Set<string>();
  for (const e of edges) s.add(e.from + '|' + e.to);
  return s;
}
