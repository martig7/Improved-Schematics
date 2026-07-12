import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classic } from '../classic';
import { nycSolid } from '../nycSolid';
import { nycMap } from '../nycMap';
import { tokyu } from '../tokyu';
import { tokyo } from '../tokyo';
import { tokyoMetro } from '../tokyoMetro';
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

test('nycMap on-map capsule: fixed white pill / black border in BOTH themes; single-dot preview', () => {
  assert.equal(nycMap.previewKind, undefined); // preview tile is a single dot
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

test('tokyu: rounded square in the line color with bullet + zero-padded number', () => {
  const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#e10f2b', bullet: 'TY', textColor: '#ffffff', pos: [10, 10], chain: 0, seq: 1 }], capsule: { kind: 'none' }, anchor: [10, 10], dotRadius: 12 };
  const gs = tokyu.paint(sc, ctx);
  const r = gs.find((g) => g.kind === 'rect') as { fill: string };
  assert.equal(r.fill, '#e10f2b');
  const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string }>;
  assert.ok(texts.some((t) => t.text === 'TY'));
  assert.ok(texts.some((t) => t.text === '01')); // seq 1 -> '01'
});

test('tokyu: omits the number when seq is absent, and the bullet when showBullets is false', () => {
  const noSeq: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#e10f2b', bullet: 'TY', textColor: '', pos: [10, 10], chain: 0 }], capsule: { kind: 'none' }, anchor: [10, 10], dotRadius: 12 };
  const gsNoSeq = tokyu.paint(noSeq, ctx);
  assert.ok(!(gsNoSeq.filter((g) => g.kind === 'text') as Array<{ text: string }>).some((t) => /\d/.test(t.text)));
  const gsNoBullet = tokyu.paint(noSeq, { dark: false, showBullets: false });
  assert.ok(!(gsNoBullet.filter((g) => g.kind === 'text') as Array<{ text: string }>).some((t) => t.text === 'TY'));
});

test('tokyu interchange: a rectRows capsule renders the group as a border rect under a fill rect + one numbered box per line', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [
      { lineId: 'L1', color: '#e10f2b', bullet: 'A', textColor: '#ffffff', pos: [0, 0], chain: 0, seq: 5 },
      { lineId: 'L2', color: '#0067c0', bullet: 'D', textColor: '#ffffff', pos: [34, 0], chain: 1, seq: 9 },
    ],
    capsule: {
      kind: 'rectRows',
      box: 30,
      groups: [{ x: -20, y: -20, w: 74, h: 40, rx: 6 }],
      connectors: [],
    },
    anchor: [17, 0],
    dotRadius: 6,
  };
  const gs = tokyu.paint(sc, ctx);
  // Expand-and-overdraw: one border rect + one fill rect for the group, plus one
  // box per line = 4 rects.
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ w: number; fill: string; stroke: string }>;
  assert.equal(rects.length, 4);
  // The border rect is the black one; the fill rect sits on top in CAP_FILL with
  // no stroke.
  const borderRect = rects.find((r) => r.fill === '#111111');
  assert.ok(borderRect, 'group border rect uses CAP_BORDER');
  assert.equal(borderRect!.stroke, '#111111');
  const fillRect = rects.find((r) => r.fill === '#6f6f73');
  assert.ok(fillRect, 'group fill rect uses CAP_FILL');
  assert.equal(fillRect!.stroke, 'none');
  const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string }>;
  assert.ok(texts.some((t) => t.text === '05'));
  assert.ok(texts.some((t) => t.text === '09'));
});

