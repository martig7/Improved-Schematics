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
import { DetailInset, SEL_COLORS, type Selection, type ExportDescriptor } from './DetailInset';
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
// Box-warp strength: the LOCAL dense-core expansion (densityBoxWarp). 0 (center)
// = the tuned default (expand 4 / growth 1.2). MULTIPLICATIVE in the slider
// position (each step scales by a constant), so the control is symmetric and
// uses its full range: right (stylized) magnifies crowded hubs up to expand 16 /
// growth 3.0 — the useful ceiling (past ~16 the extra distortion reintroduces
// boxes); left (realistic) eases the box warp toward off (expand → 1). [-1, +1].
const boxExpandFromPos = (p: number) => Math.max(1, 4 * Math.pow(4, p));
const boxGrowthFromPos = (p: number) => Math.max(1, 1.2 * Math.pow(2.5, p));

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
  // Area-select ("Draw area"): a mode where a pointer drag rubber-bands a box in
  // MAP/content space (so it tracks pan + zoom) instead of panning. The live drag
  // is imperative (boxRef + the overlay div) to match the pan/zoom model that
  // bypasses React; on release it commits to a `selections` entry.
  const [drawMode, setDrawMode] = useState(false);
  // Each committed selection spawns a persistent, color-coded DetailInset (its own
  // outline on the map + a draggable re-sim panel). They live until closed. The
  // live drag is still imperative (boxRef + the draw overlay) to match the pan/zoom
  // model that bypasses React; each inset positions itself via a registered fn.
  const [selections, setSelections] = useState<Selection[]>([]);
  const selCountRef = useRef(0); // monotonic, for id + color cycling
  // The detail-areas manager popover: rename / recolor / delete each selection.
  const [areasOpen, setAreasOpen] = useState(false);
  const areasRef = useRef<HTMLDivElement>(null);
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
  const [boxWarpPos, setBoxWarpPos] = useState(DEFAULT_REALISM_POS);
  const [applied, setApplied] = useState({
    lineWidth: DEFAULT_LINE_WIDTH,
    stationRadius: DEFAULT_STATION_RADIUS,
    mapMargin: DEFAULT_MAP_MARGIN,
    warpPos: DEFAULT_REALISM_POS,
    linePos: DEFAULT_REALISM_POS,
    boxWarpPos: DEFAULT_REALISM_POS,
  });
  const appearanceDirty =
    applied.lineWidth !== lineWidth ||
    applied.stationRadius !== stationRadius ||
    applied.mapMargin !== mapMargin ||
    applied.warpPos !== warpPos ||
    applied.linePos !== linePos ||
    applied.boxWarpPos !== boxWarpPos;
  // True when both the draft sliders and the applied values are already at the
  // defaults — nothing for Reset to do.
  const appearanceAtDefaults =
    lineWidth === DEFAULT_LINE_WIDTH &&
    stationRadius === DEFAULT_STATION_RADIUS &&
    mapMargin === DEFAULT_MAP_MARGIN &&
    warpPos === DEFAULT_REALISM_POS &&
    linePos === DEFAULT_REALISM_POS &&
    boxWarpPos === DEFAULT_REALISM_POS &&
    applied.lineWidth === DEFAULT_LINE_WIDTH &&
    applied.stationRadius === DEFAULT_STATION_RADIUS &&
    applied.mapMargin === DEFAULT_MAP_MARGIN &&
    applied.warpPos === DEFAULT_REALISM_POS &&
    applied.linePos === DEFAULT_REALISM_POS &&
    applied.boxWarpPos === DEFAULT_REALISM_POS;
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
  // Area-select: source-of-truth box in content coords (read by the imperative
  // overlay positioner so it survives pan/zoom), the drag origin, and the overlay.
  const boxRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const boxOverlayRef = useRef<HTMLDivElement>(null);
  // Each mounted DetailInset registers a reposition fn here so applyToDom can keep
  // every inset + its outline glued to the map through pan/zoom.
  const repositionFns = useRef(new Map<string, () => void>());
  // ...and an export-descriptor getter, so the download can bake the panels in.
  const exportFns = useRef(new Map<string, () => ExportDescriptor | null>());
  // Build marker — fires once when the panel mounts so the game's dev console
  // proves which bundle loaded. Bump the tag each iteration. NOTE: the "Draw
  // area" button only shows in SMOOTHED mode after Generate Map.
  useEffect(() => {
    console.log(
      '%c[improved-schematics] BUILD popout-box-p13 (areas UI fixes) loaded ✦ — panels clipped to the map (no toolbar overlap → ≣ Areas manager works), leader lines now drawn in the live viewer too',
      'color:#38bdf8;font-weight:bold;font-size:13px',
    );
  }, []);

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
      const dark = api.ui.getResolvedTheme() === 'dark';
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
        // The live render options (mode + appearance sliders, applied values),
        // mirroring buildInput().options below, so an offline repro reproduces
        // the user's current settings instead of the script's hardcoded ones.
        // Derived values (warpAlpha/geographicAffinity/theme) are baked in so a
        // script can pass `options` straight through without re-deriving them.
        options: {
          mode,
          showStations,
          showLabels,
          dark,
          padding: applied.mapMargin,
          warpAlpha: warpAlphaFromPos(applied.warpPos),
          geographicAffinity: affinityFromPos(applied.linePos),
          boxExpand: boxExpandFromPos(applied.boxWarpPos),
          boxGrowth: boxGrowthFromPos(applied.boxWarpPos),
          theme: {
            ...(dark ? DARK_THEME : DEFAULT_THEME),
            lineWidth: applied.lineWidth,
            stationRadius: applied.stationRadius,
          },
        },
        // Export-time controls (raster scale, JPEG quality, chosen format) —
        // not render inputs, but captured so scripts can match the exported file.
        exportOptions: { format: exportFormat, rasterScale, jpegQuality },
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
  }, [geography, mode, showStations, showLabels, applied, exportFormat, rasterScale, jpegQuality]);

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

  // The game exposes its real station groups (spatial-proximity-merged platforms,
  // used by the in-game SchematicMapMenu) via an undocumented method; falls back
  // to trackGroupId grouping if absent. Extracted to a callback so the magnifier
  // inset can build the SAME input to crop + re-simulate a sub-network.
  const buildInput = useCallback(() => {
    const dark = api.ui.getResolvedTheme() === 'dark';
    return {
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
        boxExpand: boxExpandFromPos(applied.boxWarpPos),
        boxGrowth: boxGrowthFromPos(applied.boxWarpPos),
        theme: {
          ...(dark ? DARK_THEME : DEFAULT_THEME),
          lineWidth: applied.lineWidth,
          stationRadius: applied.stationRadius,
        },
      },
    };
  }, [geography, mode, showStations, showLabels, applied]);

  const svg = useMemo(() => {
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
  }, [mode, showStations, showLabels, geography, smoothedReady, applied, buildInput]);

  // Crop the generated SVG to the frame (data-frame = the geography water/green
  // extent), so exports outline it — content outside is clipped by the viewBox.
  // Falls back to the full canvas when there's no frame. Returns the serialized
  // markup plus the pixel dimensions raster exports need.
  const buildExportSvg = useCallback((): { markup: string; width: number; height: number } | null => {
    if (!svg) return null;
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const vb = root.getAttribute('viewBox')?.split(/\s+/).map(Number);
    const canvasW = (vb && vb.length === 4 ? vb[2] : parseFloat(root.getAttribute('width') || '')) || GEO_SIZE;
    const canvasH = (vb && vb.length === 4 ? vb[3] : parseFloat(root.getAttribute('height') || '')) || GEO_SIZE;
    const fr = root.getAttribute('data-frame')?.split(/\s+/).map(Number);
    const frame =
      fr && fr.length === 4 && fr[2] > 0 && fr[3] > 0
        ? { x: fr[0], y: fr[1], w: fr[2], h: fr[3] }
        : { x: 0, y: 0, w: canvasW, h: canvasH };

    // Gather the live detail areas (panel rect + rendered sub-map + frame) paired
    // with each box/color/name.
    const areas = selections
      .map((s) => { const d = exportFns.current.get(s.id)?.(); return d ? { s, ...d } : null; })
      .filter((a): a is { s: Selection } & ExportDescriptor => a !== null);

    // No areas → original behaviour: crop to the geography frame.
    if (areas.length === 0) {
      root.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.w} ${frame.h}`);
      root.setAttribute('width', String(frame.w));
      root.setAttribute('height', String(frame.h));
      root.removeAttribute('data-frame');
      return { markup: new XMLSerializer().serializeToString(root), width: frame.w, height: frame.h };
    }

    // --- compose: main map (areas cut out) + outlines + leaders + callout panels,
    //     exactly as the on-screen overlay (and dev/_ingame.ts) draws them ---
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dark = api.ui.getResolvedTheme() === 'dark';
    const bg = dark ? '#18181b' : '#ffffff';

    // Union cutout on the main map's route/stop/label groups (geography untouched).
    const BIG = Math.max(canvasW, canvasH) * 100;
    let dPath = `M${-BIG} ${-BIG}H${BIG}V${BIG}H${-BIG}Z`;
    for (const a of areas) dPath += `M${a.s.box.x0} ${a.s.box.y0}H${a.s.box.x1}V${a.s.box.y1}H${a.s.box.x0}Z`;
    const cutDefs = `<defs><clipPath id="imp-export-cut" clipPathUnits="userSpaceOnUse"><path d="${dPath}" clip-rule="evenodd"/></clipPath></defs>`;
    let main = svg.replace(/ data-frame="[^"]*"/, '').replace(/(<svg[^>]*>)/, `$1${cutDefs}`);
    for (const cls of ['edges', 'stops', 'stations']) main = main.replace(`<g class="${cls}">`, `<g class="${cls}" clip-path="url(#imp-export-cut)">`);
    const mainInner = main.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

    // Composite extent = geography frame ∪ panel rects (+ margin).
    let x0 = frame.x, y0 = frame.y, x1 = frame.x + frame.w, y1 = frame.y + frame.h;
    for (const a of areas) { x0 = Math.min(x0, a.rect.x); y0 = Math.min(y0, a.rect.y); x1 = Math.max(x1, a.rect.x + a.rect.w); y1 = Math.max(y1, a.rect.y + a.rect.h); }
    const m = Math.max(canvasW, canvasH) * 0.02;
    x0 -= m; y0 -= m; x1 += m; y1 += m;
    const EW = x1 - x0, EH = y1 - y0;
    const stroke = EW * 0.0016, dash = EW * 0.006;

    const parts: string[] = [`<rect x="${x0}" y="${y0}" width="${EW}" height="${EH}" fill="${bg}"/>`, mainInner];
    for (const a of areas) {
      const cx = (a.s.box.x0 + a.s.box.x1) / 2, cy = (a.s.box.y0 + a.s.box.y1) / 2;
      const px = a.rect.x < cx ? a.rect.x + a.rect.w : a.rect.x;
      parts.push(`<line x1="${cx}" y1="${cy}" x2="${px}" y2="${a.rect.y + a.rect.h / 2}" stroke="${a.s.color}" stroke-width="${stroke * 0.7}" stroke-dasharray="${dash * 0.5} ${dash * 0.5}" opacity="0.5"/>`);
    }
    for (const a of areas) {
      const b = a.s.box;
      parts.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="3" fill="none" stroke="${a.s.color}" stroke-width="${stroke}" stroke-dasharray="${dash} ${dash}"/>`);
    }
    for (const a of areas) {
      const r = a.rect, gf = a.gf;
      const headerH = r.w * 0.06, fontPx = headerH * 0.58;
      const label = a.s.name.trim() ? a.s.name.trim() : 'DETAIL';
      const nested = a.subSvg.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" x="${r.x}" y="${r.y + headerH}" width="${r.w}" height="${r.h - headerH}" viewBox="${gf.x} ${gf.y} ${gf.w} ${gf.h}" preserveAspectRatio="xMidYMid meet">`);
      parts.push(
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${bg}" stroke="${a.s.color}" stroke-width="${r.w * 0.006}"/>`,
        nested,
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${headerH}" fill="${a.s.color}" opacity="0.32"/>`,
        `<text x="${r.x + headerH * 0.4}" y="${r.y + headerH * 0.7}" font-family="sans-serif" font-size="${fontPx}" font-weight="600" fill="${dark ? '#e5e5e5' : '#1a1a1a'}">◳ ${esc(label)}</text>`,
      );
    }

    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${EW} ${EH}" width="${EW}" height="${EH}">${parts.join('')}</svg>`;
    return { markup, width: EW, height: EH };
  }, [svg, selections]);

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

  // Position the area-select overlay div from the content box + current view, so
  // the box stays glued to its map region through pan/zoom. Hidden when no box.
  const positionBox = useCallback(() => {
    const el = boxOverlayRef.current;
    const view = viewRef.current;
    const b = boxRef.current;
    if (!el || !view) return;
    if (!b) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${(b.x0 - view.vx) * view.scale}px`;
    el.style.top = `${(b.y0 - view.vy) * view.scale}px`;
    el.style.width = `${(b.x1 - b.x0) * view.scale}px`;
    el.style.height = `${(b.y1 - b.y0) * view.scale}px`;
  }, []);

  // DetailInset plumbing: each inset reads the live view through this and registers
  // its reposition fn, so pan/zoom keeps every inset + outline glued to the map.
  const getView = useCallback(() => viewRef.current, []);
  const getMainPre = useCallback(() => smoothedCacheRef.current?.pre ?? null, []);
  const registerReposition = useCallback((id: string, fn: (() => void) | null) => {
    if (fn) repositionFns.current.set(id, fn);
    else repositionFns.current.delete(id);
  }, []);
  const registerExport = useCallback((id: string, fn: (() => ExportDescriptor | null) | null) => {
    if (fn) exportFns.current.set(id, fn);
    else exportFns.current.delete(id);
  }, []);
  const closeSelection = useCallback((id: string) => {
    repositionFns.current.delete(id);
    exportFns.current.delete(id);
    setSelections((xs) => xs.filter((s) => s.id !== id));
  }, []);
  // Edit a selection's color/name in place. Spreads `s` so `box` keeps its identity
  // — the DetailInset re-sim effect keys on `box`, so this never re-simulates.
  const updateSelection = useCallback((id: string, patch: Partial<Selection>) => {
    setSelections((xs) => xs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);
  const clearSelections = useCallback(() => {
    repositionFns.current.clear();
    exportFns.current.clear();
    setSelections([]);
  }, []);

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
    positionBox();
    for (const fn of repositionFns.current.values()) fn();
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
      // A different layout (mode switch, regen, city/water reframe) invalidates the
      // detail areas — their boxes are in the old layout's coords. Drop them.
      if (lastLayoutIdRef.current) clearSelections();
    }
    lastLayoutIdRef.current = layoutIdRef.current;
    // Surface the smoothed build time (geographic renders are cheap + auto).
    setGenMs(mode === 'smoothed' ? genMsRef.current : null);
    // The map is in the DOM now — drop the generating spinner.
    if (svg) setGenerating(false);
  }, [svg, mode, fit, applyToDom, clearSelections]);

  // The cutout depends only on the box GEOMETRY, so key the effect on that — not
  // the whole `selections` array — so editing a color/name doesn't rebuild (and
  // briefly flash) the clip on every keystroke.
  const cutoutKey = selections.map((s) => `${s.box.x0},${s.box.y0},${s.box.x1},${s.box.y1}`).join('|');
  // While any selections are active, "cut out" their areas from the MAIN map:
  // clip the route, stop and label layers to everything EXCEPT the drawn boxes, so
  // the lines and stations inside them disappear (each Detail inset shows that
  // region instead) while the geography backdrop — a separate, unclipped layer —
  // stays visible under the boxes. Runs after the inject effect (shares the `svg`
  // dep), so a content redraw re-applies it; cleared when the selections go away.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const NS = 'http://www.w3.org/2000/svg';
    const groups = ['.edges', '.stops', '.stations']
      .map((s) => svgEl.querySelector<SVGGElement>(s))
      .filter((g): g is SVGGElement => !!g);
    const clear = () => {
      svgEl.querySelector('defs.imp-cutout')?.remove();
      for (const g of groups) g.removeAttribute('clip-path');
    };
    clear();
    if (selections.length === 0) return;
    // Even-odd clip: a big outer rect (covers all content at any pan/zoom) minus
    // every selection box → keep everything OUTSIDE the boxes. clipPathUnits is
    // user space, so the boxes (content coords) stay glued to their map regions.
    const box = svgBoxRef.current ?? { w: GEO_SIZE, h: GEO_SIZE };
    const BIG = Math.max(box.w, box.h) * 100;
    let d = `M${-BIG} ${-BIG}H${BIG}V${BIG}H${-BIG}Z`;
    for (const s of selections) d += `M${s.box.x0} ${s.box.y0}H${s.box.x1}V${s.box.y1}H${s.box.x0}Z`;
    const defs = document.createElementNS(NS, 'defs');
    defs.setAttribute('class', 'imp-cutout');
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', 'imp-cutout-clip');
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('clip-rule', 'evenodd');
    clip.appendChild(path);
    defs.appendChild(clip);
    svgEl.insertBefore(defs, svgEl.firstChild);
    for (const g of groups) g.setAttribute('clip-path', 'url(#imp-cutout-clip)');
    return clear;
    // selections read inside is fine: cutoutKey changes whenever any box changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutoutKey, svg]);

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

  // (Each DetailInset runs its own re-simulation — see DetailInset.tsx.)

  // Screen (client) px -> map/content coords, via the current view.
  const screenToContent = (clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    const view = viewRef.current;
    if (!vp || !view) return null;
    const rect = vp.getBoundingClientRect();
    return { x: view.vx + (clientX - rect.left) / view.scale, y: view.vy + (clientY - rect.top) / view.scale };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (drawMode) {
      const c = screenToContent(e.clientX, e.clientY);
      if (!c) return;
      drawStartRef.current = c;
      boxRef.current = { x0: c.x, y0: c.y, x1: c.x, y1: c.y };
      positionBox();
      return;
    }
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drawMode && drawStartRef.current) {
      const c = screenToContent(e.clientX, e.clientY);
      if (!c) return;
      const s = drawStartRef.current;
      boxRef.current = { x0: Math.min(s.x, c.x), y0: Math.min(s.y, c.y), x1: Math.max(s.x, c.x), y1: Math.max(s.y, c.y) };
      positionBox();
      return;
    }
    const view = viewRef.current;
    if (!dragging || !view) return;
    viewRef.current = { ...view, vx: view.vx - e.movementX / view.scale, vy: view.vy - e.movementY / view.scale };
    applyToDom(false);
  };
  const endDrag = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (drawMode && drawStartRef.current) {
      drawStartRef.current = null;
      const b = boxRef.current;
      boxRef.current = null;
      positionBox(); // hide the live draw box; a committed selection gets its own outline
      // Commit only a real drag; a click (tiny box) just cancels. Each commit
      // spawns a new color-cycled DetailInset that persists until closed.
      if (b && b.x1 - b.x0 > 3 && b.y1 - b.y0 > 3) {
        const n = selCountRef.current++;
        setSelections((xs) => [...xs, { id: `sel-${n}`, box: b, color: SEL_COLORS[n % SEL_COLORS.length], name: '' }]);
      }
      return;
    }
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

  // Same for the detail-areas manager popover.
  useEffect(() => {
    if (!areasOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!areasRef.current?.contains(e.target as Node)) setAreasOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [areasOpen]);

  // Drop the manager open-state once there's nothing to manage (its button
  // unmounts), so it doesn't auto-reopen when the next area is drawn.
  useEffect(() => {
    if (selections.length === 0) setAreasOpen(false);
  }, [selections.length]);

  const toggleStyle = (active: boolean) => ({
    fontSize: 12,
    padding: '2px 8px',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
    opacity: active ? 1 : 0.7,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {/* position+zIndex so the toolbar (and its popovers) always stack above the
          map layer's detail-area panels. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
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
        <span style={{ opacity: 0.35, fontSize: 10 }}>v1.2.9 · areas-ui-fixes</span>
        {mode === 'smoothed' && smoothedReady && (
          <button
            onClick={() => setDrawMode((v) => !v)}
            style={toggleStyle(drawMode)}
            title="Draw a box on the map to select an area"
          >
            {drawMode ? '▭ Drawing…' : '▭ Draw area'}
          </button>
        )}
        {selections.length > 0 && (
          <div ref={areasRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setAreasOpen((v) => !v)}
              style={toggleStyle(areasOpen)}
              title="Manage detail areas — rename, recolor, delete"
              aria-expanded={areasOpen}
            >
              ≣ Areas ({selections.length})
            </button>
            {areasOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  zIndex: 10,
                  width: 290,
                  maxHeight: 360,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 12,
                  borderRadius: 8,
                  background: api.ui.getResolvedTheme() === 'dark' ? '#27272a' : '#ffffff',
                  color: api.ui.getResolvedTheme() === 'dark' ? '#e4e4e7' : '#1a1a1a',
                  border: '1px solid rgba(136,136,136,0.35)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', opacity: 0.55 }}>
                  Detail areas
                </span>
                {selections.map((s, i) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {SEL_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => updateSelection(s.id, { color: c })}
                          title={`Color ${c}`}
                          aria-label={`Set color ${c}`}
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            padding: 0,
                            background: c,
                            cursor: 'pointer',
                            border: s.color === c ? '2px solid #fff' : '1px solid rgba(0,0,0,0.35)',
                            boxShadow: s.color === c ? '0 0 0 1px rgba(0,0,0,0.4)' : 'none',
                          }}
                        />
                      ))}
                    </div>
                    <input
                      value={s.name}
                      placeholder="DETAIL"
                      onChange={(e) => updateSelection(s.id, { name: e.target.value })}
                      title={`Name for area ${i + 1} (blank shows “DETAIL”)`}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        padding: '3px 6px',
                        borderRadius: 4,
                        border: '1px solid rgba(136,136,136,0.4)',
                        background: 'transparent',
                        color: 'inherit',
                      }}
                    />
                    <button
                      onClick={() => closeSelection(s.id)}
                      title="Delete this area"
                      aria-label="Delete this area"
                      style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', opacity: 0.65, fontSize: 14, padding: '0 2px', flexShrink: 0 }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => { clearSelections(); setAreasOpen(false); }}
                  style={{ ...toggleStyle(false), alignSelf: 'flex-start', marginTop: 2 }}
                  title="Delete all detail areas"
                >
                  ✕ Clear all
                </button>
              </div>
            )}
          </div>
        )}
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
                  <Slider
                    label="Box warp"
                    value={boxWarpPos}
                    min={-1}
                    max={1}
                    step={0.1}
                    display={boxWarpPos === 0 ? 'Default' : boxWarpPos < 0 ? 'Realistic' : 'Stylized'}
                    onChange={setBoxWarpPos}
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
                    setBoxWarpPos(DEFAULT_REALISM_POS);
                    setApplied({
                      lineWidth: DEFAULT_LINE_WIDTH,
                      stationRadius: DEFAULT_STATION_RADIUS,
                      mapMargin: DEFAULT_MAP_MARGIN,
                      warpPos: DEFAULT_REALISM_POS,
                      linePos: DEFAULT_REALISM_POS,
                      boxWarpPos: DEFAULT_REALISM_POS,
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
                    setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos, boxWarpPos });
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
                    // Explicit theme colors (not `inherit`): the native option
                    // list popup ignores inherited color, so in dark mode it
                    // renders as light-on-light unless set on the option itself.
                    background: api.ui.getResolvedTheme() === 'dark' ? '#27272a' : '#ffffff',
                    color: api.ui.getResolvedTheme() === 'dark' ? '#e4e4e7' : '#1a1a1a',
                    cursor: 'pointer',
                  }}
                >
                  {FORMATS.map((f) => (
                    <option
                      key={f.id}
                      value={f.id}
                      style={{
                        background: api.ui.getResolvedTheme() === 'dark' ? '#27272a' : '#ffffff',
                        color: api.ui.getResolvedTheme() === 'dark' ? '#e4e4e7' : '#1a1a1a',
                      }}
                    >
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
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
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
            cursor: drawMode ? 'crosshair' : dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        />
        {/* Live draw box (in progress): positioned imperatively (positionBox) in
            content space so it tracks pan/zoom. Neutral white; on commit it becomes
            a color-cycled DetailInset. pointerEvents none so drags pass through. */}
        <div
          ref={boxOverlayRef}
          style={{
            position: 'absolute',
            display: 'none',
            border: '2px dashed rgba(255,255,255,0.9)',
            background: 'rgba(255,255,255,0.10)',
            borderRadius: 2,
            pointerEvents: 'none',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
          }}
        />
        {/* One persistent, color-coded detail area per committed selection: a
            colored outline over its map region + a draggable re-sim panel. */}
        {selections.map((s) => (
          <DetailInset
            key={s.id}
            sel={s}
            getView={getView}
            registerReposition={registerReposition}
            getMainPre={getMainPre}
            buildInput={buildInput}
            baseSvg={svg}
            showStations={showStations}
            showLabels={showLabels}
            onClose={closeSelection}
            registerExport={registerExport}
          />
        ))}
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
