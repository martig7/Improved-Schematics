import type { Pixel, StopMark } from './types';
import { axisUnit, coverCenter, type Line as CoverLine } from './londonBubbles';
import { computeDcByNode, type DcEnd } from './dcStations';
import { LINE_GAP, MARKER_SCALE, MARK_R0, STATION_SCALE } from '../constants';
import { capsuleStrokeWidthsFor } from '../stations/primitives';

export interface ParisCell {
  at: Pixel;
  lineIds: string[];
  endpointLineIds: string[];
  shape: 'round' | 'square';
}

export interface ParisGroup {
  axis: number;
  cellIndexes: number[];
  points: Pixel[];
}

export interface ParisConnector { points: Pixel[] }

export interface ParisStation {
  interchange: boolean;
  radius: number;
  cells: ParisCell[];
  groups: ParisGroup[];
  connectors: ParisConnector[];
  ends: DcEnd[];
  anchor: Pixel;
}

/** Radial ink rim for a Paris cell whose interior radius may be bundle-clamped. */
export function parisBorderRadius(
  radius: number,
  dotRadius: number = MARK_R0 * MARKER_SCALE,
): number {
  const widths = capsuleStrokeWidthsFor(dotRadius, STATION_SCALE);
  return widths.fill > 0 ? radius * (widths.border - widths.fill) / widths.fill : 0;
}

interface CandidateCell {
  mask: number;
  at: Pixel;
  lineIds: string[];
  endpointLineIds: string[];
  slide: number;
}

interface PlacedGroup {
  axis: number;
  indexes: number[];
  centers: Map<number, Pixel>;
  total: number;
  max: number;
}

const S = 0.7071067811865476;
const OCTI_DIRS: Pixel[] = [
  [1, 0], [S, S], [0, 1], [-S, S],
  [-1, 0], [-S, -S], [0, -1], [S, -S],
];
const CLUSTER_MAX = 3;
const ENUM_CELL_MAX = 8;
const ENUM_GROUP_MAX = 7;
const OVERLAP_PENALTY = 1e6;

const dist = (a: Pixel, b: Pixel): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
};
const qPoint = (point: Pixel): Pixel => [+point[0].toFixed(3), +point[1].toFixed(3)];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function popcount(mask: number): number {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
}

function bits(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; mask; i++, mask >>= 1) if (mask & 1) out.push(i);
  return out;
}

function lineFor(mark: StopMark): CoverLine {
  const axisKey = mark.axis == null ? -1 : ((mark.axis % 4) + 4) % 4;
  const [ux, uy] = axisUnit(axisKey < 0 ? 0 : axisKey);
  return { ux, uy, px: mark.pos[0], py: mark.pos[1], axisKey };
}

function candidateCells(marks: StopMark[], radius: number, lineWidth: number): CandidateCell[] {
  const n = marks.length;
  const cover = radius - lineWidth * 0.25;
  const reach = radius * 4;
  const out: CandidateCell[] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const indexes = bits(mask);
    if (indexes.length > CLUSTER_MAX) continue;
    let at: Pixel | undefined;
    if (indexes.length === 1) at = [marks[indexes[0]].pos[0], marks[indexes[0]].pos[1]];
    else {
      const axes = new Set(indexes
        .map((i) => marks[i].axis)
        .filter((axis): axis is number => axis != null)
        .map((axis) => ((axis % 4) + 4) % 4));
      if (axes.size < 2) continue;
      const center = coverCenter(indexes.map((i) => lineFor(marks[i])), cover, reach);
      if (!center) continue;
      at = [center.x, center.y];
    }
    const lineIds = indexes.map((i) => marks[i].lineId).sort();
    const endpointLineIds = indexes.filter((i) => marks[i].terminus).map((i) => marks[i].lineId).sort();
    const slide = indexes.reduce((sum, i) => sum + dist(at!, marks[i].pos), 0);
    out.push({ mask, at, lineIds, endpointLineIds, slide });
  }
  return out;
}

