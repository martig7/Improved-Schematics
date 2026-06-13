export interface IncidentEdge {
  id: string;
  /** True if this node is the edge's `from` endpoint (else it's `to`). */
  nodeIsFrom: boolean;
  /** Exit direction of the edge's first segment leaving this node (away from
   *  the node). Need not be unit length. */
  dir: [number, number];
  /** Line ids carried by this edge, in a stable seed order (ties keep it). */
  lines: string[];
}

export interface NodePlanResult {
  /** edgeId -> desired order of that edge's lines in its own from->to frame. */
  orderAtNode: Map<string, string[]>;
  /** False when the local circular matching has a genuine crossing. */
  planar: boolean;
}

function norm(v: [number, number]): [number, number] {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Compute each incident edge's planar (non-crossing) line order at one node.
 *  lineEdges maps a line id to the pair of edge ids it uses at this node; the
 *  second is null when the line terminates here.
 *
 *  Ordering: project each line's destination exit-direction onto the edge's
 *  FIXED from->to lateral axis L = perp(T), where T is the edge's from->to
 *  travel direction (recovered from the local exit dir + nodeIsFrom). Sorting by
 *  that projection ascending yields the lineOrder frame directly (index 0 at
 *  -L). Straight-through lines project to ~0 and keep their seed order; lines
 *  sharing a destination tie and stay contiguous (the "keep bundles together"
 *  invariant). No from/to post-hoc reversal — L is endpoint-independent. */
export function desiredOrdersAtNode(
  edges: IncidentEdge[],
  lineEdges: Map<string, [string, string | null]>,
): NodePlanResult {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const orderAtNode = new Map<string, string[]>();

  for (const e of edges) {
    const D = norm(e.dir);
    const T: [number, number] = e.nodeIsFrom ? D : [-D[0], -D[1]]; // from->to travel dir
    const L: [number, number] = [-T[1], T[0]]; // +lateral axis (perp), matches offsetPolyline
    const keyed = e.lines.map((l, idx) => {
      const pair = lineEdges.get(l);
      const other = pair ? (pair[0] === e.id ? pair[1] : pair[0]) : null;
      let s = 0; // terminators / straight-through project to 0 (kept in seed order)
      if (other && byId.has(other)) {
        const Dd = norm(byId.get(other)!.dir);
        s = Dd[0] * L[0] + Dd[1] * L[1];
      }
      return { l, s, idx };
    });
    keyed.sort((a, b) => a.s - b.s || a.idx - b.idx);
    orderAtNode.set(e.id, keyed.map((k) => k.l));
  }

  // Planarity: model each through-line as a chord between its two incident
  // edges' angular positions around the node. Two chords that interleave on the
  // cycle cross (spec 2026-06-13 §2.1). Chords sharing an edge are resolved by
  // the within-edge order above (contiguous blocks) and don't count here.
  const cyc = [...edges].sort(
    (a, b) => Math.atan2(a.dir[1], a.dir[0]) - Math.atan2(b.dir[1], b.dir[0]),
  );
  const pos = new Map(cyc.map((e, i) => [e.id, i]));
  const inArc = (x: number, a: number, b: number): boolean =>
    a < b ? x > a && x < b : x > a || x < b; // strictly inside the CCW arc a->b
  const chords: { a: number; b: number }[] = [];
  for (const [, pair] of lineEdges) {
    if (!pair[1]) continue;
    const a = pos.get(pair[0]);
    const b = pos.get(pair[1]);
    if (a === undefined || b === undefined || a === b) continue;
    chords.push({ a, b });
  }
  let planar = true;
  for (let i = 0; i < chords.length && planar; i++) {
    for (let j = i + 1; j < chords.length; j++) {
      const c1 = chords[i];
      const c2 = chords[j];
      if (c1.a === c2.a || c1.a === c2.b || c1.b === c2.a || c1.b === c2.b) continue; // share an edge
      if (inArc(c2.a, c1.a, c1.b) !== inArc(c2.b, c1.a, c1.b)) {
        planar = false;
        break;
      }
    }
  }

  return { orderAtNode, planar };
}
