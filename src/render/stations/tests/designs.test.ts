import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classic } from '../classic';
import { nycSolid } from '../nycSolid';
import { nycMap } from '../nycMap';
import { tokyu } from '../tokyu';
import { tokyo } from '../tokyo';
import { tokyoMetro } from '../tokyoMetro';
import { london } from '../london';
import { toronto } from '../toronto';
import { LINE_WIDTH } from '../../constants';
import type { StopScene, Point } from '../types';

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

test('tokyu: white base square under an inset line-color plate, bullet + zero-padded number', () => {
  const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#e10f2b', bullet: 'TY', textColor: '#ffffff', pos: [10, 10], chain: 0, seq: 1 }], capsule: { kind: 'none' }, anchor: [10, 10], dotRadius: 12 };
  const gs = tokyu.paint(sc, ctx);
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ x: number; y: number; w: number; h: number; fill: string }>;
  assert.equal(rects.length, 2);
  const [base, plate] = rects;
  assert.equal(base.fill, '#ffffff', 'white base square (the sign rim)');
  assert.equal(plate.fill, '#e10f2b', 'route-color plate');
  // rim symmetric on all four sides
  const left = plate.x - base.x;
  const right = (base.x + base.w) - (plate.x + plate.w);
  const top = plate.y - base.y;
  const bottom = (base.y + base.h) - (plate.y + plate.h);
  assert.ok(Math.abs(left - right) < 1e-9 && Math.abs(top - bottom) < 1e-9 && Math.abs(left - top) < 1e-9, 'rim uniform');
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
  // Expand-and-overdraw: one border rect + one fill rect for the group, plus
  // TWO rects per line box (white base + color plate) = 6 rects.
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ w: number; fill: string; stroke: string }>;
  assert.equal(rects.length, 6);
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
    assert.ok(Math.abs(left - outer.w * 0.1) <= 0.05 + 1e-9, `frame ${left} not ~0.1 of side ${outer.w}`);
    const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string; fill: string }>;
    assert.ok(texts.some((t) => t.text === 'JY' && t.fill === '#1e1a1b'), 'bullet in the reference near-black ink');
    assert.ok(texts.some((t) => t.text === '01' && t.fill === '#1e1a1b'), 'zero-padded number in dark ink');
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

test('tokyoMetro: route-color ring (1/8.5 diameter, reference spec) around a white disc, concentric and on the emit grid', () => {
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
    assert.ok(Math.abs(ring - (2 * outer.r) / 8.5) <= 0.1 + 1e-9, `ring ${ring} not ~1/8.5 of diameter ${2 * outer.r}`);
    const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string; fill: string; fontWeight: string }>;
    assert.ok(texts.some((t) => t.text === 'G' && t.fill === '#1e1a1b' && t.fontWeight === 'bold'), 'bold bullet in the reference near-black ink');
    assert.ok(texts.some((t) => t.text === '01' && t.fill === '#1e1a1b' && t.fontWeight === 'bold'), 'bold zero-padded number');
  }
});

const lineOf = (gs: ReturnType<typeof london.paint>) => gs.filter((g) => g.kind === 'line') as Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }>;

test('london: a single stop is one route-color tick rooted on the dot (one-sided), no disc or bullet', () => {
  const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#dc2626', bullet: 'A', textColor: '', pos: [10, 20], chain: 0, axis: 0 }], capsule: { kind: 'none' }, anchor: [10, 20], dotRadius: 3 };
  const gs = london.paint(sc, ctx);
  assert.ok(!gs.some((g) => g.kind === 'circle' || g.kind === 'text'), 'no dot, no bullet');
  const ls = lineOf(gs);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].stroke, '#dc2626', 'tick in the route color');
  // one endpoint is rooted at pos and the other is offset to a single side
  assert.ok(Math.abs(ls[0].x1 - 10) < 1e-9 && Math.abs(ls[0].y1 - 20) < 1e-9, 'rooted at pos');
  assert.ok(Math.abs(ls[0].x2 - 10) > 1e-6 || Math.abs(ls[0].y2 - 20) > 1e-6, 'extends to one side');
});

