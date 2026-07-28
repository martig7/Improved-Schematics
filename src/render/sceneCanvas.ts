// Canvas 2D backend for the Scene IR (sceneIR.ts). Paints a parsed Scene to a
// <canvas> under a camera transform: pan/zoom is one setTransform + redraw, with
// no live DOM, no per-node counter-scale writes, and no whole-SVG repaint.
//
// Scale rules:
//   - worldScale strokes/fonts scale WITH the map (.edges/.imp-stop content);
//   - everything else counter-scales to a constant screen size (lineWidth/scale);
//   - labels (.stations) are world-anchored but drawn at a constant screen size
//     and position offset, in a final identity-transform pass.
// The detail-area cutout is an even-odd canvas clip (big rect minus the boxes)
// applied to the edges + stops layers only.

import type { Scene, Prim, TextPrim, ClipBox } from './sceneIR';
import { estimateTextWidth } from './labels';
import { rotatedRectCorners } from './cropFrame';

export interface SceneView {
  scale: number; // screen px per world unit
  vx: number; // world x at viewport left
  vy: number; // world y at viewport top
}

export interface PreparedScene {
  scene: Scene;
  /** background, water, grid, and unclassed routes; drawn first, unclipped. */
  base: Prim[];
  /** route ribbons, clipped to outside the cutout boxes. */
  edges: Prim[];
  /** station markers, clipped to outside the cutout boxes. */
  stops: Prim[];
  /** station labels; constant-screen-size pass, hidden when over a cutout box. */
  labels: TextPrim[];
}

/** Bucket a Scene into draw-order layers once, so each frame just iterates. */
export function prepareScene(scene: Scene): PreparedScene {
  const base: Prim[] = [];
  const edges: Prim[] = [];
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
  return { scene, base, edges, stops, labels };
}

/** WORLD-space box of a label's text. Labels are drawn in world space (constant
 *  relative to the image, so they scale with zoom), so the box is world coords too.
 *  `labelScale` multiplies the world size (the "label size" setting). Pure. */
export function labelWorldBox(
  label: TextPrim,
  labelScale = 1,
): { x0: number; y0: number; x1: number; y1: number } {
  const ox = label.ax + label.x * labelScale; // text origin (pre-align), world
  const oy = label.ay + label.y * labelScale; // glyph baseline, world
  const w = estimateTextWidth(label.text) * labelScale;
  let x0 = ox;
  let x1 = ox + w;
  if (label.align === 'center') {
    x0 = ox - w / 2;
    x1 = ox + w / 2;
  } else if (label.align === 'right') {
    x0 = ox - w;
    x1 = ox;
  }
  // baseline → the box rises ~0.8em above, ~0.2em below.
  const fh = label.fontSize * labelScale;
  return { x0, y0: oy - fh * 0.8, x1, y1: oy + fh * 0.2 };
}

/** Whether a label should be hidden because it sits in/over a cutout box. All
 *  world-space now: (1) the dot anchor inside a box, or (2) the label's world
 *  text box overlapping a box. Pure (testable). */
