# Micro-Edge Chains C2 -> C3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> This plan follows the user's standing preference for **inline batched execution** with visual checkpoints; treat each Task as a checkpoint, not a subagent dispatch.

**Goal:** Take the C2 chain seat policy (`OCTI_CHAIN=1`, `src/render/chainSeats.ts`) from "structurally sound but failing both rulers" to the C3 gates, then flip the default on.

**Architecture:** The seat policy stays: interior chain edges take constant ladder-frame offsets at lane build; chain-end seams are ordinary jogs the fan closes. What changes is diagnosed per-site: the ladder's ordering/centering, the boundSeat frames, key-conflict handling between overlapping chains, and chain-end jog placement are the suspect knobs. Every fix follows the I4-remainder discipline: instrument, one hypothesis, one change, gate on BOTH rulers, revert falsified work.

**Tech Stack:** `npm test` (tsx --test), the pinned 6-city census corpus, and the NYC robustness harness (`dev/robustness-bake.ts` / `dev/robustness-check.ts`, baked in `dev/_robustness/`).

---

## The two rulers (gate every change on BOTH)

1. **Pinned corpus** (1 dump/city, censuses `OCTI_CLIPS/LOOPS/ZIGS/FANZONE`):
   flag-off baseline = 1 visible clip (SF Mission Bay, parked as ordering) / 0 loops /
   0 zigs / 6 latent tapers.
2. **NYC robustness table** (`npx tsx dev/robustness-check.ts dev/_robustness`, ~45s/variant,
   env flags pass through). Flag-off baselines per variant:

   | variant  | clips | loops | zigs | tapers |
   |----------|------:|------:|-----:|-------:|
   | base     | 0     | 0     | 0    | 3      |
   | growth2  | 3     | 0     | 0    | 10     |
   | growth45 | 1     | 0     | 2    | 0      |
   | nosplit  | 4     | 1     | 0    | 4      |
   | warp05   | 3     | 2     | 1    | 0      |
   | warp09   | 6     | 0     | 2    | 0      |

   C2 round-4 flag-on: 47 clips / 12 loops / 19 zigs total; growth2 alone 25/7/11/24
   and base 2/1/3/4 (confirmed by verbose re-run 2026-07-17). Flag-on growth2 also shows
   130 foreign zone crossings (vs a corpus-wide flag-off baseline of 52 across six
   cities): the seat policy is dragging lines across mates at scale, not diffusely
   mis-pitching. Dominant verbose signature: at mn254, lines `e2f8` (on me610) and
   `e94b` (on me388) each cross roughly a dozen mates inside the zone; secondary
   clusters at mn363 (me615/me269/me486), mn115 (me68), mn102 (me427), mn260
   (me530/me554/me491). A single line crossing its whole bundle is the classic
   wrong-side seat signature (hypothesis H4 first, H2 second, at those sites).

**C3 gates (from the spec, section 3):** pinned tapers -> 0; clip/loop/zig censuses no worse
anywhere; the variant sweep strictly fewer visible clips than flag-off per variant; ZERO
artifact loops on every variant (the loop census is the authoritative ruler for the
user-flagged same-color self-cross "plus" shape). Flag-off output stays byte-identical
through every commit.

**Standing rules:** never trade a latent zone intrusion for visible ink; a mid-straight
twist is worse than a wedge; after three falsified fixes on one family, stop and question
the construction (C2 already spent its three on rails-as-geometry; the seat policy gets
its own count).

---

### Task 1: Chain-seat diagnostics module

The failures are invisible without per-chain data. Build the debug module BEFORE touching
behavior, per the repo debug rules (self-gating env flag, data passed as arguments, no
debug exports from core).

**Files:**
- Create: `src/render/debug/chainSeats.debug.ts`
- Modify: `src/render/chainSeats.ts` (emit optional per-chain report data)
- Modify: `src/render/renderOctilinear.ts` (call the reporter beside `reportChains`)
- Test: none (recording-only; byte-identity is the check)

