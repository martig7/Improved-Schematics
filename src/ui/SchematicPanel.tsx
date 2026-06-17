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
import {
  generateSchematicSVG,
  precomputeSmoothedSchematic,
  drawSmoothedSchematic,
  type SmoothedPrecomputed,
} from '../render/schematic';
import { resolveStationGroupsFromGameState } from '../render/layout/graph';
import type { RenderMode } from '../render/types';
import { generateGeography } from '../geography/geography';
import type { GeographyData } from '../geography/types';
import type { BoundingBox } from '../types/core';
import { computeBounds, padBounds } from '../render/projection';
import { modState, PANEL_STORAGE_KEY } from '../state';

const api = window.SubwayBuilderAPI;

const GEO_SIZE = 2700; // canvas size for geo/smoothed — matches schematic's typical
                       // pixel scale so line widths/labels look proportional.
const MIN_SCALE = 0.01; // screen px per content unit
const MAX_SCALE = 12;

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'geographic', label: 'Geographic' },
  { id: 'smoothed', label: 'Smoothed' },
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

// Persists the generated smoothed map across mode switches AND panel close, so
// switching to geographic or reopening the panel doesn't discard it. Keyed by
// city; replaced only by an explicit (Re)generate.
let smoothedStore: { city: string; pre: SmoothedPrecomputed | string } | null = null;

