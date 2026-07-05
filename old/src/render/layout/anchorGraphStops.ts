// DEPRECATED 2026-07-05 — superseded by stop-node protection through the merge
// (runMergeRounds: stops join isMergeAnchor + dHat seed dedupe). With stops
// surviving the merge at their own positions, this pass measured minted=0
// welded=0 far=0 across a 6-config corpus (SEA split+classic, NYC-XD,
// NYC-Jul4, LON-3, SF) and was deleted from topo.ts. Imports unresolved by
// design — see old/README.md.

function projectOntoPolyline(pts: Pixel[], p: Pixel): Pixel {
  let bestD = Infinity;
  let bestPoint: Pixel = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const c2 = vx * vx + vy * vy;
    const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / c2));
    const q: Pixel = [a[0] + t * vx, a[1] + t * vy];
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      bestPoint = q;
    }
  }
  return bestPoint;
}

/** Split support edges so contracted pass-through stops regain a node.
 *
 *  `minSep` (RCA Bundle A): never create an anchor node within minSep of an
 *  existing node — contraction just guaranteed dHat spacing, and a closer
 *  anchor is a sub-cell edge the router cannot route cleanly. Solo (Fix 1)
 *  this measured net-worse because ~40 fewer nodes coarsened the grid ruler;
 *  in Bundle A the ndCollapseCand anchor-reuse removes the dominant sub-cell
 *  source and the ruler effect is measured pinned (OCTI_CELL). See
 *  docs/2026-07-05-anomaly-defense-rca.md. */
