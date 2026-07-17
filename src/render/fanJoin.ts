// Junction fan builder: computes every node corner ONCE per (junction, turn
// group) so all lines turning between the same two edges share one corner
// construction. Bundle-mates then get nested, non-crossing sweeps by
// construction instead of per-line agreement by luck, and every geometric
// gate derives from the actual bundle geometry (fan reach), never a fixed
// constant. Replaces the per-line join ladder in the ribbon renderer; see
// docs/draw-geometry-invariants.md (invariants I2 and I7).

import type { Pixel, TraversalStep } from './layout/types';
import { taperLaneEnd } from './layout/offsets';
import { fanTraceTarget, makeFanLog } from './debug/fanJoin.debug';
import { envStr } from '../env';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

export interface JoinCurve {
  lineId: string;
  node: string;
  a: Pixel;
  apex: Pixel;
  b: Pixel;
  /** The turn group's edge pair (canonical order), so a per-line path
   *  assembler can splice the curve between its two lane pieces. */
  edgeA?: string;
  edgeB?: string;
}

export interface FanEdgeRef {
  id: string;
  from: string;
  to: string;
}

export interface FanArgs {
  lineTraversals: Map<string, TraversalStep[]>;
  /** Lines that actually render (membership check only). */
  lineIds: Set<string>;
  edgeById: Map<string, FanEdgeRef>;
  /** edge.id|lineId -> offset lane polyline. End vertices are MUTATED in
   *  place (trims, pins, tapers), exactly like the join ladder did; a lane
   *  consumed by multi-edge corner absorption is DELETED. */
  segPath: Map<string, Pixel[]>;
  /** Suppressed lane keys (jog slivers). Absorption ADDS consumed lanes so
   *  every bridging consumer (assembler, legacy connectors) already knows
   *  to carry the course across them in one stroke. */
  suppressed: Set<string>;
  /** Drawn lane order per edge (post sliver suppression). */
  orderOf: Map<string, string[]>;
  biasOf: Map<string, number>;
  nodePx: Map<string, Pixel>;
  spacing: number;
  /** Corner sweep trim ceiling (the renderer's SMOOTH_R). */
  smoothR: number;
  /** Jog-branch gap cap, in slot widths. */
  bigGapMult: number;
  /** Base corridor direction at `node`, pointing away from the node into
   *  the edge. Corridor references anchored at a lane end extend along
   *  THIS direction: a lane's own end segment may already carry another
   *  group's jog taper, and extending that slant across an absorbed span
   *  amplifies it into a large lateral error. */
  baseEndDir?: (edgeId: string, node: string) => Pixel | null;
}

export interface FanResult {
  joinCurves: JoinCurve[];
  /** nodeId|lineId -> on-curve stop position (quadratic midpoint). */
  joinStopPos: Map<string, Pixel>;
  /** edgeId|lineId|s|e — lane ends already moved (each moves at most once). */
  endMoved: Set<string>;
  /** lineId|node|pairKey — pairs handled here (no node connector needed). */
  mitered: Set<string>;
  /** Fan zone per (junction, corridor): the farthest point any applied
   *  corner construction placed from the node along edgeA (invariant I3's
   *  exclusive reach, measured and directional, not theoretical). Consumed
   *  by the fan-zone census. */
  zones: Array<{ node: string; edgeA: string; edgeB: string; reach: number }>;
  /** Applied composition-change tapers: ramp length along `edgeId` starting
   *  at `node`. Consumed by the fan-zone census (a ramp reaching into
   *  ANOTHER junction's zone violates I3). */
  tapers: Array<{ node: string; edgeId: string; lineId: string; len: number }>;
}

/** One line's continuation through a node: arrives on edgeIn, leaves on
 *  edgeOut. Lane orientation flags say whether the node end of each lane
 *  polyline is its index 0. */
interface Member {
  lineId: string;
  edgeIn: string;
  edgeOut: string;
  inAtStart: boolean;
  outAtStart: boolean;
  /** The line's edges beyond the pair in its traversal, when contiguous:
   *  a corner whose near lane is a micro-edge is really a corner with the
   *  corridor beyond it, so the sharp pin can reference the through lane. */
  prevEdge?: string;
  nextEdge?: string;
}

interface Group {
  node: string;
  edgeA: string; // canonical: edgeA < edgeB
  edgeB: string;
  members: Member[];
}

/** Resolved end geometry for one member (recomputed lazily so earlier groups'
 *  mutations are seen). dirIn points INTO the node, dirOut OUT of it. */
interface Ends {
  pIn: Pixel[];
  pOut: Pixel[];
  qa: Pixel;
  qa1: Pixel;
  qb: Pixel;
  qb1: Pixel;
  lenA: number;
  lenB: number;
  dirIn: Pixel;
  dirOut: Pixel;
}

const SQ = Math.SQRT1_2;
const OCTI8: Pixel[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [SQ, SQ], [SQ, -SQ], [-SQ, SQ], [-SQ, -SQ],
];

const snapOcti = (d: Pixel): Pixel => {
  let best = OCTI8[0];
  let bd = -Infinity;
  for (const o of OCTI8) {
    const dot = d[0] * o[0] + d[1] * o[1];
    if (dot > bd) { bd = dot; best = o; }
  }
  return best;
};

/** Infinite-line meet of (pa, da) and (pb, db); null when near-parallel. */
const lineMeet = (pa: Pixel, da: Pixel, pb: Pixel, db: Pixel): Pixel | null => {
  const den = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((pb[0] - pa[0]) * db[1] - (pb[1] - pa[1]) * db[0]) / den;
  return [pa[0] + da[0] * t, pa[1] + da[1] * t];
};

/**
 * Enumerate every continuation pair of every rendered line and group them
 * by (near node, unordered edge pair). A pair is two consecutive DRAWN
 * steps: a span of suppressed-only lanes between them still pairs, since
 * the course bridges it in one stroke and its seat change is this pair's
 * to construct (left to the emission bridge, it paints a maximally steep
 * ramp). A closed ring course contributes its seam pair; an out-and-back's
 * same-edge seam does not. Groups come back in sorted (node, pairKey)
 * order; members in stable slot order on edgeA. Exported for tests.
 */
export function collectFanGroups(
  lineTraversals: Map<string, TraversalStep[]>,
  lineIds: Set<string>,
  edgeById: Map<string, FanEdgeRef>,
  orderOf: Map<string, string[]>,
  segPath: Map<string, Pixel[]>,
  suppressed: Set<string>,
): Group[] {
  const byKey = new Map<string, Group>();
  const sortedLines = [...lineTraversals.keys()].sort();
  for (const lineId of sortedLines) {
    if (!lineIds.has(lineId)) continue;
    const traversal = lineTraversals.get(lineId)!;
    const drawn: number[] = [];
    for (let i = 0; i < traversal.length; i++) {
      if (segPath.has(traversal[i].edgeId + '|' + lineId)) drawn.push(i);
    }
    if (drawn.length < 2) continue;
    const bridgeable = (from: number, to: number): boolean => {
      for (let k = from + 1; k < to; k++) {
        if (!suppressed.has(traversal[k].edgeId + '|' + lineId)) return false;
      }
      return true;
    };
    // Pairs of consecutive drawn steps (suppressed-only gaps allowed), plus
    // the seam pair of a closed course.
    const pairs: Array<[number, number]> = [];
    for (let j = 1; j < drawn.length; j++) {
      if (bridgeable(drawn[j - 1], drawn[j])) pairs.push([j - 1, j]);
    }
    {
      const f = traversal[drawn[0]];
      const l = traversal[drawn[drawn.length - 1]];
      const ef = edgeById.get(f.edgeId);
      const el = edgeById.get(l.edgeId);
      const firstStart = f.reversed ? ef?.to : ef?.from;
      const lastEnd = l.reversed ? el?.from : el?.to;
      if (firstStart !== undefined && firstStart === lastEnd) pairs.push([drawn.length - 1, 0]);
    }
    for (const [ja, jb] of pairs) {
      const a = traversal[drawn[ja]];
      const b = traversal[drawn[jb]];
      if (a.edgeId === b.edgeId) continue;
      const ea = edgeById.get(a.edgeId);
      const eb = edgeById.get(b.edgeId);
      if (!ea || !eb) continue;
      const endA = a.reversed ? ea.from : ea.to;
      const startB = b.reversed ? eb.to : eb.from;
      // Adjacent steps must genuinely meet; a bridged pair's contiguity is
      // carried by the suppressed chain between them.
      if (drawn[jb] === drawn[ja] + 1 && endA !== startB) continue;
      const [eA, eB] = a.edgeId < b.edgeId ? [a.edgeId, b.edgeId] : [b.edgeId, a.edgeId];
      const key = endA + '|' + eA + '|' + eB;
      let g = byKey.get(key);
      if (!g) byKey.set(key, (g = { node: endA, edgeA: eA, edgeB: eB, members: [] }));
      const prevStep = ja >= 1 ? traversal[drawn[ja - 1]] : (jb === 0 ? traversal[drawn[drawn.length - 2]] : undefined);
      const nextStep = jb + 1 < drawn.length ? traversal[drawn[jb + 1]] : (jb === 0 ? traversal[drawn[1]] : undefined);
      g.members.push({
        lineId,
        edgeIn: a.edgeId,
        edgeOut: b.edgeId,
        inAtStart: ea.from === endA,
        outAtStart: eb.from === startB,
        prevEdge: prevStep && prevStep.edgeId !== a.edgeId ? prevStep.edgeId : undefined,
        nextEdge: nextStep && nextStep.edgeId !== b.edgeId ? nextStep.edgeId : undefined,
      });
    }
  }
  const groups = [...byKey.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([, g]) => g);
  for (const g of groups) {
    const order = orderOf.get(g.edgeA) ?? [];
    const idx = new Map(order.map((id, i) => [id, i]));
    g.members.sort((m, n) => {
      const d = (idx.get(m.lineId) ?? order.length) - (idx.get(n.lineId) ?? order.length);
      return d !== 0 ? d : m.lineId < n.lineId ? -1 : m.lineId > n.lineId ? 1 : 0;
    });
  }
  return groups;
}