- [ ] **Step 1: Extend `computeChainSeats` to return diagnostics alongside the map.**
  Change the return type to `{ seats: Map<string, number>, report: ChainSeatReport[] }`
  where each report row carries: chain index, anchor node ids, edge count, per-run
  `{lineId, edgeIds, entry, exit, desired, ladderSeat}`, the ladder center `c`, and a
  `conflicts` list of keys that hit the first-write-wins branch (`out.has(key)`), with
  both the kept and the discarded seat values. The conflict list is hypothesis H1's
  instrument: overlapping chains silently disagreeing on a lane's seat.
- [ ] **Step 2: Write `debug/chainSeats.debug.ts`** with `reportChainSeats(args)`,
  self-gated on `OCTI_CHAIN_DUMP` via `envStr`. Print one line per chain (anchors, runs,
  c, ladder span) and one line per conflict (key, kept seat, discarded seat, the two
  chain indices). Print a final summary: chains with runs, total runs, total conflicts,
  max |desired - ladderSeat| (ladder distortion: how far the pitch-quantized ladder moved
  a run off its anchor-frame wish).
- [ ] **Step 3: Wire the call in `renderOctilinear.ts`** immediately after `computeChainSeats`,
  passing the report and `nodePx` (for readable coordinates). Flag-off and dump-off paths
  must not change any computed value.
- [ ] **Step 4: Verify.** `npm test` green; flag-off byte-identity on one pinned dump
  (`dev/_byte-identity.ts`); then run
  `OCTI_CHAIN=1 OCTI_CHAIN_DUMP=1 npx tsx dev/robustness-check.ts dev/_robustness` with
  `VERBOSE=1` and keep the growth2 section as the working RCA record.
- [ ] **Step 5: Commit** (`git commit -F <tempfile>`, message
  `feat(chains): per-chain seat diagnostics behind OCTI_CHAIN_DUMP`).

### Task 2: Per-site RCA on the worst variant (growth2), then base

No fixes in this task. Output = a defect table with a root cause per family, exactly like
the I4 remainder table.

**Files:**
- Create: none (scratchpad notes only)
- Uses: `dev/robustness-check.ts` (VERBOSE=1), `OCTI_CHAIN_DUMP`, `OCTI_FAN_TRACE=<full id>`,
  `OCTI_LANES=<edgeIds>`, `OCTI_LOOP_SEGS=1`, skeleton extraction `dev/_fanout/_skel.mjs`

- [ ] **Step 1: Enumerate.** `OCTI_CHAIN=1 VERBOSE=1` check on growth2 + base; list every
  clip (pair, px, extent), loop, and zig with coordinates. Cluster into families by
  junction/chain (the census extents + the Task 1 dump give the chain each site sits in).
  The growth2 enumeration (2026-07-17 verbose run) already clusters:
  - **Atlantic Av-Barclays** (~2590-2660, 3310-3350): 4 of the 7 artifact loops
    (routes 2/3/4/5, loopArc 36-79px) + 4 clips (5xD 31, 5x4 27sc, 4x3 23, 2x5 23) +
    2 nearby zigs (Q Bergen St, 2 Borough Hall). Same site as the mn254 foreign-crossing
    cluster (me610/me388). The densest single family; loops gate C3, start here.
  - **14 St** (~2057-2128, 2904-2906): 2 loops (B loopArc 53, HOB-33 loopArc 68) +
    ExA 21 same-color + zigs E 30.1 / A 41.1. The mn102/mn260 crossing cluster.
  - **Midtown trunk corridor** (28 St through 57 St, x 2075-2144): the largest clip
    family - 2xD 101px Penn Station, Fx1 52, Mx3 50 Bryant Park, ExN 46 57 St, MxW 35,
    Mx1 28, 3xF 28, Dx3 24, DxHOB 25, Bx1 21, WxQ 25sc + zigs R 44.1 / M 43.9 / W 38.4.
    Long chains along a dense trunk mis-seated over their whole run.
  - **Lower Manhattan** (Spring St / Christopher St / Bowling Green): WxA 48, 1xA 48,
    4xC 41, Rx5 34, 2x3 33sc, WxHOB 23, Ex4 20 + zig 1 27.5.
  - **Singles:** Court Sq E loop (2504,2535); Hoboken-8thStxJSQ 65 Newport; BxF 49sc
    2 Av; RxB 33 8 St-NYU; NxM 18 36 St; Bx2 21 Eastern Pkwy; BxA 17 Bergen St;
    B zig 37.4 81 St.