export function anchorGraphStops(
  g: TransitGraph,
  nodes: Map<string, SupportNode>,
  edges: Map<string, SupportEdge>,
  adj: Map<string, string[]>,
  snapRadius: number,
  minSep: number,
  nextNodeId: () => string,
  nextEdgeId: () => string,
): void {
  // A nearby node only satisfies a stop if it CARRIES the stop's line: twin
  // platforms put another line's corridor node within snapRadius of this
  // line's stop (191 Pl: K's anchor 1.4px from the 2's platform), and skipping
  // the anchor then leaves the line with no on-corridor node — traversal
  // reconstruction falls back to the foreign twin and heals a horseshoe
  // detour around the network to touch it.
  const carriesLine = (nid: string, lineId: string): boolean =>
    (adj.get(nid) ?? []).some((eid) => edges.get(eid)?.lineIds.has(lineId));
  const hasNodeNear = (p: Pixel, lineId: string): boolean => {
    for (const n of nodes.values()) {
      if (dist(n.pos, p) <= snapRadius && carriesLine(n.id, lineId)) return true;
    }
    return false;
  };

  const stopsToAnchor: Array<{ pos: Pixel; lineId: string }> = [];
  for (const ge of g.edges) {
    for (const [lineId, flags] of ge.stops) {
      if (flags.atFrom) {
        const gp = g.nodes.get(ge.from);
        if (gp) stopsToAnchor.push({ pos: gp.pos, lineId });
      }
      if (flags.atTo) {
        const gp = g.nodes.get(ge.to);
        if (gp) stopsToAnchor.push({ pos: gp.pos, lineId });
      }
    }
  }

  const anchorDbg =
    typeof process !== 'undefined'
      ? (process as { env?: Record<string, string> }).env?.OCTI_ANCHOR_DBG
      : undefined;
  const dbgBox = anchorDbg ? anchorDbg.split(',').map(Number) : null;
  const inDbgBox = (p: Pixel): boolean =>
    !!dbgBox && p[0] >= dbgBox[0] && p[0] <= dbgBox[2] && p[1] >= dbgBox[1] && p[1] <= dbgBox[3];

  const stats = { seated: 0, minted: 0, welded: 0, stranded: 0, noCorridor: 0, far: 0 };
  for (const { pos, lineId } of stopsToAnchor) {
    if (hasNodeNear(pos, lineId)) {
      stats.seated++;
      if (inDbgBox(pos)) {
        let who = '';
        for (const n of nodes.values()) {
          if (dist(n.pos, pos) <= snapRadius && carriesLine(n.id, lineId)) { who = `${n.id}@${dist(n.pos, pos).toFixed(1)}px`; break; }
        }
        console.error(`[anchordbg] stop ${lineId.slice(0, 8)} (${pos[0].toFixed(0)},${pos[1].toFixed(0)}) SKIP near-carrying ${who}`);
      }
      continue;
    }
    if (inDbgBox(pos)) console.error(`[anchordbg] stop ${lineId.slice(0, 8)} (${pos[0].toFixed(0)},${pos[1].toFixed(0)}) anchoring...`);

    let bestEid: string | null = null;
    let bestD = Infinity;
    let bestPoint: Pixel = pos;
    for (const [eid, e] of edges) {
      if (!e.lineIds.has(lineId)) continue;
      const point = projectOntoPolyline(e.points, pos);
      const d = dist(point, pos);
      if (d < bestD) {
        bestD = d;
        bestEid = eid;
        bestPoint = point;
      }
    }
    // Force-place: a far anchor is still better than a silently missing
    // station (the user-facing symptom is a line ending one stop early).
    if (!bestEid) {
      stats.noCorridor++;
      if (inDbgBox(pos)) console.error(`[anchordbg]   -> NO corridor carries ${lineId.slice(0, 8)}`);
      continue; // no corridor carries this line at all
    }
    if (bestD > snapRadius * 4) stats.far++;
    if (inDbgBox(pos)) console.error(`[anchordbg]   -> best ${bestEid} at ${bestD.toFixed(1)}px point (${bestPoint[0].toFixed(0)},${bestPoint[1].toFixed(0)})`);
    if (
      bestD > snapRadius * 4 &&
      typeof process !== 'undefined' &&
      (process as { env?: Record<string, string> }).env?.OCTI_DEBUG
    ) {
      console.error(`[topo] anchor FAR: stop for ${lineId.slice(0, 8)} at ${bestD.toFixed(0)}px`);
    }
    const e = edges.get(bestEid);
    if (!e) continue;
    // Spacing floor: never create a node within minSep of an existing one
    // (subsumes the old 1px endpoint guard — endpoints are nodes).
    let nearestD = Infinity;
    for (const n of nodes.values()) {
      const d = dist(n.pos, bestPoint);
      if (d < nearestD) nearestD = d;
    }
    let weldInto: string | null = null;
    if (nearestD < minSep) {
      // Spacing floor hit. If the blocking node already carries the line the
      // stop can simply seat there — no split needed. If it's a FOREIGN twin
      // (191 Pl: K's anchor 1.1px from where the 2's corridor passes), minting
      // a node would recreate the sub-cell pair the floor exists to prevent —
      // but skipping leaves the line with no on-corridor node and traversal
      // reconstruction heals a horseshoe to reach the twin. Weld the corridor
      // THROUGH the existing node instead: it becomes a real shared junction
      // carrying both lines, with no new node and no sub-cell pair.
      let nearestN: SupportNode | null = null;
      for (const n of nodes.values()) {
        if (dist(n.pos, bestPoint) === nearestD) { nearestN = n; break; }
      }
      if (!nearestN || carriesLine(nearestN.id, lineId) || nearestN.id === e.from || nearestN.id === e.to) {
        stats.seated++;
        if (inDbgBox(pos)) console.error(`[anchordbg]   -> minSep SKIP (nearest node ${nearestD.toFixed(1)}px < ${minSep}, carries line or endpoint)`);
        continue;
      }
      // Only weld when the stop would otherwise be STRANDED: if the line
      // already has a carrying node within seating range, the stop homes
      // there and a weld would just add a redundant twin node to ping-pong
      // between (E's terminus grew a 17px stutter that way).
      let seatD = Infinity;
      for (const n of nodes.values()) {
        if (dist(n.pos, pos) < seatD && carriesLine(n.id, lineId)) seatD = dist(n.pos, pos);
      }
      if (seatD <= minSep * 2) {
        stats.seated++;
        if (inDbgBox(pos)) console.error(`[anchordbg]   -> minSep SKIP (line seats at carrying node ${seatD.toFixed(1)}px away)`);
        continue;
      }
      stats.welded++;
      weldInto = nearestN.id;
      if (inDbgBox(pos)) console.error(`[anchordbg]   -> WELD-THROUGH ${weldInto} (foreign twin at ${nearestD.toFixed(1)}px)`);
    }

    let splitAt = 0;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1];
      const b = e.points[i];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const c2 = vx * vx + vy * vy;
      const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((bestPoint[0] - a[0]) * vx + (bestPoint[1] - a[1]) * vy) / c2));
      const q: Pixel = [a[0] + t * vx, a[1] + t * vy];
      if (dist(q, bestPoint) < 1) {
        splitAt = i - 1;
        bestPoint = q;
        break;
      }
    }
    // Weld case: the corridor halves meet at the EXISTING node's position (a
    // sub-minSep jog off the course), not at the projection point.
    if (weldInto) bestPoint = nodes.get(weldInto)!.pos.slice() as Pixel;

    const nid = weldInto ?? nextNodeId();
    if (!weldInto) {
      stats.minted++;
      nodes.set(nid, { id: nid, pos: bestPoint.slice() as Pixel });
      adj.set(nid, []);
    }

    const leftPts = [...e.points.slice(0, splitAt + 1), bestPoint];
    const rightPts = [bestPoint, ...e.points.slice(splitAt + 1)];

    adj.get(e.from)!.splice(adj.get(e.from)!.indexOf(bestEid), 1);
    adj.get(e.to)!.splice(adj.get(e.to)!.indexOf(bestEid), 1);
    edges.delete(bestEid);

    const leftId = nextEdgeId();
    const rightId = nextEdgeId();
    edges.set(leftId, { id: leftId, from: e.from, to: nid, points: leftPts, lineIds: new Set(e.lineIds) });
    edges.set(rightId, { id: rightId, from: nid, to: e.to, points: rightPts, lineIds: new Set(e.lineIds) });
    adj.get(e.from)!.push(leftId);
    adj.get(nid)!.push(leftId);
    adj.get(nid)!.push(rightId);
    adj.get(e.to)!.push(rightId);
  }
  if (
    typeof process !== 'undefined' &&
    (process as { env?: Record<string, string> }).env?.OCTI_AUDIT
  ) {
    console.error(
      `[audit:fire] anchorGraphStops: stops=${stopsToAnchor.length} seated=${stats.seated} ` +
      `minted=${stats.minted} welded=${stats.welded} far=${stats.far} noCorridor=${stats.noCorridor}`,
    );
  }
}
