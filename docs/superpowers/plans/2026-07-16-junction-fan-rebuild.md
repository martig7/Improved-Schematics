# Junction Fan Rebuild Implementation Plan

> **For agentic workers:** executed inline (momentum workflow per CLAUDE.md);
> spec at `docs/superpowers/specs/2026-07-16-junction-fan-rebuild-design.md`.

**Goal:** Replace the per-line join ladder with a per-(junction, turn group)
fan builder, then replace subpath-per-piece emission plus the node-connector
pass with a per-line assembler emitting one continuous path per line.

**Architecture:** New `src/render/fanJoin.ts` consumed by
`computeRibbonGeometry`; legacy ladder retained behind `OCTI_FAN=0` until
sign-off. Assembler generalizes `buildDByLine` and absorbs the connector
pass.

**Tech stack:** TypeScript, Node built-in test runner (`npm test`), dev
rulers (OCTI_LOOPS / OCTI_CLIPS / twist / interleave), `dev/_airrepro.ts` +
resvg rasterization for visual checkpoints.

---

### Task 1: fanJoin module — enumeration and grouping

**Files:** Create `src/render/fanJoin.ts`, `src/render/tests/fanJoin.test.ts`.

- [x] Types (`FanArgs`, `FanResult`, `JoinCurve` with `edgeA`/`edgeB`),
      continuation-pair enumeration (consecutive traversal steps at a shared
      node, same-edge skip, ring-seam wrap), grouping by
      `(node, sorted edge pair)`, member ordering by slot, sorted group
      iteration.
- [x] Unit test: a 3-line bundle turning a corner yields one group with 3
      slot-ordered members; a ring course contributes its seam pair; an
      out-and-back same-edge seam does not.
- [x] `npm test` green. Commit.

### Task 2: group frame + classification + jog tapers

- [x] Group frame from base edge polylines (`edgePolyline` ends at the
      node); `dot` bands: jog (>= 0.85), curve (-0.3..0.85), sharp (<= -0.3).
- [x] Jog groups: port the taper branch per member (drift = max(spacing*1.5,
      gap*1.2), 8-slot cap, 0.45 arc share, short-edge decline, gap cap
      `spacing * bigGapMult`).
- [x] Unit test: two parallel collinear edges with a slot change taper to
      midpoints; short edge declines.
- [x] Commit.

### Task 3: curve fan with shared trim + fanReach limit

- [x] Per-member apex (lane-line meet), cut-back of apexes behind ends
      (port `cutBackTo`), shared trim
      `f = min(smoothR, 0.6*min(la), 0.6*min(lb))`, member curve emission
      (joinCurves + joinStopPos + endMoved + mitered), apex limit
      `max(spacing*4, fanReach)`.
- [x] Per-member fallback to sharp pin when the member's curve construction
      fails; trace every decision (`debug/fanJoin.debug.ts`, OCTI_FAN_TRACE).
- [x] Unit test: 3 parallel lanes at a 90-degree corner produce 3 nested
      non-crossing quadratics with one shared trim; outermost lane of a wide
      bundle (apex past spacing*4) still curves via fanReach.
- [x] Commit.

### Task 4: sharp fan (miter unification) + dogleg fallback

- [x] Per-member lineMeet pin with behind/ahead gates, fanReach cap,
      collinear-vertex popping (port `setEnd`); crossing-segments case comes
      free (meet == crossing).
- [x] Forward-turn dogleg fallback (single-corner variant, far-node
      overshoot decline) for curve-band members whose meet gates fail.
- [x] Unit test: out-and-back sharp pair pins both ends to the shared meet;
      hairpin obtuse turn into a wide trunk miters within fanReach.
- [x] Commit.

### Task 5: integration into computeRibbonGeometry

**Files:** Modify `src/render/renderOctilinear.ts`.

- [x] `OCTI_FAN` gate: default calls `buildFanJoins` (mutating segPath,
      returning joinCurves/joinStopPos/endMoved/mitered into the existing
      locals); `OCTI_FAN=0` runs the legacy ladder loop unchanged.
- [x] mapCache VERSION 20 -> 21.
- [x] `npm test` green. Commit.

### Task 6 (M2 gate): corpus verification

- [x] Rulers on 1-per-city (most recent: NYC-jul-16-2, LON-jul-16, HOR,
      SEA-jul-11-2, DEN, SF if present): loops/clips at or below current;
      twists at or below baseline; interleave/contiguity unchanged.
- [x] Render + rasterize hot-spot crops (hairpin trunk corner, micro-edge
      fold station, grouped-services hub, wide-bundle corner) and surface
      them.
- [x] Fix regressions or revert falsified pieces (one invariant at a time).
      Commit results.

### Task 7 (M3): per-line assembler

**Files:** Modify `src/render/renderOctilinear.ts` (emission + connector
pass), possibly extract `src/render/assemblePath.ts`.

- [ ] Assembler: walk traversal in travel order, orient pieces, splice join
      curves by (line, node, edge pair), `L` coincident ends, constructed
      in-path cubic transitions (current connector math) for residual gaps,
      interior fillets, one subpath per contiguous course, ring `Z`.
- [ ] Route `computeLaneCrops` re-emission through the assembler; keep
      `segments[]` coverage; extend `drawnSegsByLine` to sample `C`.
- [ ] Delete the standalone node-connector pass (fan + assembler cover it);
      keep the post-marker regressive join attempt.
- [ ] Unit tests: continuity (one M per drawn course), transition inside
      path, ring closure. `npm test` green. Commit.

### Task 8 (M3 gate): corpus re-verification

- [ ] Same battery as Task 6 plus bare-end census; visual crops again.
- [ ] Commit; report to user with visuals; await sign-off before moving the
      legacy ladder to `old/`.
