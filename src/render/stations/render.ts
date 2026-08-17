import type { StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';
import type { RectCapsule } from '../layout/rectSeat';
import type { LondonCapsule } from '../layout/londonBubbles';
import type { DcStation } from '../layout/dcStations';
import type { ParisStation } from '../layout/parisCapsules';
import type { StationDesign, StopScene } from './types';
import { buildScene } from './placement';
import { glyphsToSvg, glyphsToPrims, wrapMarker } from './serialize';

export interface RenderStationsCtx {
  dark: boolean;
  showBullets: boolean;
  /** Precomputed rectangle-capsule geometry per node (seated + cross-station
   *  deconflicted at compute time). Read only by the rectangle-capsule design. */
  rectByNode?: Map<string, RectCapsule>;
  /** Precomputed rescued marker position of each single Tokyu stop. Read only by
   *  the rectangle-capsule design. */
  tokyuStopPos?: Map<string, [number, number]>;
  /** Precomputed London bubble-chain interchange geometry per node. Read only by
   *  the London design. */
  bubbleByNode?: Map<string, LondonCapsule>;
  /** Precomputed Toronto direct-intersection centers per node. Read only by the
   *  Toronto design. */
  torontoByNode?: Map<string, { cx: number; cy: number }>;
  /** Precomputed DC Metro station geometry per node. Read only by that design. */
  dcByNode?: Map<string, DcStation>;
  /** Precomputed four-axis capsule and endpoint geometry. */
  parisByNode?: Map<string, ParisStation>;
  /** The land colour the routes' casings use, so a design that continues a line
   *  can case it identically. */
  land?: string;
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
      capsuleMode: design.capsule, rectByNode: ctx.rectByNode, tokyuStopPos: ctx.tokyuStopPos,
      bubbleByNode: ctx.bubbleByNode, torontoByNode: ctx.torontoByNode, dcByNode: ctx.dcByNode,
      parisByNode: ctx.parisByNode,
    });
    built.push({ nodeId, marks, scene });
  }

  // Phase 2: paint each scene.
  for (const { nodeId, marks, scene } of built) {
    const glyphs = design.paint(scene, { dark: ctx.dark, showBullets: ctx.showBullets, land: ctx.land });
    const lineIds = marks.map((m) => m.lineId);
    svg.push(wrapMarker(scene.anchor, nodeId, lineIds, glyphsToSvg(glyphs)));
    for (const p of glyphsToPrims(glyphs)) prims.push(p);
  }
  return { svg, prims };
}
