// One detail "popout" area: a colored outline over the selected region of the
// main map plus a draggable panel that re-simulates just that region (the cropped
// sub-graph spread out over its own geography). Self-contained — owns its re-sim,
// drag, and positioning — so the parent can render N of them independently.

import { useCallback, useEffect, useRef, useState } from 'react';
import { precomputeSmoothedSchematic, drawSmoothedSchematic, type SmoothedPrecomputed } from '../render/schematic';
import { cropSubgraph } from '../render/cropSubgraph';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Selection {
  id: string;
  box: Box;
  color: string;
  /** User label shown in the panel header; falls back to "DETAIL" when empty. */
  name: string;
}
export interface SelView {
  scale: number;
  vx: number;
  vy: number;
}

/** Detail-area accent colors, cycled in creation order. */
export const SEL_COLORS = ['#22d3ee', '#e879f9', '#fb923c', '#4ade80']; // cyan, magenta, orange, green

interface DetailInsetProps {
  sel: Selection;
  /** Current pan/zoom, read fresh (the parent mutates it imperatively). */
  getView: () => SelView | null;
  /** Register/unregister this inset's reposition fn so the parent can call it on
   *  pan/zoom (pass null to unregister). */
  registerReposition: (id: string, fn: (() => void) | null) => void;
  /** The main render's precompute (for the unproject + stationPx bridge), read
   *  fresh so a map regeneration is picked up. */
  getMainPre: () => SmoothedPrecomputed | string | null;
  /** Full schematic input for the re-sim crop. */
  buildInput: () => unknown;
  /** Base map SVG — magnified-crop fallback + a re-sim trigger when it changes. */
  baseSvg: string;
  showStations: boolean;
  onClose: (id: string) => void;
  /** Register/unregister an export descriptor getter so the parent can bake this
   *  panel (current dragged rect + rendered sub-SVG + frame) into the export. */
  registerExport: (id: string, fn: (() => ExportDescriptor | null) | null) => void;
}

export interface Rect { x: number; y: number; w: number; h: number }
/** What the parent needs to draw this panel into the exported image. */
export interface ExportDescriptor {
  rect: Rect; // panel rect in CONTENT coords (post-drag)
  subSvg: string; // the rendered sub-map (or base map, for the crop fallback)
  gf: Rect; // viewBox into subSvg (the framed selected region)
}

