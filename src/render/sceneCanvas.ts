// Canvas 2D backend for the Scene IR (sceneIR.ts). Paints a parsed Scene to a
// <canvas> under a camera transform: pan/zoom is one setTransform + redraw, with
// no live DOM, no per-node counter-scale writes, and no whole-SVG repaint.
//
// Scale rules mirror the old SVG panel exactly:
//   - worldScale strokes/fonts scale WITH the map (.edges/.imp-stop content);
//   - everything else counter-scales to a constant screen size (lineWidth/scale);
//   - labels (.stations) are world-anchored but drawn at a constant screen size
//     and position offset, in a final identity-transform pass.
// The detail-area cutout is an even-odd canvas clip (big rect minus the boxes)
// applied to the edges + stops layers only, exactly as the SVG clipPath did.

import type { Scene, Prim, TextPrim, ClipBox } from './sceneIR';
import { estimateTextWidth } from './labels';

export interface SceneView {
  scale: number; // screen px per world unit
  vx: number; // world x at viewport left
  vy: number; // world y at viewport top
}

export interface PreparedScene {
  scene: Scene;
  /** background + water + grid + unclassed routes — drawn first, unclipped. */
  base: Prim[];
  /** route ribbons — clipped to outside the cutout boxes. */
  edges: Prim[];
  /** transfer connectors — drawn between edges and stops, unclipped. */
  transfers: Prim[];
  /** station markers — clipped to outside the cutout boxes. */
  stops: Prim[];
  /** station labels — constant-screen-size pass, hidden when over a cutout box. */
  labels: TextPrim[];
}

/** Bucket a Scene into draw-order layers once, so each frame just iterates. */
export function prepareScene(scene: Scene): PreparedScene {
  const base: Prim[] = [];
  const edges: Prim[] = [];
  const transfers: Prim[] = [];
  const stops: Prim[] = [];
  const labels: TextPrim[] = [];
  // First pass: everything that draws under/around the routes, in source order
  // within each class, but with a fixed inter-class order (background → water →
  // grid → other) so geographic routes ('other') sit above the backdrop.
  const order = (l: Prim['layer']): number =>
    l === 'background' ? 0 : l === 'water' ? 1 : l === 'grid' ? 2 : 3;
  for (const p of scene.prims) {
    switch (p.layer) {
      case 'edges':
        edges.push(p);
        break;
      case 'transfers':
        transfers.push(p);
        break;
      case 'stops':
        stops.push(p);
        break;
      case 'stations':
        if (p.kind === 'text') labels.push(p);
        else stops.push(p); // defensive: any non-text in .stations behaves like a marker
        break;
      default:
        base.push(p);
    }
  }
  base.sort((a, b) => order(a.layer) - order(b.layer)); // stable in modern engines
  return { scene, base, edges, transfers, stops, labels };
}

/** Screen-space box of a label's text, given the current view. `labelScale`
 *  multiplies the constant on-screen size (the user's "label size" setting). Pure. */
export function labelScreenBox(
  label: TextPrim,
  view: SceneView,
  labelScale = 1,
): { x0: number; y0: number; x1: number; y1: number } {
  const sax = (label.ax - view.vx) * view.scale + label.x * labelScale;
  const say = (label.ay - view.vy) * view.scale + label.y * labelScale;
  const w = estimateTextWidth(label.text) * labelScale;
  let x0 = sax;
  let x1 = sax + w;
  if (label.align === 'center') {
    x0 = sax - w / 2;
    x1 = sax + w / 2;
  } else if (label.align === 'right') {
    x0 = sax - w;
    x1 = sax;
  }
  // y is the glyph baseline; the box rises ~0.8em above, ~0.2em below.
  const fh = label.fontSize * labelScale;
  return { x0, y0: say - fh * 0.8, x1, y1: say + fh * 0.2 };
}

/** Whether a label should be hidden because it sits in/over a cutout box.
 *  Mirrors the panel's updateLabelOverlap: (1) the world anchor inside a box, or
 *  (2) the rendered text box overlapping a box's screen rect. Pure (testable). */
export function isLabelHidden(label: TextPrim, view: SceneView, boxes: ClipBox[], labelScale = 1): boolean {
  if (boxes.length === 0) return false;
  for (const b of boxes) {
    if (label.ax >= b.x0 && label.ax <= b.x1 && label.ay >= b.y0 && label.ay <= b.y1) return true;
  }
  const lb = labelScreenBox(label, view, labelScale);
  for (const b of boxes) {
    const bx0 = (b.x0 - view.vx) * view.scale;
    const by0 = (b.y0 - view.vy) * view.scale;
    const bx1 = (b.x1 - view.vx) * view.scale;
    const by1 = (b.y1 - view.vy) * view.scale;
    if (lb.x0 < bx1 && lb.x1 > bx0 && lb.y0 < by1 && lb.y1 > by0) return true;
  }
  return false;
}

