// Ribbon-renderer diagnostics (env-gated, dev only). Extracted from
// renderOctilinear so the renderer keeps only the call sites. Each function
// self-gates on its env flag and reproduces the exact console output the inline
// block used to emit. Enable with OCTI_JOIN_TRACE (per-line join tracing),
// OCTI_LOOPS (painted-loop census), OCTI_PLACE_DEBUG (placement / capsule
// overlap diagnostics), OCTI_CONN_TRACE (per-line connector trace),
// CSPREAD_DEBUG (corridor-spread trace), or OCTI_DEBUG (vanished/slid/evicted
// stations, egregious ring overlaps, ribbon summary).
import { envStr, envNum } from '../../env';
import type { Layout, Pixel } from '../layout/types';
import { detectPaintedLoops } from '../layout/loopMetrics';
import { findInkClips, type InkRef } from '../layout/clipMetrics';

/** OCTI_JOIN_TRACE target line id (undefined outside Node / when unset). Kept
 *  as a value so the core's `JOIN_TRACE === lineId` guards read identically. */
export function joinTraceTarget(): string | undefined {
  return typeof process !== 'undefined' ? envStr('OCTI_JOIN_TRACE') : undefined;
}

/** OCTI_JOIN_TRACE: per-line join-pass trace closure. `traceTarget` is the
 *  value of joinTraceTarget(); the returned `jlog(m)` prints '[join] '+m only
 *  when tracing this line. */
export function makeJoinLog(traceTarget: string | undefined, lineId: string): (m: string) => void {
  return (m: string) => { if (traceTarget === lineId) console.error('[join] ' + m); };
}

/** OCTI_LOOPS: measure self-crossings in the PAINTED track (offset lanes, not
 *  the edge skeleton) and anchor each to its nearest station group. */
