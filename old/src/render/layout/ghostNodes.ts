// Ghost-node splitting for high-degree station groups.
//
// Inspired by Bast/Brosi/Storandt §2 (node splitting). When a station has
// more than `maxDirections` incident edges, those edges enter the station
// from too many directions to render cleanly. We collapse them into at most
// `maxDirections` (= 4) cardinal entry buckets (E, S, W, N) by closest
// direction. Each bucket containing ≥2 edges gets a single ghost node
// positioned `ghostDistance` away from the station along the bucket
// direction. All bucket members terminate at the ghost; a single shared
// "bundle" edge connects the ghost back to the station.
//
// The downstream `computeCanonicalOffsets` then fans the bundled lines
// into parallel ribbons along the (ghost → station) corridor, producing a
// clean single-direction entry into the station. The ghost itself MUST NOT
// render: no marker, no label. It's a routing-only construct that visually
// disappears — see the paper figure: lines pass through it but no circle
// remains. The renderer is responsible for treating ids in `ghostNodeIds`
// as invisible.

import type {
  TransitGraph,
  GraphNode,
  GraphEdge,
  LineRef,
  EdgeStop,
  TraversalStep,
} from './types';

export interface GhostNodeOptions {
  /** Maximum number of distinct entry directions per station (typically 4 —
   *  the four cardinal directions). Stations with at most this many incident
   *  edges are never split. */
  maxDirections: number;
  /** Distance from the original station to the ghost, in pixels. Should be
   *  "somewhat far away" so the lines visibly fan into a single corridor
   *  before reaching the station. A typical value is on the order of the
   *  median edge length. */
  ghostDistance: number;
}

export interface GhostNodeResult {
  graph: TransitGraph;
  /** Ids of all ghost nodes inserted. Renderer MUST NOT draw markers or
   *  labels at these positions — the ghost is a routing construct only. */
  ghostNodeIds: Set<string>;
}

/** The 4 cardinal-bucket directions, in SVG y-down coords. The label is just
 *  used to derive a stable ghost-id suffix for debugging. */
const CARDINALS: ReadonlyArray<{ dir: [number, number]; name: string }> = [
  { dir: [1, 0], name: 'E' },
  { dir: [0, 1], name: 'S' },
  { dir: [-1, 0], name: 'W' },
  { dir: [0, -1], name: 'N' },
];

/** Index (0..3) of the cardinal bucket whose direction is closest to (vx,vy). */
function bucketFor(vx: number, vy: number): number {
  // argmax of dot(dir, cardinal) over E,S,W,N = {vx, vy, -vx, -vy}. The length
  // normalization is irrelevant to the argmax, so it is dropped — Math.hypot is
  // not correctly-rounded cross-V8; this is pure +,-,compare. Strict > with
  // E-first preserves the original lowest-index tie order (and vx=vy=0 → E).
  let best = 0, bestDot = vx;                       // E [1,0]
  if (vy > bestDot) { bestDot = vy; best = 1; }      // S [0,1]
  if (-vx > bestDot) { bestDot = -vx; best = 2; }    // W [-1,0]
  if (-vy > bestDot) { best = 3; }                   // N [0,-1]
  return best;
}

