# Scale & warp controls — design + build plan

**Status:** design, validated by experiment; not yet built.
**Goal:** let dense maps (e.g. NYC) render cleanly instead of crunching together
**when the box warp is minimized**, by giving the user three separated controls —
a drawn-line/chrome scale, a "declutter" warp, and an "aesthetic" warp — instead
of one conflated warp dial. This document records the architectural findings that
force this shape, the control design, the build plan, and the evidence.

---

## 1. Problem

At low warp, a dense city's core is a crunched tangle: lines and labels overlap.
The instinct is "make the drawn lines smaller, and/or make the grid cells
smaller." Investigating what actually moves that dial surfaced hard architectural
constraints that reshape the solution.

## 2. Display model (the thing that makes a chrome-scale meaningful)

The in-game view (`src/ui/SchematicPanel.tsx`) is a **pan/zoom viewport**. Zoom is
done via the SVG `viewBox` map-style: the layout spreads while **stroke widths and
label text stay a constant on-screen size** (counter-scaled by 1/zoom). A
`labelScale` control already exists, implemented as a display-time SVG group
`transform="scale()"` — no relayout. It is the direct precedent for a line/chrome
scale.

Consequence: the on-screen size of the drawn chrome (strokes, markers, labels) is
an **independent knob** from the layout. Making chrome smaller declutters the
zoomed-out view at *any* zoom, with no geometry change. (This is why the earlier
"scaling everything is a no-op after fit-to-view" reasoning applies only to the
static export, not to the interactive map.)

## 3. Architectural findings (verified in code + renders)

These are the constraints that force the three-knob shape. Each was confirmed
against the source and/or measured.

### 3.1 The octi grid is a uniform lattice; fine cells explode routing

`src/render/layout/gridGraph.ts` is a **uniform integer lattice**: one `cellSize`,
`nBases = cols × rows`, node position `= origin + col·cellSize`, 8 fixed integer
directions. Routing cost scales with grid-node count `∝ 1/cellSize²`.

Measured octi-routing stage time (NYC-jul-16-2, `OCTI_PERF=1`, precompute only):

| octi cell | octi routing |
|---|---|
| ~13 (natural default) | 2.7 s |
| 11 | 20 s |
| 10 | 33 s |
| 9 | 31 s |
| 8 | 38 s (≈14× default) |

So a **uniform** fine octi cell is a hard performance cliff — finite, not a hang,
but far too slow to be an interactive knob. This is the documented "a fine grid
lets corridors nest in concentric rings around hubs and explodes routing time."

### 3.2 It is NOT the warp

The `warpBuild` stage is **~250 ms at every cell size**, and pushing the warp's
*own* cell estimate finer (`OCTI_DIVISOR=3.0`) completes the whole pipeline in
~6 s. "Telling the un-pinch warp about a finer grid" is cheap. The cost above is
purely the octi router on a fine **uniform** grid.

### 3.3 The warp already IS a differently-sized field of cells

The warp is composed into the projection (`toSVG: (c) => warp(baseProj.toSVG(c))`
in `renderGeographic.ts`) and there is **no inverse un-warp** — octi routes in
warped space and the output stays warped. Because the warp magnifies dense regions,
one uniform warped-space cell covers a **small geographic area in the magnified
core** and a **large one in the compressed periphery**. That is exactly a
variable-sized field of *geographic* cells, produced by the warp's density
information, at the routing cost of a uniform, moderate grid. This is why the warp
is the cheap way to resolve a dense core, and a uniform-fine grid is the expensive
way to chase the same thing.

**The unavoidable corollary:** the variable-cell-field and the geographic
distortion are the *same* coordinate transform. Fine geographic cells in the core
⟺ the core is magnified ⟺ distortion there. You cannot get "smaller cells in the
dense core" without "the core takes more relative space." The warp *strength* dials
both together.

A genuinely graded true-position lattice (fine cells in the core at un-magnified
positions, coarse outside) would decouple routing-detail from distortion, but (a)
it breaks the uniform octilinear lattice the whole router is built on — a
research-level change, not a config — and (b) even then it would only cheapen
*routing*: at true positions, close stations + full-width lines still visually
crunch, so thin lines would still be required. It is out of scope; noted as
possible future work in §7.

### 3.4 Declutter warp vs aesthetic warp

The warp has two independent oracles in `src/render/layout/densityBoxWarp.ts`:

- **Declutter (survival / contraction oracle):** separates genuinely overlapping
  stations just enough that the octi grid can resolve them. **Load-bearing** —
  without it the dense core is not cleanly renderable at all. Evidence: with the
  aesthetic oracle OFF (`OCTI_BOX_DENSITY=0`) at growth 1.3, the render is
  essentially identical to the full warp — the space that redistributes is
  survival, not magnification.
- **Aesthetic (density oracle):** extra magnification of dense regions for
  emphasis / breathing room. Optional; pure geographic-faithfulness cost.

Today both are conflated under `boxExpand` / `boxGrowth` / `boxFrac`. They should
be separate user controls.

### 3.5 Line scale is the only free, distortion-free declutter

Thinner strokes + smaller markers fix the *visual* crunch (line/label overlap) at
true positions, at any zoom, with **no relayout, no routing cost, no distortion,
no station merging**. It is the one lever with no downside, and it does the bulk of
the decluttering (confirmed: at declutter 1.1× with aesthetic off, thin lines alone
keep the core traceable).

## 4. The three controls

