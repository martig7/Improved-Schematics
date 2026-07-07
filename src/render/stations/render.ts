import type { StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';
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

  // Phase 1: build every scene (design-agnostic geometry).
  const built: Array<{ nodeId: string; marks: StopMark[]; scene: StopScene }> = [];
  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    const scene = buildScene(nodeId, marks, { megaFallback: ctx.megaFallback, members: ctx.members, deg: ctx.deg, capsuleMode: design.capsule });
    built.push({ nodeId, marks, scene });
  }

  // Phase 2: slide any overlapping rect ("rectRows") clusters apart. This
  // mutates only rectRows scenes; every other capsule kind is left untouched,
  // so non-rect designs emit identical geometry.
  rescueRectCapsules(built.map((b) => b.scene));

  // Phase 3: paint each (possibly rescued) scene.
  for (const { nodeId, marks, scene } of built) {
    const glyphs = design.paint(scene, { dark: ctx.dark, showBullets: ctx.showBullets });
    const lineIds = marks.map((m) => m.lineId);
    svg.push(wrapMarker(scene.anchor, nodeId, lineIds, glyphsToSvg(glyphs)));
    for (const p of glyphsToPrims(glyphs)) prims.push(p);
  }
  return { svg, prims };
}