- [ ] **Step 2: For each family, decide which mechanism owns it.** The candidate causes,
  in prior order of suspicion:
  - **H1 key conflicts:** overlapping chains write different seats for the same
    (edge, line); first-write-wins leaves one chain's interior torn mid-corridor.
    Instrument: Task 1 conflict list. Prediction if true: defect sites sit on edges in
    the conflict list.
  - **H2 ladder order vs anchor order:** `runs.sort` orders by *desired value*; under a
    tight warp, anchor seats compress and two runs' desired values can invert relative
    to their actual anchor-side ordering, forcing a crossing at the chain end.
    Instrument: compare ladder order against the anchor edge's `orderOf` sequence in the
    dump. Prediction: crossing sites where ladder rank differs from anchor rank.
  - **H3 chain-end jog overload:** ladder center `c` (lower median) can sit several
    pitches off an anchor's bias under warped geometry; the chain-end seam then needs a
    multi-pitch jog with no room (growth2 shrinks arcs), and the fan's forced-crossing
    steepening or absorption fails or folds (loops). Instrument: max |desired - ladderSeat|
    plus the fan-zone taper census per site.
  - **H4 boundSeat frame errors:** the `dot >= 0.7` collinearity gate or the
    `aligned` travel-to-chain-frame mapping mis-signs a seat on reversed traversals in
    variant geometry, seating a line on the wrong side (sign flips read as plus-shape
    self-crossings). Instrument: per-run entry/exit signs in the dump vs the drawn side
    in the skeleton.
  - Anything that fits none of these gets a fresh RCA before any code moves.
- [ ] **Step 3: Verify each attribution on a skeleton,** not a full render: extract the
  involved `data-line-id` paths near the site and read the path commands. Record the
  family table (site, family, evidence) in the working notes.
- [ ] **Checkpoint:** present the family table to the user with 1-2 skeleton crops of the
  dominant family before starting fixes.

### Task 3: Fix family-by-family, one hypothesis at a time

One commit per family, strictly sequenced by expected yield (start with whichever family
Task 2 shows owns the growth2 loop cluster; loops gate C3 at ZERO, so they outrank clip
count). For EACH family:

**Files:**
- Modify: `src/render/chainSeats.ts` (mechanism lives here; chain-end jog issues may
  instead land in `src/render/fanJoin.ts`)
- Test: `src/render/tests/chainSeats.test.ts` (extend; fixture-first)

- [ ] **Step 1: Write a failing unit test** reproducing the mechanism in a minimal fixture
  (the existing 4 tests show the fixture shape: hand-built edges, traversals,
  laneOffsetOf). E.g. for H1: two overlapping chains sharing an edge must agree on that
  edge's seat, or the policy must yield to a deterministic winner chosen by a stated rule,
  not map iteration order. For H2: two runs whose desired values invert relative to
  anchor order must come out in anchor order.
- [ ] **Step 2: Run it, confirm it fails** for the diagnosed reason
  (`npx tsx --test src/render/tests/chainSeats.test.ts`).
