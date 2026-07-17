// Bundle-coherent paint layers: cluster lines into paint groups by co-run
// share, so all lines of one service bundle draw on one layer and any
// overlap between two bundles stacks coherently (one whole bundle over the
// other, separated by the upper group's casing). See
// docs/draw-geometry-invariants.md invariant I8.

/**
 * Cluster lines into ordered paint groups.
 *
 * Affinity between two lines is their co-run share: the summed arc of edges
 * they ride together over the shorter line's total ridden arc. Lines whose
 * share reaches at least half are bundle-mates (a line belongs with the
 * bundle it spends most of its drawn length beside); the transitive closure
 * forms the groups. Groups are ordered longest total arc first (trunks at
 * the bottom of the paint stack, short crossers on top), lines within a
 * group keep the caller's order. Deterministic: sorted pair iteration, raw
 * string compares.
 *
 * @param orderOf drawn lane order per edge (post sliver suppression)
 * @param arcOf   per-edge base polyline arc length, px
 * @param lineIds every renderable line, in stable paint order
 * @returns ordered groups covering exactly `lineIds`
 */
export function computePaintGroups(
  orderOf: Map<string, string[]>,
  arcOf: Map<string, number>,
  lineIds: string[],
): string[][] {
  const lenOf = new Map<string, number>();
  const coLen = new Map<string, number>();
  const edgeIds = [...orderOf.keys()].sort();
  for (const eid of edgeIds) {
    const arc = arcOf.get(eid) ?? 0;
    if (arc <= 0) continue;
    const order = orderOf.get(eid)!;
    for (let i = 0; i < order.length; i++) {
      lenOf.set(order[i], (lenOf.get(order[i]) ?? 0) + arc);
      for (let j = i + 1; j < order.length; j++) {
        const key = order[i] < order[j] ? order[i] + '|' + order[j] : order[j] + '|' + order[i];
        coLen.set(key, (coLen.get(key) ?? 0) + arc);
      }
    }
  }

  // union-find over bundle-mate pairs
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  for (const id of lineIds) parent.set(id, id);
  const pairKeys = [...coLen.keys()].sort();
  for (const key of pairKeys) {
    const i = key.indexOf('|');
    const a = key.slice(0, i);
    const b = key.slice(i + 1);
    if (!parent.has(a) || !parent.has(b)) continue;
    const shorter = Math.min(lenOf.get(a) ?? 0, lenOf.get(b) ?? 0);
    if (shorter <= 0) continue;
    if ((coLen.get(key) ?? 0) / shorter < 0.5) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  const byRoot = new Map<string, string[]>();
  for (const id of lineIds) {
    const r = find(id);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = []));
    g.push(id); // lineIds order preserved within the group
  }
  const groups = [...byRoot.values()];
  const groupArc = (g: string[]): number => g.reduce((s, id) => s + (lenOf.get(id) ?? 0), 0);
  groups.sort((x, y) => {
    const d = groupArc(y) - groupArc(x);
    if (d !== 0) return d;
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0;
  });
  return groups;
}