function cellPartitions(remaining: number, candidates: CandidateCell[]): CandidateCell[][] {
  if (remaining === 0) return [[]];
  const first = remaining & -remaining;
  const out: CandidateCell[][] = [];
  for (const candidate of candidates) {
    if (!(candidate.mask & first) || (candidate.mask & remaining) !== candidate.mask) continue;
    for (const rest of cellPartitions(remaining ^ candidate.mask, candidates)) out.push([candidate, ...rest]);
  }
  return out;
}

function chooseCells(marks: StopMark[], radius: number, lineWidth: number): ParisCell[] {
  if (marks.length > ENUM_CELL_MAX) {
    return marks.map((mark) => ({
      at: [mark.pos[0], mark.pos[1]],
      lineIds: [mark.lineId],
      endpointLineIds: mark.terminus ? [mark.lineId] : [],
      shape: 'round',
    }));
  }
  const candidates = candidateCells(marks, radius, lineWidth);
  const cellCost = radius * 20;
  let chosen: CandidateCell[] | undefined;
  let bestCost = Infinity;
  let bestKey = '';
  for (const part of cellPartitions((1 << marks.length) - 1, candidates)) {
    const cost = part.length * cellCost + part.reduce((sum, cell) => sum + cell.slide, 0);
    const key = part.map((cell) => cell.mask).join(',');
    if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && (!chosen || key < bestKey))) {
      chosen = part;
      bestCost = cost;
      bestKey = key;
    }
  }
  return (chosen ?? candidates.filter((candidate) => popcount(candidate.mask) === 1)).map((cell) => ({
    at: [cell.at[0], cell.at[1]],
    lineIds: [...cell.lineIds],
    endpointLineIds: [...cell.endpointLineIds],
    shape: 'round',
  }));
}

function placeGroup(cells: ParisCell[], indexes: number[], axis: number, pitch: number): PlacedGroup {
  const [ux, uy] = axisUnit(axis);
  const nx = -uy, ny = ux;
  const ordered = [...indexes].sort((a, b) => {
    const pa = cells[a].at[0] * ux + cells[a].at[1] * uy;
    const pb = cells[b].at[0] * ux + cells[b].at[1] * uy;
    return pa - pb || a - b;
  });
  const along = median(ordered.map((i) => cells[i].at[0] * ux + cells[i].at[1] * uy));
  const cross = median(ordered.map((i) => cells[i].at[0] * nx + cells[i].at[1] * ny));
  const centers = new Map<number, Pixel>();
  let total = 0, max = 0;
  ordered.forEach((cellIndex, i) => {
    const a = along + (i - (ordered.length - 1) / 2) * pitch;
    const point: Pixel = [a * ux + cross * nx, a * uy + cross * ny];
    centers.set(cellIndex, point);
    const slide = dist(point, cells[cellIndex].at);
    total += slide;
    if (slide > max) max = slide;
  });
  return { axis, indexes: ordered, centers, total, max };
}

function bestGroup(cells: ParisCell[], indexes: number[], pitch: number): PlacedGroup {
  let best = placeGroup(cells, indexes, 0, pitch);
  for (let axis = 1; axis < 4; axis++) {
    const candidate = placeGroup(cells, indexes, axis, pitch);
    if (candidate.total < best.total - 1e-9) best = candidate;
  }
  return best;
}

function* setPartitions(n: number): Generator<number[][]> {
  function* visit(index: number, groups: number[][]): Generator<number[][]> {
    if (index === n) { yield groups.map((group) => [...group]); return; }
    for (const group of groups) {
      group.push(index);
      yield* visit(index + 1, groups);
      group.pop();
    }
    groups.push([index]);
    yield* visit(index + 1, groups);
    groups.pop();
  }
  yield* visit(0, []);
}

