// Per-line path assembler: emits each line's ink by walking its traversal,
// so lane pieces, corner curves and lateral transitions form CONTINUOUS
// subpaths instead of a bag of disconnected fragments bridged afterwards by
// a standalone connector pass. Every joint is constructed (curve, taper
// continuation, or tangent-clamped cubic) and attached in-path; the raw
// standalone bridge chord ceases to exist. A retraced corridor (an
// out-and-back course) draws its lane once: the return leg emits no ink and
// the course resumes a new subpath where it diverges. See
// docs/draw-geometry-invariants.md (invariant I1).

import type { Pixel, TraversalStep } from './layout/types';
import type { JoinCurve, FanEdgeRef } from './fanJoin';
import { connectorControls } from './layout/connectorClamp';
import { reportConnTrace } from './debug/renderOctilinear.debug';
import { envNum } from '../env';

const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const fmtPt = (p: Pixel): string => p[0].toFixed(1) + ',' + p[1].toFixed(1);

export interface AssembleSegment {
  p1: Pixel;
  p2: Pixel;
}

export interface AssembleArgs {
  segPath: Map<string, Pixel[]>;
  joinCurves: JoinCurve[];
  filletR: number;
  lineTraversals: Map<string, TraversalStep[]>;
  lineIds: Set<string>;
  edgeById: Map<string, FanEdgeRef>;
  orderOf: Map<string, string[]>;
  /** edgeId|lineId lane pieces dropped by sliver suppression: a gap of only
   *  suppressed steps still bridges in one stroke. */
  suppressed: Set<string>;
  spacing: number;
  /** Straight-subsegment sink for label collision; omit for crop re-emits. */
  segmentsOut?: AssembleSegment[];
  /** Node context for the transition trace (cell lookup). */
  nodeCellOf?: (nodeId: string) => unknown;
}

/** One drawn piece oriented to travel: pts run in course order. */
interface Oriented {
  edgeId: string;
  pts: Pixel[];
  /** node the course enters the piece at (its near node in travel order) */
  startNode: string;
  /** node the course leaves the piece at (its far node in travel order) */
  endNode: string;
}

/**
 * Assemble the per-line 'd' command arrays. Iteration is deterministic:
 * traversals in sorted line-id order, leftover lanes and unconsumed curves
 * in their maps' insertion order.
 */
