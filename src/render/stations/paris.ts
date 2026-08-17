import type { Glyph, Point, StationDesign, StopScene } from './types';
import { circle, capsuleGlyphs, pillPath } from './primitives';
import { axisUnit } from '../layout/londonBubbles';
import { lineEndGlyphs } from './lineEnds';
import { parisBorderRadius } from '../layout/parisCapsules';

const INK = '#111111';
const PAPER = '#ffffff';

const f = (n: number): string => n.toFixed(1);

function polygon(points: Point[], fill: string): Glyph {
  const d = 'M ' + points.map((point) => f(point[0]) + ' ' + f(point[1])).join(' L ') + ' Z';
  return { kind: 'path', d, fill, stroke: 'none', strokeWidth: 0, lineCap: 'round', lineJoin: 'round' };
}

function squareFills(at: Point, axis: number, radius: number, colors: string[]): Glyph[] {
  const [ux, uy] = axisUnit(axis);
  const nx = -uy, ny = ux;
  return colors.map((color, i) => {
    const a0 = -radius + (2 * radius * i) / colors.length;
    const a1 = -radius + (2 * radius * (i + 1)) / colors.length;
    return polygon([
      [at[0] + a0 * ux + radius * nx, at[1] + a0 * uy + radius * ny],
      [at[0] + a1 * ux + radius * nx, at[1] + a1 * uy + radius * ny],
      [at[0] + a1 * ux - radius * nx, at[1] + a1 * uy - radius * ny],
      [at[0] + a0 * ux - radius * nx, at[1] + a0 * uy - radius * ny],
    ], color);
  });
}

function roundFills(at: Point, axis: number, radius: number, colors: string[]): Glyph[] {
  if (colors.length === 1) return [circle(at[0], at[1], radius, { fill: colors[0], stroke: 'none', strokeWidth: 0 })];
  if (colors.length === 2) {
    const [ux, uy] = axisUnit(axis);
    const a: Point = [at[0] - ux * radius, at[1] - uy * radius];
    const b: Point = [at[0] + ux * radius, at[1] + uy * radius];
    const first = `M ${f(a[0])} ${f(a[1])} A ${f(radius)} ${f(radius)} 0 0 1 ${f(b[0])} ${f(b[1])} L ${f(a[0])} ${f(a[1])} Z`;
    const second = `M ${f(b[0])} ${f(b[1])} A ${f(radius)} ${f(radius)} 0 0 1 ${f(a[0])} ${f(a[1])} L ${f(b[0])} ${f(b[1])} Z`;
    return [first, second].map((d, i): Glyph => ({ kind: 'path', d, fill: colors[i], stroke: 'none', strokeWidth: 0, lineCap: 'round', lineJoin: 'round' }));
  }
  // More than two coincident endings are rare. A compact rotated stripe block
  // keeps every route color visible while remaining inside the round cell.
  return squareFills(at, axis, radius * 0.7, colors);
}

function endpointFills(scene: StopScene): Glyph[] {
  if (scene.capsule.kind !== 'paris') return [];
  const byLine = new Map(scene.lines.map((line) => [line.lineId, line]));
  const axisByCell = new Map<number, number>();
  for (const group of scene.capsule.groups) for (const cellIndex of group.cellIndexes) axisByCell.set(cellIndex, group.axis);
  const out: Glyph[] = [];
  scene.capsule.cells.forEach((cell, cellIndex) => {
    const colors = cell.endpointLineIds
      .map((lineId) => byLine.get(lineId)?.color)
      .filter((color): color is string => color != null);
    if (colors.length === 0) return;
    const radius = scene.capsule.radius * 0.58;
    const axis = axisByCell.get(cellIndex) ?? 0;
    out.push(...(cell.shape === 'round'
      ? roundFills(cell.at, axis, radius, colors)
      : squareFills(cell.at, axis, radius, colors)));
  });
  return out;
}

function paintParis(scene: StopScene, ctx: Parameters<StationDesign['paint']>[1]): Glyph[] {
  const cap = scene.capsule;
  if (cap.kind !== 'paris') {
    if (scene.lines.length <= 1) {
      const line = scene.lines[0];
      return line ? [circle(line.pos[0], line.pos[1], scene.dotRadius, { fill: line.color, stroke: 'none', strokeWidth: 0 })] : [];
    }
    return capsuleGlyphs(cap, { border: INK, fill: PAPER }, scene.dotRadius);
  }

  const endpointGlyphs = lineEndGlyphs(scene.lines, cap.ends, ctx);
  const g: Glyph[] = [...endpointGlyphs.tailCasings, ...endpointGlyphs.tailCores];
  const border = parisBorderRadius(cap.radius, scene.dotRadius);
  const connectorWidth = cap.radius * 0.72;
  const pathGlyph = (points: Point[], stroke: string, strokeWidth: number): Glyph => ({
    kind: 'path', d: pillPath(points, false), fill: 'none', stroke, strokeWidth,
    lineCap: 'round', lineJoin: 'round',
  });

  if (!cap.interchange && cap.cells[0]?.endpointLineIds.length === 0) {
    const line = scene.lines[0];
    if (line) g.push(circle(cap.cells[0].at[0], cap.cells[0].at[1], cap.radius, { fill: line.color, stroke: 'none', strokeWidth: 0 }));
    g.push(...endpointGlyphs.badges);
    return g;
  }

  for (const connector of cap.connectors) g.push(pathGlyph(connector.points, INK, connectorWidth + 2 * border));
  for (const group of cap.groups) {
    if (group.points.length === 1) g.push(circle(group.points[0][0], group.points[0][1], cap.radius + border, { fill: INK, stroke: 'none', strokeWidth: 0 }));
    else g.push(pathGlyph(group.points, INK, 2 * (cap.radius + border)));
  }
  for (const connector of cap.connectors) g.push(pathGlyph(connector.points, PAPER, connectorWidth));
  for (const group of cap.groups) {
    if (group.points.length === 1) g.push(circle(group.points[0][0], group.points[0][1], cap.radius, { fill: PAPER, stroke: 'none', strokeWidth: 0 }));
    else g.push(pathGlyph(group.points, PAPER, 2 * cap.radius));
  }
  g.push(...endpointFills(scene), ...endpointGlyphs.badges);
  return g;
}

export const paris: StationDesign = {
  id: 'paris',
  name: 'Paris',
  capsule: 'paris',
  paint: paintParis,
  previewKind: 'interchange',
};
