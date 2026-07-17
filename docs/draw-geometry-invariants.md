# Draw-level line geometry: census and invariants

How the smoothed renderer computes line geometry today, which of its passes
solve problems at the source versus paint over them, and the invariant set a
rebuild should satisfy. Grounded in the defect archaeology of the wide-bundle
fix series (miter caps, bias clamp, span fusion, fold splices, fan floors,
fan-reach caps), each of which repaired one instance of the same structural
gap.

## 1. How line geometry is computed today

The layout hands the draw a zero-width skeleton: nodes, edges with polylines,
per-edge `lineOrder`, and per-line traversals. `computeRibbonGeometry` then
builds the ink in stages:

1. **Slot synthesis.** Per edge, lines get centered slot offsets
   (`slotOf = (i - center) * spacing`). A relaxation (`biasOf`) adds one
   scalar lateral bias per edge so continuing lines keep their lateral seat
   across composition changes; its clamp scales with the mates' reach.
2. **Lane pieces.** `segPath[edge|line] = offsetPolyline(edge base, slot + bias)`.
   The atom of all later work is the PER-EDGE lane piece; nothing at this
   stage knows what the line does before or after the edge.
3. **Lane surgery, in order:**
   - jog-sliver suppression (tiny orphan pieces whose end jogs outweigh them);
   - the **join ladder**, per line per consecutive edge pair at the shared
     node: curve join, then near-parallel taper, then sharp-corner rungs
     (uncross clip, turn miter, forward dogleg), each with its own gates;
   - marker machinery (capsule seating, slides, crops, rebuilt lanes, split
     connectors);
   - path emission with interior fillets;
   - the **node-connector pass**, bridging whatever same-line gaps survive
     with taper/S/straight jogs, including ring seams and suppressed-sliver
     spans.

## 2. Census: source computation vs coats of paint

The join ladder and connector pass are structurally *repairs*: the lane
pieces are born disconnected and context-free, and every rung reasons about
ONE line's TWO ends at ONE node, gated by size caps. Each historical defect
in this family traces to the same two facts:

- **No rung sees the neighbours.** A transition piece cannot know it is
  sweeping through another line's lane (tangent hugs, shallow-crossing
  rubs, the clip census's whole caseload), nor that its bundle-mates are
  drawing the same corner (each line re-derives the corner alone).
- **Every gate was a fixed constant that some real bundle outgrew.** The
  documented sequence: the miter's `spacing*6` caps (failed a 12-line
  bundle's outer corner: painted mini-loop), the bias clamp's one slot
  (failed a thin continuation of a wide bundle: braided junction pocket),
  the station-split floor's 8px (seated splits inside corner fans: backward
  stubs), the per-line slot cap with a fixed obliquity factor (failed a
  hairpin turn into a wide trunk: painted triangles). Each fix replaced a
  constant with a quantity derived from actual bundle geometry, and each
  next failure was the same lesson one ring further out.

Passes that ARE source-level and worth keeping conceptually: slot synthesis,
the continuity bias (it encodes a real invariant: seats persist across
nodes), corridor-level ordering (blocks + residual placement), the merge's
span fusion and fold splices (they normalize the topology the draw
receives), and the fan-depth floor on station splits (it keeps foreign
concerns out of corner zones).

Passes that are paint by construction: the raw connector chords (every
surviving loop, spike, or triangle in the census was a declined ladder rung
falling through to a chord), the whole-piece retraction nub (a corner that
spans more than one edge has no representation, so the ladder leaves a
folded-back stub), and any repair that edits one line's pixels at one node.

## 3. The invariants

**I1. Per-line continuity.** A line's ink is ONE continuous path from
terminus to terminus (or a closed ring). Corners and lateral migrations are
constructed segments of that path, never separately emitted bridge chords.
Anything currently drawn by the node-connector pass is a violation to be
designed away, not patched better.