export function assembleDByLine(args: AssembleArgs): Map<string, string[]> {
  const { segPath, joinCurves, filletR, edgeById, orderOf, suppressed, spacing, segmentsOut } = args;
  const dByLine = new Map<string, string[]>();
  const emittedLane = new Set<string>(); // edgeId|lineId drawn (once each)
  const consumedCurve = new Set<JoinCurve>();

  // Curve lookup per (lineId|edgeA|edgeB). Deliberately NOT keyed by node:
  // an absorbed multi-edge corner is planned from whichever flanking group
  // sorts first, so its recorded node can be either end of the consumed
  // span; the endpoint-proximity check at splice time disambiguates
  // instances of a pair that repeats along a course.
  const curveAt = new Map<string, JoinCurve[]>();
  for (const jc of joinCurves) {
    if (jc.edgeA === undefined || jc.edgeB === undefined) continue;
    const k = jc.lineId + '|' + jc.edgeA + '|' + jc.edgeB;
    let arr = curveAt.get(k);
    if (!arr) curveAt.set(k, (arr = []));
    arr.push(jc);
  }

  const maxGapEnv = envNum('OCTI_CONN_MAXGAP');

  const cmdsOf = (lineId: string): string[] => {
    let d = dByLine.get(lineId);
    if (!d) dByLine.set(lineId, (d = []));
    return d;
  };

  /** Emit one lane piece: M when the pen is detached, plain continuation
   *  when the pen already sits on its first vertex; interior corners get
   *  the standard clamped quadratic fillet. */
  const emitPiece = (d: string[], pts: Pixel[], cur: Pixel | null): Pixel => {
    if (segmentsOut) for (let k = 1; k < pts.length; k++) segmentsOut.push({ p1: pts[k - 1], p2: pts[k] });
    const attached = cur !== null && hyp(cur[0] - pts[0][0], cur[1] - pts[0][1]) < 0.5;
    if (!attached) d.push('M' + fmtPt(pts[0]));
    for (let k = 1; k < pts.length - 1; k++) {
      const a = pts[k - 1];
      const v = pts[k];
      const b = pts[k + 1];
      const l1 = hyp(v[0] - a[0], v[1] - a[1]);
      const l2 = hyp(b[0] - v[0], b[1] - v[1]);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const u1: Pixel = [(v[0] - a[0]) / l1, (v[1] - a[1]) / l1];
      const u2: Pixel = [(b[0] - v[0]) / l2, (b[1] - v[1]) / l2];
      const cross = u1[0] * u2[1] - u1[1] * u2[0];
      const dot = u1[0] * u2[0] + u1[1] * u2[1];
      if (Math.abs(cross) < 0.05 && dot > 0) {
        d.push('L' + fmtPt(v));
        continue;
      }
      const f = Math.min(filletR, l1 / 2, l2 / 2);
      d.push(
        'L' + fmtPt([v[0] - u1[0] * f, v[1] - u1[1] * f]),
        'Q' + fmtPt(v) + ' ' + fmtPt([v[0] + u2[0] * f, v[1] + u2[1] * f]),
      );
    }
    d.push('L' + fmtPt(pts[pts.length - 1]));
    return pts[pts.length - 1];
  };

  /** Joint from the pen (end of `from`) into the start of `to`, at their
   *  shared node. Splices the fan's corner curve when one exists, continues
   *  plainly across coincident ends, and otherwise CONSTRUCTS the lateral
   *  transition in-path (tangent-clamped cubic; plain chord only for a
   *  regressive or degenerate jog). Returns the new pen, or null when the
   *  gap is pathological (detach and restart). */
  const emitJoint = (
    lineId: string, d: string[], cur: Pixel, from: Oriented, to: Oriented, drawnJoints: Set<string>,
    detached: boolean, forceBridge = false,
  ): Pixel | null => {
    const node = from.endNode;
    const pairKey = from.edgeId < to.edgeId ? from.edgeId + '|' + to.edgeId : to.edgeId + '|' + from.edgeId;
    const jointKey = lineId + '|' + node + '|' + pairKey;
    const start = to.pts[0];
    if (!drawnJoints.has(jointKey)) {
      const curves = curveAt.get(lineId + '|' + pairKey);
      if (curves) {
        for (const jc of curves) {
          if (consumedCurve.has(jc)) continue;
          const da = hyp(cur[0] - jc.a[0], cur[1] - jc.a[1]);
          const db = hyp(cur[0] - jc.b[0], cur[1] - jc.b[1]);
          if (Math.min(da, db) > 1) continue; // not this instance's ends
          const [p, q] = da <= db ? [jc.a, jc.b] : [jc.b, jc.a];
          // `cur` is a course POSITION; after a retrace the path stream's
          // pen sits elsewhere, so a detached joint opens its own subpath.
          if (detached) d.push('M' + fmtPt(p));
          else if (da > 0.01 && db > 0.01) d.push('L' + fmtPt(p));
          d.push('Q' + fmtPt(jc.apex) + ' ' + fmtPt(q));
          if (segmentsOut) segmentsOut.push({ p1: p, p2: q });
          consumedCurve.add(jc);
          drawnJoints.add(jointKey);
          return [q[0], q[1]];
        }
      }
    }
    const gap = hyp(start[0] - cur[0], start[1] - cur[1]);
    if (gap < 0.5) {
      // coincident (pinned/tapered): plain continuation; a detached course
      // still needs its subpath opened so the piece can attach to the pen
      if (detached) d.push('M' + fmtPt(cur));
      return cur;
    }
    if (drawnJoints.has(jointKey)) return null; // retrace joint already inked
    // The maxGap decline guards against a pathological jump: a joint whose two
    // pieces do NOT meet at a shared graph node (a traversal hole, or a
    // non-walk traversal stitched from disjoint arcs), where bridging would
    // paint a long spurious diagonal. When the two edges genuinely share the
    // joint node, their lane ends are two offsets of the SAME node; a sharp
    // turn on a wide bundle can spread those offsets well past a fixed pitch
    // cap, but the node truly connects them, so the joint must always bridge.
    // Declining there severs the route into two components at the node.
    // A joint bridging a run of suppressed slivers (forceBridge) reaches across
    // real course the merge dropped as noise; it must connect in one stroke
    // whatever the span, exactly like a shared-node turn.
    const sharedNode = from.endNode === to.startNode;
    if (!sharedNode && !forceBridge) {
      const bundleSpan = ((orderOf.get(from.edgeId)?.length ?? 1) + (orderOf.get(to.edgeId)?.length ?? 1)) * spacing;
      const maxGap = Number.isFinite(maxGapEnv) && maxGapEnv > 0 ? maxGapEnv : Math.max(spacing * 8, bundleSpan);
      if (gap > maxGap) return null; // pathological jump: detach
    }
    const prevA = from.pts[from.pts.length - 2];
    const nextB = to.pts[1];
    const unitTo = (a: Pixel, b: Pixel): Pixel => {
      const len = hyp(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    };
    const dirA = prevA ? unitTo(prevA, cur) : unitTo(cur, start);
    const dirB = nextB ? unitTo(start, nextB) : unitTo(cur, start);
    reportConnTrace({
      lineId, endA: node, cell: args.nodeCellOf?.(node),
      pa: cur, pb: start, gap, prevA, nextB, dirA, dirB,
      nA: from.pts.length, nB: to.pts.length, edgeA: from.edgeId, edgeB: to.edgeId,
    });
    const tx = dirA[0] + dirB[0];
    const ty = dirA[1] + dirB[1];
    const tLen = hyp(tx, ty) || 1;
    const lon = Math.abs(((start[0] - cur[0]) * tx + (start[1] - cur[1]) * ty) / tLen);
    const k = Math.min(Math.min(spacing * 4, Math.max(gap, spacing * 2)), lon);
    const prog = Math.min(
      (start[0] - cur[0]) * dirA[0] + (start[1] - cur[1]) * dirA[1],
      (start[0] - cur[0]) * dirB[0] + (start[1] - cur[1]) * dirB[1],
    );
    if (detached) d.push('M' + fmtPt(cur));
    if (dirA[0] * dirB[0] + dirA[1] * dirB[1] < -0.3 || k < 1.5 || prog < 0) {
      d.push('L' + fmtPt(start));
    } else {
      const { c1, c2 } = connectorControls(cur, start, dirA, dirB, k);
      d.push('C' + fmtPt(c1) + ' ' + fmtPt(c2) + ' ' + fmtPt(start));
    }
    if (segmentsOut) segmentsOut.push({ p1: cur, p2: start });
    drawnJoints.add(jointKey);
    return [start[0], start[1]];
  };

  const sortedLines = [...args.lineTraversals.keys()].sort();
  for (const lineId of sortedLines) {
    if (!args.lineIds.has(lineId)) continue;
    const traversal = args.lineTraversals.get(lineId)!;
    const d = cmdsOf(lineId);
    const drawnJoints = new Set<string>();

    const orient = (step: TraversalStep): Oriented | null => {
      const lane = segPath.get(step.edgeId + '|' + lineId);
      const e = edgeById.get(step.edgeId);
      if (!lane || !e || lane.length < 2) return null;
      return {
        edgeId: step.edgeId,
        pts: step.reversed ? [...lane].reverse() : lane,
        startNode: step.reversed ? e.to : e.from,
        endNode: step.reversed ? e.from : e.to,
      };
    };

    // A closed ring course continues across its seam; one extra iteration
    // revisits the first drawn piece so the seam joint is constructed too.
    // An out-and-back's seam retraces one edge (nothing to bridge).
    let wrap = 0;
    if (traversal.length > 1) {
      const f = traversal[0];
      const l = traversal[traversal.length - 1];
      const sameEdgeSeam = f.edgeId === l.edgeId && f.reversed !== l.reversed;
      const ef = edgeById.get(f.edgeId);
      const el = edgeById.get(l.edgeId);
      const firstStart = f.reversed ? ef?.to : ef?.from;
      const lastEnd = l.reversed ? el?.from : el?.to;
      if (!sameEdgeSeam && firstStart !== undefined && firstStart === lastEnd) wrap = 1;
    }

    let cur: Pixel | null = null;
    let prev: Oriented | null = null; // the piece the pen sits on (or last walked)
    let firstDrawnIdx = -1;
    // Set while the walk skips a run of suppressed slivers, so the next joint
    // knows it is bridging that run and must not decline it as a long jump.
    let spannedSuppressed = false;
    for (let i = 0; i < traversal.length + wrap; i++) {
      const wrapped = i >= traversal.length;
      const step = wrapped ? traversal[firstDrawnIdx] : traversal[i];
      if (wrapped && firstDrawnIdx < 0) break;
      const o = orient(step);
      if (!o) {
        // undrawn: a suppressed sliver keeps the course bridgeable in one
        // stroke; any other hole is a genuine discontinuity. A run of
        // suppressed slivers can span several nodes, so the eventual bridge
        // joint reaches across all of them: mark it to bridge unconditionally.
        if (!suppressed.has(step.edgeId + '|' + lineId)) { cur = null; prev = null; spannedSuppressed = false; }
        else spannedSuppressed = true;
        continue;
      }
      const already = emittedLane.has(step.edgeId + '|' + lineId);
      if (already && !wrapped) {
        // retrace: the ink exists; the course rides it silently. Remember
        // where it rides so a later divergence can joint from the right end.
        prev = o;
        cur = null;
        continue;
      }
      if (prev && cur === null) {
        // resuming after a retrace (or after a joint decline): the course
        // position is the retraced piece's end; joint from there, opening
        // a fresh subpath (detached). A null return leaves the piece below
        // to open with its own M.
        cur = emitJoint(lineId, d, prev.pts[prev.pts.length - 1], prev, o, drawnJoints, true, spannedSuppressed);
      } else if (prev && cur !== null) {
        cur = emitJoint(lineId, d, cur, prev, o, drawnJoints, false, spannedSuppressed);
      }
      if (wrapped) break; // seam joint only; the first piece is already inked
      cur = emitPiece(d, o.pts, cur);
      emittedLane.add(step.edgeId + '|' + lineId);
      if (firstDrawnIdx < 0) firstDrawnIdx = i;
      prev = o;
      spannedSuppressed = false;
    }
  }

  // Lanes no walk visited (lines without traversals draw every edge that
  // carries them) keep their classic standalone emission.
  for (const [key, poly] of segPath) {
    if (emittedLane.has(key) || poly.length < 2) continue;
    const lineId = key.slice(key.indexOf('|') + 1);
    if (!args.lineIds.has(lineId)) continue;
    emitPiece(cmdsOf(lineId), poly, null);
    emittedLane.add(key);
  }

  // Corner curves no joint consumed (a walk detached before reaching them)
  // still draw, as the classic separate quadratic, so no constructed ink is
  // ever lost.
  for (const jc of joinCurves) {
    if (consumedCurve.has(jc)) continue;
    const d = cmdsOf(jc.lineId);
    d.push('M' + fmtPt(jc.a), 'Q' + fmtPt(jc.apex) + ' ' + fmtPt(jc.b));
    if (segmentsOut) segmentsOut.push({ p1: jc.a, p2: jc.b });
  }

  return dByLine;
}
