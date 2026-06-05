/**
 * SchematicPanel — the in-game floating panel that renders the improved
 * schematic from live game state.
 *
 * Generates an SVG string with useMemo (following the game's own
 * SchematicMapMenu pattern), then injects it via innerHTML into a transform
 * layer inside a pan/zoom viewport (drag to pan, wheel to zoom toward the
 * cursor, double-click to fit). A mode selector switches between the geographic,
 * smoothed, and octilinear (schematic) renderers; labels and station markers are
 * toggleable. Water is loaded from the city's ocean_depth_index on first open.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { generateSchematicSVG } from '../render/schematic';
import type { RenderMode, WaterCollection } from '../render/types';
import { generateWater } from '../water/oceanIndex';
import { modState } from '../state';

const api = window.SubwayBuilderAPI;

const SVG_SIZE = 900; // intrinsic SVG width/height we render at
const MIN_SCALE = 0.1;
const MAX_SCALE = 12;

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'geographic', label: 'Geographic' },
  { id: 'smoothed', label: 'Smoothed' },
  { id: 'schematic', label: 'Schematic' },
];

interface View {
  x: number;
  y: number;
  scale: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function SchematicPanel() {
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(true);
  const [showLabels, setShowLabels] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  const applyView = useCallback((v: View) => {
    viewRef.current = v;
    setView(v);
  }, []);
  const [dragging, setDragging] = useState(false);

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
    const dark = api.ui.getResolvedTheme() === 'dark';

    return generateSchematicSVG({
      routes,
      tracks,
      stations,
      water,
      options: { mode, width: SVG_SIZE, height: SVG_SIZE, showStations, showLabels, dark },
    });
  }, [mode, showStations, showLabels, water]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.innerHTML = svg;
  }, [svg]);

  // Center + scale the SVG to fit the viewport.
  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (vw === 0 || vh === 0) return;
    const scale = Math.min(vw / SVG_SIZE, vh / SVG_SIZE) || 1;
    applyView({ x: (vw - SVG_SIZE * scale) / 2, y: (vh - SVG_SIZE * scale) / 2, scale });
  }, [applyView]);

  // Fit on first mount and whenever the layout changes shape (mode switch).
  useEffect(() => {
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [mode, fit]);

  // Wheel zoom toward the cursor. Attached natively so it can be non-passive
  // (React onWheel is passive and can't preventDefault the page scroll).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const v = viewRef.current;
      const scale = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      const k = scale / v.scale;
      applyView({ x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, scale });
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [applyView]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const v = viewRef.current;
    applyView({ ...v, x: v.x + e.movementX, y: v.y + e.movementY });
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
      >
        <div
          ref={contentRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        />
      </div>
    </div>
  );
}