**I2. Bundle-coherent corners.** At a junction, all lines turning between
corridor A and corridor B share one corner construction: the nested fan of
per-line meets (each line's inbound and outbound lane lines intersected),
ordered by slot. The fan is computed once per (junction, turn group), so a
line can never disagree with its bundle-mates about where the corner is.
Corners spanning micro-edges shorter than the fan are first-class: the fan
consumes interior pieces instead of leaving folded-back stubs.

**I3. Fan zones are exclusive.** Every junction owns a fan zone whose reach
derives from the incident bundles' half widths over the turn angle's sine
(never a constant). Inside a fan zone: no station splits, no stop-mark
seating, no composition-change tapers, no crossings other than the fan's
own nested corners. Everything else must seat beyond it.

**I4. Transition clearance.** Any constructed transition either keeps at
least one lane pitch from every foreign lane or crosses it at a bounded-
steep angle. Sustained sub-pitch near-parallel overlap (the ink-clip
census's definition) is structurally impossible, not merely rare.

**I5. Folds are coincident retraces.** A course that goes out and back over
a corridor draws exactly the shared lane plus a turnaround cap. The merge
guarantees the precondition (span fusion normalizes multi-edge retraces to
same-edge folds; splices erase the manufactured ones; genuine turnarounds
are vetoed by graph-course truth) and the draw never invents a second
strand.

**I6. Octilinearity budget.** All constructed geometry is octilinear except
three named categories: interior fillets, bounded-angle mid-corridor tapers
(the lateral drift a slot migration needs, capped at a shallow maximum
angle), and marker connectors. Any non-octilinear segment outside those
categories is a defect. Incidental chords have no category.

**I7. No fixed geometric constants.** Every geometric gate derives from
bundle half widths, lane pitch, cell size, or the actual angles involved.
A constant that a wider bundle or sharper turn can outgrow is a deferred
defect, as the entire fix series demonstrates.

**I8. Bundle-coherent layering.** Lines of one bundle paint on one layer:
the paint order groups bundle-mates contiguously (each group its casings,
then its strokes), so wherever two bundles or a line and a bundle overlap,
one passes over the other as a WHOLE, with the upper group's casing
separating it cleanly from the lower. Per-line paint order interleaves the
two bundles' strokes at a crossing into an incoherent braid, and the
casing-then-stroke split across ALL lines lets no crossing separate at
all. Grouping derives from co-run share (the fraction of a line's drawn
length spent beside another), not from any hand-kept list.

**I9. No perpendicular micro-steps.** A drawn course never contains a
sub-pitch segment near-perpendicular to the travel direction around it (a
right-angle zigzag). A lateral seat correction resolves either AT the
nearest corner (the turn happens earlier or later, on the corrected seat)
or as a bounded-angle taper spread over available arc; a lane too short to
taper slants as a whole instead of stepping at its end. The degenerate
perpendicular connector chord is axis-aligned, so the octilinearity budget
(I6) never catches it; it is a defect in its own right.

## 4. Direction for the rebuild

Replace the join-ladder-plus-connector architecture with two cooperating
constructions:

- **Junction fan builder.** Per junction, per turn group: compute the nested
  corner fan for every line crossing the junction (meets, multi-edge
  absorption, fan zone extent). This owns I2 and I3, and its output is
  per-line corner curves with guaranteed nesting and clearance.
- **Per-line assembler.** Concatenate, per line: corridor lane pieces,
  the fan builder's corner curves, and mid-corridor taper segments (placed
  where I3 and I4 allow) into one path (I1), then fillet. The assembler is
  the only emitter of ink; there is nothing left to bridge.

The existing ladder rungs each survive as the special case they got right:
the curve join is the fan builder's two-line case, the taper is the sanctioned
mid-corridor migration, the miter is the fan meet, the dogleg its multi-bend
variant. What changes is that they become one construction with shared
context instead of a chain of independent fallbacks, and the raw chord
disappears entirely.

- **Paint layer builder.** Cluster lines by co-run share into paint groups
  (I8), emitted group by group (casings, then strokes). Pure paint-order
  work over the finished geometry; computed once with the geometry so
  repaints stay cheap.

Rulers that gate the rebuild, all existing: painted-loop census
(`OCTI_LOOPS`), ink-clip census (`OCTI_CLIPS`), same-section twist census,
exit-contiguity and interleave censuses, bare-end census, and per-city
renders at live options. The rebuild is done when the loop and clip censuses
are structurally zero on the corpus and every remaining non-octilinear
segment belongs to a named I6 category.
