// Scene IR — a flat, backend-agnostic display list for the rendered schematic.
//
// The renderer (renderRibbons / renderGeographic) still emits an SVG STRING,
// which stays the byte-exact source of truth for export, persist and the detail
// insets. For the INTERACTIVE panel we parse that string ONCE per layout change
// into this typed display list (see sceneFromSvg.ts) and paint it to a <canvas>
// (see sceneCanvas.ts). Pan/zoom/cutout then become a camera transform + one
// redraw with no live DOM — no innerHTML reparse, no per-node counter-scale
// writes, no whole-SVG repaint of thousands of vector nodes per frame.
//
// `worldScale` reproduces the panel's existing stroke rule exactly: a stroke
// counter-scales (stays a constant SCREEN size) UNLESS it lives inside a
// `.edges` or `.imp-stop` group, in which case it scales WITH the map. Labels
// (the `.stations` layer) are a third regime: world-anchored, constant screen
// size — modelled by a world anchor (ax,ay) plus a screen-space offset (x,y).

export type Layer =
  | 'background'
  | 'water'
  | 'grid'
  | 'edges'
  | 'transfers'
  | 'stops'
  | 'stations'
  | 'other';

interface PrimBase {
  layer: Layer;
  /** true → stroke width / font size scale with zoom (inside .edges/.imp-stop);
   *  false → counter-scaled to a constant on-screen size. */
  worldScale: boolean;
  opacity?: number;
}

export interface PathPrim extends PrimBase {
  kind: 'path';
  d: string;
  fill: string; // color or 'none'
  fillRule?: 'evenodd' | 'nonzero';
  stroke: string; // color or 'none'
  strokeWidth: number; // base (world) px
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
}

export interface RectPrim extends PrimBase {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface CirclePrim extends PrimBase {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface LinePrim extends PrimBase {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface TextPrim extends PrimBase {
  kind: 'text';
  text: string;
  /** worldScale=false (label): screen-space offset from the world anchor.
   *  worldScale=true  (route bullet): the world position; ax=ay=0. */
  x: number;
  y: number;
  /** world anchor the label hangs off (the outer .imp-lbl translate). */
  ax: number;
  ay: number;
  fontSize: number;
  fontWeight: string;
  align: CanvasTextAlign;
  fill: string;
}

export type Prim = PathPrim | RectPrim | CirclePrim | LinePrim | TextPrim;

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Scene {
  width: number;
  height: number;
  /** fit/export crop rect (the renderer's data-frame), if present. */
  frame?: FrameRect;
  /** land background fill (the top-level <rect>). */
  background?: string;
  prims: Prim[];
}

/** A selection box in content/world coords (the detail-area cutout regions). */
export interface ClipBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
