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
import { detectDrawnLoops } from '../layout/loopMetrics';
import { findInkClips, type InkRef } from '../layout/clipMetrics';

/** OCTI_JOIN_TRACE target line id (undefined outside Node / when unset). Kept
 *  as a value so the core's `JOIN_TRACE === lineId` guards read identically. */
export function joinTraceTarget(): string | undefined {
  return typeof process !== 'undefined' ? envStr('OCTI_JOIN_TRACE') : undefined;
}

/** OCTI_FANZONE: fan-zone exclusivity census (invariant I3). Every
 *  constructed fan group owns a zone of its reach along its corridors; a
 *  composition-change taper whose ramp reaches INTO another junction's
 *  zone interleaves foreign machinery with that junction's corner sweeps.
 *  Prints each intrusion with its overlap depth and a summary count. */
export function reportFanZones(d: {
  zones: Array<{ node: string; edgeA: string; edgeB: string; reach: number }>;
  tapers: Array<{ node: string; edgeId: string; lineId: string; len: number }>;
  edgeById: Map<string, { id: string; from: string; to: string }>;
  arcOf: (edgeId: string) => number;
  nodePx: Map<string, Pixel>;
}): void {
  if (envStr('OCTI_FANZONE') !== '1') return;
  const zoneAt = new Map<string, number>();
  for (const z of d.zones) {
    const k = z.node + '|' + z.edgeA;
    zoneAt.set(k, Math.max(zoneAt.get(k) ?? 0, z.reach));
  }
  let count = 0;
  for (const t of d.tapers) {
    const e = d.edgeById.get(t.edgeId);
    if (!e) continue;
    const other = e.from === t.node ? e.to : e.from;
    const reach = zoneAt.get(other + '|' + t.edgeId);
    if (reach === undefined) continue;
    const arc = d.arcOf(t.edgeId);
    const overlap = t.len - (arc - reach);
    if (overlap <= 0) continue;
    count++;
    const p = d.nodePx.get(other);
    console.warn(
      `[fanzone] taper ${t.lineId.slice(0, 4)} on ${t.edgeId} from ${t.node}` +
      ` len=${t.len.toFixed(1)} intrudes ${other}` +
      (p ? ` (${p[0].toFixed(0)},${p[1].toFixed(0)})` : '') +
      ` reach=${reach.toFixed(1)} overlap=${overlap.toFixed(1)}px arc=${arc.toFixed(1)}`,
    );
  }
  console.warn(`[fanzone] ${count} taper intrusions across ${d.zones.length} zones`);
}

/** OCTI_FANZONE: chain report (chains spec C1). Prints each detected
 *  chain; the C1 gate (every taper-intrusion edge inside a chain, no
 *  runaway chains) is read off this plus the taper report. */
export function reportChains(d: {
  chains: Array<{ edgeIds: string[]; anchorA: string | null; anchorB: string | null; arc: number }>;
  nodePx: Map<string, Pixel>;
  edgeById: Map<string, { id: string; from: string; to: string }>;
}): void {
  if (envStr('OCTI_FANZONE') !== '1') return;
  for (const c of d.chains) {
    const first = d.edgeById.get(c.edgeIds[0]);
    const p = first ? d.nodePx.get(first.from) : undefined;
    console.warn(
      '[chains] ' + c.edgeIds.join('>') + ' arc=' + c.arc.toFixed(0) +
      ' anchors=' + (c.anchorA ?? 'terminus') + '..' + (c.anchorB ?? 'terminus') +
      (p ? ' at=(' + p[0].toFixed(0) + ',' + p[1].toFixed(0) + ')' : ''),
    );
  }
  console.warn('[chains] ' + d.chains.length + ' chains');
}

/** OCTI_FANZONE: stop-mark half of the fan-zone census (invariant I3).
 *  A station's drawn mark seated inside ANOTHER junction's zone sits in
 *  ink the corner construction owns. Marks whose stop the fan itself
 *  seated (its join-curve stop positions, including absorbed far nodes)
 *  are the fan's own and exempt. */
