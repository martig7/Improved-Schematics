/**
 * SchematicPanel — the in-game floating panel that renders the improved
 * schematic from live game state.
 *
 * Generates an SVG string with useMemo (following the game's own
 * SchematicMapMenu pattern) and injects it into a pan/zoom viewport. Zoom is
 * done via the SVG's viewBox (map-style: the layout spreads while stroke widths
 * and label text stay a constant on-screen size — counter-scaled by 1/zoom).
 * A mode selector switches renderers; labels and station markers are toggleable.
 * Water is loaded from the city's ocean_depth_index on first open.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { generateSchematicSVG } from '../render/schematic';
import type { RenderMode, WaterCollection } from '../render/types';
import { generateWater } from '../water/oceanIndex';
import { modState } from '../state';

const api = window.SubwayBuilderAPI;

const GEO_SIZE = 2700; // canvas size for geo/smoothed — matches schematic's typical
                       // pixel scale so line widths/labels look proportional.
const MIN_SCALE = 0.01; // screen px per content unit
const MAX_SCALE = 12;

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'geographic', label: 'Geographic' },
  { id: 'smoothed', label: 'Smoothed' },
  { id: 'schematic', label: 'Schematic' },
];

interface View {
  scale: number; // screen px per content unit
  vx: number; // content x at viewport left
  vy: number; // content y at viewport top
}
interface Scaled {
  el: Element;
  base: number;
}
interface SvgBox {
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function SchematicPanel() {
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const strokeNodes = useRef<Scaled[]>([]);
  const labelGroups = useRef<Element[]>([]);
  const viewRef = useRef<View | null>(null);
  const svgBoxRef = useRef<SvgBox>({ w: GEO_SIZE, h: GEO_SIZE });

  // Water for the current city, loaded from its ocean_depth_index on first open.
  const [water, setWater] = useState<WaterCollection | undefined>(undefined);
  useEffect(() => {
    const city = modState.cityCode ?? api.utils.getCityCode?.();
    if (!city) return;
    let alive = true;
    generateWater(city).then((wc) => {
      if (alive && wc) setWater(wc);
    });
    return () => {
      alive = false;
    };
  }, []);

  const svg = useMemo(() => {
    const routes = api.gameState.getRoutes();
    const tracks = api.gameState.getTracks();
    const stations = api.gameState.getStations();
    // The game exposes its real station groups (spatial-proximity-merged
    // platforms, used by the in-game SchematicMapMenu) via an undocumented
    // method. Falls back to trackGroupId grouping if absent or empty.
    const gs = (api.gameState as unknown as { getStationGroups?: () => unknown[] }).getStationGroups;
    const stationGroups = typeof gs === 'function' ? gs.call(api.gameState) : undefined;
    if (stationGroups) {
      // Diagnostic: once per render, log group count + a sample shape.
      const sample = (stationGroups as unknown[])[0];
      console.log(
        '[ImprovedSchematics] stationGroups:',
        (stationGroups as unknown[]).length,
        'sample:',
        sample ? Object.keys(sample as object) : '(empty)',
      );
    }
    const dark = api.ui.getResolvedTheme() === 'dark';
    return generateSchematicSVG({
      routes,
      tracks,
      stations,
      stationGroups,
      water,
      options: { mode, width: GEO_SIZE, height: GEO_SIZE, showStations, showLabels, dark },
    });
  }, [mode, showStations, showLabels, water]);

  // Push the current view to the DOM. `updateSizes` counter-scales stroke/font
  // (only needed when the zoom changes, not on pure pans).
  const applyToDom = useCallback((updateSizes: boolean) => {
    const svgEl = svgRef.current;
    const vp = viewportRef.current;
    const view = viewRef.current;
    if (!svgEl || !vp || !view) return;
    const w = vp.clientWidth / view.scale;
    const h = vp.clientHeight / view.scale;
    svgEl.setAttribute('viewBox', `${view.vx} ${view.vy} ${w} ${h}`);
    if (updateSizes) {
      const inv = 1 / view.scale;
      for (const n of strokeNodes.current) n.el.setAttribute('stroke-width', String(n.base * inv));
      // Labels are pinned to their dot; counter-scale keeps text + offset constant size.
      const lblTransform = `scale(${inv})`;
      for (const g of labelGroups.current) g.setAttribute('transform', lblTransform);
    }
  }, []);

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const VPW = vp.clientWidth;
    const VPH = vp.clientHeight;
    if (!VPW || !VPH) return;
    const { w: SW, h: SH } = svgBoxRef.current;
    const scale = Math.min(VPW / SW, VPH / SH) || 1;
    viewRef.current = {
      scale,
      vx: SW / 2 - VPW / (2 * scale),
      vy: SH / 2 - VPH / (2 * scale),
    };
    applyToDom(true);
  }, [applyToDom]);

  // Inject SVG, take over its sizing, cache the elements we counter-scale.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.innerHTML = svg;
    const svgEl = vp.querySelector('svg');
    svgRef.current = svgEl;
    if (svgEl) {
      // Capture intrinsic SVG bounds BEFORE we overwrite viewBox.
      const vb = svgEl.getAttribute('viewBox')?.split(/\s+/).map(Number);
      const w = vb && vb.length === 4 ? vb[2] : parseFloat(svgEl.getAttribute('width') || '') || GEO_SIZE;
      const h = vb && vb.length === 4 ? vb[3] : parseFloat(svgEl.getAttribute('height') || '') || GEO_SIZE;
      svgBoxRef.current = { w, h };
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', '100%');
      svgEl.style.display = 'block';
      strokeNodes.current = [...svgEl.querySelectorAll('[stroke-width]')].map((el) => ({
        el,
        base: parseFloat(el.getAttribute('stroke-width') || '1') || 1,
      }));
      labelGroups.current = [...svgEl.querySelectorAll('.imp-lbl-s')];
    }
    // Always re-fit when the SVG (and therefore its bounds) changes.
    fit();
  }, [svg, fit, applyToDom]);

  // Re-fit on mode switch (different layout shape).
  useEffect(() => {
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [mode, fit]);

  // Wheel zoom toward the cursor (native + non-passive so it can preventDefault).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      if (!view) return;
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const contentX = view.vx + cx / view.scale;
      const contentY = view.vy + cy / view.scale;
      const scale = clamp(view.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      viewRef.current = { scale, vx: contentX - cx / scale, vy: contentY - cy / scale };
      applyToDom(true);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [applyToDom]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const view = viewRef.current;
    if (!dragging || !view) return;
    viewRef.current = { ...view, vx: view.vx - e.movementX / view.scale, vy: view.vy - e.movementY / view.scale };
    applyToDom(false);
  };
  const endDrag = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const toggleStyle = (active: boolean) => ({
    fontSize: 12,
    padding: '2px 8px',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
    opacity: active ? 1 : 0.7,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} style={toggleStyle(mode === m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <span style={{ opacity: 0.4 }}>|</span>
        <button onClick={() => setShowStations((v) => !v)} style={toggleStyle(showStations)}>
          {showStations ? '✓ Stations' : 'Stations'}
        </button>
        <button onClick={() => setShowLabels((v) => !v)} style={toggleStyle(showLabels)}>
          {showLabels ? '✓ Labels' : 'Labels'}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={fit} style={toggleStyle(false)} title="Fit to view">
          ⤢ Fit
        </button>
      </div>
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onDoubleClick={fit}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
          borderRadius: 6,
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />
    </div>
  );
}