test('london: the tick is drawn strictly perpendicular to the exact line tangent', () => {
  const withDir = (dx: number, dy: number): StopScene => ({ nodeId: 'n', lines: [{ lineId: 'L', color: '#000', bullet: '', textColor: '', pos: [0, 0], chain: 0, dir: [dx, dy] }], capsule: { kind: 'none' }, anchor: [0, 0], dotRadius: 3 });
  // For any tangent (octilinear or not) the tick vector dotted with it is zero.
  for (const [dx, dy] of [[1, 0], [0, 1], [3, 1], [-2, 5], [0.6, -0.8]]) {
    const l = lineOf(london.paint(withDir(dx, dy), ctx))[0];
    const tvx = l.x2 - l.x1, tvy = l.y2 - l.y1;
    assert.ok(Math.abs(tvx * dx + tvy * dy) < 1e-6, `tick perpendicular to tangent (${dx},${dy})`);
    assert.ok(tvx * tvx + tvy * tvy > 1e-6, 'tick has length');
  }
});

test('london: with no exact tangent it falls back to the octilinear axis, still perpendicular', () => {
  const mk = (axis: number | undefined): StopScene => ({ nodeId: 'n', lines: [{ lineId: 'L', color: '#000', bullet: '', textColor: '', pos: [0, 0], chain: 0, axis }], capsule: { kind: 'none' }, anchor: [0, 0], dotRadius: 3 });
  const vec = (sc: StopScene) => { const l = lineOf(london.paint(sc, ctx))[0]; return [l.x2 - l.x1, l.y2 - l.y1]; };
  const [hx] = vec(mk(0)); assert.ok(Math.abs(hx) < 1e-9, 'axis 0 (horizontal line) -> vertical tick');
  const [, vy] = vec(mk(2)); assert.ok(Math.abs(vy) < 1e-9, 'axis 2 (vertical line) -> horizontal tick');
  const [ax] = vec(mk(undefined)); assert.ok(Math.abs(ax) < 1e-9, 'no axis -> vertical tick');
});

test('london: a one-sided tick reaches toward the bundle outward side (flipping the canonical side)', () => {
  const mk = (out: Point): StopScene => ({
    nodeId: 'n', lines: [{ lineId: 'L', color: '#000', bullet: '', textColor: '', pos: [0, 0], chain: 0, dir: [1, 0], outward: out }], capsule: { kind: 'none' }, anchor: [0, 0], dotRadius: 3,
  });
  const up = lineOf(london.paint(mk([0, -1]), ctx))[0];   // outward points -y
  const down = lineOf(london.paint(mk([0, 1]), ctx))[0];   // outward points +y
  for (const l of [up, down]) {
    assert.ok(Math.abs(l.x1) < 1e-9 && Math.abs(l.y1) < 1e-9, 'rooted at pos');
    assert.ok(Math.abs(l.x2) < 1e-9, 'strictly perpendicular to the horizontal line');
  }
  assert.ok(up.y2 < 0, 'outward -y strikes the tick upward');
  assert.ok(down.y2 > 0, 'outward +y strikes the tick downward (the opposite side)');
});

test('london: an outward direction not exactly perpendicular still picks the aligned side', () => {
  // outward leans mostly +y but with a tangential component; the tick is still
  // exactly vertical and lands on the +y side.
  const sc: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#000', bullet: '', textColor: '', pos: [0, 0], chain: 0, dir: [1, 0], outward: [0.4, 0.9] }], capsule: { kind: 'none' }, anchor: [0, 0], dotRadius: 3 };
  const l = lineOf(london.paint(sc, ctx))[0];
  assert.ok(Math.abs(l.x2) < 1e-9, 'strictly perpendicular');
  assert.ok(l.y2 > 0, 'aligned with the outward +y side');
});