export function DetailInset({
  sel,
  getView,
  registerReposition,
  getMainPre,
  buildInput,
  baseSvg,
  showStations,
  onClose,
  registerExport,
}: DetailInsetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Last rendered sub-map + its viewBox frame, for baking into the export.
  const exportRef = useRef<{ subSvg: string; gf: Rect } | null>(null);
  // Panel rect in CONTENT (map) coords; mutated on drag. Initialised to a ~2.5x
  // callout to the right of the source box (height re-fit to the re-sim aspect).
  const bw = sel.box.x1 - sel.box.x0;
  const bh = sel.box.y1 - sel.box.y0;
  const rectRef = useRef({ x: sel.box.x1 + bw * 0.4, y: sel.box.y0, w: bw * 2.5, h: bh * 2.5 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  // The translucent fill shows while selecting; it's dropped once the detail loads.
  const [loaded, setLoaded] = useState(false);

  // Position the source-box outline + the panel from the current view.
  const position = useCallback(() => {
    const view = getView();
    if (!view) return;
    const ov = overlayRef.current;
    if (ov) {
      ov.style.left = `${(sel.box.x0 - view.vx) * view.scale}px`;
      ov.style.top = `${(sel.box.y0 - view.vy) * view.scale}px`;
      ov.style.width = `${(sel.box.x1 - sel.box.x0) * view.scale}px`;
      ov.style.height = `${(sel.box.y1 - sel.box.y0) * view.scale}px`;
    }
    const el = panelRef.current;
    const ir = rectRef.current;
    if (el) {
      el.style.left = `${(ir.x - view.vx) * view.scale}px`;
      el.style.top = `${(ir.y - view.vy) * view.scale}px`;
      el.style.width = `${ir.w * view.scale}px`;
      el.style.height = `${ir.h * view.scale}px`;
    }
  }, [getView, sel.box]);

  // Register with the parent so pan/zoom repositions us; also position on mount.
  useEffect(() => {
    registerReposition(sel.id, position);
    position();
    return () => registerReposition(sel.id, null);
  }, [sel.id, position, registerReposition]);

  // Expose an export descriptor (read fresh at export time, so it reflects the
  // current dragged rect + the latest rendered sub-map).
  useEffect(() => {
    registerExport(sel.id, () =>
      exportRef.current ? { rect: { ...rectRef.current }, subSvg: exportRef.current.subSvg, gf: exportRef.current.gf } : null,
    );
    return () => registerExport(sel.id, null);
  }, [sel.id, registerExport]);

  // Re-simulate the cropped region into the panel body (deferred behind a spinner
  // so it doesn't jank). Mirrors the single-inset path: pick core stations in the
  // box, unproject the box to geographic bounds, crop + re-precompute, frame on
  // the projected selection. Falls back to a magnified crop of the base map.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const box = sel.box;
    const fit = (isvg: SVGSVGElement | null) => {
      if (isvg) { isvg.setAttribute('width', '100%'); isvg.setAttribute('height', '100%'); }
      position();
    };
    const cropFallback = () => {
      body.innerHTML = baseSvg;
      const isvg = body.querySelector('svg');
      if (isvg) isvg.setAttribute('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
      fit(isvg);
      // Export the base map cropped to the box (same as the live fallback).
      exportRef.current = { subSvg: baseSvg, gf: { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } };
      setLoaded(true);
    };
    const pre = getMainPre();
    if (!pre || typeof pre === 'string') { cropFallback(); return; }
    const core = new Set<string>();
    for (const [sid, px] of pre.stationPx) {
      if (px[0] >= box.x0 && px[0] <= box.x1 && px[1] >= box.y0 && px[1] <= box.y1) core.add(sid);
    }
    if (core.size < 2) { cropFallback(); return; }
    const bl = pre.unproject([box.x0, box.y1]);
    const tr = pre.unproject([box.x1, box.y0]);
    const clipBbox: [number, number, number, number] = [bl[0], bl[1], tr[0], tr[1]];
    body.innerHTML =
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#999;font:11px system-ui">re-simulating…</div>';
    position();
    let cancelled = false;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled || !bodyRef.current) return;
        let out: string;
        let selFrame: [number, number, number, number] | null = null;
        try {
          const subPre = precomputeSmoothedSchematic(cropSubgraph(buildInput() as never, core, clipBbox));
          if (typeof subPre === 'string') {
            out = subPre;
          } else {
            out = drawSmoothedSchematic(subPre, { showLabels: false, showStations });
            const gf = subPre.geoBboxFrame;
            if (gf && gf.w > 1 && gf.h > 1) {
              selFrame = [gf.x, gf.y, gf.w, gf.h];
            } else {
              let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
              for (const id of core) {
                const p = subPre.stationPx.get(id);
                if (!p) continue;
                if (p[0] < mnX) mnX = p[0];
                if (p[0] > mxX) mxX = p[0];
                if (p[1] < mnY) mnY = p[1];
                if (p[1] > mxY) mxY = p[1];
              }
              if (mnX < mxX && mnY < mxY) selFrame = [mnX, mnY, mxX - mnX, mxY - mnY];
            }
          }
        } catch {
          cropFallback();
          return;
        }
        if (cancelled || !bodyRef.current) return;
        bodyRef.current.innerHTML = out;
        const isvg = bodyRef.current.querySelector('svg');
        if (isvg && selFrame) {
          isvg.setAttribute('viewBox', `${selFrame[0]} ${selFrame[1]} ${selFrame[2]} ${selFrame[3]}`);
          const ir = rectRef.current;
          rectRef.current = { ...ir, h: ir.w * (selFrame[3] / selFrame[2]) };
        }
        // The exported panel nests `out` framed on the re-laid selection (selFrame).
        exportRef.current = {
          subSvg: out,
          gf: selFrame
            ? { x: selFrame[0], y: selFrame[1], w: selFrame[2], h: selFrame[3] }
            : { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 },
        };
        fit(isvg);
        setLoaded(true);
      }),
    );
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [sel.box, getMainPre, baseSvg, showStations, position, buildInput]);

  // Drag the panel (content-space rect); stopPropagation so the map doesn't pan.
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const ir = rectRef.current;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: ir.x, oy: ir.y };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const view = getView();
    if (!d || !view) return;
    e.stopPropagation();
    rectRef.current = { ...rectRef.current, x: d.ox + (e.clientX - d.sx) / view.scale, y: d.oy + (e.clientY - d.sy) / view.scale };
    position();
  };
  const onUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  return (
    <>
      <div
        ref={overlayRef}
        style={{
          position: 'absolute',
          border: `2px dashed ${sel.color}`,
          background: loaded ? 'transparent' : `${sel.color}22`,
          borderRadius: 2,
          pointerEvents: 'none',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
        }}
      />
      <div
        ref={panelRef}
        style={{
          position: 'absolute',
          border: `1.5px solid ${sel.color}`,
          borderRadius: 6,
          boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
          overflow: 'hidden',
          background: '#18181b',
        }}
      >
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          style={{
            position: 'absolute',
            insetInline: 0,
            top: 0,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 6px',
            background: `${sel.color}2b`,
            color: '#e5e5e5',
            font: '600 9px system-ui, sans-serif',
            letterSpacing: 0.3,
            cursor: 'move',
            userSelect: 'none',
            touchAction: 'none',
            zIndex: 1,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ◳ {sel.name.trim() ? sel.name : 'DETAIL'}
          </span>
          <span
            onPointerDown={(e) => { e.stopPropagation(); onClose(sel.id); }}
            style={{ cursor: 'pointer', padding: '0 2px' }}
            title="Remove detail area"
          >
            ✕
          </span>
        </div>
        <div ref={bodyRef} style={{ position: 'absolute', inset: '16px 0 0 0' }} />
      </div>
    </>
  );
}
