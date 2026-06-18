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
import { DEFAULT_THEME, DARK_THEME } from '../render/types';
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

type ExportFormat = 'svg' | 'png' | 'jpeg';

// Render/export tunables exposed as sliders in the settings popover. The first
// three feed the renderer via SchematicOptions (theme.lineWidth, theme
// .stationRadius, padding); the last two are applied during raster export.
const DEFAULT_LINE_WIDTH = 4; // matches DEFAULT_THEME.lineWidth
const DEFAULT_STATION_RADIUS = 2.5; // matches DEFAULT_THEME.stationRadius
const DEFAULT_MAP_MARGIN = 0.06; // matches DEFAULT_OPTIONS.padding
const DEFAULT_RASTER_SCALE = 2; // upscale factor for crisp PNG/JPEG
const DEFAULT_JPEG_QUALITY = 0.92;

// Smoothed-mode "realism" sliders run on a normalized [-1, +1] position where 0
// is the tuned default (center), -1 is the most geographically realistic, and +1
// the most stylized. These map a position to the actual LOOM parameters.
const DEFAULT_REALISM_POS = 0;
// Warp strength: realistic (left) = less warp; default 0.8; stylized (right) =
// more warp. Linear so 0 → 0.8.
const warpAlphaFromPos = (p: number) => Math.max(0, 0.8 * (1 + p));
// Geographic-course affinity: realistic (left) = stronger course-keeping (up to
// ~0.15); default 0.05; stylized (right) = freely octilinear (→ 0).
const affinityFromPos = (p: number) => (p <= 0 ? 0.05 - 0.1 * p : 0.05 * (1 - p));

const FORMATS: { id: ExportFormat; label: string; ext: string; mime: string }[] = [
  { id: 'svg', label: 'SVG (vector)', ext: 'svg', mime: 'image/svg+xml' },
  { id: 'png', label: 'PNG (image)', ext: 'png', mime: 'image/png' },
  { id: 'jpeg', label: 'JPEG (image)', ext: 'jpg', mime: 'image/jpeg' },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Labeled range slider for the settings popover. `display` is the formatted
// current value shown to the right of the label.
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const { label, value, min, max, step, display, onChange, disabled } = props;
  return (
    <label
      style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, opacity: disabled ? 0.45 : 1 }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.85 }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', cursor: disabled ? 'default' : 'pointer', accentColor: '#2563eb' }}
      />
    </label>
  );
}

// Persists the generated smoothed map across mode switches AND panel close, so
// switching to geographic or reopening the panel doesn't discard it. Keyed by
// city; replaced only by an explicit (Re)generate.
let smoothedStore: { city: string; pre: SmoothedPrecomputed | string } | null = null;