function groupRect(group: PlacedGroup, radius: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const point of group.centers.values()) {
    x0 = Math.min(x0, point[0] - radius); x1 = Math.max(x1, point[0] + radius);
    y0 = Math.min(y0, point[1] - radius); y1 = Math.max(y1, point[1] + radius);
  }
  return { x0, y0, x1, y1 };
}

function overlaps(a: ReturnType<typeof groupRect>, b: ReturnType<typeof groupRect>, gap: number): boolean {
  return a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.y0 - gap < b.y1 && b.y0 - gap < a.y1;
}

function chooseGroups(cells: ParisCell[], radius: number): PlacedGroup[] {
  if (cells.length === 1) return [bestGroup(cells, [0], 2 * radius)];
  const pitch = radius * 2.25;
  const forced = bestGroup(cells, cells.map((_, i) => i), pitch);
  if (cells.length > ENUM_GROUP_MAX) {
    let groups = cells.map((_, i) => bestGroup(cells, [i], pitch));
    const maxMerge = radius * 2;
    while (groups.length > 1) {
      let best: { i: number; j: number; merged: PlacedGroup; cost: number } | undefined;
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const merged = bestGroup(cells, [...groups[i].indexes, ...groups[j].indexes], pitch);
        const cost = merged.total - groups[i].total - groups[j].total;
        if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && (i < best.i || (i === best.i && j < best.j)))) {
          best = { i, j, merged, cost };
        }
      }
      if (!best || best.cost > maxMerge) break;
      groups = groups.filter((_, index) => index !== best.i && index !== best.j);
      groups.push(best.merged);
      groups.sort((a, b) => Math.min(...a.indexes) - Math.min(...b.indexes));
    }
    return groups;
  }
  const groupCost = Math.max(radius, forced.max * 0.5);
  let best: PlacedGroup[] | undefined;
  let bestCost = Infinity;
  let bestParts = Infinity;
  let index = 0, bestIndex = Infinity;
  for (const partition of setPartitions(cells.length)) {
    const groups = partition.map((part) => bestGroup(cells, part, pitch));
    const rects = groups.map((group) => groupRect(group, radius));
    let overlapCount = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      if (overlaps(rects[i], rects[j], radius * 0.2)) overlapCount++;
    }
    const cost = groups.reduce((sum, group) => sum + group.total, 0) + (groups.length - 1) * groupCost + overlapCount * OVERLAP_PENALTY;
    if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && (groups.length < bestParts || (groups.length === bestParts && index < bestIndex)))) {
      best = groups;
      bestCost = cost;
      bestParts = groups.length;
      bestIndex = index;
    }
    index++;
  }
  return best ?? [forced];
}

function octilinearConnector(a: Pixel, b: Pixel): Pixel[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.abs(dx) < 1e-7 || Math.abs(dy) < 1e-7 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7) return [[a[0], a[1]], [b[0], b[1]]];
  let best: { point: Pixel; length: number; i: number; j: number } | undefined;
  for (let i = 0; i < OCTI_DIRS.length; i++) {
    const u = OCTI_DIRS[i];
    for (let j = 0; j < OCTI_DIRS.length; j++) {
      const v = OCTI_DIRS[j];
      const det = u[0] * v[1] - u[1] * v[0];
      if (Math.abs(det) < 1e-9) continue;
      const t = (dx * v[1] - dy * v[0]) / det;
      const s = (dy * u[0] - dx * u[1]) / det;
      if (t < -1e-9 || s < -1e-9) continue;
      const length = t + s;
      if (!best || length < best.length - 1e-9 || (Math.abs(length - best.length) <= 1e-9 && (i < best.i || (i === best.i && j < best.j)))) {
        best = { point: [a[0] + t * u[0], a[1] + t * u[1]], length, i, j };
      }
    }
  }
  return best ? [[a[0], a[1]], best.point, [b[0], b[1]]] : [[a[0], a[1]], [b[0], b[1]]];
}

