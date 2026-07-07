import type { Glyph, StationDesign, ExampleStation, StopScene } from './types';
import type { Prim } from '../sceneIR';
import { escapeXml } from '../escape';

const alignToAnchor = (a: 'start' | 'middle' | 'end'): string => a;
const alignToCanvas = (a: 'start' | 'middle' | 'end'): CanvasTextAlign => (a === 'middle' ? 'center' : a === 'end' ? 'right' : 'left');

const dataAttrs = (d?: Record<string, string>): string =>
  d ? Object.entries(d).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('') : '';

/** One glyph -> its SVG element string. */
export function glyphToSvg(g: Glyph): string {
  switch (g.kind) {
    case 'circle':
      return `<circle cx="${g.cx.toFixed(1)}" cy="${g.cy.toFixed(1)}" r="${g.r.toFixed(1)}" fill="${escapeXml(g.fill)}" stroke="${escapeXml(g.stroke)}" stroke-width="${g.strokeWidth.toFixed(2)}"${dataAttrs(g.data)}/>`;
    case 'rect':
      return `<rect x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="${g.rx.toFixed(1)}" fill="${escapeXml(g.fill)}" stroke="${escapeXml(g.stroke)}" stroke-width="${g.strokeWidth}"/>`;
    case 'path':
      return `<path d="${g.d}" fill="${g.fill}" stroke="${escapeXml(g.stroke)}" stroke-width="${g.strokeWidth.toFixed(1)}" stroke-linecap="${g.lineCap}" stroke-linejoin="${g.lineJoin}"/>`;
    case 'line':
      return `<line x1="${g.x1.toFixed(1)}" y1="${g.y1.toFixed(1)}" x2="${g.x2.toFixed(1)}" y2="${g.y2.toFixed(1)}" stroke="${escapeXml(g.stroke)}" stroke-width="${g.strokeWidth.toFixed(1)}"/>`;
    case 'text':
      return `<text x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" text-anchor="${alignToAnchor(g.align)}" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif" font-size="${g.fontSize.toFixed(2)}" font-weight="${g.fontWeight}" fill="${escapeXml(g.fill)}">${escapeXml(g.text)}</text>`;
  }
}

export function glyphsToSvg(gs: Glyph[]): string {
  return gs.map(glyphToSvg).join('');
}

// Round each numeric field to the SAME precision glyphToSvg writes, so the
// direct-emit prim equals what sceneFromSvg parses back from the string (the
// canvas path and the SVG/export path stay in agreement). The former stops.ts
// rounded its prims for exactly this reason.
const r1 = (n: number): number => +n.toFixed(1);
const r2 = (n: number): number => +n.toFixed(2);

/** One glyph -> the sceneIR Prim (stops layer, world-scaled). */
export function glyphToPrim(g: Glyph): Prim {
  const base = { layer: 'stops' as const, worldScale: true };
  switch (g.kind) {
    case 'circle':
      return { kind: 'circle', cx: r1(g.cx), cy: r1(g.cy), r: r1(g.r), fill: g.fill, stroke: g.stroke, strokeWidth: r2(g.strokeWidth), ...base };
    case 'rect':
      return { kind: 'rect', x: r1(g.x), y: r1(g.y), w: r1(g.w), h: r1(g.h), rx: r1(g.rx), fill: g.fill, stroke: g.stroke, strokeWidth: g.strokeWidth, ...base };
    case 'path':
      return { kind: 'path', d: g.d, fill: g.fill, stroke: g.stroke, strokeWidth: r1(g.strokeWidth), lineCap: g.lineCap, lineJoin: g.lineJoin, ...base };
    case 'line':
      return { kind: 'line', x1: r1(g.x1), y1: r1(g.y1), x2: r1(g.x2), y2: r1(g.y2), stroke: g.stroke, strokeWidth: r1(g.strokeWidth), ...base };
    case 'text':
      return { kind: 'text', text: g.text, x: r1(g.x), y: r1(g.y), ax: 0, ay: 0, fontSize: r2(g.fontSize), fontWeight: g.fontWeight, align: alignToCanvas(g.align), fill: g.fill, ...base };
  }
}

export function glyphsToPrims(gs: Glyph[]): Prim[] {
  return gs.map(glyphToPrim);
}

/** Anchored group the pipeline wraps each station's glyphs in, matching the
 *  markup sceneFromSvg + the panel expect (class imp-stop for world-scaling;
 *  data-stops/data-station-id for identity). No transform (anchor via data-*). */
export function wrapMarker(anchor: [number, number], nodeId: string, lineIds: string[], inner: string): string {
  return (
    `<g class="imp-stop" data-ax="${anchor[0].toFixed(1)}" data-ay="${anchor[1].toFixed(1)}">` +
    `<g data-stops="${escapeXml(lineIds.join(','))}" data-station-id="${escapeXml(nodeId)}">` +
    inner +
    `</g></g>`
  );
}

// ---- previews: same paint(), synthetic scene, standalone svg -----------------

function syntheticSingle(ex: ExampleStation): StopScene {
  return {
    nodeId: 'preview',
    lines: [{ lineId: 'L', color: ex.color, bullet: ex.bullet, textColor: ex.textColor, pos: [22, 22], chain: 0, seq: 1 }],
    capsule: { kind: 'none' },
    anchor: [22, 22],
    dotRadius: 12,
  };
}

function syntheticInterchange(ex: ExampleStation): StopScene {
  const second = ex.bullet === 'B' ? 'C' : 'B';
  return {
    nodeId: 'preview',
    lines: [
      { lineId: 'L1', color: ex.color, bullet: ex.bullet, textColor: ex.textColor, pos: [12, 22], chain: 0, seq: 1 },
      { lineId: 'L2', color: ex.color, bullet: second, textColor: ex.textColor, pos: [32, 22], chain: 1, seq: 2 },
    ],
    capsule: { kind: 'pill', points: [[12, 22], [32, 22]], smooth: false },
    anchor: [22, 22],
    dotRadius: 6,
  };
}

/** Standalone, resizable preview SVG for a design + example route. */
export function previewSvg(design: StationDesign, ex: ExampleStation, dark: boolean): string {
  const scene = design.previewKind === 'interchange' ? syntheticInterchange(ex) : syntheticSingle(ex);
  const glyphs = design.paint(scene, { dark, showBullets: true });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">${glyphsToSvg(glyphs)}</svg>`;
}