export function splitHighRouteNodes(
  graph: TransitGraph,
  opts: GhostNodeOptions,
): GhostNodeResult {
  const { maxDirections, ghostDistance } = opts;

  // 1. Index incident edges per node.
  const incidence = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    for (const nid of [e.from, e.to] as const) {
      let list = incidence.get(nid);
      if (!list) {
        list = [];
        incidence.set(nid, list);
      }
      list.push(e);
    }
  }

  // 2. For each station with too many incident edges, bucket edges into
  //    cardinals and pick which buckets get a ghost (those with ≥2 members).
  const bucketOfEdgeEnd = new Map<string, number>(); // key = sid + '|' + edgeId
  const ghostForEdgeEnd = new Map<string, string>(); // key = sid + '|' + edgeId → ghost id
  const ghostByStationBucket = new Map<string, Map<number, string>>();

  for (const [sid, incEdges] of incidence) {
    if (incEdges.length <= maxDirections) continue;
    const station = graph.nodes.get(sid);
    if (!station) continue;

    // Assign each incident edge to a cardinal bucket.
    const buckets = new Map<number, GraphEdge[]>();
    for (const e of incEdges) {
      const otherId = e.from === sid ? e.to : e.from;
      const other = graph.nodes.get(otherId);
      if (!other) continue;
      const b = bucketFor(other.pos[0] - station.pos[0], other.pos[1] - station.pos[1]);
      bucketOfEdgeEnd.set(sid + '|' + e.id, b);
      let list = buckets.get(b);
      if (!list) {
        list = [];
        buckets.set(b, list);
      }
      list.push(e);
    }

    // Create ghosts only for buckets with multiple members; single-member
    // buckets stay attached directly to the station (no point in a ghost).
    const ghostsForStation = new Map<number, string>();
    for (const [b, members] of buckets) {
      if (members.length < 2) continue;
      const ghostId = sid + '__ghost_' + CARDINALS[b].name;
      ghostsForStation.set(b, ghostId);
      for (const m of members) ghostForEdgeEnd.set(sid + '|' + m.id, ghostId);
    }
    if (ghostsForStation.size > 0) ghostByStationBucket.set(sid, ghostsForStation);
  }

  // No splitting needed — pass through.
  if (ghostByStationBucket.size === 0) {
    return { graph, ghostNodeIds: new Set() };
  }

  // 3. Build the new node map: every original node, plus one ghost per
  //    (station, ghost-bucket).
  const newNodes = new Map<string, GraphNode>(graph.nodes);
  const ghostNodeIds = new Set<string>();
  for (const [sid, ghosts] of ghostByStationBucket) {
    const station = graph.nodes.get(sid)!;
    for (const [b, gid] of ghosts) {
      const [cx, cy] = CARDINALS[b].dir;
      newNodes.set(gid, {
        id: gid,
        label: '', // empty — renderer suppresses ghost labels anyway, but keep
        // the field defined for any code that reads it raw.
        pos: [station.pos[0] + cx * ghostDistance, station.pos[1] + cy * ghostDistance],
        lngLat: station.lngLat,
      });
      ghostNodeIds.add(gid);
    }
  }

  // 4. Build new edges.
  //
  //    For each original edge e = (u, v):
  //      gu = ghost at u-end of e, if u is a split station AND e is in a
  //           multi-member bucket at u; else undefined.
  //      gv = ghost at v-end of e, same logic for v.
  //    Replacement edges along the "forward" (u → v) direction:
  //      [pre]   bundle_u  = (u → ghost_u)        — only if gu defined
  //              outer    = (gu ?? u) → (gv ?? v) — always present
  //      [post]  bundle_v  = (ghost_v → v)        — only if gv defined
  //                          (canonical form is (v, ghost_v); traversed reversed
  //                           for forward direction)
  //
  //    Bundle edges are SHARED across every member of the same (station,
  //    bucket): one bundle per ghost, carrying the union of lines that pass
  //    through it.

  interface BundleData {
    id: string;
    station: string;
    ghost: string;
    lines: Map<string, LineRef>;
    stopAtStation: Map<string, boolean>;
  }
  const bundles = new Map<string, BundleData>(); // key = sid + '|' + bucket
  const bundleKey = (sid: string, b: number) => sid + '|' + b;

  let edgeCounter = 0;
  const newEdgeId = (suffix: string) => 'e' + edgeCounter++ + '_' + suffix;

  for (const [sid, ghosts] of ghostByStationBucket) {
    for (const [b, gid] of ghosts) {
      bundles.set(bundleKey(sid, b), {
        id: newEdgeId('bundle'),
        station: sid,
        ghost: gid,
        lines: new Map(),
        stopAtStation: new Map(),
      });
    }
  }

  interface EdgePart {
    newId: string;
    /** Direction relative to the new edge's canonical (from, to) when walking
     *  the ORIGINAL edge in its native (e.from → e.to) direction. */
    reversed: boolean;
  }
  const edgeSequenceForward = new Map<string, EdgePart[]>();
  const newEdges: GraphEdge[] = [];

  for (const e of graph.edges) {
    const gu = ghostForEdgeEnd.get(e.from + '|' + e.id);
    const gv = ghostForEdgeEnd.get(e.to + '|' + e.id);

    // Fast path: edge unaffected — keep it as-is and map its traversal 1:1.
    if (!gu && !gv) {
      newEdges.push(e);
      edgeSequenceForward.set(e.id, [{ newId: e.id, reversed: false }]);
      continue;
    }

    const seq: EdgePart[] = [];

    // Pre-bundle at u (canonical from=u, to=ghost_u). Walking u→ghost_u is
    // forward (not reversed) relative to canonical.
    if (gu) {
      const bk = bundleKey(e.from, bucketOfEdgeEnd.get(e.from + '|' + e.id)!);
      const bundle = bundles.get(bk)!;
      for (const l of e.lines) {
        if (!bundle.lines.has(l.id)) bundle.lines.set(l.id, l);
        const orig = e.stops.get(l.id);
        if (orig?.atFrom) bundle.stopAtStation.set(l.id, true);
        else if (!bundle.stopAtStation.has(l.id)) bundle.stopAtStation.set(l.id, false);
      }
      seq.push({ newId: bundle.id, reversed: false });
    }

    // Outer edge: carries this single original edge's lines.
    const outerFrom = gu ?? e.from;
    const outerTo = gv ?? e.to;
    const outerStops = new Map<string, EdgeStop>();
    for (const l of e.lines) {
      const orig = e.stops.get(l.id);
      if (!orig) continue;
      // Stops at the *station* end are moved to the bundle (above); the outer
      // only keeps stops at non-split endpoints.
      const atFrom = orig.atFrom && !gu;
      const atTo = orig.atTo && !gv;
      if (atFrom || atTo) outerStops.set(l.id, { atFrom, atTo });
    }
    const outerEdge: GraphEdge = {
      id: newEdgeId('outer'),
      from: outerFrom,
      to: outerTo,
      lines: e.lines,
      stops: outerStops,
    };
    newEdges.push(outerEdge);
    seq.push({ newId: outerEdge.id, reversed: false });

    // Post-bundle at v. Canonical bundle is (v, ghost_v); walking ghost_v→v
    // is the REVERSE of canonical.
    if (gv) {
      const bk = bundleKey(e.to, bucketOfEdgeEnd.get(e.to + '|' + e.id)!);
      const bundle = bundles.get(bk)!;
      for (const l of e.lines) {
        if (!bundle.lines.has(l.id)) bundle.lines.set(l.id, l);
        const orig = e.stops.get(l.id);
        if (orig?.atTo) bundle.stopAtStation.set(l.id, true);
        else if (!bundle.stopAtStation.has(l.id)) bundle.stopAtStation.set(l.id, false);
      }
      seq.push({ newId: bundle.id, reversed: true });
    }

    edgeSequenceForward.set(e.id, seq);
  }

  // Emit bundle edges last (after lines & stops are populated).
  for (const bd of bundles.values()) {
    const linesArr = [...bd.lines.values()];
    const stopsMap = new Map<string, EdgeStop>();
    for (const [lid, atStation] of bd.stopAtStation) {
      // Canonical bundle: from = station, to = ghost. The station-end stop is
      // therefore `atFrom`. The ghost-end never has a stop.
      if (atStation) stopsMap.set(lid, { atFrom: true, atTo: false });
    }
    newEdges.push({
      id: bd.id,
      from: bd.station,
      to: bd.ghost,
      lines: linesArr,
      stops: stopsMap,
    });
  }

  // 5. Remap line traversals. A single step on a split edge becomes 2 or 3
  //    steps. If the original step was reversed, the sequence is reversed
  //    AND each item's reversed bit is flipped.
  const newLineTraversals = new Map<string, TraversalStep[]>();
  for (const [lineId, steps] of graph.lineTraversals) {
    const out: TraversalStep[] = [];
    for (const step of steps) {
      const seq = edgeSequenceForward.get(step.edgeId);
      if (!seq) {
        out.push(step);
        continue;
      }
      const ordered = step.reversed ? [...seq].reverse() : seq;
      for (const part of ordered) {
        out.push({
          edgeId: part.newId,
          reversed: step.reversed ? !part.reversed : part.reversed,
        });
      }
    }
    newLineTraversals.set(lineId, out);
  }

  // 6. Rebuild adjacency.
  const newAdj = new Map<string, string[]>();
  for (const id of newNodes.keys()) newAdj.set(id, []);
  for (const e of newEdges) {
    newAdj.get(e.from)?.push(e.id);
    newAdj.get(e.to)?.push(e.id);
  }

  return {
    graph: {
      nodes: newNodes,
      edges: newEdges,
      adj: newAdj,
      lineTraversals: newLineTraversals,
    },
    ghostNodeIds,
  };
}
