# Station marker render surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-style `if/else` in `render/stops.ts` and the hand-written per-design preview SVGs with a pluggable station-marker surface: one `paint(scene) → Glyph[]` per design, serialized to the map SVG, the canvas `Prim[]`, and the preview from a single draw list.

**Architecture:** A new `src/render/stations/` folder. `placement.ts` computes design-agnostic geometry (`StopScene`: dot data + capsule shape). Each design paints that scene into a `Glyph[]` draw list using shared `primitives.ts`. `serialize.ts` turns one draw list into SVG (`glyphsToSvg`, wrapped in the `imp-stop` group), canvas prims (`glyphsToPrims`), and previews (`previewSvg`). `renderOctilinear.paintRibbons` calls `renderStations`. `stops.ts` and `stationDesigns.ts` are deleted.

**Tech Stack:** TypeScript, React (mod UI), Node built-in test runner (`tsx --test`), Vite/esbuild. Reference spec: `docs/superpowers/specs/2026-07-06-station-marker-surface-design.md`.

**Project rules that bind this work:**
- Tests are the gate: `npm test` (= `tsx --test "src/**/*.test.ts"`). `tsc` is NOT the gate.
- Byte-identity is NOT required for this feature (waived); visually-equivalent output + green tests are the bar. The generated SVG must stay parseable by `sceneFromSvg`.
- Do NOT commit. Leave all changes in the working tree.
- Do NOT run `npm run build` (its postbuild installs into the game). Verify compilation with `npx vite build`.
- No `Date.now()` / `Math.random()` anywhere in these modules (deterministic pipeline).

**Build order rationale:** new modules are created first and coexist with the old `stops.ts`/`stationDesigns.ts` (different files, no conflict). The pipeline and panel are rewired in Task 7-8, and only then are the old files deleted, so the suite stays green throughout.

---

### Task 1: `stations/types.ts`

**Files:**
- Create: `src/render/stations/types.ts`

- [ ] **Step 1: Create the types module**

```ts
/**
 * Station design surface types. A design is one pure function
 * paint(scene, ctx) -> Glyph[]; the same draw list drives the map SVG, the
 * canvas Prim scene, and the picker preview. Placement (design-agnostic
 * geometry) produces StopScene; designs only decide appearance.
 */

export type Point = [number, number];

/** One stopping line at a station. */
export interface StopLine {
  lineId: string;
  color: string;      // route color (hex)
  bullet: string;     // route bullet text (may be '')
  textColor: string;  // route text color (hex), or '' when the route has none
  pos: Point;         // solved dot center, world px
  chain: number;      // order within the capsule spine
}

/** Design-agnostic capsule (interchange) geometry, from placement. */
export type Capsule =
  | { kind: 'none' }
  | { kind: 'pill'; points: Point[]; smooth: boolean }
  | { kind: 'box'; x: number; y: number; w: number; h: number; rx: number }
  | { kind: 'ring'; cx: number; cy: number; r: number };

/** Everything a design needs to paint one station. `lines` is the set of dots
 *  to draw (empty for an opaque mega box). */
export interface StopScene {
  nodeId: string;
  lines: StopLine[];
  capsule: Capsule;
  anchor: Point;     // marker anchor (imp-stop group / label)
  dotRadius: number; // solved dot radius (full, or capsule-shrunk)
}

/** Theme + toggles handed to every paint(). */
export interface PaintCtx {
  dark: boolean;
  showBullets: boolean; // stations toggle; when false, omit bullet text glyphs
}

/** Design-level, backend-agnostic marker vocabulary. No layer/worldScale —
 *  serialize.ts adds those. */
export type Glyph =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number; fill: string; stroke: string; strokeWidth: number }
  | { kind: 'path'; d: string; fill: string; stroke: string; strokeWidth: number; lineCap: 'round' | 'butt' | 'square'; lineJoin: 'round' | 'miter' | 'bevel' }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { kind: 'text'; x: number; y: number; text: string; fontSize: number; fontWeight: string; fill: string; align: 'start' | 'middle' | 'end' };

export interface ExampleStation { bullet: string; color: string; textColor: string }

export interface StationDesign {
  id: string;
  name: string;
  blurb?: string;
  /** Paint one station into a draw list (capsule glyphs first, dots/bullets
   *  after, so dots render on top). Pure. */
  paint: (scene: StopScene, ctx: PaintCtx) => Glyph[];
  /** What the preview tile depicts. 'single' (default) = one dot; 'interchange'
   *  = a two-line station so a capsule-distinct design shows its capsule. */
  previewKind?: 'single' | 'interchange';
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx vite build 2>&1 | tail -2`
Expected: build succeeds (no importer yet; this confirms the file parses). Do NOT commit.

---

### Task 2: `stations/primitives.ts` + tests

