import type { SimplifiedStyle, SimplifiedSetting, SimplifiedScope, SimplifiedSettingSpec } from './types';
import { simplifiedDefault } from './default';
import { simplifiedDashed } from './dashed';

export type { SimplifiedStyle, SimplifiedScope, SimplifiedSetting, SimplifiedSettingSpec } from './types';

export const SIMPLIFIED_STYLES: SimplifiedStyle[] = [simplifiedDefault, simplifiedDashed];
export const DEFAULT_SIMPLIFIED_STYLE = 'default';

export function getSimplifiedStyle(id: string | undefined): SimplifiedStyle {
  return SIMPLIFIED_STYLES.find((s) => s.id === id) ?? simplifiedDefault;
}

/** The per-route setting: route id -> style id, or style plus tunables. The bare
 *  string is the shorthand for "this style, all defaults", and is also what
 *  earlier saves stored. */
export type SimplifiedRoutes = Record<string, string | SimplifiedSetting>;

/** Normalize either stored form to the object form. */
export function asSetting(v: string | SimplifiedSetting | undefined): SimplifiedSetting | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? { style: v } : v;
}

/** Stroke weight as a PERCENTAGE of normal line width. Every style carries it,
 *  so it is injected rather than restated per style; the style's own
 *  lineWidthScale supplies the default. */
export const LINE_WIDTH_SETTING = 'lineWidthPct';

/** Every setting a style exposes: the universal Line width, then its own. */
export function settingsOf(style: SimplifiedStyle): SimplifiedSettingSpec[] {
  return [
    {
      key: LINE_WIDTH_SETTING,
      label: 'Line width',
      min: 0,
      max: 100,
      step: 5,
      default: Math.round(style.lineWidthScale * 1000) / 10,
      unit: '%',
    },
    ...(style.settings ?? []),
  ];
}

/** A style's settings resolved to concrete numbers: every declared key present,
 *  each clamped to its own range and SNAPPED to its step grid, with
 *  unknown/absent/non-finite falling back to the declared default. Snapping keeps
 *  a hand-edited or float-drifted value from reaching the deterministic render as
 *  fp dust. Unknown stored keys are dropped, so a style that removes a setting
 *  cannot be poisoned by an old save. */
export function paramsFor(style: SimplifiedStyle, raw: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of settingsOf(style)) {
    const v = raw?.[spec.key];
    const clamped = Number.isFinite(v)
      ? Math.min(spec.max, Math.max(spec.min, v as number))
      : spec.default;
    const snapped = spec.step > 0
      ? spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step
      : clamped;
    out[spec.key] = Math.round(snapped * 1e6) / 1e6;
  }
  return out;
}

/** A line's simplified display, fully resolved: the style, its clamped settings,
 *  and the concrete stroke dash pattern (world px) when the style is dashed, so
 *  the draw reads a number instead of interpreting settings. */
export interface ResolvedSimplified {
  style: SimplifiedStyle;
  params: Record<string, number>;
  /** Stroke weight as a FRACTION of normal width, from the Line width setting. */
  widthScale: number;
  dash?: [number, number];
}

function resolve(styleId: string, raw: Record<string, number> | undefined): ResolvedSimplified {
  const style = getSimplifiedStyle(styleId);
  const params = paramsFor(style, raw);
  const d = style.dash;
  const len = d ? params[d.lengthSetting] : undefined;
  return {
    style,
    params,
    widthScale: params[LINE_WIDTH_SETTING] / 100,
    ...(d && Number.isFinite(len) && (len as number) > 0
      ? { dash: [len as number, (len as number) * d.gapRatio] as [number, number] }
      : {}),
  };
}

/** Per-LINE display resolved from the per-ROUTE setting.
 *
 *  Routes that share a bullet and an edge set are merged into ONE drawn line, so
 *  a line is simplified only when EVERY route drawn as that line is simplified,
 *  and they all chose the same style AND the same settings. Otherwise a route the
 *  user left alone would silently become a hairline. `canonLineId` is the
 *  route -> line map; without it (older layouts) each route stands as its own
 *  line.
 *
 *  Deterministic: routes are visited in sorted id order and the result is keyed
 *  by line id, so the same setting always yields the same map. */
export function resolveSimplifiedLines(
  simplifiedRoutes: SimplifiedRoutes | undefined,
  canonLineId: Map<string, string> | undefined,
  allRouteIds: readonly string[] | undefined,
): Map<string, ResolvedSimplified> {
  const out = new Map<string, ResolvedSimplified>();
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
    const settings = rids.map((r) => asSetting(simplifiedRoutes[r]));
    if (settings.some((s) => s === undefined)) continue; // a route here is not simplified
    const first = resolve(settings[0]!.style, settings[0]!.params);
    // Merged routes must agree on the WHOLE display, settings included, or the
    // line has no single answer to draw.
    const same = settings.every((s) => {
      const r = resolve(s!.style, s!.params);
      return r.style.id === first.style.id && JSON.stringify(r.params) === JSON.stringify(first.params);
    });
    if (!same) continue;
    out.set(lid, first);
  }
  return out;
}

/** Signature of the resolved map for memo keys. Encodes only what the memoized
 *  work depends on, namely the per-stop SCOPES: a dash-length tweak must not
 *  invalidate label placements or capsule geometry. Order-independent. */
export function simplifiedSignature(lines: Map<string, ResolvedSimplified>): string {
  if (lines.size === 0) return '';
  return [...lines.entries()]
    .map(([id, r]) => id + ':' + r.style.stationMarks + ':' + r.style.labels)
    .sort()
    .join('|');
}

/** Whether two per-route settings maps mean the same thing (style AND params),
 *  independent of key order and of which stored form was used. */
export function sameSimplified(a: SimplifiedRoutes, b: SimplifiedRoutes): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => {
    const x = asSetting(a[k])!, y = asSetting(b[k])!;
    if (x.style !== y.style) return false;
    const sx = getSimplifiedStyle(x.style);
    return JSON.stringify(paramsFor(sx, x.params)) === JSON.stringify(paramsFor(sx, y.params));
  });
}
