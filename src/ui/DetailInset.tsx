// One detail "popout" area: a colored outline over the selected region of the
// main map plus a draggable panel that re-simulates just that region (the cropped
// sub-graph spread out over its own geography). Self-contained — owns its re-sim,
// drag, and positioning — so the parent can render N of them independently.

import { useCallback, useEffect, useRef, useState } from 'react';
import { precomputeSmoothedSchematic, drawSmoothedSchematic, type SmoothedPrecomputed } from '../render/schematic';
import { cropSubgraph } from '../render/cropSubgraph';
import { readSubPre, writeSubPre } from '../render/mapCache';

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
  /** Locked: the panel is pinned (can't be dragged) and pointer-transparent, so
   *  pan/zoom passes through to the map underneath. */
  locked?: boolean;
  /** Saved popout panel rect in CONTENT (map) coords — the user's dragged position +
   *  wheel-zoom. Persisted with the area so the popout restores where they left it;
   *  absent for a freshly-drawn area (falls back to the default callout). */
  rect?: { x: number; y: number; w: number; h: number };
}
export interface SelView {
  scale: number;
  vx: number;
  vy: number;
}

/** Detail-area accent colors, cycled in creation order. */
export const SEL_COLORS = ['#22d3ee', '#e879f9', '#fb923c', '#4ade80']; // cyan, magenta, orange, green