export function reportStopSeating(d: {
  zones: Array<{ node: string; edgeA: string; edgeB: string; reach: number }>;
  stopsByNode: Map<string, Array<{ lineId: string; pos: Pixel; seatDirt?: number }>>;
  joinStopPos: Map<string, Pixel>;
  edgeById: Map<string, { id: string; from: string; to: string }>;
  basePoly: (edgeId: string) => Pixel[] | undefined;
  halfWidthOf: (edgeId: string) => number;
  spacing: number;
  nodePx: Map<string, Pixel>;
  /** Seat-ink oracle re-query at FINAL mark positions (I10): classifies each
   *  intrusion by occlusion. Absent on callers without station machinery. */
  dirtAt?: (p: Pixel, lineId: string) => number;
}): void {
  if (envStr('OCTI_FANZONE') !== '1') return;
  let count = 0;
  const classCount = { visible: 0, 'occluded-avoidable': 0, 'occluded-certified': 0, 'lone-stop': 0 };
  for (const z of d.zones) {
    const e = d.edgeById.get(z.edgeA);
    const base = d.basePoly(z.edgeA);
    const zp = d.nodePx.get(z.node);
    if (!e || !base || base.length < 2 || !zp) continue;
    const lat = d.halfWidthOf(z.edgeA) + d.spacing;
    let arc = 0;
    for (let i = 1; i < base.length; i++) arc += Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]);
    for (const [nodeId, marks] of d.stopsByNode) {
      const homeNode = nodeId.split('::')[0];
      if (homeNode === z.node) continue;
      // A station whose OWN node lives closer to the junction than the
      // zone's reach has no legal seat on this edge at all; that is the
      // layout's spacing, not a seating choice, and not this census's
      // finding. Marks with room that strayed inside anyway, and marks
      // from FOREIGN corridors, are the violations.
      if ((e.from === homeNode || e.to === homeNode) && arc < z.reach + d.spacing) continue;
      for (const m of marks) {
        if (d.joinStopPos.has(homeNode + '|' + m.lineId)) continue;
        // nearest point on the base + its distance from the zone node
        let bestD = Infinity;
        let bestQ: Pixel = base[0];
        for (let i = 1; i < base.length; i++) {
          const ax = base[i - 1][0], ay = base[i - 1][1];
          const vx = base[i][0] - ax, vy = base[i][1] - ay;
          const len2 = vx * vx + vy * vy;
          if (len2 < 1e-12) continue;
          let t = ((m.pos[0] - ax) * vx + (m.pos[1] - ay) * vy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + vx * t, qy = ay + vy * t;
          const dd = Math.hypot(m.pos[0] - qx, m.pos[1] - qy);
          if (dd < bestD) { bestD = dd; bestQ = [qx, qy]; }
        }
        if (bestD > lat) continue;
        const along = Math.hypot(bestQ[0] - zp[0], bestQ[1] - zp[1]);
        if (along >= z.reach - 0.5) continue;
        count++;
        // Occlusion class (I10): an intruding mark whose line is the TOP ink
        // at its seat is the learned capsule-group exemption; occluded marks
        // split by whether the seat solve certified the dirt (recorded
        // seatDirt > 0 means no clean feasible seat existed) or believed the
        // seat clean (avoidable: oracle blind spot or post-seat movement).
        // Single-mark units have no seat search at all.
        let cls = '';
        if (d.dirtAt) {
          const finalDirt = d.dirtAt(m.pos, m.lineId);
          cls =
            finalDirt <= 0 ? 'visible'
            : marks.length === 1 ? 'lone-stop'
            : (m.seatDirt ?? 0) > 0 ? 'occluded-certified'
            : 'occluded-avoidable';
          classCount[cls as keyof typeof classCount]++;
        }
        console.warn(
          `[fanzone] stop ${m.lineId.slice(0, 4)}@${homeNode} pos=(${m.pos[0].toFixed(0)},${m.pos[1].toFixed(0)})` +
          ` inside ${z.node} zone on ${z.edgeA} (along=${along.toFixed(1)} < reach=${z.reach.toFixed(1)})` +
          (cls ? ` class=${cls}` : ''),
        );
      }
    }
  }
  console.warn(`[fanzone] ${count} stop-mark intrusions`);
  if (d.dirtAt) {
    console.warn(
      `[fanzone] classes: ${classCount.visible} visible, ${classCount['occluded-avoidable']} occluded-avoidable, ` +
      `${classCount['occluded-certified']} occluded-certified, ${classCount['lone-stop']} lone-stop`,
    );
    // Corpus-wide I10 ruler, zone-independent: how many drawn marks sit on
    // occluded own ink at their FINAL position (what the viewer sees). The
    // in-zone classes above are the fan-zone slice of this.
    let dirty = 0;
    let total = 0;
    for (const marks of d.stopsByNode.values()) {
      for (const m of marks) {
        total++;
        if (d.dirtAt(m.pos, m.lineId) > 0) dirty++;
      }
    }
    console.warn(`[fanzone] seat-ink: ${dirty}/${total} marks on occluded ink`);
  }
}

