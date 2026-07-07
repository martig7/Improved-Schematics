import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classic } from '../classic';
import { nycSolid } from '../nycSolid';
import { nycMap } from '../nycMap';
import { tokyu } from '../tokyu';
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

test('tokyu interchange: a rectRows capsule renders a dark-gray group rect + one numbered box per line', () => {
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
  // 1 group capsule rect + one box per line = 3 rects
  const rects = gs.filter((g) => g.kind === 'rect') as Array<{ w: number; fill: string; stroke: string }>;
  assert.equal(rects.length, 3);
  // The group capsule is the dark-gray rect with the black border.
  const cap = rects.find((r) => r.fill === '#6f6f73');
  assert.ok(cap, 'group capsule uses CAP_FILL');
  assert.equal(cap!.stroke, '#111111');
  const texts = gs.filter((g) => g.kind === 'text') as Array<{ text: string }>;
  assert.ok(texts.some((t) => t.text === '05'));
  assert.ok(texts.some((t) => t.text === '09'));
});

test('tokyu interchange: a connector emits a closed fill on top of the capsules plus two open side outlines, no closed stroked connector', () => {
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
  const paths = gs.filter((g) => g.kind === 'path') as Array<{ d: string; fill: string; stroke: string }>;
  // One connector -> one closed fill path + two open side outlines.
  assert.equal(paths.length, 3);

  const fills = paths.filter((p) => p.fill === '#6f6f73');
  assert.equal(fills.length, 1); // exactly one filled path
  const fill = fills[0];
  assert.equal(fill.stroke, 'none'); // fill carries no border
  assert.ok(fill.d.startsWith('M '));
  assert.ok(fill.d.trimEnd().endsWith('Z')); // closed
  // A 2-point connector is widened to 3 vertices (a, mid, b): 3 left + 3 right
  // = 6 line-to targets after the initial M.
  assert.equal((fill.d.match(/L /g) || []).length, 5);

  const sides = paths.filter((p) => p.fill === 'none');
  assert.equal(sides.length, 2); // left + right open outlines
  for (const side of sides) {
    assert.equal(side.stroke, '#111111'); // CAP_BORDER
    assert.ok(side.d.startsWith('M '));
    assert.ok(!side.d.trimEnd().endsWith('Z')); // open, no closing segment
    // Each side traces 3 vertices: initial M + 2 line-tos.
    assert.equal((side.d.match(/L /g) || []).length, 2);
  }

  // No closed path is stroked with the border color (the old seam).
  assert.ok(!paths.some((p) => p.stroke === '#111111' && p.d.trimEnd().endsWith('Z')));

  // The connector fill is drawn AFTER the group capsule rects so it covers the
  // capsule border at the junction; the route boxes are drawn last.
  const capRects = gs.filter((g) => g.kind === 'rect' && (g as { fill: string }).fill === '#6f6f73');
  const lastCapRectIdx = gs.lastIndexOf(capRects[capRects.length - 1]);
  const fillIdx = gs.indexOf(fill);
  assert.ok(fillIdx > lastCapRectIdx, 'connector fill drawn after the group capsules');
  const lastRectIdx = gs.map((g, i) => (g.kind === 'rect' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastRectIdx > fillIdx, 'route boxes drawn on top of the connector');
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
