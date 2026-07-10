# Tokyu square station design (prototype)

Status: approved (brainstorming), ready for implementation plan.
Date: 2026-07-06.

## Summary

Add a new selectable station design, **Tokyu** (id `tokyu`), modeled on Japanese
metro station signage: a rounded square filled with the route color, the route
bullet (e.g. `TY`) on top and the station number (e.g. `01`) below, in the
route's text color with a thin white keyline. An interchange draws one square
per stopping line. The station *name* stays on the existing label layer.

The station number is not a game field; it is derived as the station's 1-based
index in that route's ordered stop sequence (each line numbered independently).

This is a prototype: correctness on the common (group-node, ordered-route) case;
graceful fallbacks elsewhere.

## Station number derivation

A new pure helper computes the per-line stop ordering from data already on the
layout, so it uses the same node ids the markers carry (no group-vs-support-node
mismatch, no cross-module plumbing):

`render/layout/stopSeq.ts`
```ts
import type { Layout, TraversalStep } from './types';

/** For each line, the 1-based index of every node the line STOPS at, in
 *  traversal order. Key: `lineId + '|' + nodeId`. Pure. */
export function stopSeqMap(
  lineTraversals: Map<string, TraversalStep[]>,
  edges: Layout['edges'],
): Map<string, number> {
  const edgeById = new Map(edges.map((e) => [e.id, e] as const));
  const seq = new Map<string, number>();
  for (const [lineId, traversal] of lineTraversals) {
    const path: string[] = [];               // ordered node ids along the line
    const stops = new Set<string>();          // nodes where the line stops
    const push = (n: string) => { if (path[path.length - 1] !== n) path.push(n); };
    for (const step of traversal) {
      const e = edgeById.get(step.edgeId);
      if (!e) continue;
      const from = step.reversed ? e.to : e.from;
      const to = step.reversed ? e.from : e.to;
      push(from); push(to);
      const st = e.stops.get(lineId); // atFrom/atTo are relative to e.from/e.to
      if (st?.atFrom) stops.add(e.from);
      if (st?.atTo) stops.add(e.to);
    }
    let i = 0;
    for (const n of path) {
      if (!stops.has(n)) continue;
      const k = lineId + '|' + n;
      if (!seq.has(k)) seq.set(k, ++i); // first occurrence wins (loop lines)
    }
  }
  return seq;
}
```

`TraversalStep` (`{ edgeId, reversed }`) and the edge `stops: Map<lineId,
{atFrom, atTo}>` already exist. `atFrom`/`atTo` are relative to the edge's
`from`/`to` (unreversed), per `graph.ts`.

### Wiring the number to the marker

- `render/layout/types.ts`: `StopMark` gains `seq?: number`.
- `render/renderOctilinear.ts`, in `computeRibbonGeometry` (where `edgeById` and
  `layout.lineTraversals` are already available and the `addStop` closure builds
  `StopMark`s): compute `const seqByKey = stopSeqMap(layout.lineTraversals, layout.edges)`
  once, and in the `StopMark` push set `seq: seqByKey.get(lineId + '|' + nodeId)`.
  This is in the memoized geometry half, so it costs nothing per repaint and is
  not fingerprinted separately (derived from the same inputs).
- `render/stations/types.ts`: `StopLine` gains `seq?: number`.
- `render/stations/placement.ts`, `toLine`: `seq: mk.seq`.

Fallbacks: a line with no traversal, or a split-member node whose id is not in
the traversal, yields `undefined` → the square omits the number.

## The design (`render/stations/tokyu.ts`)

`paint(scene, ctx)` draws, per `scene.lines` entry, a rounded square centered at
`line.pos`. It ignores `scene.capsule` (squares are self-contained; a mega box
has empty `lines`, so nothing draws there). Uses shared `rect`/`text` primitives.

Geometry (side `s = 3 * scene.dotRadius`, center `c = line.pos`; the 3x makes the
square read as a box, bigger than a dot; in the preview `dotRadius = 12` → `s =
36`, matching the reference sign):
- square: `rect(cx - s/2, cy - s/2, s, s, s*0.19, { fill: line.color, stroke: 'none', strokeWidth: 0 })`.
- keyline: `rect(cx - s/2 + s*0.07, cy - s/2 + s*0.07, s*0.86, s*0.86, s*0.14, { fill: 'none', stroke: ink, strokeWidth: s*0.028 })`.
- bullet: `text(cx, cy - s*0.125, line.bullet, { fontSize: s*0.25, fill: ink, align: 'middle' })` (only when `ctx.showBullets && line.bullet`).
- number: `text(cx, cy + s*0.31, pad2(line.seq), { fontSize: s*0.44, fill: ink })`
  where `pad2(n)` = `String(n).padStart(2, '0')`, drawn only when `line.seq != null`.

`ink = line.textColor || '#ffffff'` (the route's text color, white default). The
keyline and text use the same `ink`.

Registered in `render/stations/index.ts`: `export const STATION_DESIGNS = [classic, nycSolid, nycMap, tokyu]` with `{ id: 'tokyu', name: 'Tokyu', paint }`.
`previewKind` defaults to `single`, so the tile is one square.

Note: the `rect` primitive currently has no `strokeWidth` rounding in the SVG
serializer and takes a fixed width; the square/keyline pass explicit widths, and
`glyphToPrim` rounds numeric fields (already fixed), so canvas/SVG stay in
agreement.

## Testing

- `render/layout/tests/stopSeq.test.ts`: a small hand-built `lineTraversals` +
  `edges` (a 3-stop line, and a 2-line case) asserts the 1-based indices and that
  a non-stop node is skipped; a shared node across two lines gets each line's own
  index.
- `render/stations/tests/designs.test.ts` (extend): `tokyu.paint` on a single
  scene with `seq: 1` yields a `rect` filled in the line color and a `text`
  containing `01`; with `seq` absent, no number text; `showBullets: false` omits
  the bullet.
- `render/stations/tests/index.test.ts` (extend): registry contains `tokyu`.

## File change list

- New: `src/render/layout/stopSeq.ts`, `src/render/layout/tests/stopSeq.test.ts`
- New: `src/render/stations/tokyu.ts`
- Modify: `src/render/layout/types.ts` (`StopMark.seq?`)
- Modify: `src/render/renderOctilinear.ts` (compute `seqByKey`, set `seq` on the
  `StopMark` push)
- Modify: `src/render/stations/types.ts` (`StopLine.seq?`)
- Modify: `src/render/stations/placement.ts` (`toLine` sets `seq`)
- Modify: `src/render/stations/index.ts` (register `tokyu`)
- Modify: `src/render/stations/tests/{designs,index}.test.ts`

## Out of scope / prototype limits

- Real-world line numbering (shared express/local numbers, fixed-terminus
  direction) is not reproduced; the number is per-route stop index.
- Split-station member nodes may miss the lookup (number omitted).
- The square uses a slightly larger footprint than a dot (`3 * dotRadius`);
  dense maps may show squares touching. Acceptable for the prototype.