export function reportPaintedLoops(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  lineTraversals: Layout['lineTraversals'];
  segPath: Map<string, Pixel[]>;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_LOOPS')) return;
  const { layout, lineById, lineTraversals, segPath, stations, nodePx } = d;
  const routesPainted: Array<{ lineId: string; pts: Pixel[] }> = [];
  for (const [lineId, traversal] of lineTraversals) {
    if (!lineById.has(lineId)) continue;
    const pts: Pixel[] = [];
    for (const step of traversal) {
      const lane = segPath.get(step.edgeId + '|' + lineId);
      if (!lane || lane.length < 2) continue;
      const seq = step.reversed ? [...lane].reverse() : lane; // lanes run from→to
      for (const p of seq) {
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) pts.push(p);
      }
    }
    if (pts.length >= 4) routesPainted.push({ lineId, pts });
  }
  // station groups (nodes carrying ≥1 stop) with pixel positions + labels,
  // for anchoring each loop to the place a reader would name it.
  const groups: Array<{ pos: Pixel; label: string }> = [];
  for (const st of stations ?? []) {
    const pos = nodePx.get(st.nodeId);
    if (pos) groups.push({ pos, label: layout.nodes.get(st.nodeId)?.label ?? st.nodeId });
  }
  const nearestGroup = (p: Pixel): string => {
    let best = '?';
    let bd = Infinity;
    for (const g of groups) {
      const dd = (g.pos[0] - p[0]) ** 2 + (g.pos[1] - p[1]) ** 2;
      if (dd < bd) { bd = dd; best = g.label; }
    }
    return `${best} (${Math.sqrt(bd).toFixed(0)}px)`;
  };
  const loops = detectPaintedLoops(routesPainted);
  for (const l of loops.slice(0, 40)) {
    const ln = lineById.get(l.lineId);
    console.error(
      `[loops] ${l.kind.toUpperCase()} route ${ln?.label ?? l.lineId} (${ln?.color ?? '?'}) ` +
      `at=(${l.at[0].toFixed(0)},${l.at[1].toFixed(0)}) group=${nearestGroup(l.at)} ` +
      `loopArc=${l.loopArc.toFixed(0)} diam=${l.diameter.toFixed(0)}`,
    );
    // OCTI_LOOP_SEGS=1 additionally prints the two crossing segments (and the
    // route's line id), pinpointing the exact ink for an RCA.
    if (envStr('OCTI_LOOP_SEGS') === '1') {
      const fp = (p: Pixel) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`;
      console.error(
        `[loops]   id=${l.lineId} segI=${fp(l.segI[0])}-${fp(l.segI[1])} segJ=${fp(l.segJ[0])}-${fp(l.segJ[1])}`,
      );
    }
  }
  const arts = loops.filter((l) => l.kind === 'artifact').length;
  console.error(`[loops] ${arts} artifact loops, ${loops.length - arts} bigloops (likely genuine routes)`);
}

/** OCTI_CLIPS: census of one line's FINAL ink riding through another line's
 *  ink (sustained near-parallel sub-pitch overlap on the finished ribbons,
 *  fillets/joins/connectors included). `parseInk` is the core's
 *  drawnSegsByLine, passed as a callback so the parse only runs when the flag
 *  is on. OCTI_CLIP_DIST / OCTI_CLIP_RUN override the thresholds (px). */
export function reportBundleClips(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  spacing: number;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_CLIPS')) return;
  const { layout, lineById, dByLine, parseInk, spacing, stations, nodePx } = d;
  const distMax = Number.isFinite(envNum('OCTI_CLIP_DIST')) ? envNum('OCTI_CLIP_DIST') : spacing * 0.75;
  const runMin = Number.isFinite(envNum('OCTI_CLIP_RUN')) ? envNum('OCTI_CLIP_RUN') : spacing * 3;
  const segsByLine = parseInk(dByLine);
  const inks: InkRef[] = [];
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    inks.push({ id: lineId, segs: segsByLine.get(lineId)! });
  }
  const clips = findInkClips(inks, distMax, runMin);
  const groups: Array<{ pos: Pixel; label: string }> = [];
  for (const st of stations ?? []) {
    const pos = nodePx.get(st.nodeId);
    if (pos) groups.push({ pos, label: layout.nodes.get(st.nodeId)?.label ?? st.nodeId });
  }
  const nearestGroup = (p: Pixel): string => {
    let best = '?';
    let bd = Infinity;
    for (const g of groups) {
      const dd = (g.pos[0] - p[0]) ** 2 + (g.pos[1] - p[1]) ** 2;
      if (dd < bd) { bd = dd; best = g.label; }
    }
    return `${best} (${Math.sqrt(bd).toFixed(0)}px)`;
  };
  const rows = [...clips].sort((a, b) => b.run - a.run);
  let sameColor = 0;
  for (const r of rows) {
    if ((lineById.get(r.idA)?.color ?? '').toLowerCase() === (lineById.get(r.idB)?.color ?? '#?').toLowerCase()) sameColor++;
  }
  for (const r of rows.slice(0, 60)) {
    const la = lineById.get(r.idA);
    const lb = lineById.get(r.idB);
    const invisible = (la?.color ?? '').toLowerCase() === (lb?.color ?? '#?').toLowerCase();
    console.error(
      `[clips] ${la?.label ?? r.idA} (${la?.color ?? '?'}) x ${lb?.label ?? r.idB} (${lb?.color ?? '?'}) ` +
      `run=${r.run.toFixed(0)}px at=(${r.at[0].toFixed(0)},${r.at[1].toFixed(0)}) near=${nearestGroup(r.at)}` +
      (invisible ? ' [same-color]' : ''),
    );
    // OCTI_CLIP_SEGS=1 additionally prints the run extent and ids.
    if (envStr('OCTI_CLIP_SEGS') === '1') {
      console.error(
        `[clips]   idA=${r.idA.slice(0, 8)} idB=${r.idB.slice(0, 8)} ` +
        `a=(${r.a[0].toFixed(1)},${r.a[1].toFixed(1)}) b=(${r.b[0].toFixed(1)},${r.b[1].toFixed(1)})`,
      );
    }
  }
  console.error(
    `[clips] ${rows.length} ink clips, ${rows.length - sameColor} visible + ${sameColor} same-color ` +
    `(dist<${distMax.toFixed(1)} run>=${runMin.toFixed(1)})`,
  );
}

/** OCTI_ZIGS: census of perpendicular micro-steps in the FINAL ink
 *  (invariant I9): a sub-pitch segment near-perpendicular to near-parallel
 *  travel on both sides of it (the right-angle zigzag a degenerate lateral
 *  jog paints). Curve samples never qualify: a sampled arc turns far less
 *  than the 60-degree bend the test demands per sample. */
export function reportZigzags(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  spacing: number;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_ZIGS')) return;
  const { layout, lineById, dByLine, parseInk, spacing, stations, nodePx } = d;
  const segsByLine = parseInk(dByLine);
  const groups: Array<{ pos: Pixel; label: string }> = [];
  for (const st of stations ?? []) {
    const pos = nodePx.get(st.nodeId);
    if (pos) groups.push({ pos, label: layout.nodes.get(st.nodeId)?.label ?? st.nodeId });
  }
  const nearestGroup = (p: Pixel): string => {
    let best = '?';
    let bd = Infinity;
    for (const g of groups) {
      const dd = (g.pos[0] - p[0]) ** 2 + (g.pos[1] - p[1]) ** 2;
      if (dd < bd) { bd = dd; best = g.label; }
    }
    return `${best} (${Math.sqrt(bd).toFixed(0)}px)`;
  };
  const len = (a: Pixel, b: Pixel): number => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  const dir = (a: Pixel, b: Pixel): Pixel | null => {
    const l = len(a, b);
    return l < 1e-6 ? null : [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  // Windowed detection: hard steps AND smooth-but-tight S ramps both read
  // as zigzags, but a tight ramp's individual samples never deviate much
  // from their immediate neighbours. Compare each material segment against
  // the RUN DIRECTIONS one and a half pitches before and after it: travel
  // that continues straight overall (runs near-parallel) while the local
  // segment deviates steeply from it is a step, whatever its smoothness.
  // A genuine corner fails the run-parallel test; a sanctioned shallow
  // taper never deviates 45 degrees from its surrounding run.
  const W = spacing * 1.5;
  let count = 0;
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    const segs = segsByLine.get(lineId)!;
    // contiguous chains as polylines (an M boundary breaks adjacency)
    const chains: Pixel[][] = [];
    let cur: Pixel[] | null = null;
    for (const [a, b] of segs) {
      if (cur && len(cur[cur.length - 1], a) <= 1e-6) cur.push(b);
      else chains.push((cur = [a, b]));
    }
    for (const pts of chains) {
      const arc: number[] = [0];
      for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + len(pts[i - 1], pts[i]));
      const total = arc[arc.length - 1];
      if (total < 2 * W) continue;
      const at = (s: number): Pixel => {
        if (s <= 0) return pts[0];
        if (s >= total) return pts[pts.length - 1];
        let i = 1;
        while (arc[i] < s) i++;
        const t = (s - arc[i - 1]) / (arc[i] - arc[i - 1] || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      };
      let skipUntil = -1;
      for (let i = 1; i < pts.length; i++) {
        if (arc[i - 1] < Math.max(W, skipUntil) || arc[i] > total - W) continue;
        const step = len(pts[i - 1], pts[i]);
        if (step < 0.5) continue;
        const dBefore = dir(at(arc[i - 1] - W), pts[i - 1]);
        const dAfter = dir(pts[i], at(arc[i] + W));
        const dd = dir(pts[i - 1], pts[i]);
        if (!dBefore || !dAfter || !dd) continue;
        if (dBefore[0] * dAfter[0] + dBefore[1] * dAfter[1] < 0.85) continue;
        if (Math.abs(dd[0] * dBefore[0] + dd[1] * dBefore[1]) > 0.7) continue;
        count++;
        skipUntil = arc[i] + W;
        if (count <= 40) {
          const ln = lineById.get(lineId);
          console.error(
            `[zigs] ${ln?.label ?? lineId} (${ln?.color ?? '?'}) step=${step.toFixed(1)}px ` +
            `at=(${pts[i - 1][0].toFixed(0)},${pts[i - 1][1].toFixed(0)}) near=${nearestGroup(pts[i - 1])}`,
          );
        }
      }
    }
  }
  console.error(`[zigs] ${count} perpendicular steps or steep ramps (window ${W.toFixed(1)})`);
}

/** OCTI_DEBUG: per-station VANISHED-marker diagnostic (a station whose marks
 *  all fail to resolve renders nothing while its edges still draw). */
export function reportVanishedStations(d: {
  stations: Array<{ nodeId: string; members: number; stopNodes: Map<string, string> }>;
  gathered: Array<{ marks: Array<unknown> }>;
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  drawnEndAt: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_DEBUG')) return;
  const { stations, gathered, layout, lineById, drawnEndAt } = d;
  let vanished = 0;
  for (let i = 0; i < stations.length; i++) {
    if (gathered[i].marks.length > 0) continue;
    const st = stations[i];
    const label = layout.nodes.get(st.nodeId)?.label ?? st.nodeId;
    const trace: string[] = [];
    for (const [lineId, flagNode] of st.stopNodes) {
      const why = !lineById.get(lineId)
        ? '!line'
        : drawnEndAt.has(flagNode + '|' + lineId) ? 'ok' : '!pos';
      trace.push(`${lineById.get(lineId)?.label ?? lineId}@${flagNode}=${why}`);
    }
    console.error(
      `[stops] VANISHED "${label}" node=${st.nodeId} members=${st.members} ` +
      `stops=${st.stopNodes.size}: ${trace.join(' ') || '(no stopNodes)'}`,
    );
    vanished++;
  }
  if (vanished > 0) {
    console.error(`[stops] vanished stations (edge drawn, no marker): ${vanished}`);
  }
}

/** OCTI_PLACE_DEBUG: far-attach outcome for a spread multi-bundle station. */
export function reportFarAttach(nodeId: string, spread: number, bundles: number, attached: boolean): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  console.error(
    `[far-attach] ${nodeId} spread=${spread.toFixed(0)} bundles=${bundles}` +
    ` -> ${attached ? 'ATTACHED' : 'failed'}`,
  );
}

/** OCTI_PLACE_DEBUG: best-effort split-unit seating outcome. */
export function reportSplitFit(nodeId: string, seated: boolean): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  console.error(`[split-fit] ${nodeId} best-effort -> ${seated ? 'seated' : 'still null (structural)'}`);
}

/** OCTI_PLACE_DEBUG: seat-time capsule overlap (self / cross) for one solution. */
export function reportCapsOverlap(d: {
  reject: boolean;
  nodeId: string;
  markCount: number;
  bestEffort: boolean;
  verts: Pixel[];
  selfOvl: boolean;
  crossOvl: string | null;
}): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  const { reject, nodeId, markCount, bestEffort, verts, selfOvl, crossOvl } = d;
  let cx = 0, cy = 0;
  for (const v of verts) { cx += v[0]; cy += v[1]; }
  console.error(
    `[capsovl] ${reject ? 'REJECT' : 'overlap'} ${nodeId} marks=${markCount}${bestEffort ? ' best-effort' : ''} at=(${(cx / verts.length).toFixed(0)},${(cy / verts.length).toFixed(0)})${selfOvl ? ' self' : ''}${crossOvl ? ` cross(${crossOvl})` : ''}${reject ? ' → split/mega' : ''}`,
  );
}

/** OCTI_PLACE_DEBUG: platform-split announcement. */
export function reportPlatformSplit(d: {
  layout: Layout;
  nodeId: string;
  clusters: number[][];
}): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  const { layout, nodeId, clusters } = d;
  console.error(
    `[stops] platform-split "${layout.nodes.get(nodeId)?.label ?? nodeId}" ` +
    `-> ${clusters.length} bundle units [${clusters.map((c) => c.length).join(',')}]`,
  );
}

/** Capsule-overlap enforcement counters (printed when place-debug is on OR any
 *  capsule was rejected). `capPlaceDebug` is passed so the OR-condition stays
 *  byte-identical to the inline site. */
export function reportCapsOvlStats(d: {
  capPlaceDebug: boolean;
  stats: { capsules: number; self: number; cross: number; rejected: number };
  guardOn: boolean;
  noOvlOn: boolean;
}): void {
  const { capPlaceDebug, stats, guardOn, noOvlOn } = d;
  if (!(capPlaceDebug || stats.rejected > 0)) return;
  console.error(
    `[capsovl] capsules=${stats.capsules} selfOvl=${stats.self} crossOvl=${stats.cross} rejected=${stats.rejected} (guard=${guardOn ? 'on' : 'off'} noovl=${noOvlOn ? 'on' : 'off'})`,
  );
}

/** OCTI_PLACE_DEBUG: hull cross/self audit over the current drawn (non-boxed)
 *  capsules. `items` are precomputed by the caller (hulls it already builds);
 *  `crossPairs` and `selfs` are the caller's classification results. */
export function reportCapsAudit(d: {
  label: string;
  crossPairs: string[];
  selfs: string[];
}): void {
  if (envStr('OCTI_PLACE_DEBUG') !== '1') return;
  const { label, crossPairs, selfs } = d;
  console.error(
    `[capsaudit:${label}] cross=${crossPairs.length}${crossPairs.length ? ' [' + crossPairs.join(',') + ']' : ''} self=${selfs.length}${selfs.length ? ' [' + selfs.join(',') + ']' : ''}`,
  );
}

/** Unconditional: a rigid slide was declined because the candidate bent
 *  off-octilinear. Dumps leg structure + the worst off-axis segment (the probe
 *  lives here). `legs` is the caller's `rowsOf(...)` leg-length string; `clone`
 *  is the (already slid + corner-recomputed) mark clone; `marks` the original
 *  station marks (for the corner count). */
export function reportRigidSlideDeclined(d: {
  nodeId: string;
  legs: string;
  marks: Array<{ cornerAfter?: Pixel }>;
  clone: Array<{ pos: Pixel; chain?: number; cornerAfter?: Pixel }>;
}): void {
  const { nodeId, legs, marks, clone } = d;
  const QPI = Math.PI / 4;
  const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);
  const ord = [...clone].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
  const vs: Pixel[] = [];
  for (const mk of ord) { vs.push(mk.pos); if (mk.cornerAfter) vs.push(mk.cornerAfter); }
  let worst = '(none)';
  let worstGap = -Infinity;
  for (let i = 1; i < vs.length; i++) {
    const dx = vs[i][0] - vs[i - 1][0], dy = vs[i][1] - vs[i - 1][1];
    const len = hyp(dx, dy);
    if (len < 1) continue;
    const m = ((Math.atan2(dy, dx) % QPI) + QPI) % QPI;
    const off = Math.min(m, QPI - m);
    const bar = Math.max(Math.PI / 180, Math.asin(Math.min(1, 0.85 / len)));
    if (off - bar > worstGap) {
      worstGap = off - bar;
      worst = `seg${i} len=${len.toFixed(1)} off=${(off * 180 / Math.PI).toFixed(1)}deg bar=${(bar * 180 / Math.PI).toFixed(1)}deg`;
    }
  }
  const corners = marks.filter((m) => m.cornerAfter).length;
  console.error(`[stops] rigid slide declined (non-octilinear) ${nodeId}: legs=${legs} marks=${marks.length} corners=${corners} worst[${worst}]`);
}

/** Unconditional: a slide was declined because it would stack two dots. */
export function reportSlideStackDeclined(nodeId: string, dist: number, floor: number): void {
  console.error(`[stops] slide declined (would stack dots) ${nodeId}: ${dist.toFixed(1)}px < floor ${floor.toFixed(1)}`);
}

/** OCTI_PLACE_DEBUG: a slide was declined because it would self-cross. */
export function reportSlideSelfCross(capPlaceDebug: boolean, nodeId: string): void {
  if (capPlaceDebug) console.error(`[capsovl] slide declined (would self-cross) ${nodeId}`);
}

/** OCTI_PLACE_DEBUG: a slide was declined because it would cross another capsule. */
export function reportSlideClashDeclined(capPlaceDebug: boolean, nodeId: string, clash: string): void {
  if (capPlaceDebug) console.error(`[capsovl] slide declined (would cross ${clash}) ${nodeId}`);
}

/** CSPREAD_DEBUG target flag (raw envStr value — truthy enables the trace). */
export function corridorSpreadDebug(): string | undefined {
  return envStr('CSPREAD_DEBUG');
}

/** CSPREAD_DEBUG: a corridor-spread chain was abandoned. Gated by the caller's
 *  `dbg` flag (the value of corridorSpreadDebug()) to match the inline site. */
export function reportCorridorAbandon(dbg: string | undefined, failNid: string, orderNodeIds: string[]): void {
  if (dbg) console.error(`[CSPREAD] chain ABANDON fail=${failNid} order=[${orderNodeIds.join(',')}]`);
}

/** CSPREAD_DEBUG: a corridor-spread chain was spread. */
export function reportCorridorSpread(dbg: string | undefined, n: number, axis: Pixel, orderNodeIds: string[]): void {
  if (dbg) console.error(`[CSPREAD] chain SPREAD n=${n} axis=[${axis[0].toFixed(2)},${axis[1].toFixed(2)}] order=[${orderNodeIds.join(',')}]`);
}

/** Unconditional summary (spreadChains > 0). */
export function reportCorridorSpreadSummary(spreadChains: number, spreadMembers: number): void {
  if (spreadChains > 0) console.error(`[stops] corridor-spread: ${spreadChains} chains, ${spreadMembers} members`);
}

/** Unconditional: two small stations the corridor-spread could not separate are
 *  left seated on their lanes (a rare residual fill overlap, accepted rather than
 *  boxed). Surfaces a concrete case if one ever appears. */
export function reportNoOverlapFloorResidual(d: {
  layout: Layout;
  aNodeId: string;
  bNodeId: string;
}): void {
  const { layout, aNodeId, bNodeId } = d;
  console.error(`[stops] NO-OVERLAP-FLOOR residual: ${aNodeId} "${layout.nodes.get(aNodeId)?.label ?? ''}" ~ ${bNodeId} "${layout.nodes.get(bNodeId)?.label ?? ''}" (corridor-spread could not separate; left seated, not boxed)`);
}

/** A station's placed marks, as the overlap census reads them. */
type MarkStation = {
  nodeId: string;
  marks: Array<{ pos: Pixel; chain?: number; cornerAfter?: Pixel }>;
};

/** OCTI_DEBUG: EGREGIOUS ring-overlap census (XSTN cross-station, INSTN
 *  intra-station). Runs its own overlap scan over the caller's live positions. */
export function reportEgregiousOverlaps<S extends MarkStation>(d: {
  layout: Layout;
  r: number;
  smalls: S[];
  gathered: S[];
}): void {
  if (!envStr('OCTI_DEBUG')) return;
  const { layout, r, smalls, gathered } = d;
  const ringDia = 2 * r + 1.5;
  const ovls: Array<{ kind: string; a: string; b: string; dist: number; x: number; y: number }> = [];
  const ringSmalls = smalls;
  for (let ai = 0; ai < ringSmalls.length; ai++) {
    for (let bi = ai + 1; bi < ringSmalls.length; bi++) {
      const A = ringSmalls[ai], B = ringSmalls[bi];
      let md = Infinity, mx = 0, my = 0;
      for (const p of A.marks) for (const q of B.marks) {
        const dx = p.pos[0] - q.pos[0], dy = p.pos[1] - q.pos[1];
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < md) { md = dd; mx = (p.pos[0] + q.pos[0]) / 2; my = (p.pos[1] + q.pos[1]) / 2; }
      }
      if (md < ringDia) ovls.push({ kind: 'XSTN', a: A.nodeId, b: B.nodeId, dist: md, x: mx, y: my });
    }
  }
  for (const s of gathered) {
    if (s.marks.length < 2) continue;
    const ord = [...s.marks].sort((a, b) => (a.chain ?? 0) - (b.chain ?? 0));
    for (let i = 0; i < ord.length; i++) {
      for (let j = i + 1; j < ord.length; j++) {
        if (j === i + 1 && !ord[i].cornerAfter) continue; // same-row-adjacent = normal
        const dx = ord[i].pos[0] - ord[j].pos[0], dy = ord[i].pos[1] - ord[j].pos[1];
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < ringDia) {
          ovls.push({ kind: 'INSTN', a: s.nodeId, b: `${i}~${j}${ord[i].cornerAfter ? '/cnr' : ''}`, dist: dd, x: (ord[i].pos[0] + ord[j].pos[0]) / 2, y: (ord[i].pos[1] + ord[j].pos[1]) / 2 });
        }
      }
    }
  }
  ovls.sort((p, q) => p.dist - q.dist);
  const lbl = (id: string) => layout.nodes.get(id)?.label ?? '';
  const xstnAll = ovls.filter((o) => o.kind === 'XSTN');
  for (const o of (envStr('OCTI_XSTN_ALL') ? xstnAll : ovls.slice(0, 25))) {
    const nm = o.kind === 'XSTN' ? ` "${lbl(o.a)}" vs "${lbl(o.b)}"` : '';
    console.error(`[stops] ${o.kind} ${o.dist.toFixed(1)}px ${o.a} vs ${o.b}${nm} @(${o.x.toFixed(0)},${o.y.toFixed(0)})`);
  }
  const xstnSevere = xstnAll.filter((o) => o.dist < 3.2).length; // dots actually overlap
  console.error(`[stops] egregious overlaps: ${ovls.length} (ringDia=${ringDia.toFixed(1)}) XSTN=${xstnAll.length} XSTN_SEVERE=${xstnSevere} INSTN=${ovls.length - xstnAll.length}`);
}

/** OCTI_DEBUG: stations slid clear of a neighbour. */
export function reportSlidStations(d: {
  layout: Layout;
  slid: Array<{ nodeId: string; at: Pixel }>;
}): void {
  if (d.slid.length === 0 || !envStr('OCTI_DEBUG')) return;
  const { layout, slid } = d;
  for (const s of slid) {
    const label = layout.nodes.get(s.nodeId)?.label ?? s.nodeId;
    console.error(`[stops] slid "${label}" clear of a neighbour at (${s.at[0].toFixed(0)},${s.at[1].toFixed(0)})`);
  }
}

/** OCTI_DEBUG: terminus dots evicted clear of a foreign capsule. */
export function reportEvictedStations(d: {
  layout: Layout;
  evicted: Array<{ node: string; to: Pixel }>;
}): void {
  if (d.evicted.length === 0 || !envStr('OCTI_DEBUG')) return;
  const { layout, evicted } = d;
  for (const e of evicted) {
    const label = layout.nodes.get(e.node)?.label ?? e.node;
    console.error(`[stops] evicted "${label}" terminus dot clear of foreign capsule -> (${e.to[0].toFixed(0)},${e.to[1].toFixed(0)})`);
  }
}

/** OCTI_CONN_TRACE: per-line node-connector trace. Self-gates on the target
 *  line id matching `lineId`. */
export function reportConnTrace(d: {
  lineId: string;
  endA: string;
  cell: [number, number] | undefined;
  pa: Pixel; pb: Pixel; gap: number;
  prevA: Pixel; nextB: Pixel;
  dirA: Pixel; dirB: Pixel;
  nA: number; nB: number;
  edgeA: string; edgeB: string;
}): void {
  if (envStr('OCTI_CONN_TRACE') !== d.lineId) return;
  const { endA, cell: np, pa, pb, gap, prevA, nextB, dirA, dirB, nA, nB, edgeA, edgeB } = d;
  console.error(`[conn] ${endA} pa=(${pa[0].toFixed(1)},${pa[1].toFixed(1)}) pb=(${pb[0].toFixed(1)},${pb[1].toFixed(1)}) gap=${gap.toFixed(1)} prevA=(${prevA[0].toFixed(1)},${prevA[1].toFixed(1)}) nextB=(${nextB[0].toFixed(1)},${nextB[1].toFixed(1)}) dirA=(${dirA[0].toFixed(2)},${dirA[1].toFixed(2)}) dirB=(${dirB[0].toFixed(2)},${dirB[1].toFixed(2)}) nA=${nA} nB=${nB} edges=${edgeA}|${edgeB} cell=${np ? np[0] + ',' + np[1] : '?'}`);
}

/** OCTI_DEBUG: one-line per-edge ribbon summary. */
export function reportRibbonSummary(d: {
  segCount: number;
  edgeCount: number;
  miteredCount: number;
  connCount: number;
  lineCount: number;
}): void {
  if (!envStr('OCTI_DEBUG')) return;
  const { segCount, edgeCount, miteredCount, connCount, lineCount } = d;
  console.error(
    `[ribbons] per-edge: ${segCount} segments across ${edgeCount} edges, ` +
    `${miteredCount} mitered joins, ${connCount} connector candidates, ${lineCount} lines`,
  );
}