**Files:**
- Create: `src/render/stations/primitives.ts`
- Test: `src/render/stations/tests/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastInk, bulletFontSize, dotStrokeWidth, capsuleStrokeWidths, capsuleGlyphs, circle, bullet } from '../primitives';

test('contrastInk picks readable ink by luminance', () => {
  assert.equal(contrastInk('#000000'), '#ffffff');
  assert.equal(contrastInk('#ffffff'), '#111111');
  assert.equal(contrastInk('#fccc0a'), '#111111');
});

test('bulletFontSize shrinks for multi-char names', () => {
  assert.equal(bulletFontSize(10, 'A'), 17);
  assert.ok(bulletFontSize(10, 'ABC') < 17);
});

test('circle carries optional data attrs', () => {
  const g = circle(1, 2, 3, { fill: '#fff', stroke: '#000', strokeWidth: 1.5, data: { 'data-line': 'L1' } });
  assert.equal(g.kind, 'circle');
  assert.deepEqual(g.data, { 'data-line': 'L1' });
});

test('bullet places text below the dot center', () => {
  const g = bullet(10, 20, 'A', 13, '#111111');
  assert.equal(g.kind, 'text');
  assert.equal(g.text, 'A');
  assert.ok((g as { y: number }).y > 20); // fs*0.36 offset
});

test('capsuleGlyphs: box -> one rect, ring -> one circle, pill -> two paths', () => {
  const box = capsuleGlyphs({ kind: 'box', x: 0, y: 0, w: 10, h: 10, rx: 2 }, { border: '#111111', fill: '#ffffff' }, 3);
  assert.equal(box.length, 1);
  assert.equal(box[0].kind, 'rect');
  const ring = capsuleGlyphs({ kind: 'ring', cx: 5, cy: 5, r: 6 }, { border: '#111111', fill: '#ffffff' }, 3);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].kind, 'circle');
  const pill = capsuleGlyphs({ kind: 'pill', points: [[0, 0], [10, 0]], smooth: false }, { border: '#111111', fill: '#ffffff' }, 3);
  assert.equal(pill.length, 2);
  assert.equal(pill[0].kind, 'path');
  assert.equal((pill[0] as { stroke: string }).stroke, '#111111'); // border first
  assert.equal((pill[1] as { stroke: string }).stroke, '#ffffff'); // fill second
  const w = capsuleStrokeWidths(3);
  assert.ok(w.border > w.fill);
});

test('capsuleGlyphs none -> empty', () => {
  assert.deepEqual(capsuleGlyphs({ kind: 'none' }, { border: '#000', fill: '#fff' }, 3), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/stations/tests/primitives.test.ts`
Expected: FAIL — cannot find module `../primitives`.

- [ ] **Step 3: Create the module**

```ts
import { LINE_WIDTH, MARKER_SCALE } from '../constants';
import type { Glyph, Capsule, Point } from './types';

const R0 = LINE_WIDTH * 0.7; // base dot radius (matches the solver)

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Readable bullet ink (near-black or white) for text on a solid fill. */
export function contrastInk(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111111' : '#ffffff';
}

/** Bullet font size for a dot of radius r and label name (matches the classic
 *  marker's sizing: full at 1 char, shrinking for longer bullets). */
export function bulletFontSize(r: number, name: string): number {
  return name.length <= 1 ? r * 1.7 : Math.min(r * 1.7, (2 * r * 0.92) / (0.6 * name.length));
}

/** Ring/outline stroke width for a dot, proportional to its radius. */
export function dotStrokeWidth(dotRadius: number): number {
  return 1.5 * (dotRadius / R0);
}

/** Border/fill stroke widths for a pill capsule so it hugs its dots. */
export function capsuleStrokeWidths(dotRadius: number): { border: number; fill: number } {
  return { border: 2 * dotRadius + 6 * MARKER_SCALE, fill: 2 * dotRadius + 3 * MARKER_SCALE };
}

export function circle(cx: number, cy: number, r: number, o: { fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }): Glyph {
  return { kind: 'circle', cx, cy, r, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth, ...(o.data ? { data: o.data } : {}) };
}

export function rect(x: number, y: number, w: number, h: number, rx: number, o: { fill: string; stroke: string; strokeWidth: number }): Glyph {
  return { kind: 'rect', x, y, w, h, rx, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth };
}

export function line(x1: number, y1: number, x2: number, y2: number, o: { stroke: string; strokeWidth: number }): Glyph {
  return { kind: 'line', x1, y1, x2, y2, stroke: o.stroke, strokeWidth: o.strokeWidth };
}

export function text(x: number, y: number, s: string, o: { fontSize: number; fill: string; fontWeight?: string; align?: 'start' | 'middle' | 'end' }): Glyph {
  return { kind: 'text', x, y, text: s, fontSize: o.fontSize, fontWeight: o.fontWeight ?? 'bold', align: o.align ?? 'middle', fill: o.fill };
}

/** Route-bullet text centered in a dot, offset like the classic marker. */
export function bullet(cx: number, cy: number, name: string, r: number, fill: string): Glyph {
  const fs = bulletFontSize(r, name);
  return text(cx, +(cy + fs * 0.36).toFixed(1), name, { fontSize: +fs.toFixed(2), fill });
}

const f1 = (n: number): string => n.toFixed(1);

/** Path `d` through a spine: a straight RDP polyline, or a smooth Catmull-Rom
 *  bezier (clamped endpoints) when `smooth`. */
export function pillPath(points: Point[], smooth: boolean): string {
  if (points.length === 0) return '';
  if (!smooth) return 'M ' + points.map((p) => f1(p[0]) + ' ' + f1(p[1])).join(' L ');
  let d = 'M ' + f1(points[0][0]) + ' ' + f1(points[0][1]);
  if (points.length === 1) return d + ' L ' + f1(points[0][0]) + ' ' + f1(points[0][1]);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1], p1 = points[i], p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ' C ' + f1(c1x) + ' ' + f1(c1y) + ' ' + f1(c2x) + ' ' + f1(c2y) + ' ' + f1(p2[0]) + ' ' + f1(p2[1]);
  }
  return d;
}

/** Paint a computed capsule geometry with the design's chosen border/fill:
 *  box -> filled+stroked rect; ring -> filled+stroked circle; pill -> two
 *  stroked open paths (wide border, then narrow fill). */
export function capsuleGlyphs(capsule: Capsule, colors: { border: string; fill: string }, dotRadius: number): Glyph[] {
  if (capsule.kind === 'none') return [];
  if (capsule.kind === 'box') return [rect(capsule.x, capsule.y, capsule.w, capsule.h, capsule.rx, { fill: colors.fill, stroke: colors.border, strokeWidth: 3 })];
  if (capsule.kind === 'ring') return [circle(capsule.cx, capsule.cy, capsule.r, { fill: colors.fill, stroke: colors.border, strokeWidth: 1.5 })];
  const w = capsuleStrokeWidths(dotRadius);
  const d = pillPath(capsule.points, capsule.smooth);
  const p = (stroke: string, sw: number): Glyph => ({ kind: 'path', d, fill: 'none', stroke, strokeWidth: +sw.toFixed(1), lineCap: 'round', lineJoin: 'round' });
  return [p(colors.border, w.border), p(colors.fill, w.fill)];
}

// eslint hint: HEX kept for potential color validation by designs.
void HEX;
```

