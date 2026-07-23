import type { SimplifiedStyle } from './types';
import { simplifiedDefault } from './default';

export type { SimplifiedStyle, SimplifiedScope } from './types';

export const SIMPLIFIED_STYLES: SimplifiedStyle[] = [simplifiedDefault];
export const DEFAULT_SIMPLIFIED_STYLE = 'default';

export function getSimplifiedStyle(id: string | undefined): SimplifiedStyle {
  return SIMPLIFIED_STYLES.find((s) => s.id === id) ?? simplifiedDefault;
}

/** The per-route setting: route id -> style id. Absent means not simplified. */
export type SimplifiedRoutes = Record<string, string>;

/** Per-LINE styles resolved from the per-ROUTE setting.
 *
 *  Routes that share a bullet and an edge set are merged into ONE drawn line, so
 *  a line is simplified only when EVERY route drawn as that line is simplified,
 *  and they all chose the same style. Otherwise a route the user left alone would
 *  silently become a hairline. `canonLineId` is the route -> line map; without it
 *  (older layouts) each route stands as its own line.
 *
 *  Deterministic: routes are visited in sorted id order and the result is keyed
 *  by line id, so the same setting always yields the same map. */
export function resolveSimplifiedLines(
  simplifiedRoutes: SimplifiedRoutes | undefined,
  canonLineId: Map<string, string> | undefined,
  allRouteIds: readonly string[] | undefined,
): Map<string, SimplifiedStyle> {
  const out = new Map<string, SimplifiedStyle>();
  if (!simplifiedRoutes) return out;
  const setIds = Object.keys(simplifiedRoutes).sort();
  if (setIds.length === 0) return out;
  const lineOf = (routeId: string): string => canonLineId?.get(routeId) ?? routeId;

  // Every route drawn as each candidate line, so a partially-simplified merged
  // line can be rejected. Without a route roster, only the routes named in the
  // setting are known, which is the identity case (no merging to detect).
  const routesByLine = new Map<string, string[]>();
  const roster = allRouteIds ? [...allRouteIds].sort() : setIds;
  for (const rid of roster) {
    const lid = lineOf(rid);
    const arr = routesByLine.get(lid);
    if (arr) arr.push(rid);
    else routesByLine.set(lid, [rid]);
  }

  for (const lid of [...routesByLine.keys()].sort()) {
    const rids = routesByLine.get(lid)!;
    const styleIds = rids.map((r) => simplifiedRoutes[r]);
    if (styleIds.some((s) => s === undefined)) continue; // a route here is not simplified
    const first = styleIds[0];
    if (styleIds.some((s) => s !== first)) continue; // mixed styles on one drawn line
    out.set(lid, getSimplifiedStyle(first));
  }
  return out;
}

/** Signature of a resolved line-style map, for memo keys that must invalidate
 *  when the simplification changes. Stable and order-independent. */
export function simplifiedSignature(lines: Map<string, SimplifiedStyle>): string {
  if (lines.size === 0) return '';
  return [...lines.entries()].map(([id, s]) => id + ':' + s.id).sort().join('|');
}
