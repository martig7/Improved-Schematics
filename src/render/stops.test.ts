import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStops } from './stops';
import type { StopMark, Pixel } from './layout/types';
import type { Prim } from './sceneIR';

// A dense, un-seatable hub: several marks all flagged mega → the fallback marker
// (box, or curve) is drawn instead of per-line dots.
function megaNode(): Map<string, StopMark[]> {
  const marks: StopMark[] = [
    { lineId: 'a', color: '#ff0000', pos: [100, 100] as Pixel, mega: true },
    { lineId: 'b', color: '#00ff00', pos: [112, 104] as Pixel, mega: true },
    { lineId: 'c', color: '#0000ff', pos: [104, 114] as Pixel, mega: true },
  ];
  return new Map([['hub', marks]]);
}

test('renderStops: mega fallback defaults to a <rect> box (parity-safe default)', () => {
  const prims: Prim[] = [];
  const svg = renderStops(megaNode(), false, undefined, undefined, true, prims).join('');
  assert.ok(svg.includes('<rect'), 'box mode emits a rect');
  assert.ok(!svg.includes('<path'), 'box mode emits no path');
  assert.ok(!svg.includes('<circle'), 'box mode suppresses the per-line dots');
  assert.ok(prims.some((p) => p.kind === 'rect'), 'box mode pushes a rect prim');
  assert.ok(!prims.some((p) => p.kind === 'path' || p.kind === 'circle'), 'box mode pushes no path/dot prims');
});

test('renderStops: megaFallback="curve" draws a smooth capsule with the dots on top', () => {
  const prims: Prim[] = [];
  const svg = renderStops(megaNode(), false, undefined, undefined, true, prims, 'curve').join('');
  assert.ok(svg.includes('<path'), 'curve mode emits the capsule path');
  assert.ok(!svg.includes('<rect'), 'curve mode emits no rect');
  // The capsule = border stroke + fill stroke (both fill:none), like the octilinear one.
  const paths = prims.filter((p) => p.kind === 'path') as Array<{ kind: 'path'; d: string; fill: string; strokeWidth: number }>;
  assert.equal(paths.length, 2, 'border stroke + fill stroke');
  for (const p of paths) {
    assert.equal(p.fill, 'none', 'capsule is stroked, not a filled shape');
    assert.ok(p.d.includes('C'), 'smooth cubic-bezier spine (curves allowed)');
    assert.ok(!p.d.includes('Z'), 'open capsule spine, not a closed shape');
  }
  assert.ok(paths[0].strokeWidth > paths[1].strokeWidth, 'border wider than fill');
  // Per-line dots are drawn ON TOP (one circle per mark), unlike the box which hides them.
  const dots = prims.filter((p) => p.kind === 'circle');
  assert.equal(dots.length, 3, 'a dot per line, drawn on top of the capsule');
  assert.ok(svg.includes('<circle'), 'dots present in the markup too');
  // SVG markup `d` and the scene-prim `d` must match exactly (canvas/SVG parity).
  const m = svg.match(/<path d="([^"]+)"/);
  assert.ok(m && m[1] === paths[0].d, 'prim d === markup d');
});