Note: drop the `void HEX;` line and the `HEX` const if no design needs color validation (they take pre-sanitized colors). Keep the module free of unused exports.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/render/stations/tests/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all pass. Do NOT commit.

---

### Task 3: `stations/serialize.ts` + tests

**Files:**
- Create: `src/render/stations/serialize.ts`
- Test: `src/render/stations/tests/serialize.test.ts`

Behavioral facts to preserve (verified against `sceneFromSvg.ts`): markers must sit inside `<g class="imp-stop" ...>` (gives `worldScale=true`, `layer='stops'`); the parser reads `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `font-size`, `font-weight`, `text-anchor`, `fill`; text prims get `ax=ay=0` (no `transform` on the group). `glyphsToPrims` must stamp `layer:'stops'`, `worldScale:true` so the direct-emit scene and the parse fallback agree.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphsToSvg, glyphsToPrims, wrapMarker } from '../serialize';
import { sceneFromSvg } from '../../sceneFromSvg';
import type { Glyph } from '../types';

const sample: Glyph[] = [
  { kind: 'circle', cx: 10, cy: 10, r: 3, fill: '#ffffff', stroke: '#dc2626', strokeWidth: 1.5, data: { 'data-line': 'L1' } },
  { kind: 'text', x: 10, y: 12, text: 'A', fontSize: 5, fontWeight: 'bold', fill: '#111111', align: 'middle' },
];

test('glyphsToSvg emits circle + text with data-line and text-anchor', () => {
  const svg = glyphsToSvg(sample);
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('data-line="L1"'));
  assert.ok(svg.includes('fill="#dc2626"'));
  assert.ok(svg.includes('text-anchor="middle"'));
  assert.ok(svg.includes('>A</text>'));
});

test('glyphsToPrims stamps stops layer + worldScale', () => {
  const prims = glyphsToPrims(sample);
  assert.equal(prims.length, 2);
  for (const p of prims) { assert.equal(p.layer, 'stops'); assert.equal(p.worldScale, true); }
  const t = prims.find((p) => p.kind === 'text') as { ax: number; ay: number; align: string };
  assert.equal(t.ax, 0); assert.equal(t.ay, 0); assert.equal(t.align, 'center');
});

test('wrapMarker output parses back to matching stops prims via sceneFromSvg', () => {
  const svg = '<svg viewBox="0 0 100 100">' + wrapMarker([10, 10], 'n1', ['L1'], glyphsToSvg(sample)) + '</svg>';
  const scene = sceneFromSvg(svg);
  const emitted = glyphsToPrims(sample);
  const circleP = scene.prims.find((p) => p.kind === 'circle') as { fill: string; stroke: string; strokeWidth: number; worldScale: boolean; layer: string };
  assert.equal(circleP.fill, '#ffffff');
  assert.equal(circleP.stroke, '#dc2626');
  assert.equal(circleP.worldScale, true);
  assert.equal(circleP.layer, 'stops');
  const parsedText = scene.prims.find((p) => p.kind === 'text') as { text: string; align: string };
  const emittedText = emitted.find((p) => p.kind === 'text') as { text: string; align: string };
  assert.equal(parsedText.text, emittedText.text);
  assert.equal(parsedText.align, emittedText.align);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/stations/tests/serialize.test.ts`
Expected: FAIL — cannot find module `../serialize`.

- [ ] **Step 3: Create the module**

```ts
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

/** One glyph -> the sceneIR Prim (stops layer, world-scaled). */
export function glyphToPrim(g: Glyph): Prim {
  const base = { layer: 'stops' as const, worldScale: true };
  switch (g.kind) {
    case 'circle':
      return { kind: 'circle', cx: g.cx, cy: g.cy, r: g.r, fill: g.fill, stroke: g.stroke, strokeWidth: g.strokeWidth, ...base };
    case 'rect':
      return { kind: 'rect', x: g.x, y: g.y, w: g.w, h: g.h, rx: g.rx, fill: g.fill, stroke: g.stroke, strokeWidth: g.strokeWidth, ...base };
    case 'path':
      return { kind: 'path', d: g.d, fill: g.fill, stroke: g.stroke, strokeWidth: g.strokeWidth, lineCap: g.lineCap, lineJoin: g.lineJoin, ...base };
    case 'line':
      return { kind: 'line', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, stroke: g.stroke, strokeWidth: g.strokeWidth, ...base };
    case 'text':
      return { kind: 'text', text: g.text, x: g.x, y: g.y, ax: 0, ay: 0, fontSize: g.fontSize, fontWeight: g.fontWeight, align: alignToCanvas(g.align), fill: g.fill, ...base };
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
    lines: [{ lineId: 'L', color: ex.color, bullet: ex.bullet, textColor: ex.textColor, pos: [22, 22], chain: 0 }],
    capsule: { kind: 'none' },
    anchor: [22, 22],
    dotRadius: 14,
  };
}

function syntheticInterchange(ex: ExampleStation): StopScene {
  const second = ex.bullet === 'B' ? 'C' : 'B';
  return {
    nodeId: 'preview',
    lines: [
      { lineId: 'L1', color: ex.color, bullet: ex.bullet, textColor: ex.textColor, pos: [14, 22], chain: 0 },
      { lineId: 'L2', color: ex.color, bullet: second, textColor: ex.textColor, pos: [30, 22], chain: 1 },
    ],
    capsule: { kind: 'pill', points: [[14, 22], [30, 22]], smooth: false },
    anchor: [22, 22],
    dotRadius: 7,
  };
}

/** Standalone, resizable preview SVG for a design + example route. */
export function previewSvg(design: StationDesign, ex: ExampleStation, dark: boolean): string {
  const scene = design.previewKind === 'interchange' ? syntheticInterchange(ex) : syntheticSingle(ex);
  const glyphs = design.paint(scene, { dark, showBullets: true });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">${glyphsToSvg(glyphs)}</svg>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/render/stations/tests/serialize.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`  → all pass. Do NOT commit.