export function SchematicPanel() {
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Smoothed mode runs the expensive LOOM octi pipeline, so it renders on
  // demand: entering the mode shows a Generate Map button instead of building
  // immediately. `smoothedReady` opens the gate; `genMs` is how long the last
  // build took, surfaced as "Finished in X.XXs".
  const [smoothedReady, setSmoothedReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Brief spinner shown while a labels/stations toggle forces an SVG re-render.
  const [rerendering, setRerendering] = useState(false);
  const [genMs, setGenMs] = useState<number | null>(null);
  const genMsRef = useRef<number | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const strokeNodes = useRef<Scaled[]>([]);
  const labelGroups = useRef<Element[]>([]);
  const viewRef = useRef<View | null>(null);
  const svgBoxRef = useRef<SvgBox>({ w: GEO_SIZE, h: GEO_SIZE });
  // The rect that Fit/export crop to: the renderer's `data-frame` (the geography
  // water/green extent in pixel space) when present, else the full intrinsic
  // canvas. Decoupled from svgBoxRef, which stays the full canvas for pan/zoom.
  const fitBoxRef = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: GEO_SIZE, h: GEO_SIZE });

  // Tile-derived geography (water + parks) for the current city, harvested from
  // the game's MapLibre vector tiles on first open. Undefined = no backdrop.
  const [geography, setGeography] = useState<GeographyData | undefined>(undefined);
  // True while the tile harvest is in flight, so the top bar can show the small
  // spinner — the geographic map's backdrop (water/parks) loads asynchronously.
  const [geoLoading, setGeoLoading] = useState(false);
  useEffect(() => {
    const city = modState.cityCode ?? api.utils.getCityCode?.();
    if (!city) return;
    // Harvest extent = bbox of the demand points (the populated city), so we grab
    // tiles where people actually are. Fall back to the station centroid extent.
    let harvestBbox: BoundingBox | null = null;
    const demand = api.gameState.getDemandData?.();
    if (demand && demand.points.size > 0) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const p of demand.points.values()) {
        const [lng, lat] = p.location;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
      harvestBbox = padBounds([minLng, minLat, maxLng, maxLat], 0.1);
    }
    if (!harvestBbox) {
      const b = computeBounds(api.gameState.getStations().map((s) => ({ points: [s.coords] })));
      if (!b) return; // no demand data and no stations yet → nothing to harvest
      harvestBbox = padBounds(b, 0.15);
    }
    let alive = true;
    setGeoLoading(true);
    generateGeography(city, harvestBbox).then(
      (g) => {
        if (!alive) return;
        if (g) setGeography(g);
        setGeoLoading(false);
      },
      () => {
        if (alive) setGeoLoading(false);
      },
    );
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

  // Dump the exact live render inputs, so in-game artifacts can be reproduced
  // offline bit-for-bit (geojson reconstructions drift from the live save and
  // the game's station grouping). storage.set silently drops multi-MB payloads,
  // so deliver as a browser download instead — triggered on demand via the
  // "input dump" control rather than auto-downloading when the panel opens.
  const [dumpStatus, setDumpStatus] = useState<string | null>(null);
  const downloadDump = useCallback(() => {
    try {
      const payload = JSON.stringify({
        at: new Date().toISOString(),
        stationGroups: resolveStationGroupsFromGameState(api.gameState),
        routes: api.gameState.getRoutes(),
        tracks: api.gameState.getTracks(),
        stations: api.gameState.getStations(),
        // geography sets the projection BOUNDS (geoFramePts → computeBounds), so
        // it must be captured or an offline repro projects the network into
        // different bounds → a different octi layout than the game produces.
        geography,
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
      setDumpStatus(`${(payload.length / 1e6).toFixed(1)}MB`);
    } catch (err) {
      setDumpStatus('failed: ' + String(err));
    }
  }, [geography]);

  // Per-mount cache of the expensive smoothed layout, hydrated from smoothedStore
  // (which persists across mounts). Reused for label/station toggles so those are
  // a cheap redraw; cleared by (Re)generate to force a fresh octi run.
  const smoothedCacheRef = useRef<{ pre: SmoothedPrecomputed | string } | null>(null);

  // View-preservation: the inject effect re-fits only when the layout identity
  // changes (mode switch, (re)generation, or water reframe), and keeps the
  // current pan/zoom when only labels/stations toggle (same layout redrawn).
  const layoutIdRef = useRef<unknown>(null);
  const lastLayoutIdRef = useRef<unknown>(undefined);
  const geoIdRef = useRef<{ mode: RenderMode; geography: GeographyData | undefined } | null>(null);

  const svg = useMemo(() => {
    const dark = api.ui.getResolvedTheme() === 'dark';
    // The game exposes its real station groups (spatial-proximity-merged
    // platforms, used by the in-game SchematicMapMenu) via an undocumented
    // method. Falls back to trackGroupId grouping if absent or empty.
    const buildInput = () => ({
      routes: api.gameState.getRoutes(),
      tracks: api.gameState.getTracks(),
      stations: api.gameState.getStations(),
      stationGroups: resolveStationGroupsFromGameState(api.gameState),
      geography,
      options: { mode, width: GEO_SIZE, height: GEO_SIZE, showStations, showLabels, dark },
    });

    if (mode === 'smoothed') {
      // Stay blank until the user clicks Generate Map.
      if (!smoothedReady) {
        genMsRef.current = null;
        layoutIdRef.current = 'smoothed-blank';
        return '';
      }
      const currentCity = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
      let cache = smoothedCacheRef.current;
      // Hydrate from the persistent store on a fresh mount / after a mode switch,
      // so a previously generated map shows instantly without rebuilding.
      if (!cache && smoothedStore && smoothedStore.city === currentCity) {
        cache = { pre: smoothedStore.pre };
        smoothedCacheRef.current = cache;
        genMsRef.current = null;
      }
      // Run the heavy octi pipeline only when there's no cache (a fresh
      // (Re)generate cleared it). Label/station toggles fall through to the
      // cheap redraw below, reusing the cached layout.
      if (!cache) {
        const t0 = performance.now();
        cache = { pre: precomputeSmoothedSchematic(buildInput()) };
        smoothedCacheRef.current = cache;
        smoothedStore = { city: currentCity, pre: cache.pre };
        genMsRef.current = performance.now() - t0;
      }
      // The cache object is stable across label/station toggles — exactly the
      // identity the inject effect needs.
      layoutIdRef.current = cache;
      const pre = cache.pre;
      return typeof pre === 'string' ? pre : drawSmoothedSchematic(pre, { showLabels, showStations });
    }

    // Geographic/schematic: cheap enough to fully render on every change. Its
    // layout identity depends only on mode + water (stable across toggles).
    genMsRef.current = null;
    if (!geoIdRef.current || geoIdRef.current.mode !== mode || geoIdRef.current.geography !== geography) {
      geoIdRef.current = { mode, geography };
    }
    layoutIdRef.current = geoIdRef.current;
    return generateSchematicSVG(buildInput());
  }, [mode, showStations, showLabels, geography, smoothedReady]);

  // Save the generated SVG cropped to the frame (data-frame = the geography
  // water/green extent), so the file outlines it — content outside is clipped by
  // the viewBox. Falls back to the full canvas when there's no frame.
  const downloadSvg = useCallback(() => {
    if (!svg) return;
    let out = svg;
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const fr = root.getAttribute('data-frame')?.split(/\s+/).map(Number);
    if (fr && fr.length === 4 && fr[2] > 0 && fr[3] > 0) {
      root.setAttribute('viewBox', `${fr[0]} ${fr[1]} ${fr[2]} ${fr[3]}`);
      root.setAttribute('width', String(fr[2]));
      root.setAttribute('height', String(fr[3]));
      root.removeAttribute('data-frame');
      out = new XMLSerializer().serializeToString(root);
    }
    const blob = new Blob([out], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `improvedschematics-${mode}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [svg, mode]);

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
    // Frame the fit box (geography water/green extent, or full canvas as
    // fallback), not the whole canvas — so the default view hugs the map.
    const { x: FX, y: FY, w: FW, h: FH } = fitBoxRef.current;
    const scale = clamp(Math.min(VPW / FW, VPH / FH) || 1, MIN_SCALE, MAX_SCALE);
    viewRef.current = {
      scale,
      vx: FX + FW / 2 - VPW / (2 * scale),
      vy: FY + FH / 2 - VPH / (2 * scale),
    };
    applyToDom(true);
  }, [applyToDom]);

  // Rebuild the smoothed map from current game state, discarding the stored one.
  const regenerate = useCallback(() => {
    smoothedCacheRef.current = null;
    smoothedStore = null;
    setSmoothedReady(false);
    setGenerating(true);
  }, []);

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
      // Fit/export frame: the geography water/green extent in pixel space
      // (data-frame="x y w h"), emitted by the renderer. Absent → full canvas.
      const fr = svgEl.getAttribute('data-frame')?.split(/\s+/).map(Number);
      fitBoxRef.current =
        fr && fr.length === 4 && fr[2] > 0 && fr[3] > 0
          ? { x: fr[0], y: fr[1], w: fr[2], h: fr[3] }
          : { x: 0, y: 0, w, h };
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
    // Preserve the current pan/zoom when only the SVG CONTENT changed (a
    // label/station toggle redraws the SAME layout). Re-fit only when the
    // layout identity changes — mode switch, (re)generation, or water reframe.
    if (viewRef.current && layoutIdRef.current === lastLayoutIdRef.current) {
      applyToDom(true); // re-apply existing viewBox + counter-scale the new nodes
    } else {
      fit();
    }
    lastLayoutIdRef.current = layoutIdRef.current;
    // Surface the smoothed build time (geographic renders are cheap + auto).
    setGenMs(mode === 'smoothed' ? genMsRef.current : null);
    // The map is in the DOM now — drop the generating spinner.
    if (svg) setGenerating(false);
  }, [svg, mode, fit, applyToDom]);

  // Re-fit on mode switch (different layout shape). When a generated map is stored
  // for this city, re-enter the generating flow rather than opening the gate
  // outright: redrawing the cached layout back in still runs the (synchronous)
  // ribbon render, so the big loading overlay should cover it. Keeping the gate
  // closed + generating=true lets the generating→double-rAF→smoothedReady effect
  // paint the spinner first, then flip the gate to trigger the draw. With no
  // stored map it just shows the Generate Map button.
  useEffect(() => {
    const currentCity = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
    const hasStored = mode === 'smoothed' && !!smoothedStore && smoothedStore.city === currentCity;
    setSmoothedReady(false);
    setGenerating(hasStored);
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [mode, fit]);

  // After the Generate Map click, paint the spinner for at least one frame
  // before the synchronous octi pipeline blocks the thread (double rAF
  // guarantees a committed, composited frame first). The rotation is a
  // transform animation, so the compositor keeps it spinning while JS blocks.
  useEffect(() => {
    if (!generating || smoothedReady) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSmoothedReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [generating, smoothedReady]);

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

  // Labels/stations toggles recompute the SVG synchronously. Flash the small
  // spinner first — the double rAF guarantees a composited frame before the
  // redraw blocks the thread — then apply the toggle.
  const rerenderStartRef = useRef(0);
  const requestToggle = useCallback((apply: () => void) => {
    rerenderStartRef.current = performance.now();
    setRerendering(true);
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }, []);

  // Drop the spinner once the toggle has been applied + drawn (keyed on the
  // toggles, so it clears even when the redraw produced no SVG change). The
  // redraw is near-instant, so hold the spinner for a short MIN so it's actually
  // perceptible instead of flashing for one frame.
  useEffect(() => {
    const MIN_MS = 450;
    const wait = Math.max(0, MIN_MS - (performance.now() - rerenderStartRef.current));
    const t = setTimeout(() => setRerendering(false), wait);
    return () => clearTimeout(t);
  }, [showLabels, showStations]);

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
        {/* Spinner keyframes — defined once here so both the small rerender
            spinner and the generating overlay can use it regardless of mode. */}
        <style>{`@keyframes imp-spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ display: 'flex', gap: 4 }}>
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} style={toggleStyle(mode === m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <span style={{ opacity: 0.4 }}>|</span>
        <button onClick={() => requestToggle(() => setShowStations((v) => !v))} style={toggleStyle(showStations)}>
          {showStations ? '✓ Stations' : 'Stations'}
        </button>
        <button onClick={() => requestToggle(() => setShowLabels((v) => !v))} style={toggleStyle(showLabels)}>
          {showLabels ? '✓ Labels' : 'Labels'}
        </button>
        {mode === 'smoothed' && smoothedReady && !generating && (
          <button onClick={regenerate} style={toggleStyle(false)} title="Rebuild the smoothed map from current game state">
            ↻ Regenerate
          </button>
        )}
        {(rerendering || geoLoading) && (
          <span
            title={geoLoading ? 'Loading map…' : 'Rerendering…'}
            aria-label={geoLoading ? 'Loading map' : 'Rerendering'}
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              flex: '0 0 auto',
              borderRadius: '50%',
              border: '2px solid rgba(136, 136, 136, 0.3)',
              borderTopColor: '#888',
              animation: 'imp-spin 0.8s linear infinite',
              willChange: 'transform',
            }}
          />
        )}
        <span style={{ flex: 1 }} />
        {mode === 'smoothed' && genMs != null && (
          <span style={{ color: '#888', fontSize: 11 }}>
            Finished in {(genMs / 1000).toFixed(2)}s
          </span>
        )}
        {mode === 'smoothed' && (
          <span style={{ opacity: 0.35, fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            input dump
            <button
              onClick={downloadDump}
              title="Download the live render inputs as JSON"
              style={{
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
                color: 'inherit',
                lineHeight: 1,
              }}
            >
              ↓
            </button>
            {dumpStatus ? ` ${dumpStatus}` : ''}
          </span>
        )}
        {/* Build marker: proves which bundle the game actually loaded. */}
        <span style={{ opacity: 0.35, fontSize: 10 }}>v1.1.0</span>
        {svg && !generating && (
          <button onClick={downloadSvg} style={toggleStyle(false)} title="Download as SVG">
            ↓ SVG
          </button>
        )}
        <button onClick={fit} style={toggleStyle(false)} title="Fit to view">
          ⤢ Fit
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onDoubleClick={fit}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            borderRadius: 6,
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        />
        {mode === 'smoothed' && !smoothedReady && !generating && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <button
              onClick={() => {
                // Fresh build: drop any cached/stored layout from a prior generation.
                smoothedCacheRef.current = null;
                smoothedStore = null;
                setGenerating(true);
              }}
              style={{
                background: '#ffffff',
                color: '#1a1a1a',
                border: 'none',
                borderRadius: 10,
                padding: '12px 24px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
              }}
            >
              Generate Map
            </button>
          </div>
        )}
        {mode === 'smoothed' && generating && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '3px solid rgba(136, 136, 136, 0.3)',
                borderTopColor: '#888',
                animation: 'imp-spin 0.8s linear infinite',
                willChange: 'transform',
              }}
            />
            <span style={{ color: '#888', fontSize: 12 }}>This may take a while</span>
            <style>{`@keyframes imp-spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
      </div>
    </div>
  );
}