test('london: a terminus gets a full two-sided tick centered on the dot', () => {
  const term: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#dc2626', bullet: '', textColor: '', pos: [10, 20], chain: 0, axis: 0, terminus: true }], capsule: { kind: 'none' }, anchor: [10, 20], dotRadius: 3 };
  const l = lineOf(london.paint(term, ctx))[0];
  // midpoint sits on the dot, and the two ends are mirror images of it
  assert.ok(Math.abs((l.x1 + l.x2) / 2 - 10) < 1e-9 && Math.abs((l.y1 + l.y2) / 2 - 20) < 1e-9, 'centered on pos');
  assert.ok(Math.abs((10 - l.x1) - (l.x2 - 10)) < 1e-9 && Math.abs((20 - l.y1) - (l.y2 - 20)) < 1e-9, 'symmetric about pos');
  // and it is longer than the one-sided intermediate stub (both arms present)
  const inter: StopScene = { ...term, lines: [{ ...term.lines[0], terminus: false }] };
  const li = lineOf(london.paint(inter, ctx))[0];
  const lenTerm = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  const lenInter = Math.hypot(li.x2 - li.x1, li.y2 - li.y1);
  assert.ok(lenTerm > lenInter + 1e-6, 'terminus tick spans both sides');
});

const circlesOf = (gs: ReturnType<typeof london.paint>) => gs.filter((g) => g.kind === 'circle') as Array<{ cx: number; cy: number; r: number; fill: string }>;

test('london: paints a bubble capsule as ink-then-paper discs and connector bars', () => {
  const sc: StopScene = {
    nodeId: 'n', lines: [],
    capsule: {
      kind: 'londonBubbles',
      bubbles: [{ x: 0, y: 0, r: 6 }, { x: 0, y: 20, r: 4 }],
      necks: [{ x0: 0, y0: 0, x1: 0, y1: 20, w: 4 }],
    },
    anchor: [0, 10], dotRadius: 6,
  };
  const gs = london.paint(sc, ctx);
  const cs = circlesOf(gs);
  const ink = cs.filter((c) => c.fill === '#111111');
  const paper = cs.filter((c) => c.fill === '#ffffff');
  assert.equal(ink.length, 2, 'one ink outline disc per bubble');
  assert.equal(paper.length, 2, 'one paper fill disc per bubble');
  assert.equal(lineOf(gs).length, 2, 'one connector bar in each layer');
  // the ink disc is fattened by the rim under its paper disc
  const inkAt0 = ink.find((c) => Math.abs(c.cy) < 1e-9)!;
  const paperAt0 = paper.find((c) => Math.abs(c.cy) < 1e-9)!;
  assert.ok(inkAt0.r > paperAt0.r, 'ink disc carries the rim');
  // draw order: the whole ink layer first, then the paper layer over it
  const lastInk = Math.max(...ink.map((c) => gs.indexOf(c)));
  const firstPaper = Math.min(...paper.map((c) => gs.indexOf(c)));
  assert.ok(firstPaper > lastInk, 'paper layer drawn over the ink layer');
  // monochrome bubble: no route color anywhere
  assert.ok(!gs.some((g) => (g as { fill?: string }).fill?.startsWith('#12')));
});

test('london: a mega (box) interchange paints a white ticket-hall block', () => {
  const sc: StopScene = { nodeId: 'n', lines: [], capsule: { kind: 'box', x: 0, y: 0, w: 40, h: 40, rx: 6 }, anchor: [20, 20], dotRadius: 6 };
  const rects = london.paint(sc, ctx).filter((g) => g.kind === 'rect') as Array<{ fill: string; stroke: string }>;
  assert.equal(rects.length, 1);
  assert.equal(rects[0].fill, '#ffffff');
  assert.equal(rects[0].stroke, '#111111');
});

test('london: requests the londonBubbles capsule regime', () => {
  assert.equal(london.capsule, 'londonBubbles');
});

test('london: tick weight never exceeds the line, and shrinks with a capsule-shrunk dot', () => {
  const single: StopScene = { nodeId: 'n', lines: [{ lineId: 'L', color: '#000', bullet: '', textColor: '', pos: [0, 0], chain: 0, axis: 0 }], capsule: { kind: 'none' }, anchor: [0, 0], dotRadius: 3 };
  const shrunk: StopScene = { ...single, dotRadius: 1.5 };
  const full = lineOf(london.paint(single, ctx))[0].strokeWidth;
  const small = lineOf(london.paint(shrunk, ctx))[0].strokeWidth;
  assert.ok(small < full, 'a smaller dot yields a thinner tick');
});

