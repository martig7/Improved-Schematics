/**
 * Placement: design-agnostic station geometry. Given the solved marks for a
 * node, produce a StopScene (dot data + capsule shape). No colors, no painting.
 * Ported from the geometry half of the former render/stops.ts.
 */

import type { Pixel, StopMark } from '../layout/types';
import { MARKER_SCALE, MARK_R0, STATION_SCALE, onRenderScale } from '../constants';
import { type RectCapsule } from '../layout/rectSeat';
import { type LondonCapsule } from '../layout/londonBubbles';
import { type DcStation } from '../layout/dcStations';
import { type ParisStation } from '../layout/parisCapsules';
import type { StopScene, StopLine, Capsule, Point } from './types';

let R0 = MARK_R0;
let RCAP = R0 * MARKER_SCALE;
onRenderScale(() => { R0 = MARK_R0; RCAP = R0 * MARKER_SCALE; });

export interface PlacementCtx {
  /** Interchange capsule regime the active design wants. 'rectRows' triggers the
   *  upright-box rectangle seating for multi-line, non-mega stations;
   *  'londonBubbles' the paired ticket-hall bubbles; 'toronto' and 'dc' the
   *  crossing collapse (perfect intersections become one ring, else a pill). The
   *  two crossing regimes differ in what the ring scene carries: see the branch. */
  capsuleMode?: 'pill' | 'rectRows' | 'londonBubbles' | 'toronto' | 'dc' | 'paris';
  /** Precomputed rectangle-capsule geometry per node (seated + cross-station
   *  deconflicted at compute time). Read only in the 'rectRows' branch; when a
   *  node has an entry the scene is built from it with no draw-time seating. */
  rectByNode?: Map<string, RectCapsule>;
  /** Precomputed rescued marker position of each single Tokyu stop. Read only in
   *  the 'rectRows' branch; when set for a single stop the box is placed there. */
  tokyuStopPos?: Map<string, [number, number]>;
  /** Precomputed London bubble-chain geometry per node. Read only in the
   *  'londonBubbles' branch; when a node has an entry the scene is built from it. */
  bubbleByNode?: Map<string, LondonCapsule>;
  /** Precomputed direct-intersection centers per node. Read only in the crossing
   *  branch; a node with an entry collapses to one mark at the junction. */
  torontoByNode?: Map<string, { cx: number; cy: number }>;
  /** Precomputed DC Metro station geometry per node: its marks and its line-end
   *  symbols, seated against the whole map. Read only in the 'dc' branch. */
  dcByNode?: Map<string, DcStation>;
  /** Precomputed four-axis capsule and endpoint geometry. */
  parisByNode?: Map<string, ParisStation>;
}

const toLine = (mk: StopMark): StopLine => ({
  lineId: mk.lineId,
  color: mk.color,
  bullet: mk.name ?? '',
  textColor: mk.textColor ?? '',
  pos: [mk.pos[0], mk.pos[1]],
  chain: mk.chain ?? 0,
  seq: mk.seq,
  axis: mk.axis,
  dir: mk.dir ? [mk.dir[0], mk.dir[1]] : undefined,
  terminus: mk.terminus,
  outward: mk.outward ? [mk.outward[0], mk.outward[1]] : undefined,
  end: mk.end ? [mk.end[0], mk.end[1]] : undefined,
});

// Repaint memo of the pure mark-geometry pieces of a scene. Marks are final
// when paint starts and the cached geometry reuses the SAME array objects
// across repaints, so the array identity keys everything that depends only on
// mark positions: the farthest-pair axis and the pill spine. The scene assembly
// itself stays live because it reads the draw-time capsuleMode. A deserialized
// cache has fresh array identities and simply refills the memo on its first paint.
interface SceneGeom {
  ai: number;    // farthest-pair axis start index
  best: number;  // farthest-pair separation
  pill?: { points: Point[]; anchor: Point };
}
const sceneGeomMemo = new WeakMap<StopMark[], SceneGeom>();