- [ ] **Step 3: Implement the minimal mechanism change.** Candidate directions per family
  (pick ONLY what the RCA confirmed; do not batch):
  - H1: merge overlapping chains before seating, or seat chains in a deterministic order
    with explicit yield (longer chain wins) and re-derive the loser's ladder around the
    fixed seats.
  - H2: sort runs by anchor-side rank (from the anchor edge's lane order), tie-break by
    desired value, instead of by desired value alone.
  - H3: clamp the ladder toward the anchor frame (cap |ladderSeat - desired| per run, or
    center `c` on the anchor-weighted mean instead of the lower median), so chain-end
    seams stay within the room the fan can close.
  - H4: fix the frame mapping/sign and tighten the gate with a test per traversal
    direction.
- [ ] **Step 4: Gate.** In order: unit tests green (`npm test`); flag-off byte-identity on
  one pinned dump; `OCTI_CHAIN=1` robustness table (all 6 variants) strictly no worse
  than the previous round on every cell and improved for the family's variant; pinned
  corpus censuses. Record the table in the commit message body.
- [ ] **Step 5: Commit or revert.** A change that improves its family but worsens ANY
  loop/twist cell anywhere is falsified: revert (`git checkout -- <files>`), record the
  falsification in the working notes, return to Task 2 for that family. Count
  falsifications per family; at three, stop and bring the architecture question to the
  user (the seat policy itself may need the spec's subsumption stage instead).
- [ ] **Repeat** until the robustness table under `OCTI_CHAIN=1` dominates flag-off
  (every cell <=, clips strictly < where flag-off is nonzero) and pinned corpus shows
  0 loops / 0 zigs / clips <= 1.

### Task 4: Close the original targets (the reason chains exist)

The policy must actually FIX the sites that motivated it, not just stop regressing.

- [ ] **Step 1: Pinned-corpus fan-zone census under `OCTI_CHAIN=1`:** the me529 trio
  (NYC, 3 latent tapers, 19.7px into the mn262 zone) must be gone or reduced; total
  latent tapers must be <= the flag-off 6 and trending to the C3 target of 0. If the
  seat policy alone does not clear the trio, RCA whether the remaining machinery is the
  chain-end jog (fixable in Task 3 terms) or genuinely the spec's subsumption stage;
  in the latter case, present the finding and scope it with the user before building.
- [ ] **Step 2: Re-verify the deferred non-goals stay parked:** SF Mission Bay stays
  1 visible clip (ordering, out of scope); HOR me486 band exchanges stay documented
  residuals (anchor, out of chains scope).
- [ ] **Checkpoint:** rendered visual (skeleton overlay + one full crop) of me529/mn262
  before/after for the user.

### Task 5: C3 certification and default flip

Only after Tasks 3-4 hold their gates.

**Files:**
- Modify: `src/render/renderOctilinear.ts` (default: `OCTI_CHAIN` unset behaves as on;
  `OCTI_CHAIN=0` keeps the escape hatch, mirroring the OCTI_FAN/OCTI_ASSEMBLE pattern)
- Modify: `src/render/mapCache.ts` (VERSION bump + changelog line)
- Modify: `docs/superpowers/specs/2026-07-17-micro-edge-chains-design.md` (record C3
  results; note any spec deviations, e.g. seat policy replacing rails)

- [ ] **Step 1: Full certification run.** `npm test`; pinned corpus both modes with all
  censuses; robustness table with the flag default-on; explicit statement of each C3
  gate with its measured number.
- [ ] **Step 2: Flip the default** (`envStr('OCTI_CHAIN') !== '0'`), bump mapCache
  VERSION with a changelog entry, update the spec doc.
- [ ] **Step 3: Re-run the certification** with no env flags set (the shipping
  configuration) and confirm identical numbers.
- [ ] **Step 4: Commit** (`feat(chains): seat policy default on (C3)` with the gate
  table in the body). Do NOT merge to master or move anything to `old/`; C4
  consolidation and the legacy-machinery move wait for user sign-off per the
  deprecation policy.
- [ ] **Checkpoint:** present the C3 gate table and before/after visuals; ask for
  sign-off on C4 scope (what the chains subsume, what moves to `old/`).

---

## Self-review notes

- Spec coverage: C3 gates quoted from the spec verbatim (section 3); C4 explicitly
  deferred to sign-off. The rails construction named in the spec's C2 was falsified and
  replaced by the seat policy; Task 5 records that deviation in the spec doc.
- This is an RCA campaign, so Task 3 cannot contain literal fix code before Task 2 runs;
  instead it pins the discipline (failing test first, one change, both rulers, revert
  falsified) and enumerates the candidate mechanisms with their instruments and
  predictions so execution never guesses.
- Determinism: any new tie-break or merge rule must be sort-order deterministic (sorted
  line ids, no map iteration order), per the pipeline determinism rule.