---

### Task 4: `stations/placement.ts` + tests

**Files:**
- Create: `src/render/stations/placement.ts`
- Test: `src/render/stations/tests/placement.test.ts`

This ports the geometry currently in `render/stops.ts` (single / coincident-ring / mega-box / mega-curve / spine) into a design-agnostic `buildScene`, with NO painting.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from '../placement';
import type { StopMark, Pixel } from '../../layout/types';

const ctx = { megaFallback: 'curve' as const };
const mk = (lineId: string, x: number, y: number, extra: Partial<StopMark> = {}): StopMark => ({ lineId, color: '#dc2626', pos: [x, y] as Pixel, name: lineId, ...extra });

test('single mark -> capsule none, lines has one dot', () => {
  const s = buildScene('n1', [mk('A', 5, 5)], ctx);
  assert.equal(s.capsule.kind, 'none');
  assert.equal(s.lines.length, 1);
  assert.deepEqual(s.anchor, [5, 5]);
});

test('two spread marks -> pill (straight), dots kept', () => {
  const s = buildScene('n1', [mk('A', 0, 0, { chain: 0 }), mk('B', 20, 0, { chain: 1 })], ctx);
  assert.equal(s.capsule.kind, 'pill');
  assert.equal((s.capsule as { smooth: boolean }).smooth, false);
  assert.equal(s.lines.length, 2);
});

test('coincident marks -> ring', () => {
  const s = buildScene('n1', [mk('A', 5, 5), mk('B', 5, 5)], ctx);
  assert.equal(s.capsule.kind, 'ring');
});

test('mega marks with megaFallback box -> box, no dots', () => {
  const marks = [mk('A', 0, 0, { mega: true }), mk('B', 12, 4, { mega: true }), mk('C', 4, 12, { mega: true })];
  const s = buildScene('n1', marks, { megaFallback: 'box' });
  assert.equal(s.capsule.kind, 'box');
  assert.equal(s.lines.length, 0);
});

test('mega marks with megaFallback curve -> smooth pill, dots kept', () => {
  const marks = [mk('A', 0, 0, { mega: true }), mk('B', 12, 4, { mega: true }), mk('C', 4, 12, { mega: true })];
  const s = buildScene('n1', marks, { megaFallback: 'curve' });
  assert.equal(s.capsule.kind, 'pill');
  assert.equal((s.capsule as { smooth: boolean }).smooth, true);
  assert.equal(s.lines.length, 3);
});