export function SchematicPanel() {
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Export controls live in a small settings popover opened via the gear icon in
  // the top-right of the panel. The chosen format drives the Download button.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('svg');
  const settingsRef = useRef<HTMLDivElement>(null);
  // Render tunables (line/station/margin feed the renderer; raster scale +
  // JPEG quality apply at export time). The appearance sliders edit DRAFT values
  // freely; only Save commits them to `applied`, which is what the renderer reads
  // — so dragging a slider doesn't trigger an (expensive) re-render mid-drag.
  const [lineWidth, setLineWidth] = useState(DEFAULT_LINE_WIDTH);
  const [stationRadius, setStationRadius] = useState(DEFAULT_STATION_RADIUS);
  const [mapMargin, setMapMargin] = useState(DEFAULT_MAP_MARGIN);
  // Smoothed-mode realism positions in [-1, +1] (0 = default). These bake into
  // the expensive precompute, so they ride the same draft→Save flow and a Save
  // in smoothed mode regenerates the layout.
  const [warpPos, setWarpPos] = useState(DEFAULT_REALISM_POS);
  const [linePos, setLinePos] = useState(DEFAULT_REALISM_POS);
  const [applied, setApplied] = useState({
    lineWidth: DEFAULT_LINE_WIDTH,
    stationRadius: DEFAULT_STATION_RADIUS,
    mapMargin: DEFAULT_MAP_MARGIN,
    warpPos: DEFAULT_REALISM_POS,
    linePos: DEFAULT_REALISM_POS,
  });
  const appearanceDirty =
    applied.lineWidth !== lineWidth ||
    applied.stationRadius !== stationRadius ||
    applied.mapMargin !== mapMargin ||
    applied.warpPos !== warpPos ||
    applied.linePos !== linePos;
  // True when both the draft sliders and the applied values are already at the
  // defaults — nothing for Reset to do.
  const appearanceAtDefaults =
    lineWidth === DEFAULT_LINE_WIDTH &&
    stationRadius === DEFAULT_STATION_RADIUS &&
    mapMargin === DEFAULT_MAP_MARGIN &&
    warpPos === DEFAULT_REALISM_POS &&
    linePos === DEFAULT_REALISM_POS &&
    applied.lineWidth === DEFAULT_LINE_WIDTH &&
    applied.stationRadius === DEFAULT_STATION_RADIUS &&
    applied.mapMargin === DEFAULT_MAP_MARGIN &&
    applied.warpPos === DEFAULT_REALISM_POS &&
    applied.linePos === DEFAULT_REALISM_POS;
  const [rasterScale, setRasterScale] = useState(DEFAULT_RASTER_SCALE);
  const [jpegQuality, setJpegQuality] = useState(DEFAULT_JPEG_QUALITY);
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
      options: {
        mode,
        width: GEO_SIZE,
        height: GEO_SIZE,
        showStations,
        showLabels,
        dark,
        padding: applied.mapMargin,
        warpAlpha: warpAlphaFromPos(applied.warpPos),
        geographicAffinity: affinityFromPos(applied.linePos),
        theme: {
          ...(dark ? DARK_THEME : DEFAULT_THEME),
          lineWidth: applied.lineWidth,
          stationRadius: applied.stationRadius,
        },
      },
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
  }, [mode, showStations, showLabels, geography, smoothedReady, applied]);

  // Crop the generated SVG to the frame (data-frame = the geography water/green
  // extent), so exports outline it — content outside is clipped by the viewBox.
  // Falls back to the full canvas when there's no frame. Returns the serialized
  // markup plus the pixel dimensions raster exports need.
  const buildExportSvg = useCallback((): { markup: string; width: number; height: number } | null => {
    if (!svg) return null;
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const vb = root.getAttribute('viewBox')?.split(/\s+/).map(Number);
    let width = (vb && vb.length === 4 ? vb[2] : parseFloat(root.getAttribute('width') || '')) || GEO_SIZE;
    let height = (vb && vb.length === 4 ? vb[3] : parseFloat(root.getAttribute('height') || '')) || GEO_SIZE;
    const fr = root.getAttribute('data-frame')?.split(/\s+/).map(Number);
    if (fr && fr.length === 4 && fr[2] > 0 && fr[3] > 0) {
      root.setAttribute('viewBox', `${fr[0]} ${fr[1]} ${fr[2]} ${fr[3]}`);
      root.setAttribute('width', String(fr[2]));
      root.setAttribute('height', String(fr[3]));
      root.removeAttribute('data-frame');
      width = fr[2];
      height = fr[3];
    }
    return { markup: new XMLSerializer().serializeToString(root), width, height };
  }, [svg]);

  // Trigger a browser download for a generated blob.
  const triggerDownload = useCallback((blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `improvedschematics-${mode}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [mode]);

  // Export the current map in the chosen format. SVG is the serialized markup
  // verbatim; PNG/JPEG rasterize that markup onto an upscaled canvas. JPEG has no
  // alpha channel, so the canvas is first flooded with the theme background (the
  // SVG's own land rect covers the full canvas, but this guards rounding edges).
  const downloadImage = useCallback(() => {
    const built = buildExportSvg();
    if (!built) return;
    const fmt = FORMATS.find((f) => f.id === exportFormat) ?? FORMATS[0];
    if (fmt.id === 'svg') {
      triggerDownload(new Blob([built.markup], { type: fmt.mime }), fmt.ext);
      return;
    }
    const svgUrl = URL.createObjectURL(new Blob([built.markup], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(built.width * rasterScale));
      canvas.height = Math.max(1, Math.round(built.height * rasterScale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(svgUrl);
        return;
      }
      if (fmt.id === 'jpeg') {
        ctx.fillStyle = api.ui.getResolvedTheme() === 'dark' ? '#18181b' : '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob(
        (blob) => {
          if (blob) triggerDownload(blob, fmt.ext);
        },
        fmt.mime,
        jpegQuality,
      );
    };
    img.onerror = () => URL.revokeObjectURL(svgUrl);
    img.src = svgUrl;
  }, [buildExportSvg, exportFormat, triggerDownload, rasterScale, jpegQuality]);

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

  // Close the settings popover when clicking anywhere outside it (or its gear).
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [settingsOpen]);

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
        <span style={{ opacity: 0.35, fontSize: 10 }}>v1.2.0</span>
        <button onClick={fit} style={toggleStyle(false)} title="Fit to view">
          ⤢ Fit
        </button>
        {/* Settings gear (top-right): opens a popover with the export-format
            dropdown + Download button. */}
        <div ref={settingsRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            style={{ ...toggleStyle(settingsOpen), fontSize: 16, lineHeight: 1 }}
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >
            ⚙
          </button>
          {settingsOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 6,
                zIndex: 10,
                minWidth: 230,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: 12,
                borderRadius: 8,
                background: api.ui.getResolvedTheme() === 'dark' ? '#27272a' : '#ffffff',
                color: api.ui.getResolvedTheme() === 'dark' ? '#e4e4e7' : '#1a1a1a',
                border: '1px solid rgba(136,136,136,0.35)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              }}
            >
              {/* Appearance — feeds the renderer live in Geographic mode;
                  applies to Smoothed on the next Regenerate. */}
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', opacity: 0.55 }}>
                Appearance
              </span>
              <Slider
                label="Line thickness"
                value={lineWidth}
                min={1}
                max={8}
                step={0.5}
                display={`${lineWidth.toFixed(1)} px`}
                onChange={setLineWidth}
              />
              <Slider
                label="Station size"
                value={stationRadius}
                min={1}
                max={6}
                step={0.5}
                display={`${stationRadius.toFixed(1)} px`}
                onChange={setStationRadius}
              />
              <Slider
                label="Map margin"
                value={mapMargin}
                min={0}
                max={0.15}
                step={0.01}
                display={`${Math.round(mapMargin * 100)}%`}
                onChange={setMapMargin}
              />

              {/* Smoothed-mode realism. Centered sliders: left = more
                  geographically realistic, right = more stylized. They bake into
                  the layout, so Saving regenerates the smoothed map. */}
              {mode === 'smoothed' && (
                <>
                  <Slider
                    label="Geography warp"
                    value={warpPos}
                    min={-1}
                    max={1}
                    step={0.1}
                    display={warpPos === 0 ? 'Default' : warpPos < 0 ? 'Realistic' : 'Stylized'}
                    onChange={setWarpPos}
                  />
                  <Slider
                    label="Line accuracy"
                    value={linePos}
                    min={-1}
                    max={1}
                    step={0.1}
                    display={linePos === 0 ? 'Default' : linePos < 0 ? 'Realistic' : 'Stylized'}
                    onChange={setLinePos}
                  />
                </>
              )}

              {/* Sliders only stage values; Save commits them to the renderer,
                  Reset restores (and applies) the defaults. */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    setLineWidth(DEFAULT_LINE_WIDTH);
                    setStationRadius(DEFAULT_STATION_RADIUS);
                    setMapMargin(DEFAULT_MAP_MARGIN);
                    setWarpPos(DEFAULT_REALISM_POS);
                    setLinePos(DEFAULT_REALISM_POS);
                    setApplied({
                      lineWidth: DEFAULT_LINE_WIDTH,
                      stationRadius: DEFAULT_STATION_RADIUS,
                      mapMargin: DEFAULT_MAP_MARGIN,
                      warpPos: DEFAULT_REALISM_POS,
                      linePos: DEFAULT_REALISM_POS,
                    });
                    // Smoothed bakes these into the precompute → rebuild.
                    if (mode === 'smoothed' && smoothedReady) regenerate();
                  }}
                  disabled={appearanceAtDefaults}
                  title="Reset appearance to defaults"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    padding: '6px 10px',
                    borderRadius: 6,
                    cursor: appearanceAtDefaults ? 'default' : 'pointer',
                    opacity: appearanceAtDefaults ? 0.5 : 1,
                    background: 'transparent',
                    color: 'inherit',
                    border: '1px solid rgba(136,136,136,0.5)',
                  }}
                >
                  Reset
                </button>
                <button
                  onClick={() => {
                    setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos });
                    // Smoothed bakes these into the precompute → rebuild if shown.
                    if (mode === 'smoothed' && smoothedReady) regenerate();
                  }}
                  disabled={!appearanceDirty}
                  title={appearanceDirty ? 'Apply appearance changes' : 'No unsaved appearance changes'}
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: 600,
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: 'none',
                    cursor: appearanceDirty ? 'pointer' : 'default',
                    opacity: appearanceDirty ? 1 : 0.5,
                    background: '#2563eb',
                    color: '#ffffff',
                  }}
                >
                  {appearanceDirty ? 'Save changes' : 'Saved'}
                </button>
              </div>

              <div style={{ height: 1, background: 'rgba(136,136,136,0.3)', margin: '2px 0' }} />

              {/* Export */}
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', opacity: 0.55 }}>
                Export
              </span>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ opacity: 0.85 }}>Format</span>
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  style={{
                    fontSize: 12,
                    padding: '4px 6px',
                    borderRadius: 6,
                    border: '1px solid rgba(136,136,136,0.4)',
                    background: 'inherit',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  {FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* Resolution scales the rasterized PNG/JPEG; SVG is vector so it
                  ignores both. JPEG quality only applies to JPEG. */}
              <Slider
                label="Export resolution"
                value={rasterScale}
                min={1}
                max={4}
                step={1}
                display={`${rasterScale}×`}
                onChange={setRasterScale}
                disabled={exportFormat === 'svg'}
              />
              <Slider
                label="JPEG quality"
                value={jpegQuality}
                min={0.5}
                max={1}
                step={0.05}
                display={`${Math.round(jpegQuality * 100)}%`}
                onChange={setJpegQuality}
                disabled={exportFormat !== 'jpeg'}
              />
              <button
                onClick={downloadImage}
                disabled={!svg || generating}
                title={`Download map as ${exportFormat.toUpperCase()}`}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: !svg || generating ? 'default' : 'pointer',
                  opacity: !svg || generating ? 0.5 : 1,
                  background: '#2563eb',
                  color: '#ffffff',
                }}
              >
                ↓ Download {exportFormat.toUpperCase()}
              </button>
            </div>
          )}
        </div>
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
