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
import { resolveStationGroupsFromGameState } from '../render/layout/graph';
import type { RenderMode, WaterCollection } from '../render/types';
import { generateWater } from '../water/oceanIndex';
import { modState, PANEL_STORAGE_KEY } from '../state';

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
  const [showGrid, setShowGrid] = useState(false);
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

  // Drop the game's persisted panel size/position when the panel closes, so
  // the next open uses our defaults instead of the last user-resized state.
  useEffect(() => {
    return () => {
      try {
        localStorage.removeItem(PANEL_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    };
  }, []);

  // One-shot dump of the exact live render inputs, so in-game artifacts can
  // be reproduced offline bit-for-bit (geojson reconstructions drift from the
  // live save and the game's station grouping). storage.set silently drops
  // multi-MB payloads, so deliver as a browser download instead.
  const dumpedInputs = useRef(false);
  const [dumpStatus, setDumpStatus] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'smoothed' || dumpedInputs.current) return;
    dumpedInputs.current = true;
    try {
      const payload = JSON.stringify({
        at: new Date().toISOString(),
        stationGroups: resolveStationGroupsFromGameState(api.gameState),
        routes: api.gameState.getRoutes(),
        tracks: api.gameState.getTracks(),
        stations: api.gameState.getStations(),
      });
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'improvedschematics-input.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setDumpStatus(`input dump ↓ ${(payload.length / 1e6).toFixed(1)}MB`);
    } catch (err) {
      setDumpStatus('dump failed: ' + String(err));
    }
  }, [mode]);

  const svg = useMemo(() => {
    const routes = api.gameState.getRoutes();
    const tracks = api.gameState.getTracks();
    const stations = api.gameState.getStations();
    // The game exposes its real station groups (spatial-proximity-merged
    // platforms, used by the in-game SchematicMapMenu) via an undocumented
    // method. Falls back to trackGroupId grouping if absent or empty.
    const stationGroups = resolveStationGroupsFromGameState(api.gameState);
    const dark = api.ui.getResolvedTheme() === 'dark';
    return generateSchematicSVG({
      routes,
      tracks,
      stations,
      stationGroups,
      water,
      options: { mode, width: GEO_SIZE, height: GEO_SIZE, showStations, showLabels, showGrid, dark },
    });
  }, [mode, showStations, showLabels, showGrid, water]);

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
      // Counter-scale strokes that should stay a constant SCREEN size with
      // zoom (station rings, transfer brackets, grid overlay). Exclude route
      // strokes (paths under <g class="edges">) — those need to scale with the
      // viewport so adjacent lanes stay edge-to-edge flush at every zoom level.
      // If we counter-scaled them too, lane spacing (baked into geometry, in
      // world units) would stay put while stroke width shrank → visible gaps
      // between bundled lines as the user zooms in.
      // Station markers (.imp-stop) are pure map objects: geometry AND stroke
      // stay in world units so capsules/dots scale exactly with the route
      // lines at every zoom. (Counter-scaling their strokes made capsules
      // look skinny next to fattening lines when zoomed in; counter-scaling
      // the whole marker made them gigantic relative to the map when zoomed
      // out.) Only rings/brackets/grid outside both groups counter-scale.
      strokeNodes.current = [...svgEl.querySelectorAll('[stroke-width]')]
        .filter((el) => !el.closest('.edges') && !el.closest('.imp-stop'))
        .map((el) => ({
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
        {mode === 'smoothed' && (
          <button
            onClick={() => setShowGrid((v) => !v)}
            style={toggleStyle(showGrid)}
            title="Overlay the Hanan routing grid (diagnostic)"
          >
            {showGrid ? '✓ Grid' : 'Grid'}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {/* Build marker: proves which bundle the game actually loaded. */}
        <span style={{ opacity: 0.35, fontSize: 10 }}>
          v0.2.39{dumpStatus ? ` · ${dumpStatus}` : ''}
        </span>
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