test('StopLine carries color/bullet/textColor from the mark', () => {
  const s = buildScene('n1', [mk('A', 5, 5, { textColor: '#00ff00' })], ctx);
  assert.equal(s.lines[0].color, '#dc2626');
  assert.equal(s.lines[0].bullet, 'A');
  assert.equal(s.lines[0].textColor, '#00ff00');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/stations/tests/placement.test.ts`
Expected: FAIL — cannot find module `../placement`.

- [ ] **Step 3: Create the module** (port from `render/stops.ts`; the source is still present — read it to cross-check the exact expressions)

```ts
/**
 * Placement: design-agnostic station geometry. Given the solved marks for a
 * node, produce a StopScene (dot data + capsule shape). No colors, no painting.
 * Ported from the geometry half of the former render/stops.ts.
 */

import type { Pixel, StopMark } from '../layout/types';
import { LINE_WIDTH, LINE_GAP, MEGA_BOXES, MARKER_SCALE } from '../constants';
import { rdpSimplify } from '../layout/chainPlace';
import { debugMegaBox } from '../debug/stops.debug';
import type { StopScene, StopLine, Capsule, Point } from './types';

const R0 = LINE_WIDTH * 0.7;
const RCAP = R0 * MARKER_SCALE;
const SPACING = LINE_WIDTH + LINE_GAP;

export interface PlacementCtx {
  megaFallback: 'box' | 'curve';
  members?: Map<string, number>;
  deg?: Map<string, number>;
}

const toLine = (mk: StopMark): StopLine => ({
  lineId: mk.lineId,
  color: mk.color,
  bullet: mk.name ?? '',
  textColor: mk.textColor ?? '',
  pos: [mk.pos[0], mk.pos[1]],
  chain: mk.chain ?? 0,
});

const median = (vals: number[]): number => {
  const s = vals.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function buildScene(nodeId: string, marks: StopMark[], ctx: PlacementCtx): StopScene {
  const isCapsule = marks.length > 1;
  const dotRadius = isCapsule ? RCAP : R0;
  const lines = marks.map(toLine);

  // farthest pair: axis start (a) + max separation (best)
  let ai = 0;
  let best = 0;
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const d = Math.sqrt((marks[i].pos[0] - marks[j].pos[0]) ** 2 + (marks[i].pos[1] - marks[j].pos[1]) ** 2);
      if (d > best) { best = d; ai = i; }
    }
  }
  const a = marks[ai].pos;

  if (!isCapsule) {
    return { nodeId, lines, capsule: { kind: 'none' }, anchor: [a[0], a[1]], dotRadius };
  }

  const members = ctx.members?.get(nodeId);
  const megaEligible = members !== undefined ? members > 1 : marks.length > 1;
  const isMega = marks.some((m) => m.mega) || (MEGA_BOXES && megaEligible && (ctx.deg?.get(nodeId) ?? 0) >= 12);

  if (isMega) {
    const pad = R0 + 7;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const mk of marks) {
      x0 = Math.min(x0, mk.pos[0]); y0 = Math.min(y0, mk.pos[1]);
      x1 = Math.max(x1, mk.pos[0]); y1 = Math.max(y1, mk.pos[1]);
    }
    const cap = Math.max(2 * R0, marks.length * SPACING * 1.5);
    const mx = median(marks.map((m) => m.pos[0]));
    const my = median(marks.map((m) => m.pos[1]));
    x0 = Math.max(x0, mx - cap / 2); x1 = Math.min(x1, mx + cap / 2);
    y0 = Math.max(y0, my - cap / 2); y1 = Math.min(y1, my + cap / 2);
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const minSide = 2 * R0 + 3;
    if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
    if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
    debugMegaBox(nodeId, marks, x0, y0, x1, y1);

    if (ctx.megaFallback === 'curve') {
      let pi = 0, pj = 0, pbest = -1;
      for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
        const dx = marks[i].pos[0] - marks[j].pos[0], dy = marks[i].pos[1] - marks[j].pos[1];
        const dd = dx * dx + dy * dy;
        if (dd > pbest) { pbest = dd; pi = i; pj = j; }
      }
      const A = marks[pi].pos, B = marks[pj].pos;
      let axx = B[0] - A[0], axy = B[1] - A[1];
      const alen = Math.sqrt(axx * axx + axy * axy) || 1;
      axx /= alen; axy /= alen;
      const orderedPos = marks
        .map((m, i) => ({ p: m.pos as Point, t: (m.pos[0] - A[0]) * axx + (m.pos[1] - A[1]) * axy, i }))
        .sort((u, v) => (u.t - v.t) || (u.i - v.i))
        .map((u) => u.p);
      const spine = rdpSimplify(orderedPos, 0.75) as Point[];
      const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
      const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
      return { nodeId, lines, capsule: { kind: 'pill', points: spine, smooth: true }, anchor: [cx, cy], dotRadius };
    }
    // box: opaque cover, no per-line dots
    return { nodeId, lines: [], capsule: { kind: 'box', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: R0 + 1.5 }, anchor: [(x0 + x1) / 2, (y0 + y1) / 2], dotRadius };
  }

  if (best < 1e-3) {
    return { nodeId, lines, capsule: { kind: 'ring', cx: a[0], cy: a[1], r: R0 + 3 }, anchor: [a[0], a[1]], dotRadius };
  }

  const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
  const vertices: Pixel[] = [];
  for (const mk of ordered) {
    vertices.push(mk.pos);
    if (mk.cornerAfter) vertices.push(mk.cornerAfter);
  }
  const spine = rdpSimplify(vertices, 0.75) as Point[];
  const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
  const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
  return { nodeId, lines, capsule: { kind: 'pill', points: spine, smooth: false }, anchor: [cx, cy], dotRadius };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/render/stations/tests/placement.test.ts`  → PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`  → all pass. Do NOT commit.

---

### Task 5: the three designs + tests

**Files:**
- Create: `src/render/stations/classic.ts`, `src/render/stations/nycSolid.ts`, `src/render/stations/nycMap.ts`
- Test: `src/render/stations/tests/designs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classic } from '../classic';
import { nycSolid } from '../nycSolid';
import { nycMap } from '../nycMap';
import type { StopScene } from '../types';

const single = (color = '#dc2626', textColor = ''): StopScene => ({
  nodeId: 'n', lines: [{ lineId: 'L', color, bullet: 'A', textColor, pos: [10, 10], chain: 0 }], capsule: { kind: 'none' }, anchor: [10, 10], dotRadius: 13,
});
const pair = (): StopScene => ({
  nodeId: 'n', lines: [ { lineId: 'L1', color: '#dc2626', bullet: 'A', textColor: '', pos: [0, 0], chain: 0 }, { lineId: 'L2', color: '#0000ff', bullet: 'B', textColor: '', pos: [20, 0], chain: 1 } ], capsule: { kind: 'pill', points: [[0, 0], [20, 0]], smooth: false }, anchor: [10, 0], dotRadius: 9,
});
const ctx = { dark: false, showBullets: true };
const circleOf = (gs: ReturnType<typeof classic.paint>) => gs.find((g) => g.kind === 'circle') as { fill: string; stroke: string };
const textOf = (gs: ReturnType<typeof classic.paint>) => gs.find((g) => g.kind === 'text') as { fill: string };

test('classic: hollow disc (bg fill, line-color ring), ink bullet', () => {
  const gs = classic.paint(single(), ctx);
  assert.equal(circleOf(gs).fill, '#ffffff');
  assert.equal(circleOf(gs).stroke, '#dc2626');
  assert.equal(textOf(gs).fill, '#111111');
});

test('nycSolid: disc filled in line color; bullet uses textColor then contrast', () => {
  assert.equal(circleOf(nycSolid.paint(single('#dc2626', '#00ff00'), ctx)).fill, '#dc2626');
  assert.equal(textOf(nycSolid.paint(single('#dc2626', '#00ff00'), ctx)).fill, '#00ff00');
  assert.equal(textOf(nycSolid.paint(single('#000080', ''), ctx)).fill, '#ffffff'); // contrast fallback
});

test('nycMap: fixed black dot + white bullet in BOTH themes', () => {
  for (const dark of [false, true]) {
    const gs = nycMap.paint(single(), { dark, showBullets: true });
    assert.equal(circleOf(gs).fill, '#111111');
    assert.equal(textOf(gs).fill, '#ffffff');
  }
});

test('nycMap capsule: fixed white pill / black border in BOTH themes; previewKind interchange', () => {
  assert.equal(nycMap.previewKind, 'interchange');
  for (const dark of [false, true]) {
    const gs = nycMap.paint(pair(), { dark, showBullets: true });
    const paths = gs.filter((g) => g.kind === 'path') as Array<{ stroke: string }>;
    assert.equal(paths[0].stroke, '#111111'); // border
    assert.equal(paths[1].stroke, '#ffffff'); // fill
  }
});

test('showBullets false omits bullet text', () => {
  const gs = classic.paint(single(), { dark: false, showBullets: false });
  assert.ok(!gs.some((g) => g.kind === 'text'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/stations/tests/designs.test.ts`