function connectGroups(groups: ParisGroup[]): ParisConnector[] {
  if (groups.length <= 1) return [];
  const inTree = new Array(groups.length).fill(false);
  inTree[0] = true;
  const out: ParisConnector[] = [];
  for (let added = 1; added < groups.length; added++) {
    let best: { from: number; to: number; a: Pixel; b: Pixel; distance: number } | undefined;
    for (let i = 0; i < groups.length; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < groups.length; j++) {
        if (inTree[j]) continue;
        for (const a of groups[i].points) for (const b of groups[j].points) {
          const d = dist(a, b);
          if (!best || d < best.distance - 1e-9 || (Math.abs(d - best.distance) <= 1e-9 && (i < best.from || (i === best.from && j < best.to)))) {
            best = { from: i, to: j, a, b, distance: d };
          }
        }
      }
    }
    if (!best) break;
    inTree[best.to] = true;
    out.push({ points: octilinearConnector(best.a, best.b).map(qPoint) });
  }
  return out;
}

function solveStation(marks: StopMark[], radius: number, lineWidth: number): ParisStation {
  const cells = chooseCells(marks, radius, lineWidth);
  const placed = chooseGroups(cells, radius);
  for (const group of placed) {
    group.indexes.forEach((cellIndex, i) => {
      cells[cellIndex].at = qPoint(group.centers.get(cellIndex)!);
      cells[cellIndex].shape = i === 0 || i === group.indexes.length - 1 ? 'round' : 'square';
    });
  }
  const groups: ParisGroup[] = placed.map((group) => ({
    axis: group.axis,
    cellIndexes: [...group.indexes],
    points: group.indexes.map((cellIndex) => cells[cellIndex].at),
  }));
  let x = 0, y = 0;
  for (const cell of cells) { x += cell.at[0]; y += cell.at[1]; }
  return {
    interchange: marks.length > 1,
    radius,
    cells,
    groups,
    connectors: connectGroups(groups),
    ends: [],
    anchor: qPoint([x / cells.length, y / cells.length]),
  };
}

/** Compute all marker, capsule, connector, and route-end geometry for this
 *  station design. The result is plain data and may be serialized directly. */
export function computeParisByNode(
  stops: Map<string, StopMark[]>,
  lineWidth: number,
  segsByLine?: Map<string, Array<[Pixel, Pixel]>>,
  lineGap: number = LINE_GAP,
): Map<string, ParisStation> {
  const dotRadius = MARK_R0 * MARKER_SCALE;
  const widths = capsuleStrokeWidthsFor(dotRadius, STATION_SCALE);
  const minimumBundleWidth = 2 * lineWidth + lineGap;
  const bundleFit = widths.border > 0 ? Math.min(1, minimumBundleWidth / widths.border) : 1;
  const radius = (widths.fill / 2) * bundleFit;
  const out = new Map<string, ParisStation>();
  const seatedStops = new Map<string, StopMark[]>();
  for (const nodeId of [...stops.keys()].sort()) {
    const marks = [...(stops.get(nodeId) ?? [])].sort((a, b) => a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    if (marks.length === 0) continue;
    const station = solveStation(marks, radius, lineWidth);
    out.set(nodeId, station);
    const atByLine = new Map<string, Pixel>();
    for (const cell of station.cells) for (const lineId of cell.lineIds) atByLine.set(lineId, cell.at);
    seatedStops.set(nodeId, marks.map((mark) => {
      const at = atByLine.get(mark.lineId) ?? mark.pos;
      return { ...mark, pos: [at[0], at[1]] };
    }));
  }
  const obstacles = [...out.values()].flatMap((station) => station.cells.map((cell) => ({
    at: cell.at,
    r: station.radius,
  })));
  const endsByNode = computeDcByNode(seatedStops, segsByLine, undefined, obstacles);
  for (const [nodeId, station] of out) station.ends = (endsByNode.get(nodeId)?.ends ?? []).map((end) => ({
    lineId: end.lineId,
    cut: [end.cut[0], end.cut[1]],
    at: [end.at[0], end.at[1]],
  }));
  return out;
}
