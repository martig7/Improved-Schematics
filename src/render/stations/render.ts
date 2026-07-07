import type { StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';
import type { RectCapsule } from '../layout/rectSeat';
import type { StationDesign, StopScene } from './types';
import { buildScene } from './placement';
import { rescueRectCapsules } from '../layout/rectRescue';
import { glyphsToSvg, glyphsToPrims, wrapMarker } from './serialize';

export interface RenderStationsCtx {
  dark: boolean;
  showBullets: boolean;
  megaFallback: 'box' | 'curve';
  members?: Map<string, number>;
  deg?: Map<string, number>;
  /** Precomputed rectangle-capsule geometry per node (seated + cross-station
   *  deconflicted at compute time). Read only by the rectangle-capsule design. */
  rectByNode?: Map<string, RectCapsule>;
  /** Precomputed rescued marker position of each single Tokyu stop. Read only by
   *  the rectangle-capsule design. */
  tokyuStopPos?: Map<string, [number, number]>;
}

/** Draw every station's marker with the chosen design. Returns the per-marker
 *  SVG fragments (already wrapped) and the flat stops-layer Prim list, both from
 *  one draw list per station. */
export function renderStations(
  stopsByNode: Map<string, StopMark[]>,
  ctx: RenderStationsCtx,
  design: StationDesign,
): { svg: string[]; prims: Prim[] } {
  const svg: string[] = [];
  const prims: Prim[] = [];

  // Phase 1: build every scene (design-agnostic geometry). For the rectangle
  // ("rectRows") design, buildScene reads the compute-time seated + cross-station
  // deconflicted capsules and single positions, so no draw-time seat or rescue
  // runs here. Other designs never pass rectByNode/tokyuStopPos through, so their
  // geometry is byte-identical.
  const built: Array<{ nodeId: string; marks: StopMark[]; scene: StopScene }> = [];
  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    const scene = buildScene(nodeId, marks, {
      megaFallback: ctx.megaFallback, members: ctx.members, deg: ctx.deg,
      capsuleMode: design.capsule, rectByNode: ctx.rectByNode, tokyuStopPos: ctx.tokyuStopPos,
    });
    built.push({ nodeId, marks, scene });
  }

  // Old-cache fallback: a pre-feature serialized geometry carries no rectByNode,
  // so buildScene seated each rect capsule on the fly WITHOUT the cross-station
  // rescue (which now runs at compute time). Restore the former draw-time rescue
  // for that case only. When rectByNode is present (the normal path) the rescue
  // already ran at compute, so this is skipped.
  if (ctx.rectByNode === undefined && design.capsule === 'rectRows') {
    rescueRectCapsules(built.map((b) => b.scene));
  }

  // Phase 2: paint each scene.
  for (const { nodeId, marks, scene } of built) {
    const glyphs = design.paint(scene, { dark: ctx.dark, showBullets: ctx.showBullets });
    const lineIds = marks.map((m) => m.lineId);
    svg.push(wrapMarker(scene.anchor, nodeId, lineIds, glyphsToSvg(glyphs)));
    for (const p of glyphsToPrims(glyphs)) prims.push(p);
  }
  return { svg, prims };
}