Expected: FAIL — cannot find module `../classic`.

- [ ] **Step 3: Create `classic.ts`**

```ts
import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, bullet, capsuleGlyphs, dotStrokeWidth } from './primitives';

function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const bg = ctx.dark ? '#18181b' : '#ffffff';
  const ink = ctx.dark ? '#e4e4e7' : '#111111';
  const nameFill = ctx.dark ? '#ffffff' : '#111111';
  const sw = dotStrokeWidth(scene.dotRadius);
  const g: Glyph[] = capsuleGlyphs(scene.capsule, { border: ink, fill: bg }, scene.dotRadius);
  for (const ln of scene.lines) {
    g.push(circle(ln.pos[0], ln.pos[1], scene.dotRadius, { fill: bg, stroke: ln.color, strokeWidth: sw, data: { 'data-line': ln.lineId } }));
    if (ctx.showBullets && ln.bullet) g.push(bullet(ln.pos[0], ln.pos[1], ln.bullet, scene.dotRadius, nameFill));
  }
  return g;
}

export const classic: StationDesign = { id: 'classic', name: 'Classic', paint };
```

- [ ] **Step 4: Create `nycSolid.ts`**

```ts
import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, bullet, capsuleGlyphs, dotStrokeWidth, contrastInk } from './primitives';

function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const bg = ctx.dark ? '#18181b' : '#ffffff';
  const ink = ctx.dark ? '#e4e4e7' : '#111111';
  const sw = dotStrokeWidth(scene.dotRadius);
  const g: Glyph[] = capsuleGlyphs(scene.capsule, { border: ink, fill: bg }, scene.dotRadius);
  for (const ln of scene.lines) {
    g.push(circle(ln.pos[0], ln.pos[1], scene.dotRadius, { fill: ln.color, stroke: ln.color, strokeWidth: sw, data: { 'data-line': ln.lineId } }));
    if (ctx.showBullets && ln.bullet) g.push(bullet(ln.pos[0], ln.pos[1], ln.bullet, scene.dotRadius, ln.textColor || contrastInk(ln.color)));
  }
  return g;
}

export const nycSolid: StationDesign = { id: 'nyc-solid', name: 'NYC-Solid', paint };
```

- [ ] **Step 5: Create `nycMap.ts`**

```ts
import type { StationDesign, StopScene, PaintCtx, Glyph } from './types';
import { circle, bullet, capsuleGlyphs, dotStrokeWidth } from './primitives';

// Fixed "paper map" palette: black ink on white paper in BOTH themes.
const INK = '#111111';
const PAPER = '#ffffff';

function paint(scene: StopScene, ctx: PaintCtx): Glyph[] {
  const sw = dotStrokeWidth(scene.dotRadius);
  // Capsule is the OPPOSITE of the dot: a white pill with a black border, so the
  // black dots read on top. Fixed in both themes.
  const g: Glyph[] = capsuleGlyphs(scene.capsule, { border: INK, fill: PAPER }, scene.dotRadius);
  for (const ln of scene.lines) {
    g.push(circle(ln.pos[0], ln.pos[1], scene.dotRadius, { fill: INK, stroke: INK, strokeWidth: sw, data: { 'data-line': ln.lineId } }));
    if (ctx.showBullets && ln.bullet) g.push(bullet(ln.pos[0], ln.pos[1], ln.bullet, scene.dotRadius, PAPER));
  }
  return g;
}

export const nycMap: StationDesign = { id: 'nyc-map', name: 'NYC-Map', paint, previewKind: 'interchange' };
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx tsx --test src/render/stations/tests/designs.test.ts`  → PASS.

- [ ] **Step 7: Full suite**

Run: `npm test`  → all pass. Do NOT commit.

---

### Task 6: `stations/index.ts` (registry) + `stations/render.ts` + tests