/** OCTI_FANZONE: foreign-crossing half of the fan-zone census (invariant
 *  I3). A transversal crossing between two lines' FINAL ink inside a
 *  junction's zone, where either line does not even traverse that
 *  junction, is foreign machinery interleaving with the corner sweeps
 *  (the fan's own nested corners always belong to lines turning there). */
export function reportZoneCrossings(d: {
  zones: Array<{ node: string; edgeA: string; edgeB: string; reach: number }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  lineById: Map<string, { id: string }>;
  lineTraversals: Map<string, Array<{ edgeId: string }>>;
  edgeById: Map<string, { id: string; from: string; to: string }>;
  basePoly: (edgeId: string) => Pixel[] | undefined;
  halfWidthOf: (edgeId: string) => number;
  spacing: number;
  nodePx: Map<string, Pixel>;
}): void {
  if (envStr('OCTI_FANZONE') !== '1') return;
  const nodesOfLine = new Map<string, Set<string>>();
  for (const [lineId, trav] of d.lineTraversals) {
    if (!d.lineById.has(lineId)) continue;
    const set = new Set<string>();
    for (const step of trav) {
      const e = d.edgeById.get(step.edgeId);
      if (e) { set.add(e.from); set.add(e.to); }
    }
    nodesOfLine.set(lineId, set);
  }
  const segsByLine = d.parseInk(d.dByLine);
  // uniform grid over all segments for pair candidates
  const CELL = 48;
  const grid = new Map<string, Array<{ lineId: string; a: Pixel; b: Pixel }>>();
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!d.lineById.has(lineId)) continue;
    for (const [a, b] of segsByLine.get(lineId)!) {
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx + ',' + gy;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push({ lineId, a, b });
      }
    }
  }
  const cross = (o: Pixel, p: Pixel, q: Pixel): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const seen = new Set<string>();
  const hits: Array<{ a: string; b: string; p: Pixel }> = [];
  for (const cell of [...grid.keys()].sort()) {
    const arr = grid.get(cell)!;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const S = arr[i], T = arr[j];
        if (S.lineId === T.lineId) continue;
        const d1 = cross(S.a, S.b, T.a), d2 = cross(S.a, S.b, T.b);
        const d3 = cross(T.a, T.b, S.a), d4 = cross(T.a, T.b, S.b);
        if (!((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0))) continue;
        // transversal only: near-parallel grazing pairs are the clip
        // census's subject, not a crossing
        const ux = S.b[0] - S.a[0], uy = S.b[1] - S.a[1];
        const vx = T.b[0] - T.a[0], vy = T.b[1] - T.a[1];
        const det = ux * vy - uy * vx;
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        if (lu < 1e-9 || lv < 1e-9 || Math.abs(det) / (lu * lv) < 0.17) continue;
        const t = ((T.a[0] - S.a[0]) * vy - (T.a[1] - S.a[1]) * vx) / det;
        const p: Pixel = [S.a[0] + ux * t, S.a[1] + uy * t];
        const [A, B] = S.lineId < T.lineId ? [S.lineId, T.lineId] : [T.lineId, S.lineId];
        const key = A + '|' + B + '|' + Math.round(p[0] / 8) + ',' + Math.round(p[1] / 8);
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ a: A, b: B, p });
      }
    }
  }
  let count = 0;
  for (const h of hits) {
    for (const z of d.zones) {
      const e = d.edgeById.get(z.edgeA);
      const base = d.basePoly(z.edgeA);
      const zp = d.nodePx.get(z.node);
      if (!e || !base || base.length < 2 || !zp) continue;
      let bestD = Infinity;
      let bestQ: Pixel = base[0];
      for (let i = 1; i < base.length; i++) {
        const ax = base[i - 1][0], ay = base[i - 1][1];
        const vx = base[i][0] - ax, vy = base[i][1] - ay;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1e-12) continue;
        let t = ((h.p[0] - ax) * vx + (h.p[1] - ay) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + vx * t, qy = ay + vy * t;
        const dd = Math.hypot(h.p[0] - qx, h.p[1] - qy);
        if (dd < bestD) { bestD = dd; bestQ = [qx, qy]; }
      }
      if (bestD > d.halfWidthOf(z.edgeA) + d.spacing) continue;
      if (Math.hypot(bestQ[0] - zp[0], bestQ[1] - zp[1]) >= z.reach) continue;
      const aAt = nodesOfLine.get(h.a)?.has(z.node) ?? false;
      const bAt = nodesOfLine.get(h.b)?.has(z.node) ?? false;
      if (aAt && bAt) continue;
      count++;
      console.warn(
        `[fanzone] crossing ${h.a.slice(0, 4)}x${h.b.slice(0, 4)} at=(${h.p[0].toFixed(0)},${h.p[1].toFixed(0)})` +
        ` inside ${z.node} zone on ${z.edgeA} (foreign: ${aAt ? h.b.slice(0, 4) : h.a.slice(0, 4)})`,
      );
      break;
    }
  }
  console.warn(`[fanzone] ${count} foreign crossings in zones (${hits.length} transversal crossings total)`);
}