const tCircles = (gs: ReturnType<typeof toronto.paint>) => gs.filter((g) => g.kind === 'circle') as Array<{ cx: number; cy: number; r: number; fill: string }>;
const tPaths = (gs: ReturnType<typeof toronto.paint>) => gs.filter((g) => g.kind === 'path') as Array<{ d: string; fill: string; stroke: string }>;

test('toronto: a single stop is a blank black-ringed white circle, no bullet', () => {
  const gs = toronto.paint(single(), ctx);
  assert.ok(!gs.some((g) => g.kind === 'text'), 'blank: no bullet');
  const cs = tCircles(gs);
  assert.equal(cs.length, 2, 'expand-and-overdraw: ink disc then paper disc');
  const [ink, paper] = cs;
  assert.equal(ink.fill, '#111111');
  assert.equal(paper.fill, '#ffffff');
  assert.ok(ink.r > paper.r, 'the ink disc carries the ring');
  assert.ok(Math.abs(ink.r - LINE_WIDTH / 2) < 1e-9, 'line-fit: outer diameter is the line width');
  // the white circle sits at the stop position
  assert.ok(Math.abs(paper.cx - 10) < 1e-9 && Math.abs(paper.cy - 10) < 1e-9);
});

test('toronto interchange: white pill (black border), a black dot per station, spine tracing the capsule', () => {
  const sc: StopScene = {
    nodeId: 'n',
    lines: [
      { lineId: 'L1', color: '#dc2626', bullet: 'A', textColor: '', pos: [0, 0], chain: 0 },
      { lineId: 'L2', color: '#0000ff', bullet: 'B', textColor: '', pos: [0, 60], chain: 1 },
    ],
    capsule: { kind: 'pill', points: [[0, 0], [0, 60]], smooth: false },
    anchor: [0, 30], dotRadius: 6,
  };
  const gs = toronto.paint(sc, ctx);
  const paths = tPaths(gs);
  // capsule border + fill, then the connector spine
  assert.equal(paths.length, 3);
  assert.equal(paths[0].stroke, '#111111', 'border path');
  assert.equal(paths[1].stroke, '#ffffff', 'white fill path');
  const spine = paths[2];
  assert.equal(spine.stroke, '#111111', 'spine is ink');
  assert.equal(spine.d, 'M 0.0 0.0 L 0.0 60.0', 'spine traces the capsule points, not a guessed path');
  // one black dot per station, at each stop position
  const dots = tCircles(gs).filter((c) => c.fill === '#111111');
  assert.equal(dots.length, 2);
  assert.ok(dots.some((d) => Math.abs(d.cy) < 1e-9) && dots.some((d) => Math.abs(d.cy - 60) < 1e-9));
});

test('toronto crossing: a ring capsule is one white circle with a single black dot', () => {
  const sc: StopScene = { nodeId: 'n', lines: [], capsule: { kind: 'ring', cx: 5, cy: 7, r: 6 }, anchor: [5, 7], dotRadius: 6 };
  const gs = toronto.paint(sc, ctx);
  const cs = tCircles(gs);
  assert.equal(cs.length, 3, 'ink disc + paper disc + one black dot');
  const ink = cs.filter((c) => c.fill === '#111111');
  const paper = cs.filter((c) => c.fill === '#ffffff');
  assert.equal(paper.length, 1, 'white circle');
  assert.equal(ink.length, 2, 'black ring + black crossing dot');
  for (const c of cs) assert.ok(Math.abs(c.cx - 5) < 1e-9 && Math.abs(c.cy - 7) < 1e-9, 'all concentric at the crossing');
  // a crossing is interchange-sized, larger than a line-fit plain stop
  assert.ok(paper[0].r > LINE_WIDTH / 2, 'crossing circle is larger than a line-fit plain stop');
});

test('toronto: requests the toronto capsule regime and an interchange preview', () => {
  assert.equal(toronto.capsule, 'toronto');
  assert.equal(toronto.previewKind, 'interchange');
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
