# Junction fan rebuild: design

Replaces the per-line join ladder and (in its final milestone) the raw-chord
node-connector pass with the two cooperating constructions from
`docs/draw-geometry-invariants.md` section 4: a **junction fan builder** that
computes every corner once per (junction, turn group) with shared geometry,
and a **per-line assembler** that emits each line's ink as one continuous
path. Targets invariants I1 (per-line continuity), I2 (bundle-coherent
corners), I7 (no fixed geometric constants); prepares the ground for I3/I4
(fan zones, transition clearance) and multi-edge absorption.

## Why (the defect record)

Every rung of the current ladder reasons about ONE line's TWO ends at ONE
node. Consequences, all observed on real dumps:

- Each line re-derives the corner alone: `curveLaneJoin` trims each member by
  its own `min(radius, la*0.6, lb*0.6)`, so bundle-mates disagree about the
  corner and their sweeps can cross (nesting is luck, not construction).
- One member of a fan can take the curve while its neighbour's curve declines
  and falls two rungs down to a raw S chord (the painted loop/triangle
  family).
- `curveLaneJoin`'s apex limit is a fixed `spacing*4`: the outermost line of
  a wide bundle has its apex farther out than that, declines, and falls to
  the sharp rungs even at a plain 90-degree corner (the same
  constant-outgrown-by-geometry defect fixed three times elsewhere).
- Declined rungs fall through to the node-connector pass, whose degenerate
  case is a raw chord: every surviving loop, spike, and triangle in the
  censuses is such a chord.

## Architecture

Two new modules, integrated in two stages. The lane-piece substrate (slot
synthesis, continuity bias, offset polylines, sliver suppression) and the
marker machinery are untouched.

### Milestone 1: fan builder (`src/render/fanJoin.ts`)

Owns everything the join-ladder loop does today, with the same output
contract, so the marker machinery downstream is untouched:

```ts
export interface FanArgs {
  lineTraversals: Map<string, Traversal>;
  lineById: Map<string, unknown>;        // membership check only
  edgeById: Map<string, EdgeRef>;        // {id, from, to}
  segPath: Map<string, Pixel[]>;         // MUTATED in place (end pins, trims, tapers)
  orderOf: Map<string, string[]>;
  slotOf: Map<string, number>;
  biasOf: Map<string, number>;
  nodePx: Map<string, Pixel>;
  spacing: number;
  smoothR: number;                       // trim radius ceiling (SMOOTH_R)
  bigGapMult: number;                    // taper-branch gap cap multiple
}
export interface FanResult {
  joinCurves: JoinCurve[];               // now also carries edgeA/edgeB of its pair
  joinStopPos: Map<string, Pixel>;       // nodeId|lineId -> on-curve stop position
  endMoved: Set<string>;                 // edgeId|lineId|s|e
  mitered: Set<string>;                  // lineId|node|pairKey
}
export function buildFanJoins(args: FanArgs): FanResult;
```

**Grouping.** Enumerate continuation pairs exactly as the ladder does
(consecutive traversal steps sharing a node, same-edge pairs skipped, ring
seam wrap appended for closed courses). Group them by
`(node, unordered {edgeA, edgeB})`. Process groups in sorted key order;
within a group, order members by slot index. Determinism: sorted iteration,
`Math.sqrt` only.

**Group frame.** One inbound direction `dirA` (into the node) and one
outbound `dirB` (out of the node), taken from the base edge polylines' end
segments at the node (parallel offset lanes share them; base ends are immune
to earlier end mutations). `dot = dirA . dirB` classifies the whole group:

- `dot >= 0.85` — **jog group** (near-parallel continuation, lateral slot
  change): each member tapers to its pair midpoint with the current drift
  math (localized swaps, 8-slot cap, short-edge decline). Unchanged
  behaviour, now decided once per group.
- `-0.3 < dot < 0.85` — **curve fan**: all members get quadratic corner
  joins with ONE shared trim radius (below).
- `dot <= -0.3` — **sharp fan**: all members pin to their own lane meet
  (the current turn miter, which geometrically subsumes the uncross rung:
  when the end segments properly cross, the infinite-line meet IS the
  crossing point and the behind/ahead gates pass).

**Curve fan construction.** Per member, the apex is its own lane-line meet.
The shared trim is
`f = min(smoothR, 0.6 * min over members of la, 0.6 * min over members of lb)`
(la/lb = each member's end-segment length to its apex, after the existing
cut-back of apexes that land behind an end). Parallel lanes trimmed by one
shared arc produce nested, non-crossing sweeps by construction. The apex
distance limit is no longer the fixed `spacing*4`: it becomes
`max(spacing*4, fanReach)` with
`fanReach = (halfWidth(edgeA) + halfWidth(edgeB) + 2*spacing) / max(|sin(turn)|, 0.5)`
(the formula already proven in the turn-miter cap; halfWidth includes the
edge bias). A member whose own curve still fails (cut-back off-lane, legs
degenerate) falls to the sharp pin within the same group frame, and the
decision is traced.

