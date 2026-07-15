# Relaxed Mega-Solver Part 2 — Implementation Plan (delete box + mega)

> Pure refactor: boxing fires 0× on the corpus, so every dump must render **byte-identical** before vs after. Baseline hashes captured. Execute in behavior-preserving commits; run the full test suite after each and byte-identity at the end + after the writer-removal commit.

**Goal:** Delete the residual boxing passes and the entire `box`/`mega` machinery.

**Gate:** `npx tsx --test "src/**/*.test.ts"` (fast) after each commit; `BI_ONLY=SEA.json,NYC-EXTRA-DIFFICULT,LON.json,TPE.json,SF.json,DEN npx tsx dev/_byte-identity.ts` vs the pinned baseline.

---

## Commit 1 — remove the box writers

**File:** `src/render/renderOctilinear.ts`

- Delete the mega-slide eviction pass (the `for (const s of gathered)` loop that iterates `megas`, ~2396-2443) plus `capsAudit('post-mega-slide')` if it only bracketed that pass (keep if it brackets more).
- Delete `let slideBoxed = 0` (~2333), the `reportSlideBoxed(...)` call, and `reportSlideBoxedSummary(slideBoxed)` (~3221).
- 3185 last resort: replace the `boxStation(S); floorBoxed++; reportNoOverlapFloorBoxed(...)` body with an **accept + log**: keep both stations as seated, emit `reportNoOverlapFloorResidual({ layout, aNodeId: A.nodeId, bNodeId: B.nodeId })` once per stuck pair. Delete `let floorBoxed = 0` and `reportNoOverlapFloorSummary(floorBoxed)`.
- Remove every `megas` clearance guard (all vacuous once `megas` is empty): the `if (!megas.every((m) => clearOf(boxOf(m)))) break;` (~2718), the `|| !megas.every(...)` term (~2757), and `clearMegas` (~2835-2842) with its call sites (~2876, ~2883). Delete the now-unused `clearOf` locals, `clearMegas`, and `boxOf` (confirm no non-mega use).
- Delete the `megas` seed (~2248) and the `boxStation` def (~2249-2252).

**Verify:** suite green; byte-identity subset matches baseline.

## Commit 2 — remove `isBoxed`

**File:** `src/render/renderOctilinear.ts`

- Delete `const isBoxed = ...` (~1712). Remove the `isBoxed(x)` term from all 16 guards: whole-line `if (isBoxed(x)) continue;` deletions (~2397 already gone with the pass, ~2893, ~2896, ~3362), and term removals in compound conditions (~2289, ~2319, ~2726, ~2849, ~3020, ~3048, ~3197, ~3200, ~3315, ~3316). Each keeps its other conditions intact.

**Verify:** suite green; byte-identity subset.

## Commit 3 — remove the `mega` flag + readers

- `src/render/layout/types.ts`: delete `mega?: boolean` on `StopMark`.
- `renderOctilinear.ts`: delete the `mega` param from `addStop` (~1495) and its push (~1507) and call (~3412 arg); remove the `mega?: boolean` from the two inline `marks:` types (~521, ~1574); delete the three dot-filters `if (mk.mega) continue;` (~3250), `if (m.mega) continue;` (~3764), `.filter((m) => !m.mega)` → drop the filter (~3885); remove the `boxIsMega` arg from `reportEgregiousOverlaps` (~3219) and its param in the debug fn.
- `src/render/layout/londonBubbles.ts`: drop `mega?` from `BubbleMark` (~20) and the `!m.mega` filter (~328 → use marks directly).
- `src/render/layout/torontoCross.ts`: drop `mega?` from `CrossMark` (~24) and the `!m.mega` filter (~38).

**Verify:** suite green; byte-identity subset.

## Commit 4 — remove the box rendering

- `src/render/stations/types.ts`: delete the `| { kind: 'box'; … }` union member (~30); reword the StopScene doc (~46, drop "empty for an opaque mega box").
- `src/render/stations/placement.ts`: delete the `isMega` block (the curve residual) and the `megaSpine` `SceneGeom` field; a station is never mega.
- Delete the `capsule.kind === 'box'` branch in `primitives.ts` (~100), `london.ts` (~83), `rectCapsule.ts` (~78), `toronto.ts` (~67).

**Verify:** suite green; byte-identity subset.

## Commit 5 — debug + tests + cache

- `src/render/debug/renderOctilinear.debug.ts`: delete `reportSlideBoxed`, `reportSlideBoxedSummary`, `reportNoOverlapFloorBoxed`, `reportNoOverlapFloorSummary`; add `reportNoOverlapFloorResidual` (env-gated, prints the stuck pair).
- Tests: delete the box-capsule tests (`designs.test.ts` tokyu/london mega-box ~188/~383, `primitives.test.ts` box glyph ~30); delete the placement `mega marks -> pill` test (Part 1); drop `mega: true` from the input fixtures in `rectByNode.test.ts` (~53-76) and any `londonBubbles.test.ts` / `torontoCross.test.ts` mega fixtures.
- `mapCache.ts`: bump VERSION only if `StopMark.mega` is persisted — check `persist.ts`; there is no `persist.ts` mega reference (grep returned none), so **no bump** unless the serialized mark shape otherwise changed.

**Verify:** full suite green; **full** byte-identity vs baseline (all 12 subset hashes identical); census: 0 box prims emitted.
