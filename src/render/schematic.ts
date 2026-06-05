/**
 * generateSchematicSVG — composes the improved schematic as an SVG string.
 *
 * Layering (bottom to top):
 *   1. Land background (solid rect)
 *   2. Water polygons (with holes for inland islands)
 *   3. Route lines
 *   4. Station markers (optional)
 *   5. Station labels (optional)
 *
 * Returns a self-contained SVG string suitable for innerHTML or file output.
 */

import type { Route, Track } from '../types/game-state';
import type { Coordinate } from '../types/core';
import type {
  WaterCollection,
  StationPoint,
  SchematicOptions,
} from './types';
import { DEFAULT_OPTIONS } from './types';
import { createProjection, computeBounds, padBounds, type Projection } from './projection';
import { extractRouteLines } from './routes';

export interface SchematicInput {
  routes: Route[];
  tracks: Track[];
  /** Precomputed water polygons in geographic coordinates. */
  water?: WaterCollection;
  /** Station points for markers/labels. */
  stations?: StationPoint[];
  options?: Partial<SchematicOptions>;
}

/** Round to 1 decimal place to keep the SVG compact. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Build an SVG path "d" string from a projected polyline. */
function lineToPath(points: Coordinate[], proj: Projection): string {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = proj.toSVG(points[i]);
    d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
  }
  return d.trim();
}

/** Build an SVG path for a polygon (exterior + holes), each ring closed. */
function polygonToPath(rings: Coordinate[][], proj: Projection): string {
  let d = '';
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = proj.toSVG(ring[i]);
      d += (i === 0 ? 'M' : 'L') + r(x) + ' ' + r(y) + ' ';
    }
    d += 'Z ';
  }
  return d.trim();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

export function generateSchematicSVG(input: SchematicInput): string {
  const opts: SchematicOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const theme = { ...DEFAULT_OPTIONS.theme, ...(input.options?.theme ?? {}) };
  const { width, height, padding } = opts;

  const lines = extractRouteLines(input.routes, input.tracks);

  // Frame on the transit network unless explicit bounds were given.
  const bounds =
    opts.bounds ??
    (() => {
      const b = computeBounds(lines);
      return b ? padBounds(b, 0.08) : ([-1, -1, 1, 1] as const);
    })();

  const proj = createProjection(bounds as any, width, height, padding);

  const parts: string[] = [];

  // 1. Land background.
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.land}"/>`);

  // 2. Water polygons.
  if (input.water && input.water.features.length > 0) {
    let waterPaths = '';
    for (const feature of input.water.features) {
      if (feature.geometry.type !== 'Polygon') continue;
      const d = polygonToPath(feature.geometry.coordinates, proj);
      if (d) waterPaths += `<path d="${d}"/>`;
    }
    parts.push(
      `<g fill="${theme.water}" fill-rule="evenodd" stroke="none">${waterPaths}</g>`,
    );
  }

  // 3. Route lines.
  let linePaths = '';
  for (const line of lines) {
    const d = lineToPath(line.points, proj);
    linePaths +=
      `<path d="${d}" fill="none" stroke="${line.color}" ` +
      `stroke-width="${theme.lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  parts.push(`<g>${linePaths}</g>`);

  // 4. Station markers.
  if (opts.showStations && input.stations && input.stations.length > 0) {
    let markers = '';
    for (const st of input.stations) {
      const [x, y] = proj.toSVG(st.coords);
      markers += `<circle cx="${r(x)}" cy="${r(y)}" r="${theme.stationRadius}"/>`;
    }
    parts.push(
      `<g fill="${theme.stationFill}" stroke="${theme.stationStroke}" stroke-width="0.6">${markers}</g>`,
    );
  }

  // 5. Station labels.
  if (opts.showLabels && input.stations && input.stations.length > 0) {
    let labels = '';
    for (const st of input.stations) {
      const [x, y] = proj.toSVG(st.coords);
      labels +=
        `<text x="${r(x + 3)}" y="${r(y - 3)}" font-size="6" ` +
        `font-family="sans-serif" fill="#222">${escapeXml(st.name)}</text>`;
    }
    parts.push(`<g>${labels}</g>`);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}