// Bounds-edit corner handles: [x-edge, y-edge] each handle controls, ordered TL, TR, BL, BR.
const EDIT_CORNERS = [['x0', 'y0'], ['x1', 'y0'], ['x0', 'y1'], ['x1', 'y1']] as const;
// Min box size (content px) enforced while resizing, so a corner can't cross the opposite
// side and invert the box (clamp, not flip).
const EDIT_MIN = 8;

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
  /** The active layout's cache key (city + fingerprint) for persisting/restoring this
   *  area's sub-layout, or null when there's no stable key (e.g. a file-loaded layout).
   *  Read fresh at re-sim time. */
  getCacheKey: () => { city: string; fp: string } | null;
  /** Full schematic input for the re-sim crop. */
  buildInput: () => unknown;
  /** Base map SVG — magnified-crop fallback + a re-sim trigger when it changes. */
  baseSvg: string;
  showStations: boolean;
  showLabels: boolean;
  /** Dense-hub fallback shape (the main map's setting) — re-sims of the crop may also
   *  hit un-seatable hubs, so they honour the same box/curve choice. */
  megaFallback: 'box' | 'curve';
  /** Label-size multiplier (the main map's setting); scaled onto this sub-map's labels. */
  labelScale: number;
  /** Bounds-edit mode: show draggable corner handles over the source box (the prior
   *  bounds stay lightly outlined; the new bounds outline + handles track the drag). */
  editing: boolean;
  /** Report the in-progress (working) box to the parent on each corner drag, so it can
   *  apply it on commit (✓). The source box itself isn't touched until then. */
  onBoundsChange: (id: string, box: Box) => void;
  /** Persist the popout panel rect (position + zoom) on the area, so it restores where the
   *  user left it. Called on drag-end and a debounced wheel-zoom, not per frame. */
  onRectChange: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
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
  getCacheKey,
  buildInput,
  baseSvg,
  showStations,
  showLabels,
  megaFallback,
  labelScale,
  editing,
  onBoundsChange,
  onRectChange,
  onClose,
  registerExport,
}: DetailInsetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  // Last rendered sub-map + its viewBox frame, for baking into the export.
  const exportRef = useRef<{ subSvg: string; gf: Rect } | null>(null);
  // Cached sub-layout (heavy octi precompute), keyed by box. Areas clear on any
  // layout change, so this is computed once per area; toggles just re-draw it.
  const subCacheRef = useRef<{ box: Box; pre: SmoothedPrecomputed | null; selFrame: Rect | null } | null>(null);
  // Panel rect in CONTENT (map) coords; mutated on drag/zoom. Restored from the saved rect
  // if the area has one, else a ~2.5x callout to the right of the source box (height re-fit
  // to the re-sim aspect). The initialiser runs once, so our own persist (below) can't loop.
  const bw = sel.box.x1 - sel.box.x0;
  const bh = sel.box.y1 - sel.box.y0;
  const rectRef = useRef(sel.rect ?? { x: sel.box.x1 + bw * 0.4, y: sel.box.y0, w: bw * 2.5, h: bh * 2.5 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  // Persist the panel rect (position + zoom) on the area so it restores next mount/reload.
  // Imperative during the gesture (no re-render); pushed up on drag-end and a debounced
  // wheel-zoom. A pending push is flushed on unmount (a mode switch right after a zoom).
  const rectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRect = useCallback(() => {
    if (rectTimerRef.current) { clearTimeout(rectTimerRef.current); rectTimerRef.current = null; }
    onRectChange(sel.id, { ...rectRef.current });
  }, [onRectChange, sel.id]);
  const scheduleRectPersist = useCallback(() => {
    if (rectTimerRef.current) clearTimeout(rectTimerRef.current);
    rectTimerRef.current = setTimeout(() => { rectTimerRef.current = null; onRectChange(sel.id, { ...rectRef.current }); }, 350);
  }, [onRectChange, sel.id]);
  useEffect(() => () => { if (rectTimerRef.current) { clearTimeout(rectTimerRef.current); onRectChange(sel.id, { ...rectRef.current }); } }, [onRectChange, sel.id]);
  // Bounds-edit state. The WORKING box lives here while editing so sel.box (and thus the
  // heavy re-sim, which keys on it) stays put until the parent commits on ✓. position()
  // draws the new-bounds outline + the 4 corner handles from it; the prior bounds keep
  // showing via the (dimmed) source outline. editingRef lets the stable position() branch.
  const editBoxRef = useRef<Box | null>(null);
  const editOutlineRef = useRef<HTMLDivElement>(null);
  const h0 = useRef<HTMLDivElement>(null);
  const h1 = useRef<HTMLDivElement>(null);
  const h2 = useRef<HTMLDivElement>(null);
  const h3 = useRef<HTMLDivElement>(null);
  const editDragRef = useRef<{ cx: 'x0' | 'x1'; cy: 'y0' | 'y1'; sx: number; sy: number; box0: Box } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // The translucent fill shows while selecting; it's dropped once the detail loads.
  const [loaded, setLoaded] = useState(false);
  // Mirror the label-size setting so the (closure-bound) re-sim draw reads the current
  // value without re-running. Labels are world-space `.imp-lbl-s` groups in the rendered
  // sub-SVG; scaling them matches the main map (which transforms the same groups).
  const labelScaleRef = useRef(labelScale);
  labelScaleRef.current = labelScale;
  const applyLabelScale = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const t = `scale(${labelScaleRef.current})`;
    body.querySelectorAll('.imp-lbl-s').forEach((g) => g.setAttribute('transform', t));
  }, []);

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
    // Leader from the box centre to the panel's nearest vertical edge.
    const line = leaderRef.current;
    if (line) {
      const bcx = (sel.box.x0 + sel.box.x1) / 2;
      const anchorX = ir.x < bcx ? ir.x + ir.w : ir.x;
      line.setAttribute('x1', `${(bcx - view.vx) * view.scale}`);
      line.setAttribute('y1', `${((sel.box.y0 + sel.box.y1) / 2 - view.vy) * view.scale}`);
      line.setAttribute('x2', `${(anchorX - view.vx) * view.scale}`);
      line.setAttribute('y2', `${(ir.y + ir.h / 2 - view.vy) * view.scale}`);
    }
    // Bounds-edit: the new-bounds outline + 4 corner handles, from the working box.
    if (editingRef.current && editBoxRef.current) {
      const eb = editBoxRef.current;
      const eo = editOutlineRef.current;
      if (eo) {
        eo.style.left = `${(eb.x0 - view.vx) * view.scale}px`;
        eo.style.top = `${(eb.y0 - view.vy) * view.scale}px`;
        eo.style.width = `${(eb.x1 - eb.x0) * view.scale}px`;
        eo.style.height = `${(eb.y1 - eb.y0) * view.scale}px`;
      }
      const cs: [number, number][] = [[eb.x0, eb.y0], [eb.x1, eb.y0], [eb.x0, eb.y1], [eb.x1, eb.y1]];
      const hs = [h0, h1, h2, h3];
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i].current;
        if (!h) continue;
        h.style.left = `${(cs[i][0] - view.vx) * view.scale}px`;
        h.style.top = `${(cs[i][1] - view.vy) * view.scale}px`;
      }
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

  // Re-simulate the cropped region into the panel body. The heavy octi PRECOMPUTE
  // is cached per box (areas clear on any layout change, so the layout is stable
  // for an area's life) — toggling stations/labels only RE-DRAWS the cached sub,
  // cheaply and with no spinner, exactly like the main map's two-phase render.
  // First compute is deferred behind a spinner; falls back to a base-map crop.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const box = sel.box;
    const boxFrame: Rect = { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
    const fit = (isvg: SVGSVGElement | null) => {
      if (isvg) { isvg.setAttribute('width', '100%'); isvg.setAttribute('height', '100%'); }
      position();
    };
    // Base-map crop fallback — reflects the toggles since baseSvg already does.
    const cropFallback = () => {
      body.innerHTML = baseSvg;
      const isvg = body.querySelector('svg');
      if (isvg) isvg.setAttribute('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
      applyLabelScale();
      fit(isvg);
      exportRef.current = { subSvg: baseSvg, gf: boxFrame };
      setLoaded(true);
    };
    // Cheap redraw of a cached sub-layout with the CURRENT toggles.
    const drawResim = (subPre: SmoothedPrecomputed, selFrame: Rect | null) => {
      const out = drawSmoothedSchematic(subPre, { showLabels, showStations, megaFallback });
      if (!bodyRef.current) return;
      bodyRef.current.innerHTML = out;
      applyLabelScale();
      const isvg = bodyRef.current.querySelector('svg');
      if (isvg && selFrame) {
        isvg.setAttribute('viewBox', `${selFrame.x} ${selFrame.y} ${selFrame.w} ${selFrame.h}`);
        rectRef.current = { ...rectRef.current, h: rectRef.current.w * (selFrame.h / selFrame.w) };
      }
      exportRef.current = { subSvg: out, gf: selFrame ?? boxFrame };
      fit(isvg);
      setLoaded(true);
    };

    // Cache hit (box unchanged → only a station/label toggle): re-draw instantly.
    const cached = subCacheRef.current;
    if (cached && cached.box === box) {
      if (cached.pre) drawResim(cached.pre, cached.selFrame);
      else cropFallback();
      return;
    }

    // Cache miss: compute the sub-layout once, deferred behind a spinner.
    const miss = (pre: SmoothedPrecomputed | null, selFrame: Rect | null) => { subCacheRef.current = { box, pre, selFrame }; };

    // Persistent hit: this region was octi-computed for this exact layout before. Restore
    // the sub-layout from localStorage (fp+box gated) and draw it instantly — no spinner,
    // no re-sim. Mirrors the main map's cache read; falls through to compute on a miss.
    const boxKey = `${box.x0},${box.y0},${box.x1},${box.y1}`;
    const ck = getCacheKey();
    if (ck) {
      const saved = readSubPre(ck.city, ck.fp, boxKey);
      if (saved && typeof saved.pre !== 'string') {
        miss(saved.pre, saved.selFrame);
        drawResim(saved.pre, saved.selFrame);
        return;
      }
    }

    const pre = getMainPre();
    if (!pre || typeof pre === 'string') { miss(null, null); cropFallback(); return; }
    const core = new Set<string>();
    for (const [sid, px] of pre.stationPx) {
      if (px[0] >= box.x0 && px[0] <= box.x1 && px[1] >= box.y0 && px[1] <= box.y1) core.add(sid);
    }
    if (core.size < 2) { miss(null, null); cropFallback(); return; }
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
        let subPre: SmoothedPrecomputed | string;
        try {
          subPre = precomputeSmoothedSchematic(cropSubgraph(buildInput() as never, core, clipBbox));
        } catch {
          miss(null, null); cropFallback(); return;
        }
        if (cancelled || !bodyRef.current) return;
        if (typeof subPre === 'string') { miss(null, null); cropFallback(); return; }
        // Frame on the projected selection (geoBboxFrame), else the core bbox.
        let selFrame: Rect | null = null;
        const gf = subPre.geoBboxFrame;
        if (gf && gf.w > 1 && gf.h > 1) {
          selFrame = { x: gf.x, y: gf.y, w: gf.w, h: gf.h };
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
          if (mnX < mxX && mnY < mxY) selFrame = { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY };
        }
        miss(subPre, selFrame);
        drawResim(subPre, selFrame);
        // Persist AFTER the draw so the lazily-computed geometry (marker placement) is
        // captured too — a restore then skips both octi and marker placement, like the
        // main-map cache. Best-effort; fp+box gated.
        if (ck) writeSubPre(ck.city, ck.fp, boxKey, subPre, selFrame);
      }),
    );
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [sel.box, getMainPre, getCacheKey, baseSvg, showStations, showLabels, megaFallback, position, buildInput, applyLabelScale]);

  // Re-apply the label scale when only the setting changes (no re-draw needed).
  useEffect(() => { applyLabelScale(); }, [labelScale, applyLabelScale]);

  // Wheel over the panel zooms the WHOLE panel — frame and content together — like a
  // map object (the panel scales and moves so the point under the cursor stays put).
  // It rescales the panel's content-space rect, so panel + sub-map magnify as a unit;
  // position() redraws it. Independent of the main map (the panel isn't inside the
  // viewport, so the map's wheel handler never sees this); non-passive so it can
  // preventDefault the page/map scroll. Panel width clamped to 150..2500 content px.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const ir = rectRef.current;
      let z = Math.exp(-e.deltaY * 0.0015); // scroll up → z>1 → bigger
      z = Math.max(150, Math.min(2500, ir.w * z)) / ir.w; // clamp panel width, keep aspect
      // anchor the point under the cursor (content coords): x' + fx·w' = x + fx·w
      rectRef.current = { x: ir.x + fx * ir.w * (1 - z), y: ir.y + fy * ir.h * (1 - z), w: ir.w * z, h: ir.h * z };
      position();
      scheduleRectPersist(); // debounced — wheel has no "end" event
    };
    panel.addEventListener('wheel', onWheel, { passive: false });
    return () => panel.removeEventListener('wheel', onWheel);
  }, [position, scheduleRectPersist]);

  // Drag the panel (content-space rect); stopPropagation so the map doesn't pan.
  const onDown = (e: React.PointerEvent) => {
    if (sel.locked) return; // pinned — don't move (also pointer-transparent via CSS)
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
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    if (wasDragging) persistRect(); // save the new position once, on release
  };

  // Entering edit mode: seed the working box from the current source box and place the
  // handles (they just mounted). Leaving: drop it. sel.box is stable during an edit —
  // a commit changes it, which also ends editing — so this never reseeds mid-drag.
  useEffect(() => {
    editBoxRef.current = editing ? { ...sel.box } : null;
    position();
  }, [editing, sel.box, position]);

  // Drag a corner handle: move its two edges by the cursor delta (÷scale → content px),
  // clamped so the box keeps a min size (no inversion). Reports the working box up; the
  // parent applies it on ✓. stopPropagation isn't strictly needed (handles are siblings
  // of the map viewport, not children) but keeps intent clear + pointer capture clean.
  const onHandleDown = (cx: 'x0' | 'x1', cy: 'y0' | 'y1') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    editDragRef.current = { cx, cy, sx: e.clientX, sy: e.clientY, box0: { ...(editBoxRef.current ?? sel.box) } };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = editDragRef.current;
    const view = getView();
    if (!d || !view) return;
    e.stopPropagation();
    const dx = (e.clientX - d.sx) / view.scale;
    const dy = (e.clientY - d.sy) / view.scale;
    const nb: Box = { ...d.box0 };
    if (d.cx === 'x0') nb.x0 = Math.min(d.box0.x0 + dx, d.box0.x1 - EDIT_MIN);
    else nb.x1 = Math.max(d.box0.x1 + dx, d.box0.x0 + EDIT_MIN);
    if (d.cy === 'y0') nb.y0 = Math.min(d.box0.y0 + dy, d.box0.y1 - EDIT_MIN);
    else nb.y1 = Math.max(d.box0.y1 + dy, d.box0.y0 + EDIT_MIN);
    editBoxRef.current = nb;
    onBoundsChange(sel.id, nb);
    position();
  };
  const onHandleUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    editDragRef.current = null;
  };

  return (
    <>
      {/* Leader from the source box to the callout panel (positioned imperatively).
          Covers the map layer; pointer-events none so it never blocks the map. */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
        <line ref={leaderRef} stroke={sel.color} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.5} />
      </svg>
      <div
        ref={overlayRef}
        style={{
          position: 'absolute',
          border: `2px dashed ${sel.color}`,
          background: loaded ? 'transparent' : `${sel.color}22`,
          borderRadius: 2,
          pointerEvents: 'none',
          // While editing this shows the PRIOR bounds, lightly: dimmed + no drop shadow.
          boxShadow: editing ? 'none' : '0 0 0 1px rgba(0,0,0,0.45)',
          opacity: editing ? 0.4 : 1,
        }}
      />
      {/* Bounds-edit: the NEW-bounds outline + 4 draggable corner handles, tracking the
          working box (positioned imperatively in position()). Solid, full-color. */}
      {editing && (
        <>
          <div
            ref={editOutlineRef}
            style={{
              position: 'absolute',
              border: `2px solid ${sel.color}`,
              borderRadius: 2,
              pointerEvents: 'none',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.55)',
              zIndex: 4,
            }}
          />
          {EDIT_CORNERS.map(([cx, cy], i) => (
            <div
              key={i}
              ref={[h0, h1, h2, h3][i]}
              onPointerDown={onHandleDown(cx, cy)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerLeave={onHandleUp}
              title="Drag to resize this area"
              style={{
                position: 'absolute',
                width: 12,
                height: 12,
                marginLeft: -6,
                marginTop: -6,
                borderRadius: 3,
                background: '#fff',
                border: `2px solid ${sel.color}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.6)',
                // TL/BR resize on the NW–SE diagonal; TR/BL on the NE–SW diagonal.
                cursor: (cx === 'x0') === (cy === 'y0') ? 'nwse-resize' : 'nesw-resize',
                touchAction: 'none',
                zIndex: 5,
              }}
            />
          ))}
        </>
      )}
      <div
        ref={panelRef}
        style={{
          position: 'absolute',
          border: `1.5px solid ${sel.color}`,
          borderRadius: 6,
          boxShadow: '0 6px 22px rgba(0,0,0,0.55)',
          overflow: 'hidden',
          background: '#18181b',
          // Locked → pointer-transparent: pan/zoom/clicks fall through to the map,
          // and the panel can't be dragged.
          pointerEvents: sel.locked ? 'none' : 'auto',
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
            {sel.name}
          </span>
          {sel.locked ? (
            <span style={{ padding: '0 2px' }} title="Locked (unlock in the Areas menu)">🔒</span>
          ) : (
            <span
              onPointerDown={(e) => { e.stopPropagation(); onClose(sel.id); }}
              style={{ cursor: 'pointer', padding: '0 2px' }}
              title="Remove detail area"
            >
              ✕
            </span>
          )}
        </div>
        <div
          ref={bodyRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          style={{ position: 'absolute', inset: '16px 0 0 0', touchAction: 'none', cursor: sel.locked ? 'default' : 'grab' }}
        />
      </div>
    </>
  );
}
