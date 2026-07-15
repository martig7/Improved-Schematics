# Octilinear + perpendicular label rotation (decluttering) — design

**Goal:** Let a station label rotate to an octilinear angle (0, 45, 90) so it can slot
into space a flat label cannot, cutting label/line/label overlaps in dense areas, while
keeping labels as close to flat as the geometry allows and fully sideways only as a last
resort.

**Status:** design approved (fork decisions recorded below). Not yet implemented.

---

## 1. Background: what the packer does today

`placeLabels` in `src/render/labels.ts` gives every station a **horizontal** label. For each
node it builds 8 candidate boxes (E/W side, N/S above/below, and 4 diagonal offset
positions, all with flat text), then greedily picks the lowest-cost box:

```
cost = 100·(label–label overlaps) + 30·(label–marker overlaps) + 12·(line crossings) + slotPriority
```

Nodes are placed longest-label-first so the hardest labels pick first. `renderLabel` emits a
plain horizontal `<text>`; nothing rotates. The entire vocabulary a label can take is eight
flat rectangles, so in a tight corridor every candidate collides and the packer just keeps
the least-bad overlap. That is the clutter this change targets.

## 2. Governing principle

> For each station, choose the octilinear text orientation that reads **closest to flat on
> screen**, offset it to **one side of the line** (along the line's perpendicular), and rotate
> away from flat **only as far as needed to escape a collision**, with fully sideways text
> (90 degrees on screen) as a strong last resort.

Orientation is decided **relative to the line**; readability is measured **relative to the
screen**. Separating those two frames is what reconciles "at a right angle to the line" with
"almost never completely sideways":

| Line through the station | Chosen label | Text angle on screen |
| --- | --- | --- |
| Horizontal | flat, parallel to the line | 0 degrees (best) |
| Diagonal (45) | flat if it fits; else 45 echoing the line | 0, else 45 |
| Vertical | flat, stuck out to the side **at a right angle to the line** | 0 degrees (best) |
| (any, fully boxed in) | sideways | 90 degrees (last resort) |

So "perpendicular" is what a vertical line naturally produces: a flat label offset sideways
off the track. It is not vertical text. Vertical text is the penalty case.

## 3. Fork decisions (from brainstorming)

1. **Angle set:** full octilinear (0, 45, 90) plus the line-relative "perpendicular" placement.
   135 never renders; it folds to -45 so text is never upside down.
2. **Diagonal default:** *flat when it fits.* A station on a 45 line stays horizontal unless a
   flat placement collides; only then does it rotate to 45. Rotation is a decluttering tool,
   not a house style.
3. **Eagerness:** aggressive declutter. Collision weights stay dominant so labels move freely
   to clear overlaps; the tilt penalty (below) is what keeps them near-flat and reserves
   sideways for genuine last resort.
4. **Same bundle, same side:** enforced by a **local neighbor bonus** made reliable by
   changing the greedy **placement order to a per-bundle walk** (so a station's on-bundle
   neighbor is already placed when its turn comes). No separate pre-pass.

## 4. Candidate set (per node)

For each node the packer enumerates candidates over two axes:

- **Text angle** from `{0, 45, 90}` on screen. 45 covers both screen diagonals (a candidate
  at -45 and one at +45); 90 is the sideways case. 135 is represented as -45.
- **Offset slot**: the label hung off the node's `labelAnchor`, displaced by `LABEL_OFFSET`
  along the **line's perpendicular** to one side, plus the along-line variants. Each angle
  gets a small set of slots (the two perpendicular sides, and for flat text the existing
  N/S/diagonal positions as today).

The flat (0) candidates reproduce today's 8-box set, so a sparse map that never needs to
rotate is geometrically unchanged (see Section 11 on determinism/legacy).

## 5. Scoring

Extends today's cost with three orientation-aware terms:

```
cost =  100·labelOverlaps + 30·markerOverlaps + 12·lineCrossings      (unchanged: declutter, dominant)
      +  tilt(screenAngle)                                            (near-flat preference)
      +  Wside·bundleSideMismatch                                     (same bundle, same side)
      +  slotBase(offset slot)                                        (sub-order within an orientation)
```

Initial constants (tunable at the visual checkpoint, rationale below):

| Term | Value |
| --- | --- |
| `tilt(0)` | 0 |
| `tilt(45)` = `tilt(-45)` | 4 |
| `tilt(90)` | 35 |
| `Wside` (side mismatch) | 5 |
| `slotBase` side / above / diagonal | 1 / 2 / 3 |

**Why these numbers.** The ladder of a *clean* (collision-free) candidate is
`flat-side(1) < flat-above(2) < flat-diagonal(3) < 45(≈5) < 90(≈36)`, so flat always wins when
it fits (fork 2). Against collisions:

- Escape a single **line crossing** (12): a clean 45 (≈5) beats the flat crossing (12), so a
  lone crossing declutters to 45, not sideways.
- Escape a **marker overlap** (30): a clean 45 (≈5) beats it; still handled at 45.
- Escape a **label–label overlap** (100): a clean 45 (≈5) beats it. Only if *every* 45 slot
  also overlaps a label does a clean 90 (≈36) win. That makes sideways a true last resort:
  it appears only to escape overprinting another label when no flatter angle is free.
- `tilt(90)=35 > 30` deliberately means a station will **tolerate a marker overlap rather
  than go sideways**; 45 is expected to resolve those first. This is the main knob for "how
  often do we see sideways text"; raise it to see sideways even less.

`Wside=5` breaks ties toward the bundle's chosen side among otherwise-equal candidates, but
never overrides a real collision (>=12), so a station still flips sides to avoid an overlap.

The existing `OCTI_LABEL_TIEBREAK` crowding term stays as an unscored final tiebreak.

## 6. Placement order and the neighbor bonus

**Order (replaces longest-label-first).** Derived inside `placeLabels` from `stopsByNode`
alone: every stop mark already carries its `lineId` and station `seq`, so invert them into a
per-line ordered stop-node list (sort each line's nodes by `seq`), walk the lines in a stable
id order, and emit each node the first time it is seen. Nodes with no `seq` (e.g. the
geographic caller's synthetic stops) fall back to today's longest-label-first at the end.
Effect: stations along one line are placed consecutively.

Trade-off to record: longest-first gave the hardest labels first pick of open space; the
bundle walk gives *consistency* first pick instead. With rotation available each label now
has far more slots, which offsets the loss. Flagged as a visual-checkpoint watch-item.

**Neighbor bonus.** "Side" needs no global bearing: the on-bundle predecessor's position
gives the local line direction, so `side = sign(cross(pos[n] − pos[prev], offset))` (which
side of the line the label sits on). When placing node S on bundle B, look up the side the
previously-placed node on B chose; a candidate whose side matches pays `0`, a candidate that
differs pays `Wside`. The first station on a bundle has no predecessor, so it picks the most
open side and seeds the ladder the rest inherit.

## 7. Inputs the packer needs

None new to the signature. `placeLabels` keeps `(graph, nodePx, stopsByNode, segments)` and
derives the bundle order and each node's on-bundle predecessor internally from `stopsByNode` +
`nodePx` (Section 6). The rotation on/off switch is read inside `placeLabels` via `envStr`,
exactly like the existing `OCTI_LABEL_TIEBREAK` / `OCTI_NO_LABEL_REANCHOR` knobs. When a
node has no `seq` (geographic synthetic stops) it falls back to today's flat, longest-first
behavior, so that caller needs no change and stays byte-identical on sparse maps.

Note: orientation needs no bearing either. "Flat for a vertical line" is not a special case;
the existing flat E/W candidates already place a horizontal label to the side of a vertical
line, and they win on the tilt term (0) whenever they fit. Bearing only ever mattered for the
side sign, which the predecessor direction now supplies.

## 8. Rotated-box geometry

A rotated label's true footprint is an oriented bounding box (OBB). Overlap tests use the
separating-axis theorem (SAT):

- `obbFromLabel(anchor, offset, w, h, angle)` builds the 4 corners from fixed `cos/sin`
  literals for the angle (only 0, ±45, 90 occur), so no runtime trig.
- `obbOverlap(a, b)` projects both boxes onto the 4 candidate axes (2 per box) and checks for
  a separating gap. For axis-aligned boxes (0/90) it reduces to the existing AABB result.
- `segmentIntersectsObb(p1, p2, obb)` generalizes today's `segmentIntersectsBox`.

Marker boxes and station boxes stay axis-aligned; only the label box can be an OBB. Crucially,
**a flat (angle 0) candidate keeps running the existing `boxesOverlap` / `segmentIntersectsBox`
code**, not the OBB path: a footprint is stored as `{ box, angle }` and OBB tests are used only
when a rotated box is involved. In legacy mode every box is angle 0, so the whole packer runs
the old code and is byte-identical by construction, not by a floating-point argument about SAT
reducing to AABB.

## 9. Rendering

- `Placement` gains `angle?: number` (default 0). `renderLabel` emits
  `transform="translate(x,y) rotate(angle)"` around the existing counter-scaled
  `imp-lbl-s` group, so the zoom/size behavior is unchanged and only the glyphs rotate.
- The scene-IR `TextPrim` gains an optional `angle` (default 0), applied by `sceneCanvas`
  (`ctx.rotate`) so canvas paint matches the SVG. Optional-and-defaulted fields mean no
  scene-schema bump and byte-identical output when `angle` is 0.
- Never-upside-down: a computed screen angle outside (-90, 90] is folded by 180 and the
  text-anchor flipped so reading direction stays left-to-right; 90 reads bottom-to-top.

## 10. Determinism

The pipeline must render byte-identical SVG across runs and cross-V8 (offline == in-game).
This design holds that: the only angles are `{0, ±45, 90}`, all fixed literal `cos/sin`
constants (no runtime `Math.cos`/`Math.sin`, no `Date.now`/`Math.random`); SAT uses only
multiply/add/compare on those literals and node coordinates; the argmin is a total order
(cost, then the existing crowding tiebreak, then enumeration). Placement stays memoized per
geometry as today.

## 11. Flags and legacy repro

`OCTI_LABEL_NO_ROTATE=1` restores the **entire** legacy path: rotation candidates suppressed
**and** longest-label-first order restored. With the flag on, output is byte-identical to the
pre-change renderer on the map dumps (the byte-identity gate for the non-feature path). The
flag lives behind `envStr` per the env-var rule, and its read self-gates like the existing
`OCTI_LABEL_TIEBREAK` / `OCTI_NO_LABEL_REANCHOR` switches.

## 12. Testing

- **Unit (`src/render/tests/labels.test.ts`)**: OBB overlap (flat OBB matches `boxesOverlap`;
  a 90 box is the flat box with w/h swapped; a 45 box separates/overlaps correctly);
  `segmentIntersectsObb` on a rotated box; a node boxed in horizontally chooses 45 before 90;
  a fully label-boxed node chooses 90; determinism (same input, same placement twice);
  `nodeBearing` absent falls back to flat; bundle order + side bonus keeps a run of stations
  on one side.
- **Visual checkpoint**: rasterize before/after on a dense dump (via the dev harness) at the
  decision point; confirm sideways labels are rare and bundle ladders are consistent; tune
  `tilt(90)` / `Wside` from what the render shows.
- **Legacy byte-identity**: with `OCTI_LABEL_NO_ROTATE=1`, the map dumps render byte-identical
  to master in both modes (`dev/_byte-identity.ts`).

## 13. Files touched

- `src/render/labelGeom.ts` *(new)* — OBB geometry and orientation math: `obbFromLocalBox`,
  `obbOverlap` (SAT), `segmentIntersectsObb`, `tilt`, fixed-angle `trig`.
- `src/render/labels.ts` — rotation-aware candidate generation, scoring, the internal
  bundle-order + predecessor derivation, the `{ box, angle }` footprint, `Placement.angle`,
  `renderLabel` rotation. Reads `OCTI_LABEL_NO_ROTATE` via `envStr`.
- `src/render/sceneIR.ts` — optional `angle` on `TextPrim` (default 0).
- `src/render/sceneCanvas.ts` — rotate the label prim by `angle` when painting.
- `src/render/tests/labelGeom.test.ts` *(new)* + `src/render/tests/labels.test.ts` — tests.

The renderers (`renderOctilinear.ts`, `renderGeographic.ts`) need no change: they already pass
each node's `placement` to `renderLabel`, which now honors `placement.angle`; `placeLabels`
keeps its signature.

## 14. Risks / watch-items

- **Order change churn.** Dropping longest-first changes greedy outcomes even before any
  rotation; watch dense maps for a long label getting boxed into a worse slot.
- **Too many sideways labels.** If the render shows sideways text more than rarely, raise
  `tilt(90)`; it is the designed knob.
- **Bearing at interchanges.** A node on several non-collinear edges has an ambiguous bearing;
  the dominant-incident-edge choice must be deterministic (stable tiebreak by edge id).
- **45 footprint honesty.** Fix at source with the true OBB (no inflated AABB fudge); a
  conservative AABB would reject 45 slots that actually fit and is explicitly rejected here.

## 15. Non-goals

- No label hiding/dropping. Decluttering is by placement and orientation only; every station
  still gets a label.
- No new render modes; geographic and smoothed only.
- No curved or along-path text; octilinear straight text only.

## 16. Follow-ups shipped on this branch

- **Aggression tuned.** `tilt(45)` lowered from 4 to 2 so a diagonal is reached for a touch
  more readily (still far below the collision weights); `tilt(90)=35` unchanged, so sideways
  stays a last resort (1 of ~500 labels on the densest dump).
- **Two-line wrapping for long names.** A name estimated wider than `LABEL_WRAP_W` (96px)
  wraps to two lines, split only at a space (never mid-word) at the point that balances the
  two lines; a name with no space or within the width stays one line. A wrapped label is
  narrower (max line width) and one line taller (the box grows down), so the packer treats it
  as a more compact footprint, cutting collisions and giving more room. It composes with
  rotation (a two-line block can be rotated). `renderLabel` emits the two lines as tspans and
  the canvas paints them with matching line spacing; single-line labels are byte-identical.

- **Single-dot anchor fix.** A single-dot stop's label hung off the graph-node centre
  (`nodePx`), but the drawn dot sits on its line's lane (bundle-slot offset, plus any slide),
  so the label floated off the marker by up to a bundle half-width (audited: NYC 130/306
  labels >2px off up to 16px, SEA 221/417 up to 20px). `labelAnchor` now returns the single
  dot's final position, collapsing the gap to 0 on both. Multi-dot capsules are unchanged.

- **Position (clearance) term.** A soft penalty for a candidate being merely CLOSE (within
  `CLEAR_MARGIN`, not overlapping) to already-placed labels, station markers, and line
  segments, weighted on the tilt scale (`W_CLEAR`) so it trades off against rotation. Labels
  drift into the clearer of two otherwise-equal spots. `boxSegGap` gives the box-to-line gap;
  segments are prefiltered per node. Replaces the old default-off crowding tie-break.

- **Side-aware multi-dot anchor.** A multi-dot capsule's label hangs off the OUTERMOST dot on
  the side it lands (the near end of the pill), not the empty cluster centre, so as the
  clearance term shifts it to the clearer side it stays tied to a real marker. Each candidate
  direction anchors to the dot with the largest projection along it.

- **Label-only adjacency term.** A sharper, closer-range penalty (`W_ADJ` over `ADJ_MARGIN`)
  for a candidate near an already-placed LABEL only, so two labels never crowd close enough to
  read as one. Heavier per-unit than the clearance term, so it overrides the side bonus rather
  than let labels stack for consistency. Built on the shared `encroachment` helper. Measured
  on the dense dumps it roughly halves label pairs closer than 6px (NYC 29->11, SEA 85->57,
  LON 30->13). `OCTI_LABEL_NO_ADJ=1` disables it.

**Legacy guarantee, preserved.** All of the above are gated by the single legacy switch
`OCTI_LABEL_NO_ROTATE=1` (which now means "all new label behaviour off"), so that flag still
reproduces master byte-for-byte. The intrinsic label-to-station lead is preserved throughout:
every candidate sits at a fixed offset from its anchor (now a real dot), so no scoring term
can stretch a label away from its marker.
