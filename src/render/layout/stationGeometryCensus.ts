import { LINE_GAP, LINE_WIDTH } from '../constants';
import { insetShape, type CropShape } from '../laneCrop';
import type { DirectBubbleCropTarget } from './directBubbleCrops';
import { parisBorderRadius, type ParisStation } from './parisCapsules';
import type { StopMark } from './types';

export interface StationGeometryViolation {
  kind: 'parallel-bubble' | 'bundle-width' | 'missing-crop' | 'bad-crop';
  nodeId: string;
  lineIds: string[];
  detail: string;
}

export interface StationGeometryCensus {
  stations: number;
  cells: number;
  directEndpoints: number;
  violations: StationGeometryViolation[];
}

export interface StationGeometryCensusInput {
  stopsByNode: ReadonlyMap<string, StopMark[]>;
  parisByNode: ReadonlyMap<string, ParisStation>;
  cropTargetsByRegime: ReadonlyMap<string, DirectBubbleCropTarget[]>;
  croppedLaneByLine: ReadonlyMap<string, ReadonlyMap<string, string>>;
  lineWidth?: number;
  lineGap?: number;
}

const pathEndpoints = (d: string): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (const subpath of d.split(/(?=M)/)) {
    if (!subpath.startsWith('M')) continue;
    const points = [...subpath.matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?),(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)]
      .map((match): [number, number] => [Number(match[1]), Number(match[2])]);
    if (points.length) {
      out.push(points[0]);
      if (points.length > 1) out.push(points[points.length - 1]);
    }
  }
  return out;
};

const boundaryError = (point: [number, number], shape: CropShape): number => {
  if (shape.kind === 'disc') {
    const dx = point[0] - shape.cx, dy = point[1] - shape.cy;
    return Math.abs(Math.sqrt(dx * dx + dy * dy) - shape.r);
  }
  const insideX = point[0] >= shape.x0 && point[0] <= shape.x1;
  const insideY = point[1] >= shape.y0 && point[1] <= shape.y1;
  if (insideX && insideY) return Math.min(
    Math.abs(point[0] - shape.x0), Math.abs(point[0] - shape.x1),
    Math.abs(point[1] - shape.y0), Math.abs(point[1] - shape.y1),
  );
  const dx = point[0] < shape.x0 ? shape.x0 - point[0] : point[0] > shape.x1 ? point[0] - shape.x1 : 0;
  const dy = point[1] < shape.y0 ? shape.y0 - point[1] : point[1] > shape.y1 ? point[1] - shape.y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
};

/** Audit invariants shared by the compact capsule and direct-bubble geometry. */
export function censusStationGeometry(input: StationGeometryCensusInput): StationGeometryCensus {
  const lineWidth = input.lineWidth ?? LINE_WIDTH;
  const lineGap = input.lineGap ?? LINE_GAP;
  const violations: StationGeometryViolation[] = [];
  let cells = 0;

  for (const [nodeId, station] of input.parisByNode) {
    const marks = input.stopsByNode.get(nodeId) ?? [];
    const byLine = new Map(marks.map((mark) => [mark.lineId, mark]));
    cells += station.cells.length;
    for (const cell of station.cells) {
      if (cell.lineIds.length < 2) continue;
      const axes = new Set(cell.lineIds
        .map((lineId) => byLine.get(lineId)?.axis)
        .filter((axis): axis is number => axis != null)
        .map((axis) => ((axis % 4) + 4) % 4));
      if (axes.size < 2) violations.push({
        kind: 'parallel-bubble', nodeId, lineIds: [...cell.lineIds],
        detail: `normalizedAxes=${[...axes].join(',')}`,
      });
    }
    if (marks.length > 1) {
      const bundleWidth = marks.length * lineWidth + (marks.length - 1) * lineGap;
      const capsuleWidth = 2 * (station.radius + parisBorderRadius(station.radius));
      if (capsuleWidth > bundleWidth + 1e-6) violations.push({
        kind: 'bundle-width', nodeId, lineIds: marks.map((mark) => mark.lineId).sort(),
        detail: `capsule=${capsuleWidth.toFixed(3)} bundle=${bundleWidth.toFixed(3)}`,
      });
    }
  }

  let directEndpoints = 0;
  for (const regime of ['pill', 'toronto', 'dc', 'paris']) {
    const lanes = input.croppedLaneByLine.get(regime);
    for (const target of input.cropTargetsByRegime.get(regime) ?? []) {
      if (target.shared) continue;
      directEndpoints++;
      const d = lanes?.get(target.lineId);
      if (!d) {
        violations.push({
          kind: 'missing-crop', nodeId: target.flagNode, lineIds: [target.lineId],
          detail: `regime=${regime}`,
        });
        continue;
      }
      const shape = insetShape(target.shape, lineWidth / 2);
      let error = Infinity;
      let nearest: [number, number] | undefined;
      for (const point of pathEndpoints(d)) {
        const candidate = boundaryError(point, shape);
        if (candidate < error) { error = candidate; nearest = point; }
      }
      if (error > 0.15) violations.push({
        kind: 'bad-crop', nodeId: target.flagNode, lineIds: [target.lineId],
        detail: `regime=${regime} boundaryError=${Number.isFinite(error) ? error.toFixed(3) : 'none'}` +
          ` nearest=${nearest ? nearest.map((v) => v.toFixed(1)).join(',') : 'none'} shape=${JSON.stringify(shape)}`,
      });
    }
  }
  return { stations: input.parisByNode.size, cells, directEndpoints, violations };
}