**Sharp fan construction.** Per member: lineMeet of the two end directions,
gated by the existing behind/ahead constraints and the fanReach cap, with
collinear-vertex popping on both legs (current `setEnd`). Forward turns
(`dot > 0`) whose meet gates fail keep the dogleg fallback (single-corner
variant only, with the far-node overshoot decline), unchanged.

**Bookkeeping.** Same as today: `endMoved` guards each lane end against a
second move (a member whose end an earlier group already moved is skipped),
`mitered` suppresses the node connector for handled pairs, `joinStopPos`
records the on-curve stop position (quadratic midpoint). Trace via
`OCTI_FAN_TRACE=<lineId>` in a `debug/fanJoin.debug.ts` module following the
repo debug pattern.

**Kill switch.** `OCTI_FAN=0` keeps the legacy ladder (which stays in
`renderOctilinear.ts` until the rebuild is signed off, then moves to `old/`
per the deprecation policy). Default is the fan builder.

### Milestone 3: per-line assembler (assembler replaces emission + connectors)

`buildDByLine` today emits every lane piece and every join curve as an
independent `M...` subpath; round line caps hide most joints and the
node-connector pass bridges the rest, degenerating to raw chords. The
assembler replaces both:

- Walk each line's traversal in travel order (suppressed-sliver gaps and the
  ring seam handled as today), orienting each drawn piece to travel
  direction.
- At each junction between consecutive pieces: if the fan builder recorded a
  join curve for this (line, node, edge pair), splice it in as a `Q`;
  coincident pinned ends continue with `L`; any residual gap gets a
  CONSTRUCTED in-path transition using the current connector math
  (tangent-clamped cubic, chord fallback only for regressive
  zero-progress cases) — the transition is part of the line's one path,
  never a separate subpath.
- Interior fillets applied as today (quadratic per bend, clamped per
  corner).
- Output: ONE `M ...` path per line per contiguous drawn course (a closed
  ring closes on itself). Lines with genuinely disjoint drawn courses keep
  one subpath per course.

Consequences handled in the same milestone:

- `computeLaneCrops` re-emits through the same assembler over its cloned
  segPath (parameterized emission, as `buildDByLine` is today).
- The `segments[]` label-collision set collects from assembled geometry
  (pieces plus constructed transitions), preserving today's coverage.
- `drawnSegsByLine` learns to sample `C` cubics (today it silently drops
  them, so the censuses never saw connector cubics; making them measurable
  may surface pre-existing ink, which is documented, not chased).
- The second (post-marker, allowRegressive) join attempt stays: it repairs
  ends the marker pass moved, and its output is a curve, not a chord.

### Explicitly deferred (follow-up milestones, not this build)

- **Multi-edge absorption** (I2's micro-edge corners): the fan consuming
  interior pieces shorter than its reach. Needs marker/stop re-homing for
  consumed pieces.
- **Fan zone exclusivity** (I3) beyond the existing fan-depth station-split
  floor.
- **Transition clearance** (I4): neighbour-aware shaping of the constructed
  transitions.

## Caching and determinism

- `cacheFingerprint` SCHEMA stays 26 (no layout/support topology change).
- `mapCache` VERSION bumps 20 -> 21 at the first behaviour-changing commit
  (persisted drawn geometry changes).
- No Date.now/Math.random; sqrt not hypot; sorted group iteration; quantized
  nothing new.

## Verification gates (all rulers exist)

Behaviour-changing rebuild: the gate is the census battery plus tests plus
visual scrutiny, NOT byte identity.

- `npm test` green (new fanJoin unit tests included).
- One dump per city (most recent): painted-loop census (OCTI_LOOPS) and
  ink-clip census (OCTI_CLIPS) at or below current counts; twist census
  stays at or below baseline (twists are worse than wedges: never trade);
  interleave and contiguity rulers unchanged or better.
- Rendered crops of the known hot spots (the hairpin-into-trunk corner, the
  micro-edge fold station, the grouped-services hub, wide-bundle turn
  corners) surfaced for review.

## Risks

- The ladder's per-line sequencing resolved end contention (a line visiting
  a node twice) by traversal order; the group ordering changes who wins.
  Mitigated by the endMoved guard (no double moves, only different winners)
  and the census gates.
- Shared trim uses the group minimum: one member with a degenerate short leg
  shrinks every member's sweep. Floor at 1px with per-member sharp-pin
  fallback; watch corner sweep quality in renders.
- Assembler transition construction inside the path changes z-ordering of
  ink (a transition drawn as part of the line instead of appended last).
  Casing/stroke emission is per line already, so ordering between lines is
  unchanged.
