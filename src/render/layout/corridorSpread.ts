// Seating a run of crowded stops along one corridor: a bounded 1-D problem.
// Each stop arrives with its present coordinate on the spread axis and the
// interval it can reach, which the caller measures against every constraint on
// that stop alone (its stop-order clamp, the vetoes on translating its capsule,
// and its clearance to stations outside the run).
//
// Because the intervals are per-stop and ordered, stop order holds by
// CONSTRUCTION: a stop that keeps to its own interval cannot pass a neighbour.
// The solver therefore only chooses a spacing the intervals admit, and seats
// every stop as near its present position as that spacing allows, so a run
// disturbs only the stops it must.

export interface SpreadPlacement {
  /** spacing between consecutive stops, in px along the axis */
  gap: number;
  /** placed axis coordinate per stop, in the input's order */
  at: number[];
}

/** Maximum travel needed to give every member the requested spacing when all
 *  members start at one coordinate and one end must remain fixed. */
export function corridorSpreadReachLimit(memberCount: number, want: number): number {
  return Math.max(0, memberCount - 1) * want;
}

/**
 * @param home present axis coordinate per stop, in non-decreasing order
 * @param lo   lowest axis coordinate each stop can reach (`lo[k] <= home[k]`)
 * @param hi   highest axis coordinate each stop can reach (`hi[k] >= home[k]`)
 * @param want spacing to take when the corridor is free enough to allow it
 * @param min  spacing below which spreading buys nothing, because the drawn
 *             markers still merge
 * @returns the placement, or null when the intervals admit no spacing >= `min`
 */
export function solveCorridorSpread(
  home: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
  want: number,
  min: number,
): SpreadPlacement | null {
  const n = home.length;
  if (n < 2) return null;
  // Widest spacing the intervals admit, exactly: stops x < y have (y - x) gaps
  // between them and together span at most hi[y] - lo[x].
  let gap = want;
  for (let x = 0; x < n; x++) {
    for (let y = x + 1; y < n; y++) {
      const cap = (hi[y] - lo[x]) / (y - x);
      if (cap < gap) gap = cap;
    }
  }
  if (!(gap >= min)) return null;
  // Tighten every interval against its neighbours at that spacing.
  const a = new Array<number>(n);
  const b = new Array<number>(n);
  a[0] = lo[0];
  for (let k = 1; k < n; k++) a[k] = Math.max(lo[k], a[k - 1] + gap);
  b[n - 1] = hi[n - 1];
  for (let k = n - 2; k >= 0; k--) b[k] = Math.min(hi[k], b[k + 1] - gap);
  for (let k = 0; k < n; k++) if (a[k] > b[k] + 1e-9) return null;
  // Seat each stop as near its present position as its tightened interval
  // allows, then carry forward any left closer than the spacing. The forward
  // pass cannot overrun an interval: b[k-1] <= b[k] - gap by construction.
  const at = home.map((h, k) => (h < a[k] ? a[k] : h > b[k] ? b[k] : h));
  for (let k = 1; k < n; k++) if (at[k] < at[k - 1] + gap) at[k] = at[k - 1] + gap;
  return { gap, at };
}