test('tokyu interchange: a connector renders as a seamless border-then-fill silhouette (neck path in each layer, no thin side outlines)', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [
      { lineId: 'L1', color: '#e10f2b', bullet: 'A', textColor: '#ffffff', pos: [0, 0], chain: 0, seq: 5 },
      { lineId: 'L2', color: '#0067c0', bullet: 'D', textColor: '#ffffff', pos: [0, 60], chain: 1, seq: 9 },
    ],
    capsule: {
      kind: 'rectRows',
      box: 30,
      groups: [
        { x: -20, y: -20, w: 40, h: 40, rx: 6 },
        { x: -20, y: 40, w: 40, h: 40, rx: 6 },
      ],
      connectors: [{ points: [[0, 0], [0, 60]] }],
    },
    anchor: [0, 30],
    dotRadius: 6,
  };
  const gs = tokyu.paint(sc, ctx);
  const paths = gs.filter((g) => g.kind === 'path') as Array<{ d: string; fill: string; stroke: string; strokeWidth: number }>;
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ fill: string; stroke: string; strokeWidth: number }>;

  // Expand-and-overdraw: one neck path per connector in the BORDER layer, then
  // one in the FILL layer. Exactly two neck paths, no thin side outlines.
  assert.equal(paths.length, 2);

  const borderNecks = paths.filter((p) => p.fill === '#111111');
  const fillNecks = paths.filter((p) => p.fill === '#6f6f73');
  assert.equal(borderNecks.length, 1); // border-layer neck
  assert.equal(fillNecks.length, 1); // fill-layer neck

  const borderNeck = borderNecks[0];
  // The border-layer neck is fattened: fill AND stroke are CAP_BORDER.
  assert.equal(borderNeck.stroke, '#111111');
  assert.ok(borderNeck.strokeWidth > 0);
  assert.ok(borderNeck.d.startsWith('M '));
  assert.ok(borderNeck.d.trimEnd().endsWith('Z')); // closed

  const fillNeck = fillNecks[0];
  assert.equal(fillNeck.stroke, 'none'); // fill-layer neck carries no border
  assert.ok(fillNeck.d.startsWith('M '));
  assert.ok(fillNeck.d.trimEnd().endsWith('Z')); // closed

  // No thin non-fattened side outline: every path is a closed silhouette piece,
  // none is an open (unclosed) stroke.
  assert.ok(!paths.some((p) => !p.d.trimEnd().endsWith('Z')));

  // Two group rects x two layers = 4 route-less rects, plus one box per line.
  const borderRects = rects.filter((r) => r.fill === '#111111');
  const fillRects = rects.filter((r) => r.fill === '#6f6f73' && r.stroke === 'none');
  assert.equal(borderRects.length, 2); // border layer: one per group
  assert.equal(fillRects.length, 2); // fill layer: one per group

  // Draw order: whole BORDER layer (rects + neck) first, then whole FILL layer
  // (rects + neck), then the route boxes on top.
  const borderNeckIdx = gs.indexOf(borderNeck);
  const fillNeckIdx = gs.indexOf(fillNeck);
  const lastBorderRectIdx = gs.lastIndexOf(borderRects[borderRects.length - 1]);
  const firstFillRectIdx = gs.indexOf(fillRects[0]);
  assert.ok(borderNeckIdx > lastBorderRectIdx, 'border neck drawn after the border rects');
  assert.ok(fillNeckIdx > borderNeckIdx, 'fill layer drawn after the border layer');
  assert.ok(firstFillRectIdx > borderNeckIdx, 'fill rects drawn after the border layer');
  const lastRectIdx = gs.map((g, i) => (g.kind === 'rect' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastRectIdx > fillNeckIdx, 'route boxes drawn on top of the fill layer');
});

test('tokyu: a box (mega-fallback) capsule renders the opaque dark-gray rounded rect', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [],
    capsule: { kind: 'box', x: 0, y: 0, w: 40, h: 40, rx: 6 },
    anchor: [20, 20],
    dotRadius: 6,
  };
  const gs = tokyu.paint(sc, ctx);
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ x: number; w: number; fill: string; stroke: string }>;
  assert.equal(rects.length, 1);
  assert.equal(rects[0].w, 40);
  assert.equal(rects[0].fill, '#6f6f73');
  assert.equal(rects[0].stroke, '#111111');
});

test('tokyo: route-color frame around a sharp-cornered white interior, dark ink, symmetric at ANY center', () => {
  // The SVG emit rounds each rect coordinate to 0.1px independently; a frame
  // built from raw floats could round thicker on one side ("sometimes the
  // left edge is thicker"). The box pre-quantizes to the emit grid, so all
  // four frame sides must come out EXACTLY equal for arbitrary centers.
  for (const cx of [10, 10.04, 10.05, 10.13, 317.77, 1234.56]) {
    const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#9acd32', bullet: 'JY', textColor: '#ffffff', pos: [cx, cx / 3], chain: 0, seq: 1 }], capsule: { kind: 'none' }, anchor: [cx, cx / 3], dotRadius: 12 };
    const gs = tokyo.paint(sc, ctx);
    const rects = gs.filter((g) => g.kind === 'rect') as Array<{ x: number; y: number; w: number; h: number; rx: number; fill: string }>;
    assert.equal(rects.length, 2);
    const [outer, inner] = rects;
    assert.equal(outer.fill, '#9acd32', 'outer square carries the route color');
    assert.ok(outer.rx > 0, 'outer corners rounded');
    assert.equal(inner.fill, '#ffffff', 'interior is white');
    assert.equal(inner.rx, 0, 'interior corners sharp');
    // emit-grid quantization: every coordinate must already sit on the grid
    for (const v of [outer.x, outer.y, outer.w, outer.h, inner.x, inner.y, inner.w, inner.h]) {
      assert.ok(Math.abs(v - +v.toFixed(1)) < 1e-9, `coordinate ${v} off the emit grid at cx=${cx}`);
    }
    const left = inner.x - outer.x;
    const right = (outer.x + outer.w) - (inner.x + inner.w);
    const top = inner.y - outer.y;
    const bottom = (outer.y + outer.h) - (inner.y + inner.h);
    assert.ok(Math.abs(left - right) < 1e-9, `left ${left} != right ${right} at cx=${cx}`);
    assert.ok(Math.abs(top - bottom) < 1e-9, `top ${top} != bottom ${bottom} at cx=${cx}`);
    assert.ok(Math.abs(left - top) < 1e-9, `frame not uniform at cx=${cx}`);
    // frame tracks the design fraction within the 0.1px emit quantum
    assert.ok(Math.abs(left - outer.w / 8) <= 0.05 + 1e-9, `frame ${left} not ~1/8 of side ${outer.w}`);
    const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string; fill: string }>;
    assert.ok(texts.some((t) => t.text === 'JY' && t.fill === '#111111'), 'bullet in dark ink');
    assert.ok(texts.some((t) => t.text === '01' && t.fill === '#111111'), 'zero-padded number in dark ink');
  }
});

