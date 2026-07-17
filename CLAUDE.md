# CLAUDE.md — dev rules for Improved Schematics

Improved Schematics is an octilinear transit-map renderer (LOOM-inspired) for a metro game.
Its two main parts are the **geographic view** and the **smoothed (octilinear) view**
(`RenderMode = 'geographic' | 'smoothed'`). Keep new work aimed at those two; don't add
back other modes.

## Build, test, verify

- **Tests are the gate, not `tsc`.** Run `npm test` (= `tsx --test "src/**/*.test.ts"`,
  Node's built-in runner — not vitest). The mod ships via `vite build` (esbuild,
  transpile-only), so `tsc --noEmit` carries known pre-existing type errors and is NOT a
  pass/fail gate. Unused imports don't fail the build.
- **The render pipeline is deterministic and must stay so.** No `Date.now()` /
  `Math.random()` in the pipeline; offline output must equal in-game (cross-V8 FP
  determinism). Same input renders byte-identical SVG every run.
- **Verify refactors by byte-identity on the map dumps.** A behavior-preserving change must
  render byte-identical SVG across the `improvedschematics-map-*.json` dumps in both modes
  (dump input is at `raw.inputDump`). A scratch harness for this lives at
  `dev/_byte-identity.ts` (gitignored). Renders are slow; run them in the background.

## Root-cause discipline

- **Fix problems at their source, not with "coats of paint."** No draw-time pixel edits to
  mask a layout problem — compute the real geometry. A change that only rerolls the output
  is not a fix.
- **Delete code that harms more than it helps.** Don't keep code (or an invariant) "just in
  case". Justify it or delete it.
- **Verify first.** Instrument before fixing. Run a falsifying before/after experiment
  against a pinned ruler. Change one invariant at a time and revert falsified work. After
  three failed fixes, stop and question the architecture instead of trying a fourth.
- **Analyze geometry on skeletons, not full renders.** For RCA and geometry inspection,
  extract the relevant per-line paths (by `data-line-id`) and render them as thin skeleton
  overlays, or read the path commands directly; full-styling crops bury the geometry under
  stroke width, casings, and markers. Full rendered crops are for FINAL presentation only.

## Code organization

- **Tests** live in a per-directory `tests/` subfolder beside the code they cover
  (`render/layout/tests/octi.test.ts`), never inline next to the source. Shared test infra
  (`_fixtures.ts`) lives there too.
- **Debug / diagnostics** live in a per-directory `debug/<name>.debug.ts` module (see
  `render/layout/debug/travAudit.ts` for the shape):
  - Each debug function **self-gates** on its `OCTI_*` env flag (early return when off).
  - The routine **calls** it, passing the data it needs **as arguments**. Do NOT add
    debug-only exports to core files; pass private helpers in as callbacks, and for a trace
    called at many sites export a factory that returns the closure.
  - **Behavior/tuning knobs stay in the core** (they feed the algorithm, they are not
    debug). **Operational logging stays in the core** too:
    `[ImprovedSchematics]`-tagged startup/error/status `console.warn`/`info` coupled to
    control flow is not debug.
- **Env-var reads go through `src/env.ts`** (`envStr(name)` / `envNum(name)`), never the
  inline `(process as {...}).env?.X` boilerplate.

## Deprecated code

When a rebuild or replacement is signed off, **move** the superseded module(s), their
tests, and dedicated dev tools into the repo-root **`old/`** folder (mirrored paths, plus a
row in `old/README.md` pointing at the replacement), in the **same commit** that flips the
default. Imports inside `old/` must break loudly, not resolve silently. Nothing under
`old/` is compiled, tested, or imported by the live tree.

## Comments

Comments describe **what the code does** and, in general terms, **why**.

- **No em-dashes** — rephrase; do not substitute `-`, `:`, or parentheses.
- **No references** to specific example maps, cities, stations, or dumps; to user requests
  or session history; or to commit hashes / schema numbers. State the general phenomenon or
  the current behavior instead.
- Keep legitimate provenance: algorithm/paper references, a concise spec-file pointer,
  `@param`/`@returns`, and units.

## Production UI copy

Never add unnecessary text to production-facing designs. A title or label that **names**
the control is good; explanatory sentences, hints, and reassurance ("applies instantly",
"choose how X works") are fluff and must not ship. When in doubt, cut the sentence and
keep the noun.

## Workflow & git

- **Momentum with inline batched execution.** Use `AskUserQuestion` only for genuine scope
  forks; otherwise keep moving and pause at natural checkpoints. Surface **rendered
  visuals** (rasterized SVG → PNG via the dev harness) at decision points.
- Do feature/refactor work on a branch and **fast-forward merge to `master` locally**.
  Commit incrementally (one logical unit per commit) so an interruption cannot lose
  progress.
- **Commit or push only when asked.** Branch before committing if on `master`.
- Write commit messages to a temp file and use `git commit -F <file>`: an inline `-m`
  containing a drive-letter string (e.g. `C:`) is blocked by a safety hook.
