# Octi hook suppression + node-connector overshoot clamp

**Date:** 2026-07-02
**Status:** Approved (user chose: fix both; loop via option B — post-octi hook
suppression — with the bearing-aware topo merge guard held in reserve).
**Root-cause reports:** memory `lon-render-defects`; scratch probes
`dev/_loopinv-*`, `dev/_spikeinv-*`; repro input `dev/_lon-input-extracted.json`.

## Problems

1. **Pipeline-introduced line loops (LON "pink triangle").** Topo over-merges
   geographically divergent corridors at dense interchanges (Lincoln's Inn
   Fields) into a synthetic node cluster; octi resolves the cluster by routing
   the whole bundle down a shared lane to a synthetic junction and fanning
   back — a line whose stops are geographically collinear draws a closed
   triangle (LIF→mn1→mn75), and out-and-back lines draw hairpins, purely
   through SYNTHETIC (non-station) nodes.
2. **Bundle-join spike.** The node-connector cubic that bridges a lane-slot
   change between edges sizes its tangent `k = min(spacing·4, max(gap,
   spacing·2), lon)` by the LONGITUDINAL span; with a diagonal approach and a
   small lateral jog (~5.6px), the first control point (pa + dirA·k, k≈22)
   crosses ~3.4px past the destination lane and the recovery reads as an
   upward spike. Verified by cubic reconstruction; miter/dogleg/octi-path
   ruled out with a synthetic control.

## Goals

- No line's drawn path detours through a zero-progress synthetic hook when a
  short octilinear shortcut exists (loop/hairpin suppression).
- Node-connector bridges never overshoot the destination lane by more than
  ~1px; genuine long slot jogs (the NYC Q/R/N/W bundle-span fix) keep working.
- Deterministic, schema-bumped (layout changes), regression-gated on
  LON + NYC-difficult + SEA (+ CHI if it renders) contiguity and capsule audits.

## Non-goals

- The bearing-aware topo merge guard (option A) — reserved as follow-up if
  hook suppression proves insufficient; do NOT attempt in this round.
- Changing octi's cost model or the topo merge itself.

## Design

### 1. Connector overshoot clamp (renderOctilinear.ts)

> **Amended during implementation:** the unsigned formula below was superseded
> by a SIGNED clamp (`connectorClamp.ts` — see its header comment) after review
> found a reverse-perp corner where the unsigned form overshot the NEAR lane.
> The signed form stops the control point exactly at the far lane when heading
> toward it and bounds the stray to 0.75px when heading away, making the
> zero-overshoot goal true universally.

Extract the connector control-point computation into a small pure helper
(testable): given `pa, pb, dirA, dirB, spacing`, return `c1, c2`. Clamp each
tangent length PER END so its control point cannot cross the far end's lane
line: decompose `pb − pa` into the outgoing-axis component (lon) and the
perpendicular component (lat, the slot delta); then
`kA ≤ |lat| / max(0.15, |perp(dirA)·n̂|)` where `n̂` is the unit normal of
`dirB` (i.e. the control point's perpendicular excursion stops AT the
destination lane), and symmetrically `kB ≤ |lat| / max(0.15, |perp(dirB)·n̂A|)`
against the incoming lane axis. Keep the existing upper bounds; the clamp only
LOWERS k. Collinear ends (lat≈0 or perp≈0) keep current behavior. On the LON
case this yields kA≈7.9 → the control point lands exactly on the destination
lane → zero overshoot; on NYC-scale jogs lat is large → clamp inactive.

### 2. Hook suppression pass (new `src/render/layout/hookSuppress.ts`)

Runs in `precomputeSmoothed` AFTER `supportToLayout` + spur-step cleanup and
BEFORE `orderLines` (the layout is assembled; lanes/offsets don't exist yet).
Per line traversal:

- **Detect:** maximal runs of consecutive traversal steps whose INTERIOR nodes
  are all synthetic (no station marker — not in the stations set) — a
  candidate hook from real-or-boundary node `A` to node `E`. Flag when
  (a) pathLen(A..E along the run) / chordLen(A,E) > HOOK_RATIO (default 1.7)
  AND (b) the run reverses direction (min over consecutive segment pairs of
  dot(d̂ᵢ, d̂ᵢ₊₁) < −0.2 — a genuine fold, not a gentle arc). Both knobs env-
  overridable for sweeps (OCTI_HOOK_RATIO, OCTI_HOOK_FOLD).
- **Splice:** build a shortcut course from A to E — octilinear two-segment
  path (axis-aligned + 45°, choosing the split that stays nearest the chord;
  degenerate to one segment when the chord is octilinear). Add a NEW layout
  edge A↔E with that course carrying the hooked line (reuse an existing
  spliced edge for subsequent lines with the same A,E — lines bundle on it and
  get lanes like any edge). Remove the line from the hook run's edges; drop an
  edge entirely when its line set empties. Rewrite the line's traversal steps.
- **Safety:** never splice when A==E (closed loop at one node — leave those);
  never splice a run containing a station stop for that line; skip when the
  shortcut would be LONGER than the hook (ratio guard makes this impossible,
  belt-and-suspenders). Cap splices per line (8) against pathological inputs.
  Deterministic: iterate lines by id, runs in traversal order.
- Yellow's straight LIF→mn1→Marlborough run has no fold (dot ≈ +1) — untouched.
  The magenta triangle folds hard at mn1 (dot ≈ −0.45) — spliced. Green/orange
  hairpins fold at their apex — spliced per the same rule.

### 3. Consistency

- **Schema 9** (both changes alter layouts/drawn geometry).
- Determinism: arithmetic + sorts only; traversal/line iteration in id order.
- The spliced-edge course is drawn by the normal ribbon path (lane offsets,
  connectors) — no special rendering.

## Verification

- Unit: connector clamp helper (overshoot ≤ ~0.5px on the LON-reproduced
  geometry; NYC-scale jog unchanged); hook detector on synthetic layouts
  (triangle spliced; straight-through synthetic runs kept; station-stop runs
  kept; A==E skipped); splice rewrites traversals + edge line-sets correctly.
- Dumps (full re-sim via extracted inputs): LON — triangle and hairpins gone
  (visual crop at Lincoln's Inn Fields/Adam St), spike gone (vertex probe on
  the yellow/magenta d-fragments: overshoot < 1px), contig all-pass, capsaudit
  0/0; NYC-difficult — 38/38 contig, megaboxes ≤ 5, capsaudit 0/0, JFK crop
  unregressed; SEA — megaboxes ≤ 1, capsaudit 0/0.
- Visual checkpoint to the user: LON before/after at both defect sites.

## Risks

- **Splice course may cross unrelated lanes** (it's a new edge octi never saw)
  — accepted for v1: the hook it replaces was worse; the capsule/marker
  enforcement and contig checks gate the damage; if a splice creates crossings
  the sweep will show it and option A (merge guard) becomes the follow-up.
- **HOOK_RATIO/FOLD tuning** — too loose suppresses legitimate S-bends; too
  tight misses shallow hooks. Defaults chosen from the LON case (ratio ~2.0,
  fold ~−0.45) with margin; env knobs for sweeps.
- **Connector clamp regressing dense-hub bridges** — gated by the NYC contig
  suite (the exact fixture the bundle-span fix was built on).