/** OCTI_LANES=<edgeId,edgeId,...>: print each listed edge's lane seating
 *  right after lane construction: the drawn order and, per line, its slot,
 *  the edge bias, and the lane polyline's end points. */
export function reportLaneSeats(d: {
  orderOf: Map<string, string[]>;
  slotOf: Map<string, number>;
  biasOf: Map<string, number>;
  segPath: Map<string, Pixel[]>;
}): void {
  const want = envStr('OCTI_LANES');
  if (!want) return;
  // line:<idPrefix>@x0,y0,x1,y1 dumps every lane of that line entering
  // the bbox, when the hosting edge is unknown.
  if (want.startsWith('line:')) {
    const [prefix, box] = want.slice(5).split('@');
    const [x0, y0, x1, y1] = (box ?? '').split(',').map(Number);
    for (const [key, poly] of d.segPath) {
      const [edgeId, lineId] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      if (!lineId.startsWith(prefix)) continue;
      const hit = !box || poly.some((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1);
      if (!hit) continue;
      const bias = d.biasOf.get(edgeId) ?? 0;
      const slot = d.slotOf.get(key);
      const a = poly[0];
      const b = poly[poly.length - 1];
      console.error(
        `[lanes] ${edgeId} ${lineId.slice(0, 4)} slot=${slot?.toFixed(2)} bias=${bias.toFixed(2)}` +
        ` a=(${a?.[0].toFixed(1)},${a?.[1].toFixed(1)}) b=(${b?.[0].toFixed(1)},${b?.[1].toFixed(1)})`,
      );
    }
    return;
  }
  for (const edgeId of want.split(',').filter(Boolean)) {
    const order = d.orderOf.get(edgeId);
    if (!order) { console.error(`[lanes] ${edgeId}: no order`); continue; }
    const bias = d.biasOf.get(edgeId) ?? 0;
    for (const lineId of order) {
      const slot = d.slotOf.get(edgeId + '|' + lineId);
      const poly = d.segPath.get(edgeId + '|' + lineId);
      const a = poly?.[0];
      const b = poly?.[poly.length - 1];
      console.error(
        `[lanes] ${edgeId} ${lineId.slice(0, 4)} slot=${slot?.toFixed(2)} bias=${bias.toFixed(2)}` +
        ` a=(${a?.[0].toFixed(1)},${a?.[1].toFixed(1)}) b=(${b?.[0].toFixed(1)},${b?.[1].toFixed(1)})`,
      );
    }
  }
}

/** OCTI_JOIN_TRACE: per-line join-pass trace closure. `traceTarget` is the
 *  value of joinTraceTarget(); the returned `jlog(m)` prints '[join] '+m only
 *  when tracing this line. */
export function makeJoinLog(traceTarget: string | undefined, lineId: string): (m: string) => void {
  return (m: string) => { if (traceTarget === lineId) console.error('[join] ' + m); };
}

/** OCTI_LOOPS: measure self-crossings in the FINAL DRAWN ink of each route
 *  (every fillet, join, connector, and closure curve, exactly what the reader
 *  sees) and anchor each to its nearest station group. Operates on the drawn
 *  'd' rather than the traversal-concatenated painted track, so a course that
 *  retraces or jumps between non-adjacent steps reports no phantom crossing
 *  where the concatenation chord would have cut across its own ink. */
export function reportPaintedLoops(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_LOOPS')) return;
  const { layout, lineById, dByLine, parseInk, stations, nodePx } = d;
  const segsByLine = parseInk(dByLine);
  const routesDrawn: Array<{ lineId: string; chains: Pixel[][] }> = [];
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    const chains = inkChains(segsByLine.get(lineId)!);
    if (chains.some((c) => c.length >= 2)) routesDrawn.push({ lineId, chains });
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
  const loops = detectDrawnLoops(routesDrawn);
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
        if (count <= (Number.isFinite(envNum("OCTI_CENSUS_PRINT")) ? envNum("OCTI_CENSUS_PRINT") : 40)) {
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

interface StraightRun {
  dir: Pixel;
  arcLen: number;
  start: Pixel;
  end: Pixel;
  /** Polyline segments merged into the run: a clean constructed lane is
   *  a few long segments; harvested surface-track data is dense. */
  segs: number;
}

/** Maximal straight runs of a drawn polyline: direction stable within
 *  `coneDeg` over at least `minRun` arclength. Curve samples between
 *  runs never qualify, so the runs are the design-strategy segments. */
const straightRunsOf = (pts: Pixel[], minRun: number, coneDeg: number): StraightRun[] => {
  const len = (a: Pixel, b: Pixel): number => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  const dir = (a: Pixel, b: Pixel): Pixel | null => {
    const l = len(a, b);
    return l < 1e-6 ? null : [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const deg = (dot: number): number => (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  const runs: StraightRun[] = [];
  let runStart = 0;
  let runDir: Pixel | null = null;
  let runArc = 0;
  let runSegs = 0;
  const closeRun = (endIdx: number): void => {
    if (runDir && runArc >= minRun) {
      const d0 = dir(pts[runStart], pts[endIdx]);
      if (d0) runs.push({ dir: d0, arcLen: runArc, start: pts[runStart], end: pts[endIdx], segs: runSegs });
    }
  };
  for (let i = 1; i < pts.length; i++) {
    const d0 = dir(pts[i - 1], pts[i]);
    const step = len(pts[i - 1], pts[i]);
    if (!d0) continue;
    if (runDir && deg(runDir[0] * d0[0] + runDir[1] * d0[1]) <= coneDeg) {
      runArc += step;
      runSegs++;
      continue;
    }
    closeRun(i - 1);
    runStart = i - 1;
    runDir = d0;
    runArc = step;
    runSegs = 1;
  }
  closeRun(pts.length - 1);
  return runs;
};

const inkChains = (segs: Array<[Pixel, Pixel]>): Pixel[][] => {
  const len = (a: Pixel, b: Pixel): number => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  const chains: Pixel[][] = [];
  let cur: Pixel[] | null = null;
  for (const [a, b] of segs) {
    if (cur && len(cur[cur.length - 1], a) <= 1e-6) cur.push(b);
    else chains.push((cur = [a, b]));
  }
  return chains;
};

/** OCTI_SPIKES: census of sub-octilinear angles in the FINAL ink. The
 *  design strategy allows straight travel and 45-degree-multiple turns;
 *  any sustained direction change below that family is a spike. Two
 *  shapes qualify: a RAMP (travel continues straight overall while a
 *  local stretch deviates by a sub-octilinear angle, the Z a jog taper
 *  paints) and a BEND (the run direction itself changes by a lasting
 *  sub-octilinear angle). Windowed like the zig census so smooth curve
 *  samples near sanctioned corners never qualify: their net change
 *  reaches the full 45 degrees. */
export function reportSpikes(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  spacing: number;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_SPIKES')) return;
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
  const deg = (dot: number): number => (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  // The design strategy is straight octilinear segments joined by
  // 45-degree-family turns (rounded by fillets). Extract STRAIGHT RUNS
  // (direction stable within a small cone over a material arclength) and
  // measure the angle between consecutive runs; fillet samples between
  // them never qualify as straight and cannot fire. A spike is a
  // straight-to-straight angle that sits away from every multiple of 45.
  const MIN_RUN = Math.max(8, spacing * 1.5);
  const STRAIGHT_DEG = 6;
  const OFF_GRID_DEG = 10;
  let count = 0;
  let denseCount = 0;
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    const segs = segsByLine.get(lineId)!;
    for (const pts of inkChains(segs)) {
      const runs = straightRunsOf(pts, MIN_RUN, STRAIGHT_DEG);
      for (let k = 1; k < runs.length; k++) {
        const a = runs[k - 1];
        const b = runs[k];
        const theta = deg(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1]);
        const offGrid = Math.abs(theta - Math.round(theta / 45) * 45);
        if (theta < OFF_GRID_DEG || offGrid <= OFF_GRID_DEG) continue;
        count++;
        // A run of harvested surface-track data merges many short
        // segments; a constructed lane is a few long ones. Either flank
        // dense marks the spike as data-shaped rather than construction.
        const dense = a.segs / a.arcLen > 1 / 6 || b.segs / b.arcLen > 1 / 6;
        if (dense) denseCount++;
        if (count <= (Number.isFinite(envNum("OCTI_CENSUS_PRINT")) ? envNum("OCTI_CENSUS_PRINT") : 40)) {
          const ln = lineById.get(lineId);
          console.error(
            `[spikes] ${ln?.label ?? lineId} (${ln?.color ?? '?'}) angle=${theta.toFixed(0)}deg ` +
            `runs=${a.arcLen.toFixed(0)}/${b.arcLen.toFixed(0)}px ${dense ? 'DENSE' : 'clean'} ` +
            `at=(${a.end[0].toFixed(0)},${a.end[1].toFixed(0)}) near=${nearestGroup(a.end)}`,
          );
        }
      }
    }
  }
  console.error(`[spikes] ${count} sub-octilinear angles between straight runs (${denseCount} data-shaped, >=${MIN_RUN.toFixed(0)}px runs, off-grid > ${OFF_GRID_DEG}deg)`);
}

/** OCTI_STAIRS: census of staircasing in the FINAL ink. A single
 *  45-degree jog is the sanctioned way to resolve an offset; STAIRS are
 *  the repeated form: four or more consecutive straight runs alternating
 *  between two grid directions a 45-degree turn apart, with short treads
 *  between the outer runs. The design preference is one straight
 *  resolution over a flight of small steps. */
export function reportStairs(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  spacing: number;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
}): void {
  if (!envStr('OCTI_STAIRS')) return;
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
  const deg = (dot: number): number => (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  const MIN_RUN = Math.max(8, spacing * 1.5);
  const STRAIGHT_DEG = 6;
  // A tread longer than this reads as genuine travel, not a step.
  const MAX_TREAD = spacing * 5;
  let flights = 0;
  let steps = 0;
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    const segs = segsByLine.get(lineId)!;
    for (const pts of inkChains(segs)) {
      const runs = straightRunsOf(pts, MIN_RUN, STRAIGHT_DEG);
      let k = 0;
      while (k + 3 < runs.length + 1 && k < runs.length - 1) {
        const turn01 = deg(runs[k].dir[0] * runs[k + 1].dir[0] + runs[k].dir[1] * runs[k + 1].dir[1]);
        if (turn01 < 35 || turn01 > 55) { k++; continue; }
        // extend the alternation dirA, dirB, dirA, dirB, ...
        let j = k + 1;
        while (
          j + 1 < runs.length &&
          deg(runs[j + 1].dir[0] * runs[j - 1].dir[0] + runs[j + 1].dir[1] * runs[j - 1].dir[1]) <= STRAIGHT_DEG &&
          runs[j].arcLen <= MAX_TREAD
        ) j++;
        const turns = j - k;
        if (turns >= 3) {
          flights++;
          steps += turns - 1;
          if (flights <= 40) {
            const ln = lineById.get(lineId);
            console.error(
              `[stairs] ${ln?.label ?? lineId} (${ln?.color ?? '?'}) turns=${turns} ` +
              `at=(${runs[k].end[0].toFixed(0)},${runs[k].end[1].toFixed(0)}) near=${nearestGroup(runs[k].end)}`,
            );
          }
          k = j;
        } else {
          k++;
        }
      }
    }
  }
  console.error(`[stairs] ${flights} staircases (${steps} steps, treads <= ${MAX_TREAD.toFixed(0)}px)`);
}

/** OCTI_CONTIG: census of drawn-route non-contiguities. A route's ink
 *  is contiguous iff its sub-paths form ONE connected component;
 *  endpoints within a sub-pixel seam epsilon count as joined (the
 *  renderer treats consecutive lane ends under half a pixel as already
 *  joined and emits no bridge). Every extra component is a break; the
 *  reported gap is the closest endpoint pair between components, so a
 *  1px crack and an intentional long cut are distinguishable. */
export function reportContiguity(d: {
  layout: Layout;
  lineById: Map<string, { id: string; label?: string; color: string }>;
  dByLine: Map<string, string[]>;
  parseInk: (dByLine: Map<string, string[]>) => Map<string, Array<[Pixel, Pixel]>>;
  stations?: Array<{ nodeId: string }>;
  nodePx: Map<string, Pixel>;
  /** Drawn stop-mark positions; a break whose endpoints sit under one of
   *  the line's own marks is an intentional opaque-design crop window,
   *  not a crack. */
  stopsByNode?: Map<string, Array<{ lineId: string; pos: Pixel }>>;
}): void {
  if (!envStr('OCTI_CONTIG')) return;
  const { layout, lineById, dByLine, parseInk, stations, nodePx, stopsByNode } = d;
  const EPS = 0.6;
  const MARK_R = 14;
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
  const stopsOf = new Map<string, Pixel[]>();
  for (const entries of stopsByNode?.values() ?? []) {
    for (const e of entries) {
      const list = stopsOf.get(e.lineId);
      if (list) list.push(e.pos); else stopsOf.set(e.lineId, [e.pos]);
    }
  }
  // Point-to-segment distance, for T-join detection (see below).
  const TJOIN_EPS = 2;
  const ptSeg = (p: Pixel, a: Pixel, b: Pixel): number => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return len(p, a);
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return len(p, [a[0] + vx * t, a[1] + vy * t]);
  };
  // Whether an endpoint of chain `ci` lands on any segment of chain `cj`. A
  // branching route (one whose own drawn ink has a degree-3 node, i.e. it
  // serves a spur) is inherently drawn as several subpaths that meet at a
  // T-junction: the spur subpath's M sits ON the corridor subpath's interior
  // ink, not at its endpoint. Endpoint-coincidence alone reads that as a
  // break. Only a CHAIN ENDPOINT landing on ink connects; a mid-segment
  // self-crossing has no endpoint there, so genuine crossings and true gaps
  // (whose dangling end lands on empty canvas) stay flagged.
  const tjoined = (ci: number, cj: number, endsArr: Array<[Pixel, Pixel]>, chainsArr: Pixel[][]): boolean => {
    const cjPts = chainsArr[cj];
    for (const e of endsArr[ci]) {
      for (let k = 1; k < cjPts.length; k++) {
        if (ptSeg(e, cjPts[k - 1], cjPts[k]) <= TJOIN_EPS) return true;
      }
    }
    return false;
  };

  let brokenLines = 0;
  let breaks = 0;
  let exempt = 0;
  let tjoins = 0;
  let printed = 0;
  for (const lineId of [...segsByLine.keys()].sort()) {
    if (!lineById.has(lineId)) continue;
    const chains = inkChains(segsByLine.get(lineId)!);
    if (chains.length <= 1) continue;
    // connected components over chains via endpoint coincidence
    const ends = chains.map((c) => [c[0], c[c.length - 1]] as [Pixel, Pixel]);
    const comp = chains.map((_, i) => i);
    const findC = (i: number): number => (comp[i] === i ? i : (comp[i] = findC(comp[i])));
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        let touch = false;
        for (const a of ends[i]) {
          for (const b of ends[j]) {
            if (len(a, b) <= EPS) { touch = true; break; }
          }
          if (touch) break;
        }
        if (touch) comp[findC(i)] = findC(j);
      }
    }
    // T-junction joins: a chain endpoint lying on another chain's interior ink
    // (a spur resuming on the corridor it branches from) is connected drawing.
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        if (findC(i) === findC(j)) continue;
        if (tjoined(i, j, ends, chains) || tjoined(j, i, ends, chains)) {
          comp[findC(i)] = findC(j);
          tjoins++;
          if (envStr('OCTI_CONTIG_TJ') === '1') {
            const ln = lineById.get(lineId);
            console.error(`[contig-tj] ${ln?.label ?? lineId} chains ${i}<->${j} near=${nearestGroup(ends[i][0])}`);
          }
        }
      }
    }
    // opaque-design crop windows: a small gap whose BOTH sides sit under
    // one of this line's own drawn marks is an intentional cut, and its
    // components count as joined
    const marks = stopsOf.get(lineId) ?? [];
    const underMark = (p: Pixel): boolean => marks.some((m) => len(m, p) <= MARK_R);
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        if (findC(i) === findC(j)) continue;
        for (const a of ends[i]) {
          for (const b of ends[j]) {
            if (len(a, b) <= 2 * MARK_R && underMark(a) && underMark(b)) {
              comp[findC(i)] = findC(j);
              exempt++;
            }
          }
        }
      }
    }
    const roots = new Set(chains.map((_, i) => findC(i)));
    if (roots.size <= 1) continue;
    brokenLines++;
    breaks += roots.size - 1;
    // closest endpoint pair across DIFFERENT components = the crack
    let gap = Infinity;
    let at: Pixel = ends[0][0];
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        if (findC(i) === findC(j)) continue;
        for (const a of ends[i]) {
          for (const b of ends[j]) {
            const g = len(a, b);
            if (g < gap) { gap = g; at = a; }
          }
        }
      }
    }
    if (printed++ < 40) {
      const ln = lineById.get(lineId);
      console.error(
        `[contig] ${ln?.label ?? lineId} (${ln?.color ?? '?'}) components=${roots.size} ` +
        `minGap=${gap.toFixed(1)}px at=(${at[0].toFixed(0)},${at[1].toFixed(0)}) near=${nearestGroup(at)}`,
      );
    }
  }
  console.error(`[contig] ${breaks} non-contiguities across ${brokenLines} broken routes (${exempt} crop windows exempt, ${tjoins} T-joins, seam eps ${EPS})`);
}

/** OCTI_DEBUG: a stop flag whose node has no drawn lane for its line was
 *  re-anchored to the nearest drawn endpoint on the line's own course. */
export function reportReanchoredFlag(d: {
  layout: Layout;
  lineLabel: string;
  fromNode: string;
  toNode: string;
  pos: Pixel;
}): void {
  if (!envStr('OCTI_DEBUG')) return;
  const label = d.layout.nodes.get(d.fromNode)?.label ?? '';
  console.error(`[stops] re-anchored ${d.lineLabel} flag ${d.fromNode} "${label}" -> ${d.toNode} at (${d.pos[0].toFixed(1)},${d.pos[1].toFixed(1)})`);
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
