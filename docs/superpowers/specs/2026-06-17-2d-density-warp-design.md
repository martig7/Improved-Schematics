# 2D local density warp

**Date:** 2026-06-17
**Status:** Design approved; ready for implementation plan.

## Problem

The smoothed pipeline pre-warps pixel space before octilinearization to enlarge
crowded parts of the map (print-NYC-subway style). The current warp
(`src/render/layout/densityWarp.ts`, `buildDensityWarp`) is **separable** — it is
a product of two independent 1D axis maps, `W(x,y) = (fx(x), fy(y))`, each built
from a 1D station histogram integrated to a CDF.

Separability has two consequences, both confirmed with `dev/warp-heatmap.ts`:

1. **It cannot target a 2D sector.** "Dense band in x" × "dense band in y"
   stretches *everything in that whole row and that whole column*, producing a
   red "cross" of magnification over Manhattan's entire row and column rather
   than over Manhattan itself.
2. **It is near-binary in the dense core.** A coarse 96-bin histogram plus an
   8× per-axis magnification clamp flatten what little 2D variation could survive,
   so the whole crowded core saturates at roughly uniform maximum stretch.

We want the warp to **expand specific dense sectors locally** — give crowded
regions room proportional to their *local 2D density* — not whole rows/columns.

## Goal & success criteria

A **smooth 2D local density-equalizing warp**: every area gets room proportional
to its local 2D density. Dense sectors expand, sparse areas compress, the whole
map breathes proportionally. Success is judged by:

- `dev/warp-heatmap.ts` shows **local magnified sectors**, not a row/column cross.
- Box counts on `difficult-nyc` improve (or at least don't regress); `sea`/`nyc`/
  `chi` do not regress.
- `_ulpcheck` still reports **CONVERGED** (offline == in-game).
- The rendered maps look **as good or better** — no new crammed/ugly areas. This
  is a human visual judgement, owned by the user (per the OCTI_CROWD=0.5 lesson:
  a lower box count is not automatically a better map).

## Constraints (firm)

- **Fold-free, unconditionally.** No line may ever cross another and no water
  polygon may self-intersect, for *any* input. Today's separable warp guarantees
  this structurally; the replacement must guarantee it too.
- **Cross-V8 deterministic.** The warped node positions feed the discrete
  convergence fingerprint, so the warp must be bit-identical across V8 builds.
  This bites only on transcendentals (`exp`/`pow`/`atan2`/trig); anything built
  from `+ − × ÷ √` is IEEE-correctly-rounded and therefore automatically stable.
- **Warps all geometry coherently.** The warp is one pixel→pixel function applied
  to the network *and* the water polygons through `proj.toSVG`, so they deform
  together. The replacement keeps that single integration point.
- *Invertibility* is a property of today's construction but is not used anywhere,
  so it is **not** required.

## Approach: density-repulsion displacement field (closed-form, single pass)

Chosen over (B) an iterative diffusion/Gastner–Newman cartogram and (C) a
moving-mesh rubber sheet. A is the smallest fold-free, deterministic step that
delivers local sector expansion, and it is a stepping stone toward B (B is
essentially A iterated), so it is not throwaway work.

### Density field

Reuse today's weighted samples — each node contributes `lineWeight × crowd`
copies of its projected position (the existing weighting in `renderGeographic`),
so the *input* to the warp is unchanged. Bin them into a **2D** grid `ρ`
(e.g. 96×96) and smooth with a separable 2D Gaussian. The Gaussian is the only
transcendental and is quantized exactly as the current 1D kernel is
(`Math.round(Math.exp(...) * 1e12) / 1e12`). Let `ρ̄` be the mean and
`e = ρ − ρ̄` the excess density (`Σ e = 0`).

### Displacement field

```
F(x) = Σ_cells  e_c · (x − c) · w(|x − c|),   w(r) = exp(−r² / 2σ²)
W(x) = x + α · F(x)
```

- A dense cell (`e>0`) pushes nearby space *outward* (the `(x−c)` factor) → its
  sector **expands**. A sparse cell (`e<0`) pulls inward → **compresses**.
- Because `F` is a sum of *local* radial kernels, magnification concentrates on
  dense **sectors** — no rows/columns.
- `F` is a convolution of `e` with the vector kernel `k(d) = d · w(|d|)`;
  precompute `F` on the grid once, then **bilinearly interpolate** it at any query
  point (network nodes, water vertices). `σ` controls how local the expansion is.

### Fold-free guarantee (critical)

`W` is fold-free iff `det(I + α·∇F) > 0` everywhere. `∇F` is bounded, so:

1. Compute `∇F` per grid cell by finite differences (a 2×2 matrix).
2. `M = max over the grid of ‖∇F‖`. The Frobenius norm (`√` of the sum of the
   four squared entries) is used — it is an upper bound on the spectral norm, so
   it makes the guarantee *conservative* (never under-clamps) while staying pure
   `√` + arithmetic, no eigenvalue solve.
3. `α_safe = min(α_target, 0.9 / M)`.

`α_safe · ‖∇F‖ < 1` everywhere is a sufficient condition for a Jacobian with
positive determinant → no fold, for any input. The cost is that extreme density makes `M` large, so `α`
auto-throttles and the densest cores expand *less* than ideal — this is the
"approximate" in single-pass equalization, and exactly the limit escalating to B
(iterate the field, each step bounded) would relax.

### Determinism

2D histogram binning (integers), the quantized Gaussian, the convolution, the
finite-difference `∇F`, the `√` in the operator norm, the `max`, `α_safe`, and the
bilinear interpolation are all `+ − × ÷ √` plus the one quantized `exp` → bit-
identical cross-V8. No new transcendental is introduced on the hot path.

## Architecture & integration

- **New module** `src/render/layout/densityWarp2d.ts` exporting
  `buildDensityWarp2D(samples, box, opts): WarpFn` — the *same signature* as
  `buildDensityWarp`, so it is a drop-in.
- **Keep** the separable `buildDensityWarp`. Select between them in
  `renderGeographic` with `OCTI_WARP_MODE` (`2d` | `separable`). **Default stays
  `separable`** until the 2D warp is validated and the user signs off on the look;
  only then is the default flipped (a one-line change).
- **One call site** changes in `renderGeographic.ts` (~line 546): pick the warp by
  mode. The `proj.toSVG = c => warp(baseProj.toSVG(c))` wrapper is unchanged, so
  network and water deform coherently with no other edits.
- **Heatmap reuse:** the existing `__warpDebug` stash captures any `WarpFn`, so
  `dev/warp-heatmap.ts` visualizes the 2D warp with zero changes — the
  see-it-before-trusting-it gate.
- **Knobs:** reuse `OCTI_WARP` (α target); add `OCTI_WARP_SIGMA` (kernel radius =
  locality) and a grid-resolution override. The old `maxScale` ceiling is
  superseded by the fold-clamp (optionally retained as an extra explicit Jacobian
  cap).

## Testing & verification gates

**Unit** (`src/render/layout/densityWarp2d.test.ts`):
- Uniform samples → identity (no warp).
- Single dense cluster → local magnification `J>1` at the cluster and `J<1`
  immediately around it — and explicitly *not* a full row/column.
- Fold-free: on a deliberately peaked stress input, the sampled Jacobian
  determinant is `> 0` at every grid point.
- Determinism: the same input rendered twice yields identical output.

**Integration:**
- Box counts: `difficult-nyc` improves (or at least no worse); `sea`/`nyc`/`chi`
  do not regress (`dev/box-diag.ts`).
- Convergence: `dev/_ulpcheck.ts` reports CONVERGED on `sea` (and difficult-nyc's
  FP modes).
- Full test suite (currently 246) green.
- **Visual gate (decisive):** `dev/warp-heatmap.ts` shows local sectors not a
  cross, and the rendered maps (`dev/_render-boxes.ts` across sea/nyc/chi/
  difficult-nyc) look as good or better — the user makes this call before the
  default is flipped to `2d`.

## Escalation path (documented, not built now)

If single-pass A under-expands the densest cores (visible as still-saturated
heatmap centers after the fold-clamp throttles α), escalate to **B**: iterate the
displacement field a fixed number of bounded steps (each fold-safe), which
approaches true density equalization. B reuses A's density field, kernel, and
fold-clamp, so it is an extension rather than a rewrite.

## Risks / open questions

- **Will single-pass A expand the densest cores enough** given the fold-safety
  α-throttle? Unknown until rendered — the heatmap answers it directly, and B is
  the fallback.
- **σ / grid-resolution tuning** trades locality against smoothness; defaults to
  be chosen empirically via the heatmap.
- **Global drift/scale:** `Σe = 0` keeps the field roughly balanced, but a final
  re-fit of the warped extent to the canvas may be needed (as the 1D warp maps to
  `[x0, x0+W]`).
