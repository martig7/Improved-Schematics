import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareScene, drawScene } from '../sceneCanvas';
import type { Scene, Prim } from '../sceneIR';

// Node has no canvas, so the path type the drawing code builds is stubbed out.
(globalThis as { Path2D?: unknown }).Path2D ??= class { constructor(_d?: string) { /* opaque */ } };

/** A canvas context stub that records the cap in force at each stroke. */
function recorder(): { ctx: CanvasRenderingContext2D; caps: string[] } {
  const caps: string[] = [];
  const ctx = {
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    setTransform() { /* no-op */ },
    clearRect() { /* no-op */ },
    save() { /* no-op */ },
    restore() { /* no-op */ },
    beginPath() { /* no-op */ },
    moveTo() { /* no-op */ },
    lineTo() { /* no-op */ },
    arc() { /* no-op */ },
    rect() { /* no-op */ },
    roundRect() { /* no-op */ },
    fill() { /* no-op */ },
    fillText() { /* no-op */ },
    measureText() { return { width: 0 }; },
    setLineDash() { /* no-op */ },
    stroke(this: { lineCap: string }) { caps.push(this.lineCap); },
    translate() { /* no-op */ },
    scale() { /* no-op */ },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, caps: caps };
}

const draw = (prims: Prim[]): string[] => {
  const { ctx, caps } = recorder();
  const scene: Scene = { width: 100, height: 100, prims } as Scene;
  drawScene(ctx, prepareScene(scene), { scale: 1, vx: 0, vy: 0 }, { dpr: 1, cssWidth: 100, cssHeight: 100 });
  return caps;
};

test('a line prim caps butt, whatever stroked before it', () => {
  // The routes are stroked with a round cap. A line prim that does not set its own
  // keeps that cap and reaches half a stroke width past each end, which puts every
  // tick and every cut line over ink it was measured to clear.
  const caps = draw([
    { kind: 'path', d: 'M 0 0 L 10 0', fill: 'none', stroke: '#f00', strokeWidth: 4, lineCap: 'round', lineJoin: 'round', layer: 'edges', worldScale: true },
    { kind: 'line', x1: 0, y1: 10, x2: 10, y2: 10, stroke: '#fff', strokeWidth: 2, layer: 'stops', worldScale: true },
  ] as Prim[]);
  assert.deepEqual(caps, ['round', 'butt'], 'the line must not inherit the route cap');
});

test('a path prim still uses the cap it asks for', () => {
  const caps = draw([
    { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0, stroke: '#fff', strokeWidth: 2, layer: 'stops', worldScale: true },
    { kind: 'path', d: 'M 0 5 L 10 5', fill: 'none', stroke: '#111', strokeWidth: 3, lineCap: 'round', lineJoin: 'round', layer: 'stops', worldScale: true },
  ] as Prim[]);
  assert.deepEqual(caps, ['butt', 'round']);
});