| Control | Effect | Mechanism | Cost | Relayout? |
|---|---|---|---|---|
| **Line scale** | drawn stroke + marker + label chrome size | multiply `LINE_WIDTH`/`LINE_GAP`/`MARK_R0`; UI mirrors `labelScale` | none | no (draw-time) |
| **Declutter warp** | un-pinch overlapping stations so the core is renderable | survival/contraction oracle strength + growth-cap throttle | ~250 ms warp build; mild dialable distortion | yes (in fingerprint) |
| **Aesthetic warp** | optional magnification of dense regions for emphasis | density oracle strength | more distortion; off by default | yes (in fingerprint) |

**Recommended defaults (from the experiments):** line scale ≈ 0.4–0.5 of current
(the current `LINE_WIDTH=3.5` reads heavy at full-map zoom); declutter low but
non-zero (≈ the survival minimum, growth-cap ~1.1–1.2); aesthetic 0 by default,
available for emphasis. The `sep_g11_lw12` / `sep_g12_lw12` renders (declutter
1.1–1.2×, aesthetic 0, line 1.2) are the target look; `cw_warp13` shows a
slightly warmer setting with a touch of aesthetic.

**Uniform octi cell:** keep at its natural value (`max(12, medLen/divisor)`). Do
NOT expose a fine-cell slider — it is the expensive wrong tool for detail (§3.1)
and buys nothing the warp does not give more cheaply (§3.3). If ever exposed, floor
it at ~11–12.

## 5. Build plan

### 5.1 Line scale (standalone, highest value, no relayout) — do first

1. `src/render/constants.ts`: change `LINE_WIDTH`, `LINE_GAP`, `MARK_R0` from
   `const` to `export let`, add `setDrawScale(s)` that recomputes them from base
   values (base line width still honours the `IS_LINE_WIDTH` dev override).
   ES module live bindings propagate to importers **except** the ~8 top-level
   derived captures — these must be made live too (they capture at import):
   - `src/render/renderOctilinear.ts:543` `RECT_R0 = MARK_R0`
   - `src/render/labels.ts:200` `ANCHOR_SLID_DIST = LINE_WIDTH * 3`
   - `src/render/stations/primitives.ts:4`, `placement.ts`, `london.ts` `R0 = MARK_R0`
   - `src/render/stations/toronto.ts` `STOP_OUTER`/`STOP_RING`/`CAP_W`/`DOT_R`/`CONNECTOR_W`
   (convert each to read the live binding at use, or to a getter).
2. `src/render/renderGeographic.ts`: call `setDrawScale(opts.lineScale)` at the
   start of precompute AND draw; stash `lineScale` on the precomputed object so the
   draw uses the same value the marker-seating was baked with.
3. `src/render/types.ts`: add `lineScale?: number` (default 1).
4. `src/render/cacheFingerprint.ts`: include `lineScale` — it changes marker sizes,
   which feed capsule/rigid-row seating (baked in precompute), so it affects layout
   geometry, not just stroke width.
5. `src/ui/SchematicPanel.tsx`: add a slider mirroring `labelScale` (state,
   persistence via `writeModeSettings`, clamp to a `LINE_SCALE_MIN/MAX`).

Note: because chrome is counter-scaled to constant on-screen size at draw/zoom
time, the interactive part can be a display-time redraw; only the marker-seating
coupling (step 4) needs the fingerprint entry.

### 5.2 Declutter / aesthetic warp split (in the warp module)

The two oracles already exist separately in `densityBoxWarp.ts`; the work is to
expose distinct strengths instead of the conflated `boxExpand`/`boxGrowth`/`boxFrac`:

1. `types.ts`: add `declutterWarp?: number` (survival strength / growth throttle)
   and `aestheticWarp?: number` (density strength); keep the legacy options mapping
   to these for back-compat, or migrate.
2. `densityBoxWarp.ts` + `renderGeographic.ts`: route `declutterWarp` to the
   contraction oracle demand + growth cap, and `aestheticWarp` to the density
   oracle weight (0 disables, = current `OCTI_BOX_DENSITY=0`).
3. `cacheFingerprint.ts`: both are layout inputs; include them.
4. `SchematicPanel.tsx`: two sliders; aesthetic default 0.

This part is the warp module's territory (currently carried in the worktree as a
reproduction scaffold from the warp branch); coordinate with that work.

## 6. Evidence (repro)

Dev tools (worktree, gitignored): `dev/_bw_render.ts` (env-driven full render),
`dev/_dr_crop.ts` (crop), `dev/_dr_grid.ts` (octi skeleton + `OCTI_PERF` stage
timing). Renders live under `dev/_scale_exp/`.

```bash
# the validated target look: aesthetic OFF, declutter low, thin lines, natural cell
OCTI_BOX_DENSITY=0 OCTI_BOX_GROWTH=1.1 IS_LINE_WIDTH=1.2 \
  npx tsx dev/_bw_render.ts testdata/improvedschematics-map-NYC-jul-16-2.json out '{}'

# octi routing-cost curve vs cell size (proves the fine-cell cliff)
OCTI_PERF=1 OCTI_CELL=10 npx tsx dev/_dr_grid.ts testdata/improvedschematics-map-NYC-jul-16-2.json g.png
```

Env → future option mapping: `IS_LINE_WIDTH` → line scale; `OCTI_BOX_DENSITY=0`
→ aesthetic 0; `OCTI_BOX_GROWTH` (growth cap) → declutter throttle; `OCTI_CELL`
→ do NOT expose (routing cliff).

## 7. Non-goals / future work

- **Graded (non-uniform) octilinear lattice** driven by the warp density field:
  would let core detail exceed the warp's distortion budget by giving the router
  fine cells only in the dense core at true positions. Blocked by §3.3(a/b): a deep
  router change that still would not fix visual crunch. Parked.
- **Un-warping the octi output** toward faithful geography while keeping octilinear
  topology: self-contradictory (un-warping breaks octilinearity). Not pursued.
