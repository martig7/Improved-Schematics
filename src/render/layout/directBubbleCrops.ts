import { STATION_SCALE, MARKER_SCALE, MARK_R0 } from '../constants';
import type { CropShape } from '../laneCrop';
import { capsuleStrokeWidths } from '../stations/primitives';
import type { DcStation } from './dcStations';
import { parisBorderRadius, type ParisStation } from './parisCapsules';
import type { StopMark } from './types';

export interface DirectBubbleCropTarget {
  lineId: string;
  flagNode: string;
  shape: CropShape;
  shared: boolean;
}

export interface DirectBubbleCropInput {
  stopsByNode: ReadonlyMap<string, StopMark[]>;
  torontoByNode: ReadonlyMap<string, { cx: number; cy: number }>;
  dcByNode: ReadonlyMap<string, DcStation>;
  parisByNode: ReadonlyMap<string, ParisStation>;
  isRouteTerminus: (lineId: string, flagNode: string) => boolean;
  isShared: (lineId: string, flagNode: string, nodeId: string) => boolean;
}

const push = (
  out: Map<string, DirectBubbleCropTarget[]>,
  regime: string,
  target: DirectBubbleCropTarget,
): void => {
  let targets = out.get(regime);
  if (!targets) out.set(regime, (targets = []));
  targets.push(target);
};

/** Build terminal-lane crop footprints for designs whose exact interchange is
 *  one opaque disc. The caller applies the targets to final lane geometry. */
export function directBubbleCropTargets(input: DirectBubbleCropInput): Map<string, DirectBubbleCropTarget[]> {
  const out = new Map<string, DirectBubbleCropTarget[]>();
  const nycWidths = capsuleStrokeWidths(MARK_R0 * MARKER_SCALE);
  const ringOuter = MARK_R0 + 3.75 * STATION_SCALE;

  for (const nodeId of [...input.stopsByNode.keys()].sort()) {
    const marks = [...(input.stopsByNode.get(nodeId) ?? [])]
      .sort((a, b) => a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    if (marks.length < 2) continue;
    const cross = input.torontoByNode.get(nodeId);
    const dc = input.dcByNode.get(nodeId);
    const paris = input.parisByNode.get(nodeId);
    const coincident = marks.every((mark) => {
      const dx = mark.pos[0] - marks[0].pos[0];
      const dy = mark.pos[1] - marks[0].pos[1];
      return dx * dx + dy * dy < 1e-6;
    });

    for (const mark of marks) {
      const flagNode = mark.flagNode ?? nodeId;
      if (!mark.terminus || !input.isRouteTerminus(mark.lineId, flagNode)) continue;
      const shared = input.isShared(mark.lineId, flagNode, nodeId);
      if (cross) {
        push(out, 'toronto', {
          lineId: mark.lineId, flagNode,
          shape: { kind: 'disc', cx: cross.cx, cy: cross.cy, r: nycWidths.border / 2 }, shared,
        });
        const dcMark = dc?.marks.find((candidate) => candidate.lineId === mark.lineId)
          ?? (dc?.marks.length === 1 && dc.marks[0].ring ? dc.marks[0] : undefined);
        if (dcMark) push(out, 'dc', {
          lineId: mark.lineId, flagNode,
          shape: { kind: 'disc', cx: dcMark.at[0], cy: dcMark.at[1], r: dcMark.r }, shared,
        });
      }
      const cell = paris?.cells.find((candidate) => candidate.lineIds.includes(mark.lineId));
      if (cell && cell.lineIds.length > 1) push(out, 'paris', {
        lineId: mark.lineId, flagNode,
        shape: { kind: 'disc', cx: cell.at[0], cy: cell.at[1], r: paris!.radius + parisBorderRadius(paris!.radius) }, shared,
      });
      if (coincident) push(out, 'pill', {
        lineId: mark.lineId, flagNode,
        shape: { kind: 'disc', cx: marks[0].pos[0], cy: marks[0].pos[1], r: ringOuter }, shared,
      });
    }
  }
  return out;
}