export function buildScene(nodeId: string, marks: StopMark[], ctx: PlacementCtx): StopScene {
  const isCapsule = marks.length > 1;
  const dotRadius = isCapsule ? RCAP : R0;
  const lines = marks.map(toLine);

  const paris = ctx.capsuleMode === 'paris' ? ctx.parisByNode?.get(nodeId) : undefined;
  if (paris) {
    const atByLine = new Map<string, Point>();
    for (const cell of paris.cells) for (const lineId of cell.lineIds) atByLine.set(lineId, [cell.at[0], cell.at[1]]);
    const seatedLines = lines.map((line) => ({ ...line, pos: atByLine.get(line.lineId) ?? line.pos }));
    return {
      nodeId,
      lines: seatedLines,
      capsule: {
        kind: 'paris',
        interchange: paris.interchange,
        radius: paris.radius,
        cells: paris.cells.map((cell) => ({
          at: [cell.at[0], cell.at[1]],
          lineIds: [...cell.lineIds],
          endpointLineIds: [...cell.endpointLineIds],
          shape: cell.shape,
        })),
        groups: paris.groups.map((group) => ({
          axis: group.axis,
          cellIndexes: [...group.cellIndexes],
          points: group.points.map((point): Point => [point[0], point[1]]),
        })),
        connectors: paris.connectors.map((connector) => ({
          points: connector.points.map((point): Point => [point[0], point[1]]),
        })),
        ends: paris.ends.map((end) => ({
          lineId: end.lineId,
          cut: [end.cut[0], end.cut[1]],
          at: [end.at[0], end.at[1]],
        })),
      },
      anchor: [paris.anchor[0], paris.anchor[1]],
      dotRadius,
    };
  }

  // Rectangle ("Tokyu") seating: a multi-line station uses its compute-time
  // seated, cross-station-deconflicted rect capsule when one is cached, mega
  // interchanges included (they get a compact grid of numbered boxes rather than
  // an opaque cover). Seating is never done at draw time, so a cache miss falls
  // through to the normal pill / mega / ring / none paths. Single stops fall
  // through to the none path below.
  const cachedRect = ctx.capsuleMode === 'rectRows' && isCapsule
    ? ctx.rectByNode?.get(nodeId)
    : undefined;
  if (cachedRect) {
    const byLine = new Map(cachedRect.centers.map((c) => [c.lineId, [c.x, c.y] as Point]));
    const rlines = lines.map((ln) => ({ ...ln, pos: byLine.get(ln.lineId) ?? ln.pos }));
    let cx = 0, cy = 0;
    for (const c of cachedRect.centers) { cx += c.x; cy += c.y; }
    const n = cachedRect.centers.length || 1;
    const groups = cachedRect.groups.map((g) => ({ ...g }));
    const connectors = cachedRect.connectors.map((cn) => ({ points: cn.points.map((p): Point => [p[0], p[1]]) }));
    return { nodeId, lines: rlines, capsule: { kind: 'rectRows', box: cachedRect.box, groups, connectors, necks: cachedRect.necks }, anchor: [cx / n, cy / n], dotRadius };
  }

  // London bubbles: a multi-line station uses its compute-time bubble chain when
  // one is cached. Mega interchanges have no entry and fall through to the mega
  // box below; single stops fall through to the none path (a tick).
  const cachedBubble = ctx.capsuleMode === 'londonBubbles' && isCapsule
    ? ctx.bubbleByNode?.get(nodeId)
    : undefined;
  if (cachedBubble) {
    const bubbles = cachedBubble.bubbles.map((b) => ({ ...b }));
    const necks = cachedBubble.necks.map((n) => ({ ...n }));
    let cx = 0, cy = 0;
    for (const b of bubbles) { cx += b.x; cy += b.y; }
    const n = bubbles.length || 1;
    return { nodeId, lines, capsule: { kind: 'londonBubbles', bubbles, necks }, anchor: [cx / n, cy / n], dotRadius };
  }

  // Direct intersection: the solved point where a node's lines truly cross, over
  // the drawn ribbons. The two crossing regimes consume it differently.
  //
  // 'toronto' COVERS the junction with a capsule-sized disc, so the node collapses
  // to that disc outright: the lanes underneath need no separate treatment and the
  // scene drops them.
  //
  // 'dc' marks a junction as a point, which only speaks for the lanes that point
  // stands on. It therefore cannot collapse: it needs the lanes AND the capsule
  // spine, so that a station spread wider than one mark can be drawn along its
  // capsule instead. The crossing rides along on the pill for it to use when the
  // lanes do meet tightly enough.
  const isCross = ctx.capsuleMode === 'toronto' || ctx.capsuleMode === 'dc';
  const cross = isCross && isCapsule ? ctx.torontoByNode?.get(nodeId) : undefined;
  if (cross && ctx.capsuleMode === 'toronto') {
    return { nodeId, lines: [], capsule: { kind: 'ring', cx: cross.cx, cy: cross.cy, r: R0 + 3 * STATION_SCALE }, anchor: [cross.cx, cross.cy], dotRadius };
  }

  // DC Metro: marks and line-end symbols are solved over the whole map, since a
  // symbol must keep clear of lines and stations this scene cannot see. The scene
  // carries the solved geometry; the design only draws it.
  const dc = ctx.capsuleMode === 'dc' ? ctx.dcByNode?.get(nodeId) : undefined;
  if (dc) {
    const dmarks = dc.marks.map((m) => ({ at: [m.at[0], m.at[1]] as Point, r: m.r, ring: m.ring, lineId: m.lineId }));
    const ends = dc.ends.map((e) => ({ lineId: e.lineId, cut: [e.cut[0], e.cut[1]] as Point, at: [e.at[0], e.at[1]] as Point }));
    let cx = 0, cy = 0;
    for (const m of dmarks) { cx += m.at[0]; cy += m.at[1]; }
    const n = dmarks.length || 1;
    // The capsule spine ties several marks together, so it is only carried when
    // there is more than one. It is the solver's exact chain: every dot, plus each
    // elbow vertex it emitted at a bundle bend.
    let spine: Point[] | undefined;
    if (dmarks.length > 1) {
      spine = [];
      for (const mk of [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0))) {
        spine.push([mk.pos[0], mk.pos[1]]);
        if (mk.cornerAfter) spine.push([mk.cornerAfter[0], mk.cornerAfter[1]]);
      }
    }
    return { nodeId, lines, capsule: { kind: 'dcMarks', marks: dmarks, ends, spine }, anchor: cross ? [cross.cx, cross.cy] : [cx / n, cy / n], dotRadius };
  }

  // farthest pair: axis start (a) + max separation (best); memoized on the
  // marks array (positions are final for the life of the cached geometry)
  let gm = sceneGeomMemo.get(marks);
  if (!gm) {
    let ai = 0;
    let best = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const d = Math.sqrt((marks[i].pos[0] - marks[j].pos[0]) ** 2 + (marks[i].pos[1] - marks[j].pos[1]) ** 2);
        if (d > best) { best = d; ai = i; }
      }
    }
    gm = { ai, best };
    sceneGeomMemo.set(marks, gm);
  }
  const best = gm.best;
  const a = marks[gm.ai].pos;

  if (!isCapsule) {
    // A single Tokyu stop uses its compute-time rescued position (deconflicted
    // against interchange capsules and other singles) when one is cached; the box
    // draws at the line's pos, so override both. Other designs never reach here
    // with a rectRows capsuleMode, so their singles keep the raw mark position.
    const rescued = ctx.capsuleMode === 'rectRows' ? ctx.tokyuStopPos?.get(nodeId) : undefined;
    const p: Point = rescued ? [rescued[0], rescued[1]] : [a[0], a[1]];
    const slines = rescued ? lines.map((ln) => ({ ...ln, pos: [p[0], p[1]] as Point })) : lines;
    return { nodeId, lines: slines, capsule: { kind: 'none' }, anchor: p, dotRadius };
  }

  if (best < 1e-3) {
    return { nodeId, lines, capsule: { kind: 'ring', cx: a[0], cy: a[1], r: R0 + 3 * STATION_SCALE }, anchor: [a[0], a[1]], dotRadius };
  }

  if (!gm.pill) {
    const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
    // The spine is the solver's exact chain: every dot, plus each elbow vertex
    // it emitted at a bundle bend. No simplification, so every dot sits on the
    // capsule centerline (and on the connector) and the solver's octilinear
    // bends are preserved. (RDP would flatten a shallow-but-real bend and float
    // its dot off-centre.)
    const spine: Point[] = [];
    for (const mk of ordered) {
      spine.push([mk.pos[0], mk.pos[1]]);
      if (mk.cornerAfter) spine.push([mk.cornerAfter[0], mk.cornerAfter[1]]);
    }
    const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
    const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
    gm.pill = { points: spine, anchor: [cx, cy] };
  }
  // Defensive copies, mirroring the cachedRect branch (see the mega variant). The
  // solved crossing rides along when one was found, and the anchor follows it, so a
  // node that reads as a single point still anchors its label there.
  return {
    nodeId,
    lines,
    capsule: { kind: 'pill', points: gm.pill.points.map((p): Point => [p[0], p[1]]), smooth: false, ...(cross ? { cross: [cross.cx, cross.cy] as Point } : {}) },
    anchor: cross ? [cross.cx, cross.cy] : [gm.pill.anchor[0], gm.pill.anchor[1]],
    dotRadius,
  };
}