**Files:**
- Create: `src/render/stations/index.ts`, `src/render/stations/render.ts`
- Test: `src/render/stations/tests/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATION_DESIGNS, getStationDesign, DEFAULT_STATION_DESIGN, EXAMPLE_STATION_DEFAULT, pickExampleRoute, renderStationPreview } from '../index';
import { renderStations } from '../render';
import type { StopMark, Pixel } from '../../layout/types';

test('registry has classic, nyc-solid, nyc-map; default classic; fallback', () => {
  for (const id of ['classic', 'nyc-solid', 'nyc-map']) assert.ok(STATION_DESIGNS.some((d) => d.id === id));
  assert.equal(DEFAULT_STATION_DESIGN, 'classic');
  assert.equal(getStationDesign('classic').id, 'classic');
  assert.equal(getStationDesign('nope').id, 'classic');
  assert.equal(getStationDesign(undefined).id, 'classic');
});

test('pickExampleRoute: first bulleted non-temp route, else A/red default', () => {
  assert.deepEqual(pickExampleRoute([{ tempParentId: 'x', bullet: 'Z' }, { bullet: 'Q', color: '#00ff00', textColor: '#000000' }]), { bullet: 'Q', color: '#00ff00', textColor: '#000000' });
  assert.deepEqual(pickExampleRoute([]), EXAMPLE_STATION_DEFAULT);
  assert.equal(pickExampleRoute([{ bullet: 'A', color: 'bad' }]).color, '#888888');
  assert.equal(pickExampleRoute([{ bullet: 'A', color: 'bad' }]).textColor, '');
});

test('renderStationPreview returns an <svg> with the bullet and expected color', () => {
  const svg = renderStationPreview(getStationDesign('nyc-solid'), { bullet: 'A', color: '#dc2626', textColor: '#ffffff' }, false);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('fill="#dc2626"'));
  assert.ok(svg.includes('>A</text>'));
});

test('renderStations emits svg fragments + matching stops prims', () => {
  const marks: StopMark[] = [{ lineId: 'L', color: '#dc2626', pos: [5, 5] as Pixel, name: 'A' }];
  const stops = new Map([['n1', marks]]);
  const { svg, prims } = renderStations(stops, { dark: false, showBullets: true, megaFallback: 'curve' }, getStationDesign('classic'));
  assert.equal(svg.length, 1);
  assert.ok(svg[0].includes('class="imp-stop"'));
  assert.ok(svg[0].includes('data-station-id="n1"'));
  assert.ok(prims.some((p) => p.kind === 'circle' && p.layer === 'stops'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/render/stations/tests/index.test.ts`
Expected: FAIL — cannot find module `../index`.

- [ ] **Step 3: Create `stations/index.ts`**

```ts
import type { StationDesign, ExampleStation } from './types';
import { classic } from './classic';
import { nycSolid } from './nycSolid';
import { nycMap } from './nycMap';
import { previewSvg } from './serialize';

export type { StationDesign, ExampleStation, StopScene, PaintCtx, Glyph, Capsule, StopLine } from './types';

export const STATION_DESIGNS: StationDesign[] = [classic, nycSolid, nycMap];
export const DEFAULT_STATION_DESIGN = 'classic';
export const EXAMPLE_STATION_DEFAULT: ExampleStation = { bullet: 'A', color: '#dc2626', textColor: '#ffffff' };

export function getStationDesign(id: string | undefined): StationDesign {
  return STATION_DESIGNS.find((d) => d.id === id) ?? classic;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const okColor = (c: string | undefined): string => (c && HEX.test(c) ? c : '#888888');

/** Representative example route for the picker: first non-temporary bulleted
 *  route, else the A/red default. Framework-free (accepts the game's Route[]). */
export function pickExampleRoute(routes: ReadonlyArray<{ bullet?: string; color?: string; textColor?: string; tempParentId?: string | null }>): ExampleStation {
  for (const r of routes) {
    if (r.tempParentId != null) continue;
    const bullet = (r.bullet ?? '').trim();
    if (bullet) return { bullet, color: okColor(r.color), textColor: r.textColor || '' };
  }
  return EXAMPLE_STATION_DEFAULT;
}

/** Standalone preview SVG for a design + example (delegates to serialize). */
export function renderStationPreview(design: StationDesign, ex: ExampleStation, dark: boolean): string {
  return previewSvg(design, ex, dark);
}
```

- [ ] **Step 4: Create `stations/render.ts`**

```ts
import type { StopMark } from '../layout/types';
import type { Prim } from '../sceneIR';
import type { StationDesign } from './types';
import { buildScene } from './placement';
import { glyphsToSvg, glyphsToPrims, wrapMarker } from './serialize';

export interface RenderStationsCtx {
  dark: boolean;
  showBullets: boolean;
  megaFallback: 'box' | 'curve';
  members?: Map<string, number>;
  deg?: Map<string, number>;
}

/** Draw every station's marker with the chosen design. Returns the per-marker
 *  SVG fragments (already wrapped) and the flat stops-layer Prim list, both from
 *  one draw list per station. */
export function renderStations(
  stopsByNode: Map<string, StopMark[]>,
  ctx: RenderStationsCtx,
  design: StationDesign,
): { svg: string[]; prims: Prim[] } {
  const svg: string[] = [];
  const prims: Prim[] = [];
  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    const scene = buildScene(nodeId, marks, { megaFallback: ctx.megaFallback, members: ctx.members, deg: ctx.deg });
    const glyphs = design.paint(scene, { dark: ctx.dark, showBullets: ctx.showBullets });
    const lineIds = marks.map((m) => m.lineId);
    svg.push(wrapMarker(scene.anchor, nodeId, lineIds, glyphsToSvg(glyphs)));
    for (const p of glyphsToPrims(glyphs)) prims.push(p);
  }
  return { svg, prims };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test src/render/stations/tests/index.test.ts`  → PASS.

- [ ] **Step 6: Full suite + build**

Run: `npm test`  → all pass.
Run: `npx vite build 2>&1 | tail -2`  → succeeds. Do NOT commit.

---

### Task 7: wire `paintRibbons` to `renderStations`