export function isLabelHidden(label: TextPrim, boxes: ClipBox[], labelScale = 1): boolean {
  if (boxes.length === 0) return false;
  for (const b of boxes) {
    if (label.ax >= b.x0 && label.ax <= b.x1 && label.ay >= b.y0 && label.ay <= b.y1) return true;
  }
  const lb = labelWorldBox(label, labelScale);
  for (const b of boxes) {
    if (lb.x0 < b.x1 && lb.x1 > b.x0 && lb.y0 < b.y1 && lb.y1 > b.y0) return true;
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
  /** multiplier on the constant on-screen label size ("label size" setting). */
  labelScale?: number;
  /** dense box-warp regions in world coords, drawn as a debug overlay on top of
   *  everything (the "show warp boxes" toggle). Display-only. */
  warpBoxes?: ClipBox[];
  /** Clip the whole draw to the scene bounds [0,0,width,height] (the viewBox). For
   *  a CROP the layout deliberately places geography and boundary exit stubs just
   *  outside the box, relying on the SVG viewBox to clip them; the canvas has no
   *  viewBox, so this reproduces that clip. Off for normal maps so edge labels
   *  that overhang the canvas still show when panned. */
  clipToBounds?: boolean;
  /** Crop-edit overlay: the working crop box in world coords. Drawn LAST, under the
   *  camera (so it tracks pan/zoom with the map, no DOM rehome): a dim mask outside
   *  the box, a bright outline, and screen-sized corner handles. */
  /** The working crop box: its axis-aligned extent, how far it is turned about
   *  its own centre (radians), and where the tilt grip sits (world coords). */
  cropEdit?: { box: ClipBox; angle?: number; tilt?: [number, number] };
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

  // Crop clip: keep only what falls inside the scene bounds (the viewBox), so a
  // crop's off-box geography / boundary stubs are cut exactly as the SVG viewBox
  // cuts them. Set under the camera so the rect is world coords; the device-space
  // clip then persists across the identical later camera() calls. Restored at the end.
  if (opts.clipToBounds) {
    camera();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, prepared.scene.width, prepared.scene.height);
    ctx.clip();
  }

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
          // Dash lengths are world px like strokeWidth, so a screen-space prim
          // divides them by the camera scale the same way. Always reset, or the
          // pattern leaks onto every later stroke.
          if (p.dash && p.dash.length > 0) ctx.setLineDash(p.worldScale ? p.dash : p.dash.map((v) => v / scale));
          ctx.stroke(path);
          if (p.dash && p.dash.length > 0) ctx.setLineDash([]);
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
        // A line prim caps BUTT, as the SVG it mirrors does: <line> carries no
        // stroke-linecap. Without setting it the canvas keeps whatever the last
        // stroke left behind, which is the routes' round cap, and every tick and
        // cut line then reaches half a stroke width past its own end.
        ctx.lineCap = 'butt';
        ctx.stroke();
        break;
      }
      case 'text': {
        // worldScale text (route bullets) draws under the camera at world size.
        ctx.font = `${p.fontWeight} ${p.fontSize}px ${p.fontFamily ?? LABEL_FONT}`;
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
  withClip(() => drawList(prepared.stops));

  // Labels: WORLD space, constant relative to the image, so they scale with the
  // map as you zoom (× labelScale). Drawn in the camera pass; font
  // size and offset are in world units. Hidden when over a cutout box.
  const ls = opts.labelScale ?? 1;
  camera();
  ctx.textBaseline = 'alphabetic';
  for (const label of prepared.labels) {
    if (boxes && isLabelHidden(label, boxes, ls)) continue;
    ctx.font = `${label.fontWeight} ${label.fontSize * ls}px ${LABEL_FONT}`;
    ctx.textAlign = label.align;
    ctx.fillStyle = label.fill;
    const ox = label.ax + label.x * ls;
    const oy = label.ay + label.y * ls;
    const lines = label.lines && label.lines.length > 1 ? label.lines : null;
    const dyStep = (label.fontSize + 2) * ls; // per-line height, matches the SVG tspan dy
    // Canvas is display-only (the SVG string is the deterministic artifact), so
    // runtime trig for the rotated case is fine. Flat single-line labels draw at
    // the same coordinates as before.
    if (label.angle) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate((label.angle * Math.PI) / 180);
      if (lines) lines.forEach((ln, i) => ctx.fillText(ln, 0, i * dyStep));
      else ctx.fillText(label.text, 0, 0);
      ctx.restore();
    } else if (lines) {
      lines.forEach((ln, i) => ctx.fillText(ln, ox, oy + i * dyStep));
    } else {
      ctx.fillText(label.text, ox, oy);
    }
  }

  // Warp-box debug overlay (LAST, on top of everything): the dense-core regions the
  // box-warp magnified. World space so it pans/zooms with the map; stroke width and
  // dash are divided by scale for a constant on-screen size.
  const wb = opts.warpBoxes;
  if (wb && wb.length > 0) {
    camera();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(225,29,143,0.08)';
    ctx.strokeStyle = '#e11d8f';
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([9 / scale, 6 / scale]);
    for (const b of wb) {
      const w = b.x1 - b.x0, h = b.y1 - b.y0;
      ctx.fillRect(b.x0, b.y0, w, h);
      ctx.strokeRect(b.x0, b.y0, w, h);
    }
    ctx.setLineDash([]);
  }

  // Crop-edit overlay (LAST, on top): the working crop box drawn under the camera,
  // so it pans/zooms with the map. A dim mask outside it, a bright outline, and
  // screen-constant corner handles.
  const ce = opts.cropEdit;
  if (ce) {
    const b = ce.box;
    camera();
    ctx.globalAlpha = 1;
    // The box may be turned, previewing the frame the content will be righted
    // into, so mask and outline both run off its four corners rather than off an
    // axis-aligned rect.
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const corners = rotatedRectCorners(cx, cy, (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, ce.angle ?? 0);
    const big = Math.max(prepared.scene.width, prepared.scene.height) * 100;
    const mask = new Path2D();
    mask.rect(-big, -big, big * 2, big * 2);
    mask.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) mask.lineTo(corners[i][0], corners[i][1]);
    mask.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill(mask, 'evenodd');
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    const hh = 7 / scale; // handle half-size, constant on screen
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.5 / scale;
    for (const [hx, hy] of corners) {
      ctx.beginPath();
      ctx.rect(hx - hh, hy - hh, 2 * hh, 2 * hh);
      ctx.fill();
      ctx.stroke();
    }
    if (ce.tilt) drawTiltHandle(ctx, ce.tilt[0], ce.tilt[1], ce.angle ?? 0, scale);
  }

  if (opts.clipToBounds) ctx.restore();
}

/** The tilt grip: a round pad carrying a double-headed arc, drawn at a constant
 *  screen size and turned with the box so it reads as "turn this". */
function drawTiltHandle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, angle: number, scale: number,
): void {
  const R = 12 / scale;      // pad radius, constant on screen
  const r = 6.4 / scale;     // arc radius
  const tip = 3.4 / scale;   // arrowhead half-size
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1 / scale;
  ctx.stroke();
  // A three-quarter arc with a head at each end.
  ctx.strokeStyle = '#04283a';
  ctx.lineWidth = 1.8 / scale;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI * 0.35, Math.PI * 1.65);
  ctx.stroke();
  ctx.fillStyle = '#04283a';
  for (const a of [Math.PI * 0.35, Math.PI * 1.65]) {
    const ax = Math.cos(a) * r, ay = Math.sin(a) * r;
    // Tangent at the arc's end, so each head points the way the arc runs.
    const tx = -Math.sin(a), ty = Math.cos(a);
    // Each head points AWAY from the arc's body, so the two read as opposed.
    const s = a > Math.PI ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(ax + tx * tip * s * 1.6, ay + ty * tip * s * 1.6);
    ctx.lineTo(ax - ty * tip, ay + tx * tip);
    ctx.lineTo(ax + ty * tip, ay - tx * tip);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
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