/**
 * Build every corner join for the rendered network. Mutates segPath lane ends
 * in place (trims, meet pins, tapers) and returns the curve/stop/bookkeeping
 * sets the renderer's emission and marker passes consume. Deterministic:
 * sorted group iteration, sqrt-only math.
 */
export function buildFanJoins(args: FanArgs): FanResult {
  const { segPath, suppressed, edgeById, orderOf, biasOf, nodePx, spacing, smoothR, bigGapMult, baseEndDir } = args;
  // OCTI_ABSORB=0 disables multi-edge corner absorption (A/B).
  const absorbOn = envStr('OCTI_ABSORB') !== '0';
  const joinCurves: JoinCurve[] = [];
  const joinStopPos = new Map<string, Pixel>();
  const endMoved = new Set<string>();
  const mitered = new Set<string>();
  const zones: FanResult['zones'] = [];
  const tapers: FanResult['tapers'] = [];
  // Actual constructed extent per (node, edge): the farthest point any
  // applied corner construction (curve trim or sharp pin) placed from the
  // node ALONG that corridor. Directional, not radial: a corner's long leg
  // up one corridor must not veto ramps on the junction's other corridors.
  // And measured, not theoretical: a near-parallel group's clamped fan
  // reach can exceed whole edges while it constructs nothing but tapers.
  const extentAt = new Map<string, number>();
  const bumpExtent = (node: string, edgeId: string, p: Pixel): void => {
    const np = nodePx.get(node);
    if (!np) return;
    const d = hyp(p[0] - np[0], p[1] - np[1]);
    const k = node + '|' + edgeId;
    if (d > (extentAt.get(k) ?? 0)) extentAt.set(k, d);
  };
  const trace = fanTraceTarget();

  const halfWidthOf = (edgeId: string): number => {
    const n = orderOf.get(edgeId)?.length ?? 1;
    return ((n - 1) / 2) * spacing + Math.abs(biasOf.get(edgeId) ?? 0);
  };

  /** Inner reference vertex for a lane end: the first vertex a material
   *  distance from the end (sub-pixel junk segments at lane ends, left by
   *  offset mitering at sharp base vertices, would otherwise poison the end
   *  DIRECTION and misclassify the whole group). */
  const innerVertex = (poly: Pixel[], atStart: boolean): Pixel => {
    const end = atStart ? poly[0] : poly[poly.length - 1];
    const depth = Math.min(4, poly.length - 1);
    for (let s = 1; s <= depth; s++) {
      const v = atStart ? poly[s] : poly[poly.length - 1 - s];
      if (hyp(v[0] - end[0], v[1] - end[1]) >= 0.25) return v;
    }
    return atStart ? poly[1] : poly[poly.length - 2];
  };

  const endsOf = (m: Member): Ends | null => {
    const pIn = segPath.get(m.edgeIn + '|' + m.lineId);
    const pOut = segPath.get(m.edgeOut + '|' + m.lineId);
    if (!pIn || !pOut || pIn.length < 2 || pOut.length < 2) return null;
    const qa = m.inAtStart ? pIn[0] : pIn[pIn.length - 1];
    const qa1 = innerVertex(pIn, m.inAtStart);
    const qb = m.outAtStart ? pOut[0] : pOut[pOut.length - 1];
    const qb1 = innerVertex(pOut, m.outAtStart);
    const lenA = hyp(qa[0] - qa1[0], qa[1] - qa1[1]);
    const lenB = hyp(qb[0] - qb1[0], qb[1] - qb1[1]);
    if (lenA < 1e-6 || lenB < 1e-6) return null;
    return {
      pIn, pOut, qa, qa1, qb, qb1, lenA, lenB,
      dirIn: [(qa[0] - qa1[0]) / lenA, (qa[1] - qa1[1]) / lenA],
      dirOut: [(qb1[0] - qb[0]) / lenB, (qb1[1] - qb[1]) / lenB],
    };
  };

  const keyIn = (m: Member): string => m.edgeIn + '|' + m.lineId + '|' + (m.inAtStart ? 's' : 'e');
  const keyOut = (m: Member): string => m.edgeOut + '|' + m.lineId + '|' + (m.outAtStart ? 's' : 'e');

  /** Where a lane's line meets the apex behind its end, find the cut so the
   *  lane would END at the apex: scan up to 4 end segments for the apex lying
   *  ON the lane. Returns how many outer vertices a cut would drop, or null
   *  when the apex is off the lane (a genuine reversal; decline the curve). */
  const findCutBack = (poly: Pixel[], atStart: boolean, px: number, py: number): number | null => {
    const n = poly.length;
    const maxSegs = Math.min(4, n - 1);
    for (let s = 0; s < maxSegs; s++) {
      const i = atStart ? s : n - 1 - s;
      const j = atStart ? s + 1 : n - 2 - s;
      const ax = poly[j][0], ay = poly[j][1];
      const vx = poly[i][0] - ax, vy = poly[i][1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-12) continue;
      const u = ((px - ax) * vx + (py - ay) * vy) / len2;
      if (u < -0.001 || u > 1.001) continue;
      if (hyp(px - (ax + vx * u), py - (ay + vy * u)) > 1.5) return null;
      return s;
    }
    return null;
  };
  const applyCutBack = (poly: Pixel[], atStart: boolean, drop: number, px: number, py: number): void => {
    if (atStart) poly.splice(0, drop + 1, [px, py]);
    else poly.splice(poly.length - 1 - drop, drop + 1, [px, py]);
  };

  /** Pin a lane's node end to `pt`, popping trailing (near-)collinear
   *  vertices the pin retracts past so the last segment never folds back.
   *  `dir` is the direction the surviving penultimate vertex must lie BEFORE
   *  `pt` along. */
  const setEnd = (poly: Pixel[], atStart: boolean, dir: Pixel, pt: Pixel): void => {
    if (atStart) {
      while (poly.length > 2 && (pt[0] - poly[1][0]) * dir[0] + (pt[1] - poly[1][1]) * dir[1] <= 0) poly.shift();
      poly[0] = pt;
    } else {
      while (poly.length > 2 && (pt[0] - poly[poly.length - 2][0]) * dir[0] + (pt[1] - poly[poly.length - 2][1]) * dir[1] <= 0) poly.pop();
      poly[poly.length - 1] = pt;
    }
  };

  const polyLenOf = (poly: Pixel[]): number => {
    let L = 0;
    for (let i = 1; i < poly.length; i++) L += hyp(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    return L;
  };

  const markDone = (g: Group, m: Member): void => {
    endMoved.add(keyIn(m));
    endMoved.add(keyOut(m));
    mitered.add(m.lineId + '|' + g.node + '|' + g.edgeA + '|' + g.edgeB);
  };

  /** The far node of a member's lane relative to the group node. */
  const farNodeOf = (edgeId: string, atStart: boolean): string | undefined => {
    const ed = edgeById.get(edgeId);
    return ed ? (atStart ? ed.to : ed.from) : undefined;
  };
  /** Corridor reference line through a line's lane at `node`: its end point
   *  there, its end-segment direction (pointing INTO the node when `into`,
   *  OUT of it otherwise), the end segment length, and the lane itself so
   *  an absorbing construction can move its end. */
  const throughRef = (
    lineId: string, edgeId: string, node: string | undefined, into: boolean,
  ): { q: Pixel; q1: Pixel; dir: Pixel; len: number; poly: Pixel[]; atStart: boolean; edgeId: string } | null => {
    if (!node) return null;
    const poly = segPath.get(edgeId + '|' + lineId);
    const ed = edgeById.get(edgeId);
    if (!poly || !ed || poly.length < 2) return null;
    const atStart = ed.from === node;
    if (!atStart && ed.to !== node) return null;
    const q = atStart ? poly[0] : poly[poly.length - 1];
    let q1 = atStart ? poly[1] : poly[poly.length - 2];
    let len = hyp(q[0] - q1[0], q[1] - q1[1]);
    if (len < 1e-6) return null;
    // Reference frame from the BASE corridor when available: the lane's own
    // end segment may carry another group's jog taper, and a reference line
    // extended along that slant across an absorbed span amplifies a
    // sub-pixel-per-pixel taper into a many-pixel lateral error at the
    // corner (a micro lane's whole polyline IS its end segment). The inner
    // point is re-synthesized on the corridor-parallel ray through the
    // lane's anchor end, so every consumer of (q, q1) sees the base
    // direction.
    const bd = baseEndDir?.(edgeId, node);
    if (bd) {
      q1 = [q[0] + bd[0] * len, q[1] + bd[1] * len];
      len = hyp(q[0] - q1[0], q[1] - q1[1]);
    }
    return {
      q, q1,
      dir: into ? [(q[0] - q1[0]) / len, (q[1] - q1[1]) / len] : [(q1[0] - q[0]) / len, (q1[1] - q[1]) / len],
      len,
      poly, atStart, edgeId,
    };
  };

  /** Sharp pin: both lane ends meet at the infinite-line intersection of
   *  their end directions (subsumes the crossing-segments case, whose meet
   *  IS the crossing point). Bounded by the fan's reach. In a genuinely
   *  sharp group the fan nests: inner members RETRACT to their meets while
   *  outer members EXTEND to theirs (the outer corner tip lies beyond both
   *  lane ends), so `allowExtend` lifts the retraction-only gates there.
   *  Members falling back from a failed curve keep the conservative gates:
   *  the meet must lie behind the inbound end and ahead of the outbound
   *  end. A MICRO near-lane (shorter than two pitches) is part of the
   *  corner, not its corridor: its lateral seat can sit off the through
   *  corridor's line, and a pin computed against the stub drags the corner
   *  point off-corridor, painting a self-crossing hook where the course
   *  returns. When the line continues beyond such a stub, the meet is
   *  computed against the THROUGH lane's line instead (the first slice of
   *  multi-edge corner absorption). Returns true when applied. */
  const endKeyAt = (edgeId: string, atStart: boolean, lineId: string): string =>
    edgeId + '|' + lineId + '|' + (atStart ? 's' : 'e');
  const pairOf = (a: string, b: string): string => (a < b ? a + '|' + b : b + '|' + a);

  /** Does `C` overrun the lane: for the pin to live on this lane's line,
   *  its projection along the lane's chord (node end toward far end) must
   *  not pass the far end. When it does, the whole lane is inside the
   *  corner and the true reference is the corridor beyond it. */
  const overruns = (poly: Pixel[], atStart: boolean, C: Pixel): boolean => {
    const q = atStart ? poly[0] : poly[poly.length - 1];
    const far = atStart ? poly[poly.length - 1] : poly[0];
    const ux = far[0] - q[0], uy = far[1] - q[1];
    const len2 = ux * ux + uy * uy;
    if (len2 < 1e-12) return true;
    return ((C[0] - q[0]) * ux + (C[1] - q[1]) * uy) / len2 > 1;
  };

  const sharpPin = (g: Group, m: Member, e: Ends, fanReach: number, allowExtend: boolean, flog: (s: string) => void): boolean => {
    let refA = { q: e.qa, dir: e.dirIn, len: e.lenA };
    let refB = { q: e.qb, dir: e.dirOut, len: e.lenB };
    let subA: ReturnType<typeof throughRef> = null;
    let subB: ReturnType<typeof throughRef> = null;
    let farA: string | undefined;
    let farB: string | undefined;
    const C0 = lineMeet(refA.q, refA.dir, refB.q, refB.dir);
    if (!C0) return false;
    if (m.prevEdge && m.prevEdge !== m.edgeOut && overruns(e.pIn, m.inAtStart, C0)) {
      farA = farNodeOf(m.edgeIn, m.inAtStart);
      const sub = farA !== undefined && farA !== g.node ? throughRef(m.lineId, m.prevEdge, farA, true) : null;
      if (sub) { refA = sub; subA = sub; }
    }
    if (m.nextEdge && m.nextEdge !== m.edgeIn && overruns(e.pOut, m.outAtStart, C0)) {
      farB = farNodeOf(m.edgeOut, m.outAtStart);
      const sub = farB !== undefined && farB !== g.node ? throughRef(m.lineId, m.nextEdge, farB, false) : null;
      if (sub) { refB = sub; subB = sub; }
    }
    const C = !subA && !subB ? C0 : lineMeet(refA.q, refA.dir, refB.q, refB.dir);
    if (!C) return false;
    const dispA = hyp(C[0] - e.qa[0], C[1] - e.qa[1]);
    const dispB = hyp(C[0] - e.qb[0], C[1] - e.qb[1]);
    const capA = Math.max(spacing * 6, e.lenA, fanReach);
    const capB = Math.max(spacing * 6, e.lenB, fanReach);
    const behindA = allowExtend || (C[0] - refA.q[0]) * refA.dir[0] + (C[1] - refA.q[1]) * refA.dir[1] <= 0.01 * refA.len;
    const aheadB = allowExtend || (C[0] - refB.q[0]) * refB.dir[0] + (C[1] - refB.q[1]) * refB.dir[1] >= -0.01 * refB.len;
    if (!(dispA <= capA && dispB <= capB && behindA && aheadB)) return false;
    // A substituted side ABSORBS its micro lane when absorption is on: the
    // pin moves the through lane's end instead and the micro's ink is
    // erased (the corner owns it). With absorption off the substituted
    // MEET stands but the micro keeps its ink (the prior behaviour).
    if (!absorbOn) { subA = null; subB = null; }
    const moveKeys = [keyIn(m), keyOut(m)];
    if (subA) moveKeys.push(endKeyAt(m.edgeIn, !m.inAtStart, m.lineId), endKeyAt(subA.edgeId, subA.atStart, m.lineId));
    if (subB) moveKeys.push(endKeyAt(m.edgeOut, !m.outAtStart, m.lineId), endKeyAt(subB.edgeId, subB.atStart, m.lineId));
    if (moveKeys.some((k) => endMoved.has(k))) return false;
    bumpExtent(g.node, m.edgeIn, C);
    bumpExtent(g.node, m.edgeOut, C);
    if (subA) bumpExtent(g.node, subA.edgeId, C);
    if (subB) bumpExtent(g.node, subB.edgeId, C);
    if (subA) setEnd(subA.poly, subA.atStart, subA.dir, C);
    else setEnd(e.pIn, m.inAtStart, e.dirIn, C);
    if (subB) setEnd(subB.poly, subB.atStart, [-subB.dir[0], -subB.dir[1]], C);
    else setEnd(e.pOut, m.outAtStart, [-e.dirOut[0], -e.dirOut[1]], C);
    for (const k of moveKeys) endMoved.add(k);
    mitered.add(m.lineId + '|' + g.node + '|' + pairOf(m.edgeIn, m.edgeOut));
    const consumed: string[] = [];
    if (subA && farA) {
      const key = m.edgeIn + '|' + m.lineId;
      segPath.delete(key);
      suppressed.add(key);
      consumed.push(key);
      mitered.add(m.lineId + '|' + farA + '|' + pairOf(subA.edgeId, m.edgeIn));
      mitered.add(m.lineId + '|' + farA + '|' + pairOf(subA.edgeId, m.edgeOut));
    }
    if (subB && farB) {
      const key = m.edgeOut + '|' + m.lineId;
      segPath.delete(key);
      suppressed.add(key);
      consumed.push(key);
      mitered.add(m.lineId + '|' + farB + '|' + pairOf(subB.edgeId, m.edgeOut));
      mitered.add(m.lineId + '|' + farB + '|' + pairOf(subB.edgeId, m.edgeIn));
    }
    flog(`${m.lineId} PIN C=(${C[0].toFixed(1)},${C[1].toFixed(1)}) dispA=${dispA.toFixed(1)} dispB=${dispB.toFixed(1)}${consumed.length ? ' ABSORB ' + consumed.join(',') : ''}`);
    return true;
  };

  /** Forward-turn dogleg fallback, single-corner variant only: extend the
   *  inbound run straight to a bend point on the outbound line. The genuine
   *  two-bend variant trades the gap for a protruding stub, so it declines
   *  (the residual gap falls to the assembler/connector). */
  const doglegPin = (g: Group, m: Member, e: Ends, flog: (s: string) => void): boolean => {
    const sdirA = snapOcti(e.dirIn);
    const sdirB = snapOcti(e.dirOut);
    const cap = Math.max(spacing * 6, e.lenA, e.lenB);
    let best: { B2: Pixel; collinearIn: boolean; bends: number; len: number } | null = null;
    for (const D of OCTI8) {
      const den = D[0] * sdirB[1] - D[1] * sdirB[0];
      if (Math.abs(den) < 1e-6) continue;
      const t = ((e.qb[0] - e.qa[0]) * sdirB[1] - (e.qb[1] - e.qa[1]) * sdirB[0]) / den;
      if (t < 0.5) continue;
      const s = ((e.qb[0] - e.qa[0]) * D[1] - (e.qb[1] - e.qa[1]) * D[0]) / den;
      const bendIn = sdirA[0] * D[0] + sdirA[1] * D[1];
      const bendOut = D[0] * sdirB[0] + D[1] * sdirB[1];
      if (bendIn < -0.5 || bendOut < -0.5) continue;
      if (t > cap || Math.abs(s) > cap) continue;
      const collinearIn = bendIn > 0.99;
      const bends = (collinearIn ? 0 : 1) + (bendOut > 0.99 ? 0 : 1);
      const len = t + Math.abs(s);
      if (!best || bends < best.bends || (bends === best.bends && len < best.len)) {
        best = { B2: [e.qa[0] + D[0] * t, e.qa[1] + D[1] * t], collinearIn, bends, len };
      }
    }
    if (!best || !best.collinearIn) return false;
    // The bend corner sits ON the outbound line and must fall strictly
    // between this node and the outbound edge's far node; overshooting pins
    // the outbound start beyond its own corridor and closes a self-loop.
    const eb = edgeById.get(m.edgeOut);
    if (eb) {
      const farNodeId = m.outAtStart ? eb.to : eb.from;
      const farPx = nodePx.get(farNodeId);
      if (farPx) {
        const projB2 = (best.B2[0] - e.qb[0]) * sdirB[0] + (best.B2[1] - e.qb[1]) * sdirB[1];
        const projFar = (farPx[0] - e.qb[0]) * sdirB[0] + (farPx[1] - e.qb[1]) * sdirB[1];
        if (projB2 > projFar - spacing / 2) {
          flog(`${m.lineId} DOGLEG-DECLINE overshoot projB2=${projB2.toFixed(1)} projFar=${projFar.toFixed(1)}`);
          return false;
        }
      }
    }
    const B2 = best.B2;
    if (m.inAtStart) {
      while (e.pIn.length > 2 && (B2[0] - e.pIn[1][0]) * sdirA[0] + (B2[1] - e.pIn[1][1]) * sdirA[1] <= 0) e.pIn.shift();
      e.pIn[0] = B2;
    } else {
      while (e.pIn.length > 2 && (B2[0] - e.pIn[e.pIn.length - 2][0]) * sdirA[0] + (B2[1] - e.pIn[e.pIn.length - 2][1]) * sdirA[1] <= 0) e.pIn.pop();
      e.pIn[e.pIn.length - 1] = B2;
    }
    if (m.outAtStart) {
      while (e.pOut.length > 2 && (e.pOut[1][0] - B2[0]) * sdirB[0] + (e.pOut[1][1] - B2[1]) * sdirB[1] <= 0) e.pOut.shift();
      const ahead = (e.pOut[0][0] - B2[0]) * sdirB[0] + (e.pOut[0][1] - B2[1]) * sdirB[1];
      if (ahead > 0.01) e.pOut.unshift(B2); else e.pOut[0] = B2;
    } else {
      while (e.pOut.length > 2 && (e.pOut[e.pOut.length - 2][0] - B2[0]) * sdirB[0] + (e.pOut[e.pOut.length - 2][1] - B2[1]) * sdirB[1] <= 0) e.pOut.pop();
      const ahead = (e.pOut[e.pOut.length - 1][0] - B2[0]) * sdirB[0] + (e.pOut[e.pOut.length - 1][1] - B2[1]) * sdirB[1];
      if (ahead > 0.01) e.pOut.push(B2); else e.pOut[e.pOut.length - 1] = B2;
    }
    markDone(g, m);
    flog(`${m.lineId} DOGLEG B2=(${B2[0].toFixed(1)},${B2[1].toFixed(1)})`);
    return true;
  };

  /** The lateral-jog taper: a member's ends drift to their shared midpoint
   *  over an arc that scales with its own gap, so small swaps localize at
   *  the node and band exchanges spread into a long shallow crossing. The
   *  FALLBACK for near-parallel members whose curve planning found no
   *  corner within reach. Runs in a SECOND pass after every group's corner
   *  constructions (invariant I3): each ramp then places itself in the
   *  room its edge has before the far junction's measured zone, going
   *  one-sided away from an engulfing corner instead of spreading a ramp
   *  through its sweeps. */
  const jogTaper = (g: Group, m: Member, e: Ends, flog: (s: string) => void): void => {
    if (endMoved.has(keyIn(m)) || endMoved.has(keyOut(m))) {
      flog(`${m.lineId} JOG-CLAIMED ${m.edgeIn}>${m.edgeOut} @${g.node}`);
      return;
    }
    const gap = hyp(e.qb[0] - e.qa[0], e.qb[1] - e.qa[1]);
    if (gap < 0.5 || gap > spacing * bigGapMult) { flog(`${m.lineId} JOG-SKIP gap=${gap.toFixed(1)}`); return; }
    // A sub-pitch seam resolves as ONE crisp near-45-degree step, the
    // sanctioned way to move over: stretching it across the pitch-scale
    // minimum paints a sub-octilinear ramp, which reads as a spike
    // against the strategy's straight-and-45 family. The 1.2 slope
    // factor keeps the step just inside the 45-degree family with
    // margin against the perpendicular-step ceiling (invariant I9).
    // Sub-pixel-class gaps keep the long shallow ramp: a crisp step
    // that small is direction noise, and a ramp that shallow sits
    // inside the spike tolerance anyway.
    // The small-gap long ramp stretches until its slope drops under the
    // straightness threshold (about nine degrees): a fixed pitch-scale
    // length leaves an 11-to-15-degree drift that still reads as a
    // sub-octilinear kink.
    const drift = gap <= spacing
      ? (gap >= spacing * 0.4 ? gap * 1.2 : Math.max(spacing * 1.5, gap * 6.3))
      : Math.max(spacing * 1.5, gap * 1.2);
    const arcIn = polyLenOf(e.pIn);
    const arcOut = polyLenOf(e.pOut);
    const taperA = Math.min(drift, spacing * 8, arcIn * 0.45);
    const taperB = Math.min(drift, spacing * 8, arcOut * 0.45);
    // Zone room per side: the ramp may only use the corridor span before
    // the far node's constructed zone. Both the zone and the room live in
    // NODE space (the span between the junction and the far node), not in
    // lane-arc space: an absorbed lane extends past its nodes, and a
    // lane-length measure credits that extension as room and seats the
    // ramp inside the neighbouring corner's zone.
    const spanOf = (edgeId: string, poly: Pixel[]): number => {
      const ed = edgeById.get(edgeId);
      const a = ed ? nodePx.get(ed.from) : undefined;
      const b = ed ? nodePx.get(ed.to) : undefined;
      return a && b ? hyp(b[0] - a[0], b[1] - a[1]) : polyLenOf(poly);
    };
    const farIn = farNodeOf(m.edgeIn, m.inAtStart);
    const farOut = farNodeOf(m.edgeOut, m.outAtStart);
    const roomIn = Math.max(0, spanOf(m.edgeIn, e.pIn) - (farIn !== undefined ? extentAt.get(farIn + '|' + m.edgeIn) ?? 0 : 0));
    const roomOut = Math.max(0, spanOf(m.edgeOut, e.pOut) - (farOut !== undefined ? extentAt.get(farOut + '|' + m.edgeOut) ?? 0 : 0));
    const capA = Math.min(taperA, roomIn);
    const capB = Math.min(taperB, roomOut);
    // Ride until the node, recenter past it (invariant I4): a seat change
    // between edges of DIFFERENT bundle widths absorbs entirely on the
    // sparser side, where the departing lines' seats are vacant; the group
    // drifts in parallel at preserved pitch. Equal widths keep the
    // symmetric midpoint drift unless a neighbouring zone engulfs one
    // side, which pushes the whole change to the side with room.
    const nIn = orderOf.get(m.edgeIn)?.length ?? 0;
    const nOut = orderOf.get(m.edgeOut)?.length ?? 0;
    let oneSided = nIn !== nOut
      ? (nIn > nOut
          ? (capB >= gap ? 'out' : null)
          : (capA >= gap ? 'in' : null))
      : null;
    if (oneSided === null) {
      if (capA < gap / 2 && capB >= gap) oneSided = 'out';
      else if (capB < gap / 2 && capA >= gap) oneSided = 'in';
    }
    if (oneSided === 'out') {
      const t = Math.min(taperB, Math.max(capB, gap));
      taperLaneEnd(e.pOut, m.outAtStart, e.qa, t);
      tapers.push({ node: g.node, edgeId: m.edgeOut, lineId: m.lineId, len: t });
      markDone(g, m);
      flog(`${m.lineId} JOG-HOLD in gap=${gap.toFixed(1)} taperB=${t.toFixed(1)} caps=${capA.toFixed(1)}/${capB.toFixed(1)} rooms=${roomIn.toFixed(1)}/${roomOut.toFixed(1)} n=${nIn}/${nOut}`);
      return;
    }
    if (oneSided === 'in') {
      const t = Math.min(taperA, Math.max(capA, gap));
      taperLaneEnd(e.pIn, m.inAtStart, e.qb, t);
      tapers.push({ node: g.node, edgeId: m.edgeIn, lineId: m.lineId, len: t });
      markDone(g, m);
      flog(`${m.lineId} JOG-HOLD out gap=${gap.toFixed(1)} taperA=${t.toFixed(1)} caps=${capA.toFixed(1)}/${capB.toFixed(1)} rooms=${roomIn.toFixed(1)}/${roomOut.toFixed(1)} n=${nIn}/${nOut}`);
      return;
    }
    if ((taperA < gap || taperB < gap) && (taperA < spacing * 1.5 || taperB < spacing * 1.5)) {
      // A lane too short for the standard drift SLANTS over its whole arc
      // instead of leaving a perpendicular step at its end (invariant I9):
      // the far end stays fixed (the fade reaches zero exactly there) and
      // the jog spreads across every pixel the lane has. Only a jog larger
      // than a side's whole arc (a bend past 45 degrees) still declines.
      if (arcIn >= gap && arcOut >= gap) {
        const mid: Pixel = [(e.qa[0] + e.qb[0]) / 2, (e.qa[1] + e.qb[1]) / 2];
        taperLaneEnd(e.pIn, m.inAtStart, mid, Math.min(spacing * 8, arcIn));
        taperLaneEnd(e.pOut, m.outAtStart, mid, Math.min(spacing * 8, arcOut));
        tapers.push({ node: g.node, edgeId: m.edgeIn, lineId: m.lineId, len: Math.min(spacing * 8, arcIn) });
        tapers.push({ node: g.node, edgeId: m.edgeOut, lineId: m.lineId, len: Math.min(spacing * 8, arcOut) });
        markDone(g, m);
        flog(`${m.lineId} JOG-SLANT gap=${gap.toFixed(1)} arcIn=${arcIn.toFixed(1)} arcOut=${arcOut.toFixed(1)}`);
        return;
      }
      flog(`${m.lineId} JOG-SHORT taperA=${taperA.toFixed(1)} taperB=${taperB.toFixed(1)}`);
      return;
    }
    // A jog whose endpoints bracket another line's seat at this node is a
    // FORCED CROSSING: the ramp must pass over that lane's ink, and the
    // gentle drift profile crosses a near-parallel mate so shallowly the
    // two read as one doubled stroke for a long run. Such ramps take a
    // decisive slope (about 35 degrees per side, inside the 45-degree
    // step ceiling) so the crossing resolves in a few pitches.
    const bracketsMate = (): boolean => {
      const ab: Pixel = [e.qb[0] - e.qa[0], e.qb[1] - e.qa[1]];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1];
      if (len2 < 1e-9) return false;
      const sides: Array<[string, boolean]> = [[m.edgeIn, m.inAtStart], [m.edgeOut, m.outAtStart]];
      for (const [edgeX, atStart] of sides) {
        for (const L of orderOf.get(edgeX) ?? []) {
          if (L === m.lineId) continue;
          const lp = segPath.get(edgeX + '|' + L);
          if (!lp || lp.length < 2) continue;
          const qL = atStart ? lp[0] : lp[lp.length - 1];
          const t = ((qL[0] - e.qa[0]) * ab[0] + (qL[1] - e.qa[1]) * ab[1]) / len2;
          if (t > 0.1 && t < 0.9) return true;
        }
      }
      return false;
    };
    const mid: Pixel = [(e.qa[0] + e.qb[0]) / 2, (e.qa[1] + e.qb[1]) / 2];
    // Midpoint ramps respect zone caps down to the 45-degree half-ramp
    // floor (a steeper step violates I9; below the floor the intrusion
    // stands and the census reports it).
    let tA = Math.min(taperA, Math.max(capA, gap / 2));
    let tB = Math.min(taperB, Math.max(capB, gap / 2));
    if (bracketsMate()) {
      const steep = Math.max(spacing, gap * 0.71);
      tA = Math.min(tA, steep);
      tB = Math.min(tB, steep);
    }
    taperLaneEnd(e.pIn, m.inAtStart, mid, tA);
    taperLaneEnd(e.pOut, m.outAtStart, mid, tB);
    tapers.push({ node: g.node, edgeId: m.edgeIn, lineId: m.lineId, len: tA });
    tapers.push({ node: g.node, edgeId: m.edgeOut, lineId: m.lineId, len: tB });
    markDone(g, m);
    flog(`${m.lineId} JOG gap=${gap.toFixed(1)} taperA=${tA.toFixed(1)} taperB=${tB.toFixed(1)} caps=${capA.toFixed(1)}/${capB.toFixed(1)} rooms=${roomIn.toFixed(1)}/${roomOut.toFixed(1)} n=${nIn}/${nOut} in=${m.edgeIn}@${farIn ?? '?'} out=${m.edgeOut}@${farOut ?? '?'} arcs=${arcIn.toFixed(1)}/${arcOut.toFixed(1)}`);
  };
  const deferredJogs: Array<{ g: Group; m: Member; flog: (s: string) => void }> = [];

  for (const g of collectFanGroups(args.lineTraversals, args.lineIds, edgeById, orderOf, segPath, suppressed)) {
    const flog = makeFanLog(trace, g.members.map((m) => m.lineId));
    // Members whose ends an earlier group already moved sit this group out.
    const live: Array<{ m: Member; e: Ends }> = [];
    for (const m of g.members) {
      if (endMoved.has(keyIn(m)) || endMoved.has(keyOut(m))) {
        flog(`${m.lineId} OUT moved ${endMoved.has(keyIn(m)) ? keyIn(m) : keyOut(m)} @${g.node}`);
        continue;
      }
      const e = endsOf(m);
      if (e) live.push({ m, e });
      else flog(`${m.lineId} OUT no-ends @${g.node}`);
    }
    if (live.length === 0) continue;
    // One classification for the whole group. Parallel offset lanes of the
    // same two edges share their end directions, so any member could frame
    // the group; take the one with the LONGEST end segments, whose
    // directions are least contaminated by residual end junk.
    let f0 = live[0].e;
    let f0len = Math.min(f0.lenA, f0.lenB);
    for (const { e } of live) {
      const l = Math.min(e.lenA, e.lenB);
      if (l > f0len) { f0 = e; f0len = l; }
    }
    const dot = f0.dirIn[0] * f0.dirOut[0] + f0.dirIn[1] * f0.dirOut[1];
    const den = Math.abs(f0.dirIn[0] * f0.dirOut[1] - f0.dirIn[1] * f0.dirOut[0]);
    const fanReach = (halfWidthOf(g.edgeA) + halfWidthOf(g.edgeB) + 2 * spacing) / Math.max(den, 0.5);
    flog(`group ${g.node} ${g.edgeA}x${g.edgeB} n=${live.length} dot=${dot.toFixed(2)} fanReach=${fanReach.toFixed(1)}`);


    // Corner construction first for every non-regressive group: plan every
    // member's apex without mutating, resolve the nested per-member trims,
    // then apply. Each plan carries its two reference lanes explicitly: for
    // a plain corner they are the member's own; a corner whose apex OVERRUNS
    // a near lane shorter than the fan's reach ABSORBS it (multi-edge
    // corner, invariant I2): the reference becomes the through lane beyond
    // the micro, whose ink the corner curve replaces entirely. Members with
    // no apex within reach fall back by band: near-parallel ones jog-taper,
    // corner ones pin sharp.
    interface SideRef { q: Pixel; q1: Pixel; poly: Pixel[]; atStart: boolean; edgeId: string }
    interface PlanSide { poly: Pixel[]; atStart: boolean; cut: number | null; edgeId: string; q: Pixel }
    interface Plan {
      m: Member; e: Ends; apex: Pixel; la: number; lb: number;
      sIn: PlanSide; sOut: PlanSide;
      moveKeys: string[];
      miterKeys: string[];
      stopNodes: string[];
      consumeKeys: string[];
      pair: [string, string];
    }
    const planCorner = (m: Member, e: Ends, limit: number, rIn: SideRef, rOut: SideRef): Plan | null => {
      const d1: Pixel = [rIn.q[0] - rIn.q1[0], rIn.q[1] - rIn.q1[1]];
      const d2: Pixel = [rOut.q[0] - rOut.q1[0], rOut.q[1] - rOut.q1[1]];
      const scale = hyp(d1[0], d1[1]) * hyp(d2[0], d2[1]);
      const denom = d1[0] * d2[1] - d1[1] * d2[0];
      if (scale < 1e-9 || Math.abs(denom) < 1e-3 * scale) return null;
      const t = ((rOut.q1[0] - rIn.q1[0]) * d2[1] - (rOut.q1[1] - rIn.q1[1]) * d2[0]) / denom;
      const x = rIn.q1[0] + t * d1[0];
      const y = rIn.q1[1] + t * d1[1];
      if (hyp(x - rIn.q[0], y - rIn.q[1]) > limit || hyp(x - rOut.q[0], y - rOut.q[1]) > limit) return null;
      // An apex behind an end means the lane overdrew the corner: plan a
      // cut back to the apex (declining if the apex is off the lane).
      let cutIn: number | null = null;
      let cutOut: number | null = null;
      if ((x - rIn.q1[0]) * d1[0] + (y - rIn.q1[1]) * d1[1] <= 0) {
        cutIn = findCutBack(rIn.poly, rIn.atStart, x, y);
        if (cutIn === null) return null;
      }
      if ((x - rOut.q1[0]) * d2[0] + (y - rOut.q1[1]) * d2[1] <= 0) {
        cutOut = findCutBack(rOut.poly, rOut.atStart, x, y);
        if (cutOut === null) return null;
      }
      // Leg lengths from the effective inner vertex to the apex (what the
      // trim must fit inside after any cut back).
      const innerIn = cutIn !== null
        ? (rIn.atStart ? rIn.poly[cutIn + 1] : rIn.poly[rIn.poly.length - 2 - cutIn])
        : rIn.q1;
      const innerOut = cutOut !== null
        ? (rOut.atStart ? rOut.poly[cutOut + 1] : rOut.poly[rOut.poly.length - 2 - cutOut])
        : rOut.q1;
      const la = hyp(x - innerIn[0], y - innerIn[1]);
      const lb = hyp(x - innerOut[0], y - innerOut[1]);
      if (la < 1e-6 || lb < 1e-6) return null;
      const pair: [string, string] = rIn.edgeId < rOut.edgeId ? [rIn.edgeId, rOut.edgeId] : [rOut.edgeId, rIn.edgeId];
      return {
        m, e, apex: [x, y], la, lb,
        sIn: { poly: rIn.poly, atStart: rIn.atStart, cut: cutIn, edgeId: rIn.edgeId, q: rIn.q },
        sOut: { poly: rOut.poly, atStart: rOut.atStart, cut: cutOut, edgeId: rOut.edgeId, q: rOut.q },
        moveKeys: [endKeyAt(rIn.edgeId, rIn.atStart, m.lineId), endKeyAt(rOut.edgeId, rOut.atStart, m.lineId)],
        miterKeys: [m.lineId + '|' + g.node + '|' + pair[0] + '|' + pair[1]],
        stopNodes: [g.node],
        consumeKeys: [],
        pair,
      };
    };
    // Absorption fires in two modes. 'seat': tried BEFORE the normal plan
    // when a micro near-lane's far end does not SEAT on the through corridor
    // (any residual jog there would step perpendicular, invariant I9); the
    // corner then turns directly onto the corrected seat. 'overrun': tried
    // after the normal plan fails, when the apex provably lies past the
    // micro lane's far end (invariant I2).
    const tryAbsorb = (m: Member, e: Ends, limit: number, mode: 'seat' | 'overrun'): Plan | null => {
      if (!absorbOn) return null;
      const rIn: SideRef = { q: e.qa, q1: e.qa1, poly: e.pIn, atStart: m.inAtStart, edgeId: m.edgeIn };
      const rOut: SideRef = { q: e.qb, q1: e.qb1, poly: e.pOut, atStart: m.outAtStart, edgeId: m.edgeOut };
      const farGap = (poly: Pixel[], atNodeStart: boolean, q: Pixel): number => {
        const far = atNodeStart ? poly[poly.length - 1] : poly[0];
        return hyp(far[0] - q[0], far[1] - q[1]);
      };
      // Seat-mode absorption takes MICRO lanes (a couple of pitches: sliver
      // geometry off its through seat is part of the corner) and ANGLED
      // pieces (their bend is corner geometry). A longer piece COLLINEAR
      // with its through corridor is absorbed only when no OTHER line keeps
      // a rub-length lane in the piece's own frame: chained edges' biases
      // can disagree by a pixel or two, and a leg re-referenced to the next
      // edge's frame runs sub-pitch beside a neighbour that stayed (the
      // bias seam repainted as a pitch violation). Lines turning this same
      // corner absorb together and sub-pitch stubs cannot rub, so neither
      // blocks. Overrun mode keeps the reach gate alone (the apex provably
      // engulfs the lane).
      const chordOf = (poly: Pixel[]): Pixel => {
        const dx = poly[poly.length - 1][0] - poly[0][0];
        const dy = poly[poly.length - 1][1] - poly[0][1];
        const l = hyp(dx, dy) || 1;
        return [dx / l, dy / l];
      };
      const seatTakes = (edgeX: string, poly: Pixel[], thrDir: Pixel): boolean => {
        if (polyLenOf(poly) <= spacing * 2) return true;
        const ch = chordOf(poly);
        if (Math.abs(ch[0] * thrDir[0] + ch[1] * thrDir[1]) < 0.99) return true;
        for (const L of orderOf.get(edgeX) ?? []) {
          if (L === m.lineId) continue;
          if (g.members.some((m2) => m2.lineId === L && (m2.edgeIn === edgeX || m2.edgeOut === edgeX))) continue;
          const lp = segPath.get(edgeX + '|' + L);
          if (lp && polyLenOf(lp) > spacing * 2) return false;
        }
        return true;
      };
      // BOTH flanks first: a corner whose near lane is engulfed on EACH
      // side absorbs both and spans through-corridor to through-corridor,
      // so the seat seams at BOTH far nodes resolve inside the corner
      // instead of leaving one to a taper that ramps through its sweep.
      if (mode === 'seat'
        && m.nextEdge && m.nextEdge !== m.edgeIn && polyLenOf(e.pOut) < fanReach
        && m.prevEdge && m.prevEdge !== m.edgeOut && polyLenOf(e.pIn) < fanReach) {
        const farOut = farNodeOf(m.edgeOut, m.outAtStart);
        const farIn = farNodeOf(m.edgeIn, m.inAtStart);
        const thrOut = farOut !== undefined && farOut !== g.node ? throughRef(m.lineId, m.nextEdge, farOut, false) : null;
        const thrIn = farIn !== undefined && farIn !== g.node ? throughRef(m.lineId, m.prevEdge, farIn, true) : null;
        if (thrOut && thrIn
          && seatTakes(m.edgeOut, e.pOut, thrOut.dir) && farGap(e.pOut, m.outAtStart, thrOut.q) >= 0.5
          && seatTakes(m.edgeIn, e.pIn, thrIn.dir) && farGap(e.pIn, m.inAtStart, thrIn.q) >= 0.5) {
          const p = planCorner(m, e, limit, thrIn, thrOut);
          if (p) {
            p.consumeKeys.push(m.edgeOut + '|' + m.lineId, m.edgeIn + '|' + m.lineId);
            p.moveKeys.push(
              keyOut(m), endKeyAt(m.edgeOut, !m.outAtStart, m.lineId),
              keyIn(m), endKeyAt(m.edgeIn, !m.inAtStart, m.lineId),
            );
            p.miterKeys.push(
              m.lineId + '|' + g.node + '|' + pairOf(m.edgeIn, m.edgeOut),
              m.lineId + '|' + farOut + '|' + pairOf(m.edgeOut, thrOut.edgeId),
              m.lineId + '|' + farIn + '|' + pairOf(m.edgeIn, thrIn.edgeId),
            );
            p.stopNodes.push(farOut!, farIn!);
            if (!p.moveKeys.some((k) => endMoved.has(k))) return p;
          }
        }
      }
      if (m.nextEdge && m.nextEdge !== m.edgeIn && polyLenOf(e.pOut) < fanReach) {
        const farNode = farNodeOf(m.edgeOut, m.outAtStart);
        const thr = farNode !== undefined && farNode !== g.node ? throughRef(m.lineId, m.nextEdge, farNode, false) : null;
        if (thr && (mode === 'overrun' ||
          (seatTakes(m.edgeOut, e.pOut, thr.dir) && farGap(e.pOut, m.outAtStart, thr.q) >= 0.5))) {
          const p = planCorner(m, e, limit, rIn, thr);
          if (p && (mode === 'seat' || overruns(e.pOut, m.outAtStart, p.apex))) {
            p.consumeKeys.push(m.edgeOut + '|' + m.lineId);
            p.moveKeys.push(keyOut(m), endKeyAt(m.edgeOut, !m.outAtStart, m.lineId));
            p.miterKeys.push(
              m.lineId + '|' + g.node + '|' + pairOf(m.edgeIn, m.edgeOut),
              m.lineId + '|' + farNode + '|' + pairOf(m.edgeOut, thr.edgeId),
            );
            p.stopNodes.push(farNode!);
            // An absorption whose keys an earlier construction already
            // claimed can never apply; returning it would only rob the
            // member of its plain-taper fallback.
            if (!p.moveKeys.some((k) => endMoved.has(k))) return p;
          }
        }
      }
      if (m.prevEdge && m.prevEdge !== m.edgeOut && polyLenOf(e.pIn) < fanReach) {
        const farNode = farNodeOf(m.edgeIn, m.inAtStart);
        const thr = farNode !== undefined && farNode !== g.node ? throughRef(m.lineId, m.prevEdge, farNode, true) : null;
        if (thr && (mode === 'overrun' ||
          (seatTakes(m.edgeIn, e.pIn, thr.dir) && farGap(e.pIn, m.inAtStart, thr.q) >= 0.5))) {
          const p = planCorner(m, e, limit, thr, rOut);
          if (p && (mode === 'seat' || overruns(e.pIn, m.inAtStart, p.apex))) {
            p.consumeKeys.push(m.edgeIn + '|' + m.lineId);
            p.moveKeys.push(keyIn(m), endKeyAt(m.edgeIn, !m.inAtStart, m.lineId));
            p.miterKeys.push(
              m.lineId + '|' + g.node + '|' + pairOf(m.edgeIn, m.edgeOut),
              m.lineId + '|' + farNode + '|' + pairOf(m.edgeIn, thr.edgeId),
            );
            p.stopNodes.push(farNode!);
            if (!p.moveKeys.some((k) => endMoved.has(k))) return p;
          }
        }
      }
      return null;
    };
    const planned: Plan[] = [];
    const fallback: Array<{ m: Member; e: Ends }> = [];
    if (dot > -0.3) {
      // The fan-reach enlargement exists so a WIDE bundle's outer corner can
      // still curve; a near-parallel group keeps the plain limit so genuine
      // lateral jogs (far apexes) fall to the taper, as before.
      const limit = dot >= 0.85 ? spacing * 4 : Math.max(spacing * 4, fanReach);
      for (const { m, e } of live) {
        const rIn: SideRef = { q: e.qa, q1: e.qa1, poly: e.pIn, atStart: m.inAtStart, edgeId: m.edgeIn };
        const rOut: SideRef = { q: e.qb, q1: e.qb1, poly: e.pOut, atStart: m.outAtStart, edgeId: m.edgeOut };
        const plan =
          tryAbsorb(m, e, limit, 'seat') ??
          planCorner(m, e, limit, rIn, rOut) ??
          tryAbsorb(m, e, limit, 'overrun');
        if (plan) planned.push(plan);
        else fallback.push({ m, e });
      }
    } else {
      for (const le of live) fallback.push(le);
    }

    // Trim per member (each sweep as large as its own legs allow), then
    // clamp to NEST: ordered from the turn's inside out (apex distance from
    // the node), an inner member may never sweep wider than its outer
    // neighbour, or its wide sweep would cross the outer's tighter corner.
    // A single short-legged member therefore tightens only the members
    // inside it, not the whole fan.
    // Signed fan depth: apexes of a corner fan line up along the turn's
    // bisector, with (dirIn - dirOut) pointing from the inside toward the
    // outside; absolute distance from the node cannot tell the two sides
    // apart (they are symmetric about it).
    const nodeP = nodePx.get(g.node);
    const outw: Pixel = [f0.dirIn[0] - f0.dirOut[0], f0.dirIn[1] - f0.dirOut[1]];
    const depthOf = (apex: Pixel): number =>
      nodeP ? (apex[0] - nodeP[0]) * outw[0] + (apex[1] - nodeP[1]) * outw[1] : 0;
    const fOf = new Map<Member, number>();
    if (planned.length > 0) {
      const byDepth = [...planned].sort((x, y) => depthOf(x.apex) - depthOf(y.apex));
      let cap = Infinity;
      for (let i = byDepth.length - 1; i >= 0; i--) {
        const p = byDepth[i];
        cap = Math.min(cap, smoothR, p.la * 0.6, p.lb * 0.6);
        fOf.set(p.m, cap);
      }
    }
    // Steep landing (invariant I4): a corner sweep landing tangentially on
    // its seat rides any lane one pitch INSIDE the turn at sub-pitch
    // distance for a run that grows with the trim. From the quadratic's
    // tail (lateral deviation from the seat at arc s before the endpoint
    // is about s*s*sin(turn)/(4*trim)), the run spent within the clip
    // census's band [pitch - distMax, pitch + distMax] of that neighbour is
    // sqrt(4*trim/sin) * (sqrt(pitch + distMax) - sqrt(pitch - distMax)).
    // Bounding it at 0.8 of the census's run threshold (runMin = 3*pitch,
    // distMax = 0.75*pitch) gives trim <= 2.13 * pitch * sin(turn). Only a
    // leg with an inside bundle-mate is capped; genuine near-straight bends
    // (small sine) barely deviate toward a neighbour, so the cap applies to
    // real corners only (sine >= 0.5).
    const steepCap = den >= 0.5 ? 2.13 * spacing * den : Infinity;
    const insideNeighbour = (edgeId: string, atStart: boolean, endPt: Pixel, lineId: string): boolean => {
      const order = orderOf.get(edgeId);
      if (!order) return false;
      const idx = order.indexOf(lineId);
      if (idx < 0) return false;
      for (const nIdx of [idx - 1, idx + 1]) {
        const nId = order[nIdx];
        if (!nId) continue;
        const npoly = segPath.get(edgeId + '|' + nId);
        if (!npoly || npoly.length < 2) continue;
        const nEnd = atStart ? npoly[0] : npoly[npoly.length - 1];
        if ((nEnd[0] - endPt[0]) * outw[0] + (nEnd[1] - endPt[1]) * outw[1] < 0) return true;
      }
      return false;
    };
    for (const p of planned) {
      const { m, e, apex } = p;
      const f = fOf.get(m) ?? 0;
      // A sub-pixel sweep is no corner at all: this member has no room for
      // a curve, so it falls to the sharp pin instead of emitting a
      // degenerate quadratic.
      if (f < 0.75) { fallback.push({ m, e }); continue; }
      // Re-check at apply time: a twice-visited corner's second member
      // shares both polylines with the first and must not re-apply onto
      // the mutated geometry (its cached refs are stale).
      if (p.moveKeys.some((k) => endMoved.has(k))) continue;
      if (p.sIn.cut !== null) applyCutBack(p.sIn.poly, p.sIn.atStart, p.sIn.cut, apex[0], apex[1]);
      if (p.sOut.cut !== null) applyCutBack(p.sOut.poly, p.sOut.atStart, p.sOut.cut, apex[0], apex[1]);
      // Re-resolve ends after cut backs, then trim both legs back from the
      // apex by this member's nested trim and bridge with a quadratic
      // through the apex.
      if (p.sIn.poly.length < 2 || p.sOut.poly.length < 2) continue;
      const ra1 = innerVertex(p.sIn.poly, p.sIn.atStart);
      const rb1 = innerVertex(p.sOut.poly, p.sOut.atStart);
      const la = hyp(apex[0] - ra1[0], apex[1] - ra1[1]);
      const lb = hyp(apex[0] - rb1[0], apex[1] - rb1[1]);
      if (la < 1e-6 || lb < 1e-6) { fallback.push({ m, e }); continue; }
      const ua: Pixel = [(apex[0] - ra1[0]) / la, (apex[1] - ra1[1]) / la];
      const ub: Pixel = [(apex[0] - rb1[0]) / lb, (apex[1] - rb1[1]) / lb];
      // A leg with an inside bundle-mate lands steeply (I4); the other keeps
      // the full sweep. Shrinking a leg keeps the curve inside its mates, so
      // the nesting clamp is undisturbed.
      const fIn = insideNeighbour(p.sIn.edgeId, p.sIn.atStart, p.sIn.q, m.lineId) ? Math.min(f, steepCap) : f;
      const fOut = insideNeighbour(p.sOut.edgeId, p.sOut.atStart, p.sOut.q, m.lineId) ? Math.min(f, steepCap) : f;
      const a: Pixel = [apex[0] - ua[0] * fIn, apex[1] - ua[1] * fIn];
      const b: Pixel = [apex[0] - ub[0] * fOut, apex[1] - ub[1] * fOut];
      // Pin via setEnd, not a bare overwrite: the trim can land past residual
      // sub-pixel vertices near the node (the leg is measured to the first
      // MATERIAL vertex), and a passed vertex must pop or the lane folds
      // back through the corner as a painted lobe.
      setEnd(p.sIn.poly, p.sIn.atStart, ua, a);
      setEnd(p.sOut.poly, p.sOut.atStart, ub, b);
      bumpExtent(g.node, p.sIn.edgeId, a);
      bumpExtent(g.node, p.sOut.edgeId, b);
      for (const key of p.consumeKeys) {
        const consumedEdge = key.slice(0, key.indexOf('|'));
        bumpExtent(g.node, consumedEdge, a);
        bumpExtent(g.node, consumedEdge, b);
      }
      joinCurves.push({ lineId: m.lineId, node: g.node, a, apex: [apex[0], apex[1]], b, edgeA: p.pair[0], edgeB: p.pair[1] });
      // A stop at any node the corner spans (the shared node, plus the far
      // node of an absorbed micro lane) draws ON the curve.
      for (const nd of p.stopNodes) {
        const stopKey = nd + '|' + m.lineId;
        if (!joinStopPos.has(stopKey)) {
          joinStopPos.set(stopKey, [
            (a[0] + 2 * apex[0] + b[0]) / 4,
            (a[1] + 2 * apex[1] + b[1]) / 4,
          ]);
        }
      }
      for (const k of p.moveKeys) endMoved.add(k);
      for (const k of p.miterKeys) mitered.add(k);
      // An absorbed micro lane's ink is replaced by the corner curve; erase
      // it and mark it suppressed so every bridging consumer carries the
      // course across in one stroke.
      for (const key of p.consumeKeys) {
        segPath.delete(key);
        suppressed.add(key);
      }
      flog(`${m.lineId} CURVE apex=(${apex[0].toFixed(1)},${apex[1].toFixed(1)}) f=${f.toFixed(1)}${p.consumeKeys.length ? ' ABSORB ' + p.consumeKeys.join(',') : ''}`);
    }

    // Fallbacks by band. Near-parallel members whose curve found no corner
    // are lateral jogs: taper. Corner members pin sharp (nested-V extension
    // allowed only for genuinely regressive groups); forward turns whose pin
    // gates fail keep the dogleg. Residual members are left for the
    // connector bridge.
    for (const { m, e } of fallback) {
      if (dot >= 0.85) { deferredJogs.push({ g, m, flog }); continue; }
      if (endMoved.has(keyIn(m)) || endMoved.has(keyOut(m))) continue;
      if (sharpPin(g, m, e, fanReach, dot <= -0.3, flog)) continue;
      if (dot > 0 && doglegPin(g, m, e, flog)) continue;
      flog(`${m.lineId} DECLINE (connector)`);
    }
  }

  // Second pass: composition-change tapers, after EVERY junction's corner
  // constructions exist. Corners are primary (their references stay
  // pristine and their zones are measured); a jog member whose ends a
  // corner claimed meanwhile sits out, and ends are re-resolved so all
  // corner mutations are seen.
  for (const { g, m, flog } of deferredJogs) {
    if (endMoved.has(keyIn(m)) || endMoved.has(keyOut(m))) continue;
    const e = endsOf(m);
    if (!e) continue;
    jogTaper(g, m, e, flog);
  }

  for (const [key, reach] of [...extentAt.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const cut = key.indexOf('|');
    zones.push({ node: key.slice(0, cut), edgeA: key.slice(cut + 1), edgeB: '', reach });
  }
  return { joinCurves, joinStopPos, endMoved, mitered, zones, tapers };
}