test('tokyo interchange rides the shared rectRows capsule painter', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [
      { lineId: 'L1', color: '#9acd32', bullet: 'JY', textColor: '', pos: [0, 0], chain: 0, seq: 5 },
      { lineId: 'L2', color: '#0067c0', bullet: 'JK', textColor: '', pos: [34, 0], chain: 1, seq: 9 },
    ],
    capsule: { kind: 'rectRows', box: 30, groups: [{ x: -20, y: -20, w: 74, h: 40, rx: 6 }], connectors: [] },
    anchor: [17, 0],
    dotRadius: 6,
  };
  const gs = tokyo.paint(sc, ctx);
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ fill: string; stroke: string }>;
  // border rect + fill rect for the group, plus TWO rects per line box
  // (route-color frame + white interior) = 6.
  assert.equal(rects.length, 6);
  assert.ok(rects.some((r) => r.fill === '#111111'), 'group border rect');
  assert.ok(rects.some((r) => r.fill === '#6f6f73' && r.stroke === 'none'), 'group fill rect');
  const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string }>;
  assert.ok(texts.some((t) => t.text === '05') && texts.some((t) => t.text === '09'));
});

test('tokyoMetro: route-color ring (1/8 diameter) around a white disc, concentric and on the emit grid', () => {
  for (const cx of [10, 10.04, 10.13, 317.77]) {
    const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#f39700', bullet: 'G', textColor: '', pos: [cx, cx / 3], chain: 0, seq: 1 }], capsule: { kind: 'none' }, anchor: [cx, cx / 3], dotRadius: 12 };
    const gs = tokyoMetro.paint(sc, ctx);
    const circles = gs.filter((g) => g.kind === 'circle') as Array<{ cx: number; cy: number; r: number; fill: string }>;
    assert.equal(circles.length, 2);
    const [outer, inner] = circles;
    assert.equal(outer.fill, '#f39700', 'outer disc carries the route color');
    assert.equal(inner.fill, '#ffffff', 'interior is white');
    assert.ok(Math.abs(outer.cx - inner.cx) < 1e-9 && Math.abs(outer.cy - inner.cy) < 1e-9, 'concentric');
    for (const v of [outer.cx, outer.cy, outer.r, inner.r]) {
      assert.ok(Math.abs(v - +v.toFixed(1)) < 1e-9, `coordinate ${v} off the emit grid at cx=${cx}`);
    }
    const ring = outer.r - inner.r;
    assert.ok(Math.abs(ring - (2 * outer.r) / 8) <= 0.1 + 1e-9, `ring ${ring} not ~1/8 of diameter ${2 * outer.r}`);
    const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string; fill: string; fontWeight: string }>;
    assert.ok(texts.some((t) => t.text === 'G' && t.fill === '#111111' && t.fontWeight === 'bold'), 'bold bullet in dark ink');
    assert.ok(texts.some((t) => t.text === '01' && t.fill === '#111111' && t.fontWeight === 'bold'), 'bold zero-padded number');
  }
});

test('tokyoMetro interchange rides the shared rectRows capsule painter', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [
      { lineId: 'L1', color: '#f39700', bullet: 'G', textColor: '', pos: [0, 0], chain: 0, seq: 5 },
      { lineId: 'L2', color: '#0067c0', bullet: 'T', textColor: '', pos: [34, 0], chain: 1, seq: 9 },
    ],
    capsule: { kind: 'rectRows', box: 30, groups: [{ x: -20, y: -20, w: 74, h: 40, rx: 6 }], connectors: [] },
    anchor: [17, 0],
    dotRadius: 6,
  };
  const gs = tokyoMetro.paint(sc, ctx);
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ fill: string; w: number; h: number; rx: number }>;
  assert.equal(rects.length, 2, 'group border + fill rects');
  assert.ok(rects.some((r) => r.fill === '#111111') && rects.some((r) => r.fill === '#6f6f73'));
  for (const r of rects) {
    assert.ok(Math.abs(r.rx - Math.min(r.w, r.h) / 2) < 1e-9, 'capsule has stadium ends (rx = half the short side)');
  }
  const circles = gs.filter((g) => g.kind === 'circle');
  assert.equal(circles.length, 4, 'two discs per line box');
  const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string }>;
  assert.ok(texts.some((t) => t.text === '05') && texts.some((t) => t.text === '09'));
});