**Files:**
- Modify: `src/render/renderOctilinear.ts`

Currently `paintRibbons` calls `getStationDesign(args.stationDesign).renderStops(...)` and fills a `stopsPrims` sink. Replace with `renderStations`.

- [ ] **Step 1: Swap the import**

In `src/render/renderOctilinear.ts`, replace:

```ts
import { getStationDesign } from './stationDesigns';
```

with:

```ts
import { getStationDesign } from './stations';
import { renderStations } from './stations/render';
```

- [ ] **Step 2: Replace the marker render call**

Find (in `paintRibbons`):

```ts
  const stopParts = getStationDesign(args.stationDesign).renderStops(
    stopsByNode, dark, membersByNode, degByNode, args.showStations !== false,
    sceneOut ? stopsPrims : undefined, args.megaFallback ?? 'curve',
  );
```

Replace with:

```ts
  const stationOut = renderStations(
    stopsByNode,
    { dark, showBullets: args.showStations !== false, megaFallback: args.megaFallback ?? 'curve', members: membersByNode, deg: degByNode },
    getStationDesign(args.stationDesign),
  );
  const stopParts = stationOut.svg;
  if (sceneOut) for (const p of stationOut.prims) stopsPrims.push(p);
```

`stopParts` is used later as `stopParts.join('')` (a `string[]`) — unchanged. `stopsPrims` is the existing prim sink flushed into `sceneOut` further down — unchanged.

- [ ] **Step 3: Full suite + build**

Run: `npm test`  → all pass (the OLD `stops.ts`/`stationDesigns.ts` and their tests still exist; nothing imports `renderStops` from the pipeline now).
Run: `npx vite build 2>&1 | tail -2`  → succeeds. Do NOT commit.

---

### Task 8: repoint the panel + picker; delete the old modules

**Files:**
- Modify: `src/ui/StationDesignPicker.tsx`, `src/ui/SchematicPanel.tsx`
- Delete: `src/render/stops.ts`, `src/render/stationDesigns.ts`, `src/render/tests/stops.test.ts`, `src/render/tests/stationDesigns.test.ts`

- [ ] **Step 1: Repoint `StationDesignPicker.tsx`**

Replace the import:

```ts
import { getStationDesign, type StationDesign, type ExampleStation } from '../render/stationDesigns';
```

with:

```ts
import { renderStationPreview, type StationDesign, type ExampleStation } from '../render/stations';
```

And replace the tile preview call:

```ts
                dangerouslySetInnerHTML={{ __html: getStationDesign(d.id).renderPreview(example, dark) }}
```

with:

```ts
                dangerouslySetInnerHTML={{ __html: renderStationPreview(d, example, dark) }}
```

- [ ] **Step 2: Repoint `SchematicPanel.tsx`**

Replace the import:

```ts
import { STATION_DESIGNS, getStationDesign, pickExampleRoute, DEFAULT_STATION_DESIGN } from '../render/stationDesigns';
```

with:

```ts
import { STATION_DESIGNS, getStationDesign, pickExampleRoute, DEFAULT_STATION_DESIGN } from '../render/stations';
```

(No other panel logic changes: `getStationDesign(stationDesign).name` in the row and the `applyBundle` validation against `STATION_DESIGNS` keep working.)

- [ ] **Step 3: Delete the superseded modules and their tests**

```bash
git rm src/render/stops.ts src/render/stationDesigns.ts src/render/tests/stops.test.ts src/render/tests/stationDesigns.test.ts
```

(If `git rm` prompts about the working tree, use plain file deletion instead; the point is these four files are removed.)

- [ ] **Step 4: Confirm nothing still imports the deleted modules**

Run: `grep -rn "from './stops'\|from '../stops'\|from './stationDesigns'\|from '../render/stationDesigns'\|renderStops" src` (expect: no matches, or only inside `src/render/stations/placement.ts` comments referencing the former file by name).

- [ ] **Step 5: Full suite + build**

Run: `npm test`  → all pass.
Run: `npx vite build 2>&1 | tail -2`  → succeeds. Do NOT commit.

---

### Task 9: final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: green, including the new `src/render/stations/tests/*.test.ts` and no remaining `stops.test.ts` / `stationDesigns.test.ts`.

- [ ] **Step 2: Build**

Run: `npx vite build 2>&1 | tail -2`
Expected: succeeds.

- [ ] **Step 3: Summary**

Report created/modified/deleted files and the passing test count. Leave everything uncommitted for review.

---

## Self-review notes

- **Spec coverage:** one surface (T1 types, T5 designs) → three outputs (T3 serialize); reusable primitives incl. `circle` (T2); placement/appearance split (T4 placement vs T5 designs); capsule shape/colors pluggable via `capsuleGlyphs` (T2/T5) with packing left in placement (T4); previews reuse `paint` (T3 `previewSvg`, T6 `renderStationPreview`); no hand-synced SVG/Prim (T3 both from one list); `stops.ts`/`stationDesigns.ts` deleted (T8); pipeline (T7) and panel (T8) rewired; `textColor` plumbing kept (feeds `StopLine.textColor` in T4).
- **Type consistency:** `StationDesign.paint`, `StopScene`, `Capsule`, `Glyph`, `PaintCtx` defined in T1 and used identically in T2–T6. `getStationDesign`/`pickExampleRoute`/`STATION_DESIGNS`/`DEFAULT_STATION_DESIGN`/`EXAMPLE_STATION_DEFAULT` exported from T6 `index.ts`, imported by T7/T8. `renderStations` signature identical in T6 (def) and T7 (call).
- **No commits** anywhere; each task ends on `npm test` (+ `npx vite build` where TSX/pipeline is touched).