const LABEL_FONT = '"Helvetica","Helvetica Neue",Arial,sans-serif';

export interface DrawSceneOpts {
  /** device pixel ratio; the caller sizes the backing store to css*dpr. */
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  /** detail-area cutout boxes in world coords (edges/stops clipped to outside). */
  clipBoxes?: ClipBox[];
  /** multiplier on the constant on-screen label size (user "label size" setting). */
  labelScale?: number;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedScene,
  view: SceneView,
  opts: DrawSceneOpts,
): void {
  const { dpr, cssWidth, cssHeight } = opts;
  const boxes = opts.clipBoxes && opts.clipBoxes.length > 0 ? opts.clipBoxes : null;
  const { scale, vx, vy } = view;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cssWidth * dpr, cssHeight * dpr);

  // World-space camera: a world point (wx,wy) → device px. A worldScale stroke of
  // width w then renders at w*scale css px; a screen stroke uses w/scale so it
  // renders at a constant w css px.
  const camera = () => ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -vx * scale * dpr, -vy * scale * dpr);

  const drawPrim = (p: Prim): void => {
    ctx.globalAlpha = p.opacity ?? 1;
    switch (p.kind) {
      case 'path': {
        const path = new Path2D(p.d);
        if (p.fill && p.fill !== 'none') {
          ctx.fillStyle = p.fill;
          ctx.fill(path, p.fillRule ?? 'nonzero');
        }
        if (p.stroke && p.stroke !== 'none') {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.worldScale ? p.strokeWidth : p.strokeWidth / scale;
          ctx.lineCap = p.lineCap;
          ctx.lineJoin = p.lineJoin;
          ctx.stroke(path);
        }
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
        if (p.fill && p.fill !== 'none') {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke && p.stroke !== 'none') {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.worldScale ? p.strokeWidth : p.strokeWidth / scale;
          ctx.stroke();
        }
        break;
      }
      case 'rect': {
        const lw = p.worldScale ? p.strokeWidth : p.strokeWidth / scale;
        roundRect(ctx, p.x, p.y, p.w, p.h, p.rx);
        if (p.fill && p.fill !== 'none') {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke && p.stroke !== 'none' && p.strokeWidth > 0) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = lw;
          ctx.stroke();
        }
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.worldScale ? p.strokeWidth : p.strokeWidth / scale;
        ctx.stroke();
        break;
      }
      case 'text': {
        // worldScale text (route bullets) draws under the camera at world size.
        ctx.font = `${p.fontWeight} ${p.fontSize}px ${LABEL_FONT}`;
        ctx.textAlign = p.align;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = p.fill;
        ctx.fillText(p.text, p.x, p.y);
        break;
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawList = (list: Prim[]): void => {
    for (const p of list) drawPrim(p);
  };

  // even-odd clip: big rect minus the cutout boxes → keep everything OUTSIDE them
  const withClip = (fn: () => void): void => {
    if (!boxes) {
      fn();
      return;
    }
    const big = Math.max(prepared.scene.width, prepared.scene.height) * 100;
    const clip = new Path2D();
    clip.rect(-big, -big, big * 2, big * 2);
    for (const b of boxes) clip.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.save();
    ctx.clip(clip, 'evenodd');
    fn();
    ctx.restore();
  };

  camera();
  drawList(prepared.base);
  withClip(() => drawList(prepared.edges));
  drawList(prepared.transfers);
  withClip(() => drawList(prepared.stops));

  // Labels: constant screen size (× the user's labelScale), identity transform.
  // Size and offset both scale so the label grows around its dot. Hidden when
  // over a box.
  const ls = opts.labelScale ?? 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'alphabetic';
  for (const label of prepared.labels) {
    if (boxes && isLabelHidden(label, view, boxes, ls)) continue;
    ctx.font = `${label.fontWeight} ${label.fontSize * ls}px ${LABEL_FONT}`;
    ctx.textAlign = label.align;
    ctx.fillStyle = label.fill;
    const sx = (label.ax - vx) * scale + label.x * ls;
    const sy = (label.ay - vy) * scale + label.y * ls;
    ctx.fillText(label.text, sx, sy);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
): void {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2));
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
