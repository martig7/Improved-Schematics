// Parse the renderer's SVG-string output into a Scene display list (sceneIR.ts).
//
// This runs ONCE per layout change (the same cadence as the panel's old
// `innerHTML = svg`), but the result drives a canvas instead of the live DOM, so
// pan/zoom/cutout afterwards cost nothing in the DOM. The renderer's markup is
// generated and regular (see renderOctilinear.ts / renderGeographic.ts /
// stops.ts / labels.ts / geographyBackdrop.ts), so a focused, dependency-free
// tokenizer is sufficient and — unlike DOMParser — runs in node for tests.
//
// Layer + worldScale are derived from the enclosing `<g class="...">` chain,
// reproducing the panel's stroke-scaling rule (constant screen size unless
// inside .edges/.imp-stop). Labels carry the accumulated translate as a world
// anchor plus their text x/y as a constant-screen offset.

import type { Scene, Prim, Layer } from './sceneIR';

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so a literal "&amp;amp;" → "&amp;"

const num = (v: string | undefined, d = 0): number => {
  if (v == null) return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

type Attrs = Record<string, string>;

const parseAttrs = (s: string): Attrs => {
  const a: Attrs = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) a[m[1]] = m[2];
  return a;
};

const parseTranslate = (transform: string | undefined): [number, number] => {
  if (!transform) return [0, 0];
  const m = /translate\(\s*([-\d.]+)[ ,]\s*([-\d.]+)/.exec(transform);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
};

const anchorToAlign = (a: string | undefined): CanvasTextAlign =>
  a === 'middle' ? 'center' : a === 'end' ? 'right' : 'left';

/** Map a group class to a Layer; null when the class isn't a known layer. */
const layerForClass = (c: string): Layer | null => {
  switch (c) {
    case 'edges':
      return 'edges';
    case 'water':
      return 'water';
    case 'octi-grid':
      return 'grid';
    case 'transfers':
      return 'transfers';
    case 'stops':
    case 'imp-stop':
    case 'stations-dots':
      return 'stops';
    case 'stations':
    case 'imp-lbl':
    case 'imp-lbl-s':
      return 'stations';
    default:
      return null;
  }
};

interface Frame {
  classes: string[];
  tx: number;
  ty: number;
  // SVG presentation attrs set on a <g> are inherited by descendants. The
  // geography backdrop (geographyBackdrop.ts) and schematic water group put
  // fill/fill-rule/stroke on the group, not the <path>, so leaves must inherit.
  fill?: string;
  fillRule?: string;
  stroke?: string;
}

// Matches: a close tag | an open/self-closing tag (name + attrs + optional /) |
// a run of text content. Attribute values never contain a literal " (escapeXml
// encodes it as &quot;), so [^"]* is safe.
const TOKEN =
  /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;

export function sceneFromSvg(svg: string): Scene {
  const stack: Frame[] = [];
  const prims: Prim[] = [];
  let width = 0;
  let height = 0;
  let frame: Scene['frame'];
  let background: string | undefined;

  const worldScale = (): boolean =>
    stack.some((f) => f.classes.includes('edges') || f.classes.includes('imp-stop'));
  const layerOf = (): Layer => {
    for (let i = stack.length - 1; i >= 0; i--) {
      for (const c of stack[i].classes) {
        const l = layerForClass(c);
        if (l) return l;
      }
    }
    return 'other';
  };
  const accTranslate = (): [number, number] => {
    let tx = 0;
    let ty = 0;
    for (const f of stack) {
      tx += f.tx;
      ty += f.ty;
    }
    return [tx, ty];
  };
  // Nearest ancestor value of an inheritable presentation attr (fill/fillRule/
  // stroke), innermost first; undefined when no ancestor sets it.
  const inherited = (key: 'fill' | 'fillRule' | 'stroke'): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const v = stack[i][key];
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const resolveFillRule = (raw: string | undefined): 'evenodd' | 'nonzero' | undefined =>
    raw === 'evenodd' ? 'evenodd' : raw === 'nonzero' ? 'nonzero' : undefined;
  // A leaf with no enclosing group is the top-level land rect / empty-state text.
  const leafLayer = (): Layer => (stack.length === 0 ? 'background' : layerOf());

  const emitShape = (name: string, attrs: Attrs): void => {
    const layer = leafLayer();
    const ws = worldScale();
    const opacity = attrs['opacity'] != null ? num(attrs['opacity'], 1) : undefined;
    if (name === 'path') {
      prims.push({
        kind: 'path',
        d: attrs['d'] || '',
        fill: attrs['fill'] ?? inherited('fill') ?? 'none',
        fillRule: resolveFillRule(attrs['fill-rule'] ?? inherited('fillRule')),
        stroke: attrs['stroke'] ?? inherited('stroke') ?? 'none',
        strokeWidth: num(attrs['stroke-width'], 1),
        lineCap: (attrs['stroke-linecap'] as CanvasLineCap) || 'butt',
        lineJoin: (attrs['stroke-linejoin'] as CanvasLineJoin) || 'miter',
        layer,
        worldScale: ws,
        opacity,
      });
    } else if (name === 'circle') {
      prims.push({
        kind: 'circle',
        cx: num(attrs['cx']),
        cy: num(attrs['cy']),
        r: num(attrs['r']),
        fill: attrs['fill'] ?? inherited('fill') ?? 'none',
        stroke: attrs['stroke'] ?? inherited('stroke') ?? 'none',
        strokeWidth: num(attrs['stroke-width'], 1),
        layer,
        worldScale: ws,
        opacity,
      });
    } else if (name === 'rect') {
      const fill = attrs['fill'] ?? inherited('fill') ?? 'none';
      if (layer === 'background' && background === undefined && fill !== 'none') background = fill;
      prims.push({
        kind: 'rect',
        x: num(attrs['x']),
        y: num(attrs['y']),
        w: num(attrs['width']),
        h: num(attrs['height']),
        rx: num(attrs['rx']),
        fill,
        stroke: attrs['stroke'] ?? inherited('stroke') ?? 'none',
        strokeWidth: num(attrs['stroke-width'], 0),
        layer,
        worldScale: ws,
        opacity,
      });
    } else if (name === 'line') {
      prims.push({
        kind: 'line',
        x1: num(attrs['x1']),
        y1: num(attrs['y1']),
        x2: num(attrs['x2']),
        y2: num(attrs['y2']),
        stroke: attrs['stroke'] ?? inherited('stroke') ?? 'none',
        strokeWidth: num(attrs['stroke-width'], 1),
        layer,
        worldScale: ws,
        opacity,
      });
    }
  };

  const emitText = (attrs: Attrs, text: string): void => {
    const ws = worldScale();
    const [tx, ty] = accTranslate();
    prims.push({
      kind: 'text',
      text,
      x: num(attrs['x']),
      y: num(attrs['y']),
      ax: tx,
      ay: ty,
      fontSize: num(attrs['font-size'], 12),
      fontWeight: attrs['font-weight'] || 'normal',
      align: anchorToAlign(attrs['text-anchor']),
      fill: attrs['fill'] ?? inherited('fill') ?? '#000',
      layer: leafLayer(),
      worldScale: ws,
    });
  };

  let pendingText: Attrs | null = null;
  let textBuf = '';
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(svg))) {
    if (m[1] !== undefined) {
      // close tag
      if (m[1] === 'text' && pendingText) {
        emitText(pendingText, decodeEntities(textBuf));
        pendingText = null;
        textBuf = '';
      } else if (m[1] === 'g') {
        stack.pop();
      }
      continue;
    }
    if (m[2] !== undefined) {
      const name = m[2];
      const attrs = parseAttrs(m[3] || '');
      const selfClose = m[4] === '/';
      if (name === 'svg') {
        const vb = attrs['viewBox']?.split(/\s+/).map(Number);
        width = vb && vb.length === 4 ? vb[2] : num(attrs['width']);
        height = vb && vb.length === 4 ? vb[3] : num(attrs['height']);
        const fr = attrs['data-frame']?.split(/\s+/).map(Number);
        if (fr && fr.length === 4) frame = { x: fr[0], y: fr[1], w: fr[2], h: fr[3] };
        continue;
      }
      if (name === 'g') {
        if (!selfClose) {
          const classes = (attrs['class'] || '').split(/\s+/).filter(Boolean);
          const [tx, ty] = parseTranslate(attrs['transform']);
          stack.push({
            classes,
            tx,
            ty,
            fill: attrs['fill'],
            fillRule: attrs['fill-rule'],
            stroke: attrs['stroke'],
          });
        }
        continue;
      }
      if (name === 'text') {
        if (!selfClose) {
          pendingText = attrs;
          textBuf = '';
        }
        continue;
      }
      emitShape(name, attrs);
      continue;
    }
    if (m[5] !== undefined && pendingText) textBuf += m[5];
  }

  return { width, height, frame, background, prims };
}
