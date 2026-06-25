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

import { useMemo, useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import {
  generateSchematicSVG,
  precomputeSmoothedSchematic,
  drawSmoothedSchematic,
  type SmoothedPrecomputed,
} from '../render/schematic';
import { DetailInset, SEL_COLORS, type Selection, type Box, type ExportDescriptor } from './DetailInset';
import { decideAreaAction } from './areaLifecycle';
import { Icon } from './icons';
import { serializeMap, deserializeMap } from '../render/persist';
import { resolveStationGroupsFromGameState } from '../render/layout/graph';
import { sceneFromSvg } from '../render/sceneFromSvg';
import { fingerprintInputs } from '../render/cacheFingerprint';
import { readCachedPre, writeCachedPre, peekCache, readSelections, writeSelections, readSettings, writeSettings, readModeSettings, writeModeSettings, pruneSubPres, readAllSubPres, writeAllSubPres, clearCityLayout } from '../render/mapCache';
import { cropSubgraph } from '../render/cropSubgraph';
import type { SceneOut } from '../render/renderOctilinear';
import { prepareScene, drawScene, type PreparedScene } from '../render/sceneCanvas';
import type { RenderMode } from '../render/types';
import { DEFAULT_THEME, DARK_THEME } from '../render/types';
import { peekGeography } from '../geography/geography';
import { warmGeography } from '../geography/warm';
import type { GeographyData } from '../geography/types';
import { modState, PANEL_STORAGE_KEY } from '../state';
import { MOD_VERSION } from '../version';

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

type ExportFormat = 'svg' | 'png' | 'jpeg';

// Render/export tunables exposed as sliders in the settings popover. The first
// three feed the renderer via SchematicOptions (theme.lineWidth, theme
// .stationRadius, padding); the last two are applied during raster export.
const DEFAULT_LINE_WIDTH = 4; // matches DEFAULT_THEME.lineWidth
const DEFAULT_STATION_RADIUS = 2.5; // matches DEFAULT_THEME.stationRadius
const DEFAULT_MAP_MARGIN = 0.06; // matches DEFAULT_OPTIONS.padding
// Labels render at a constant WORLD size — i.e. constant relative to the map
// image, scaling WITH zoom (like text printed on the map), not pinned to a fixed
// screen size. This multiplies that world size. Applied at DISPLAY time (canvas
// world font + SVG label transform + export), so changing it is instant.
const DEFAULT_LABEL_SCALE = 0.7;
const LABEL_SCALE_MIN = 0.2;
const LABEL_SCALE_MAX = 1.5;
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
// = the tuned default (expand 6 / growth 1.5). MULTIPLICATIVE in the slider
// position (each step scales by a constant), so the control is symmetric and
// uses its full range: right (stylized) magnifies crowded hubs up to expand 36 /
// growth 4.5 (box-rescue + the box density cutoff keep that strength usable);
// left (realistic) eases the box warp toward off (expand → 1). [-1, +1].
const boxExpandFromPos = (p: number) => Math.max(1, 6 * Math.pow(6, p));
const boxGrowthFromPos = (p: number) => Math.max(1, 1.5 * Math.pow(3, p));
// Box-warp density CUTOFF (densityBoxWarp `frac`): a cell joins a warp box when its
// smoothed density ≥ this fraction of the peak. Lower = looser cutoff → more/larger
// boxes (broader warping); higher = only the densest cores → fewer/smaller boxes. It
// bakes into the layout (which regions warp), so it rides the Apply/Save flow and is
// part of the fingerprint. A direct value in [BOX_FRAC_MIN, BOX_FRAC_MAX]; default 0.4.
const DEFAULT_BOX_FRAC = 0.4;
const BOX_FRAC_MIN = 0.1;
const BOX_FRAC_MAX = 0.8;

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

// Keep an absolutely-positioned popover (the top bar's Areas / Settings menus)
// inside the panel. These menus anchor to the RIGHT edge of their button and
// grow leftward, so when the panel is narrow and the top bar wraps the button
// near the left edge, a fixed-width menu opens past the panel's left edge and
// gets clipped. On open — and on panel/window resize — this measures the menu
// against the panel bounds and (a) caps its width/height to the panel, then
// (b) nudges it horizontally so neither edge spills out. `signature` re-runs the
// measure when the menu's own content changes size (e.g. areas added/removed).
function useClampedPopover(
  open: boolean,
  boundsRef: { current: HTMLElement | null },
  signature: string,
  desiredWidth: number,
  maxHeightCap = Infinity,
) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const M = 6; // gutter kept between the menu and the panel edge
    const adjust = () => {
      const br = (boundsRef.current ?? document.documentElement).getBoundingClientRect();
      // Width: never wider than the panel; shrink below the desired width only
      // when the panel genuinely can't fit it.
      const availW = Math.max(0, br.width - M * 2);
      el.style.transform = 'none';
      el.style.minWidth = `${Math.min(desiredWidth, availW)}px`;
      el.style.maxWidth = `${availW}px`;
      // Horizontal: pull in whichever edge spills past the panel.
      const pr = el.getBoundingClientRect();
      let dx = 0;
      if (pr.right > br.right - M) dx = br.right - M - pr.right;
      if (pr.left + dx < br.left + M) dx = br.left + M - pr.left;
      el.style.transform = dx ? `translateX(${dx}px)` : 'none';
      // Vertical: cap to the room below (within any design cap) so a tall menu
      // scrolls instead of spilling past the panel's bottom edge.
      const availH = Math.max(0, br.bottom - M - pr.top);
      el.style.maxHeight = `${Math.min(maxHeightCap, availH)}px`;
      el.style.overflowY = 'auto';
    };
    adjust();
    const bounds = boundsRef.current;
    const ro = bounds ? new ResizeObserver(adjust) : null;
    if (bounds) ro?.observe(bounds);
    window.addEventListener('resize', adjust);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', adjust);
    };
  }, [open, boundsRef, signature, desiredWidth, maxHeightCap]);
  return ref;
}

// The automatic map cache (localStorage :pre:/:svg:/:meta:, the in-memory
// smoothedStore, and the instant-restore) was TORN OUT — it was the source of the
// stale-render bugs. The generated layout now lives only in the per-mount
// smoothedCacheRef (so in-session toggles stay cheap); nothing is persisted
// automatically. The explicit Save/Load map FILE feature below is the only way to
// persist a generated map across reloads.

// Shape of the settings carried by a saved map FILE (read back in applyBundle).
type RestoredSettings = {
  showStations?: boolean;
  showLabels?: boolean;
  applied?: { lineWidth: number; stationRadius: number; mapMargin: number; warpPos: number; linePos: number; boxWarpPos: number; boxFrac?: number };
  rasterScale?: number;
  jpegQuality?: number;
  exportFormat?: ExportFormat;
  labelScale?: number;
};

export function SchematicPanel() {
  // Seed the appearance settings from the per-city cache (synchronous, tiny) so a
  // customized layout's fingerprint matches its cached `pre` → Generate hits, and its
  // detail areas restore. Read once at mount; benign UI prefs, so unconditional (the
  // `pre` stays fingerprint-gated). A saved map FILE still seeds via applyBundle.
  const mountSeed = useMemo(() => {
    const city = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
    // Shared (export prefs) + the per-MODE visual settings for the open mode (geographic).
    // The visual read falls back to the old shared blob so a pre-split cache migrates in.
    const shared = ((city ? (readSettings(city) as RestoredSettings | null) : null) ?? {}) as RestoredSettings;
    const geoVis = ((city ? (readModeSettings(city, 'geographic') as RestoredSettings | null) : null) ?? shared) as RestoredSettings;
    return { city, shared, geoVis };
  }, []);
  const mountCity = mountSeed.city; // the city these restored settings belong to
  // The city whose settings are CURRENTLY displayed. Starts as the mount city; a file load
  // (applyBundle) repoints it at the loaded file's city. The per-mode settings-persist effect
  // gates on this so loading a file for a DIFFERENT city than the live game can't clobber the
  // live city's saved settings with the loaded file's values.
  const settingsCityRef = useRef(mountCity);
  const rset = mountSeed.shared; // shared export prefs (rasterScale, jpegQuality, exportFormat)
  const rvis = mountSeed.geoVis; // per-mode visual settings for the open (geographic) mode
  const rapp = rvis.applied;
  // Always open in geographic mode; smoothed is the expensive mode and must be
  // entered explicitly (its Generate button), never auto-shown on open.
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(rvis.showStations ?? true);
  const [showLabels, setShowLabels] = useState(rvis.showLabels ?? false);
  // Debug overlay: outline the dense-core regions the box-warp magnified (pre.denseBoxesPx).
  // Display-only + in-session (defaults off, not persisted, not in the layout fingerprint);
  // mirrored to a ref so the dep-[] drawCanvas can read it.
  const [showWarpBoxes, setShowWarpBoxes] = useState(false);
  const showWarpBoxesRef = useRef(showWarpBoxes);
  showWarpBoxesRef.current = showWarpBoxes;
  const [dragging, setDragging] = useState(false);
  // Area-select ("Draw area"): a mode where a pointer drag rubber-bands a box in
  // MAP/content space (so it tracks pan + zoom) instead of panning. The live drag
  // is imperative (boxRef + the overlay div) to match the pan/zoom model that
  // bypasses React; on release it commits to a `selections` entry.
  const [drawMode, setDrawMode] = useState(false);
  // Which area (if any) is in bounds-edit mode: its DetailInset shows corner handles and
  // the menu row swaps the ✎ edit button for ✓/✗. Only one area edits at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Each committed selection spawns a persistent, color-coded DetailInset (its own
  // outline on the map + a draggable re-sim panel). They live until closed. The
  // live drag is still imperative (boxRef + the draw overlay) to match the pan/zoom
  // model that bypasses React; each inset positions itself via a registered fn.
  // Starts empty; a FILE load reinstates its saved areas via restoreSelectionsRef
  // (the inject effect installs them once the loaded layout is in the cache).
  const [selections, setSelections] = useState<Selection[]>([]);
  // monotonic, for id + color cycling.
  const selCountRef = useRef(0);
  // The detail-areas manager popover: rename / recolor / delete each selection.
  const [areasOpen, setAreasOpen] = useState(false);
  const areasRef = useRef<HTMLDivElement>(null);
  // Export controls live in a small settings popover opened via the gear icon in
  // the top-right of the panel. The chosen format drives the Download button.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(rset.exportFormat ?? 'svg');
  const settingsRef = useRef<HTMLDivElement>(null);
  // Save/Load a generated map to a file (skips the precompute on reload).
  const mapFileRef = useRef<HTMLInputElement>(null);
  const [mapMsg, setMapMsg] = useState<string | null>(null);
  // Render tunables (line/station/margin feed the renderer; raster scale +
  // JPEG quality apply at export time). The appearance sliders edit DRAFT values
  // freely; only Save commits them to `applied`, which is what the renderer reads
  // — so dragging a slider doesn't trigger an (expensive) re-render mid-drag.
  const [lineWidth, setLineWidth] = useState(rapp?.lineWidth ?? DEFAULT_LINE_WIDTH);
  const [stationRadius, setStationRadius] = useState(rapp?.stationRadius ?? DEFAULT_STATION_RADIUS);
  const [mapMargin, setMapMargin] = useState(rapp?.mapMargin ?? DEFAULT_MAP_MARGIN);
  // Smoothed-mode realism positions in [-1, +1] (0 = default). These bake into
  // the expensive precompute, so they ride the same draft→Save flow and a Save
  // in smoothed mode regenerates the layout.
  const [warpPos, setWarpPos] = useState(rapp?.warpPos ?? DEFAULT_REALISM_POS);
  const [linePos, setLinePos] = useState(rapp?.linePos ?? DEFAULT_REALISM_POS);
  const [boxWarpPos, setBoxWarpPos] = useState(rapp?.boxWarpPos ?? DEFAULT_REALISM_POS);
  // Box density cutoff (densityBoxWarp frac) — same draft→Save flow as the realism sliders.
  const [boxFrac, setBoxFrac] = useState(rapp?.boxFrac ?? DEFAULT_BOX_FRAC);
  const [applied, setApplied] = useState(
    rapp
      ? { ...rapp, boxFrac: rapp.boxFrac ?? DEFAULT_BOX_FRAC } // older files lack boxFrac → default it
      : {
          lineWidth: DEFAULT_LINE_WIDTH,
          stationRadius: DEFAULT_STATION_RADIUS,
          mapMargin: DEFAULT_MAP_MARGIN,
          warpPos: DEFAULT_REALISM_POS,
          linePos: DEFAULT_REALISM_POS,
          boxWarpPos: DEFAULT_REALISM_POS,
          boxFrac: DEFAULT_BOX_FRAC,
        },
  );
  const appearanceDirty =
    applied.lineWidth !== lineWidth ||
    applied.stationRadius !== stationRadius ||
    applied.mapMargin !== mapMargin ||
    applied.warpPos !== warpPos ||
    applied.linePos !== linePos ||
    applied.boxWarpPos !== boxWarpPos ||
    applied.boxFrac !== boxFrac;
  // True when both the draft sliders and the applied values are already at the
  // defaults — nothing for Reset to do.
  const appearanceAtDefaults =
    lineWidth === DEFAULT_LINE_WIDTH &&
    stationRadius === DEFAULT_STATION_RADIUS &&
    mapMargin === DEFAULT_MAP_MARGIN &&
    warpPos === DEFAULT_REALISM_POS &&
    linePos === DEFAULT_REALISM_POS &&
    boxWarpPos === DEFAULT_REALISM_POS &&
    boxFrac === DEFAULT_BOX_FRAC &&
    applied.lineWidth === DEFAULT_LINE_WIDTH &&
    applied.stationRadius === DEFAULT_STATION_RADIUS &&
    applied.mapMargin === DEFAULT_MAP_MARGIN &&
    applied.warpPos === DEFAULT_REALISM_POS &&
    applied.linePos === DEFAULT_REALISM_POS &&
    applied.boxWarpPos === DEFAULT_REALISM_POS &&
    applied.boxFrac === DEFAULT_BOX_FRAC;
  const [rasterScale, setRasterScale] = useState(rset.rasterScale ?? DEFAULT_RASTER_SCALE);
  const [jpegQuality, setJpegQuality] = useState(rset.jpegQuality ?? DEFAULT_JPEG_QUALITY);
  // Label size multiplier (live, display-time — see DEFAULT_LABEL_SCALE). Mirrored
  // into a ref so the dep-[] draw callbacks read the current value without being
  // rebuilt on every slider tick.
  const [labelScale, setLabelScale] = useState(rvis.labelScale ?? DEFAULT_LABEL_SCALE);
  const labelScaleRef = useRef(labelScale);
  labelScaleRef.current = labelScale;
  // Smoothed mode runs the expensive LOOM octi pipeline, so it renders on
  // demand: entering the mode shows a Generate Map button instead of building
  // immediately. `smoothedReady` opens the gate; `genMs` is how long the last
  // build took, surfaced as "Finished in X.XXs". Starts false: smoothed always
  // opens on the Generate Map button (nothing is auto-restored).
  const [smoothedReady, setSmoothedReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Whether the pending generate will reuse the fingerprinted layout cache (vs run
  // octi) — peeked cheaply when Generate is clicked, shown under the spinner.
  const [cacheHit, setCacheHit] = useState(false);
  // Brief spinner shown while a labels/stations toggle forces an SVG re-render.
  const [rerendering, setRerendering] = useState(false);
  const [genMs, setGenMs] = useState<number | null>(null);
  const genMsRef = useRef<number | null>(null);

  // The panel root — the bounds the top bar's popovers are clamped within.
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Canvas render surface + the parsed display list it paints.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PreparedScene | null>(null);
  // Single rAF that coalesces pan/zoom redraws: pointermove + wheel can fire several
  // times per frame, so accumulate the target view synchronously and repaint at most once.
  const drawRafRef = useRef(0);
  const drawSizesRef = useRef(false);
  const viewRef = useRef<View | null>(null);
  // The rect that Fit/export crop to: the renderer's `data-frame` (the geography
  // water/green extent in pixel space) when present, else the full intrinsic canvas.
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
  // Live mirror of `selections`, read by the imperative dep-[] callbacks.
  const selectionsRef = useRef<Selection[]>([]);
  // Detail areas pending restore from a loaded map file. The inject effect's
  // layout-change branch (which normally CLEARS areas) installs these instead.
  const restoreSelectionsRef = useRef<Selection[] | null>(null);
  // Bumped by a file load to force the inject effect to run even when the loaded layout is
  // byte-identical to the one on screen (load the map you just saved → same fp → same svg
  // string → the [svg, mode] inject deps don't change → the queued restore would never be
  // consumed). An explicit nonce in the inject deps guarantees it fires.
  const [restoreNonce, setRestoreNonce] = useState(0);
  // In-memory snapshot of the last SMOOTHED-mode selections (updated in the persist
  // effect, smoothed-only). Reinstated when returning to smoothed from a non-smoothed
  // mode: the smoothed layout is still cached so the memo's restore-queue path is skipped,
  // and a file-loaded layout has no durable :sel: backing (its fp is null) — so this
  // in-memory copy, not the store, is what survives a geographic round-trip.
  const lastSmoothedSelRef = useRef<Selection[]>([]);
  // When a FILE load switches mode to smoothed, skip the mode effect's
  // smoothedReady blank for one run so the loaded map shows in a single settle
  // (no transient that would race the area restore). Starts false (no mount restore).
  const skipModeBlankRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Switch render mode AND load that mode's saved visual settings (toggles + appearance +
  // label size). Each mode keeps its own look; the persist effect saves the mode you leave,
  // so this just installs the target's. Unsaved appearance drafts are discarded (the draft
  // sliders are re-seeded from the loaded `applied`). Migration: a mode with no saved entry
  // yet falls back to the old shared settings, so prior customizations (and the smoothed
  // fingerprint) carry over on first switch. Only the mode BUTTONS route through here — a
  // file load (applyBundle) sets its own settings + mode directly.
  const switchMode = useCallback((target: RenderMode) => {
    if (target === modeRef.current) return;
    const shared = readSettings(mountCity) as RestoredSettings | null;
    const v = ((readModeSettings(mountCity, target) as RestoredSettings | null) ?? shared ?? {}) as RestoredSettings;
    const apRaw = v.applied ?? {
      lineWidth: DEFAULT_LINE_WIDTH,
      stationRadius: DEFAULT_STATION_RADIUS,
      mapMargin: DEFAULT_MAP_MARGIN,
      warpPos: DEFAULT_REALISM_POS,
      linePos: DEFAULT_REALISM_POS,
      boxWarpPos: DEFAULT_REALISM_POS,
    };
    const ap = { ...apRaw, boxFrac: apRaw.boxFrac ?? DEFAULT_BOX_FRAC }; // older entries lack boxFrac
    setShowStations(v.showStations ?? true);
    setShowLabels(v.showLabels ?? false);
    setLabelScale(v.labelScale ?? DEFAULT_LABEL_SCALE);
    setApplied(ap);
    setLineWidth(ap.lineWidth);
    setStationRadius(ap.stationRadius);
    setMapMargin(ap.mapMargin);
    setWarpPos(ap.warpPos);
    setLinePos(ap.linePos);
    setBoxWarpPos(ap.boxWarpPos);
    setBoxFrac(ap.boxFrac);
    setMode(target);
  }, [mountCity]);
  // One-time migration: the pre-split single settings blob (:set:<city>) seeded BOTH modes.
  // Copy its visual fields into each mode's per-mode entry (when that entry is still absent)
  // BEFORE the persist effect below trims :set: to export-only — so a prior session's
  // customizations (and the smoothed fingerprint they feed → the :pre: hit) carry into both
  // modes instead of resetting to defaults. Runs first (declared before persist); idempotent
  // (the per-mode-entry-absent guard skips once entries exist).
  useEffect(() => {
    if (!mountCity) return;
    const shared = readSettings(mountCity) as RestoredSettings | null;
    if (!shared) return;
    const visual = { showStations: shared.showStations, showLabels: shared.showLabels, applied: shared.applied, labelScale: shared.labelScale };
    for (const m of ['geographic', 'smoothed'] as const) {
      if (readModeSettings(mountCity, m) == null) writeModeSettings(mountCity, m, visual);
    }
  }, [mountCity]);
  // Tile-derived geography (water + parks) for the current city, harvested from
  // the game's MapLibre vector tiles on first open. Undefined = no backdrop.
  const [geography, setGeography] = useState<GeographyData | undefined>(undefined);
  // Mirror geography into a ref so the `[]`-dep file-load handler (applyBundle) can read
  // the live backdrop to validate a loaded file's fingerprint without re-creating itself.
  const geographyRef = useRef(geography);
  geographyRef.current = geography;
  // True while the tile harvest is in flight, so the top bar can show the small
  // spinner — the geographic map's backdrop (water/parks) loads asynchronously.
  const [geoLoading, setGeoLoading] = useState(false);
  useEffect(() => {
    // Geography is harvested in the BACKGROUND (geography/warm.ts), kicked off at city
    // load — so it's independent of this panel's lifecycle. Previously the panel drove
    // the harvest retry itself, but that retry died when the panel closed, so a too-early
    // first open (city/demand/tiles not yet ready) left no backdrop until a reopen. Here
    // we just (a) ensure the warm-up is running for the current city and (b) poll its
    // per-city cache, adopting the result the instant it's ready — including on a first
    // open where the warm-up (started earlier) has already finished. Bounded so the
    // spinner eventually clears even if the harvest never succeeds (the warm-up keeps
    // its own, longer retry, so a later reopen will still pick it up).
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const SPINNER_ATTEMPTS = 30; // ~22s of visible spinner, then poll on silently
    const MAX_ATTEMPTS = 240; // ~3min — keep watching so an open panel adopts a late harvest
    const DELAY = 750;
    const poll = (): void => {
      if (!alive) return;
      const city = modState.cityCode ?? api.utils.getCityCode?.();
      if (city) {
        const g = peekGeography(city);
        if (g) { setGeography(g); setGeoLoading(false); return; }
        warmGeography(city); // ensure the background harvest is running (idempotent)
      }
      attempts++;
      if (attempts === SPINNER_ATTEMPTS) setGeoLoading(false); // drop the spinner, keep polling
      if (attempts < MAX_ATTEMPTS) timer = setTimeout(poll, DELAY);
    };
    setGeoLoading(true);
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
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

  // Per-mount cache of the expensive smoothed layout. Reused for label/station
  // toggles so those are a cheap redraw; cleared by (Re)generate to force a fresh
  // octi run. Lost on panel close — nothing is persisted automatically anymore.
  const smoothedCacheRef = useRef<{ pre: SmoothedPrecomputed | string } | null>(null);
  // A freshly-computed precompute queued for the fingerprinted layout cache. Set
  // by the svg memo on an octi MISS; flushed (serialized + written) by an effect
  // AFTER render so the ~MB serialize never blocks the draw. Null on a cache hit.
  const cacheWriteRef = useRef<{ city: string; fp: string; pre: SmoothedPrecomputed | string } | null>(null);
  // Set by Regenerate so the next build SKIPS the layout cache and recomputes
  // fresh (then overwrites the cache). A first Generate leaves it false → cache hit.
  const forceRegenRef = useRef(false);
  // City + fingerprint of the currently-shown smoothed layout — set by the svg memo
  // on each (re)generate. The detail-area persistence effect writes the drawn areas
  // under this fp, so a later reload restores them only against the identical layout.
  const currentCityRef = useRef('');
  const currentFpRef = useRef<string | null>(null);
  // The Scene IR emitted directly by the smoothed draw (Phase 3), paired with the
  // svg string it came from. The canvas inject path uses this display list as-is
  // INSTEAD OF re-parsing the svg, when the strings match. Restore-from-cache and
  // geographic/schematic modes (where no scene was emitted) fall back to parsing.
  const emittedSceneRef = useRef<{ svg: string; scene: SceneOut['scene'] } | null>(null);

  // View-preservation: the inject effect re-fits only when the layout identity
  // changes (mode switch, (re)generation, or water reframe), and keeps the
  // current pan/zoom when only labels/stations toggle (same layout redrawn).
  const layoutIdRef = useRef<unknown>(null);
  const lastLayoutIdRef = useRef<unknown>(undefined);
  // Detail-area lifecycle key, kept SEPARATE from layoutIdRef. The view re-fit keys on
  // the cache OBJECT (which is new on every (re)generate even when the layout is identical)
  // — fine for pan/zoom, fatal for areas: clearing on it wiped freshly-drawn areas and
  // persisted the wipe as an empty :sel: write under the same fp. Areas key on the layout
  // FINGERPRINT instead, so a same-fp regenerate / spurious re-render keeps them.
  const lastAreaKeyRef = useRef<string | undefined>(undefined);
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
        boxFrac: applied.boxFrac,
        theme: {
          ...(dark ? DARK_THEME : DEFAULT_THEME),
          lineWidth: applied.lineWidth,
          stationRadius: applied.stationRadius,
        },
      },
    };
  }, [geography, mode, showStations, showLabels, applied]);

  // The exact live render inputs, captured for offline repro (geojson reconstructions
  // drift from the live save and the game's station grouping). Formerly downloaded via a
  // standalone "input dump" button; now baked into the saved map JSON (exportMap) so the
  // one Save map file carries both the cache AND the debug inputs. IGNORED on load.
  //
  // Per-area inputs: for each detail area we also capture the cropped sub-graph input —
  // the exact SchematicInput the inset's re-sim runs (cropSubgraph of the live network to
  // the area's box, with the geography clipped to the box's geographic preimage). This lets
  // any area be debugged on its own offline, the same way the whole map can.
  const buildInputDump = useCallback(() => {
    const dark = api.ui.getResolvedTheme() === 'dark';
    const full = buildInput();
    // One cropped sub-input per area, mirroring DetailInset's re-sim crop (core stations
    // inside the box + the box's unprojected geographic bounds for the geography clip).
    const pre = smoothedCacheRef.current?.pre;
    const areas = selectionsRef.current.map((sel) => {
      const box = sel.box;
      const out: Record<string, unknown> = { id: sel.id, name: sel.name, box };
      if (pre && typeof pre !== 'string') {
        const core = new Set<string>();
        for (const [sid, px] of pre.stationPx) {
          if (px[0] >= box.x0 && px[0] <= box.x1 && px[1] >= box.y0 && px[1] <= box.y1) core.add(sid);
        }
        const bl = pre.unproject([box.x0, box.y1]);
        const tr = pre.unproject([box.x1, box.y0]);
        const clipBbox: [number, number, number, number] = [bl[0], bl[1], tr[0], tr[1]];
        out.coreStationIds = [...core];
        out.clipBbox = clipBbox;
        try {
          out.input = core.size >= 2 ? cropSubgraph(full as never, core, clipBbox) : null;
        } catch (err) {
          out.input = null;
          out.error = String(err);
        }
      }
      return out;
    });
    return {
      at: new Date().toISOString(),
      stationGroups: full.stationGroups,
      routes: full.routes,
      tracks: full.tracks,
      stations: full.stations,
      // geography sets the projection BOUNDS (geoFramePts → computeBounds), so it must be
      // captured or an offline repro projects the network into different bounds → a
      // different octi layout than the game produces.
      geography,
      // The live render options (mirrors buildInput().options, with derived warp/affinity/
      // theme baked in) so a script can pass `options` straight through.
      options: full.options,
      // Export-time controls — not render inputs, but captured so scripts can match the file.
      exportOptions: { format: exportFormat, rasterScale, jpegQuality },
      // Per-area cropped sub-inputs (see above) for debugging any area in isolation.
      areas,
    };
  }, [buildInput, geography, exportFormat, rasterScale, jpegQuality]);

  const svg = useMemo(() => {
    if (mode === 'smoothed') {
      // Stay blank until the user clicks Generate Map.
      if (!smoothedReady) {
        genMsRef.current = null;
        layoutIdRef.current = 'smoothed-blank';
        return '';
      }
      let cache = smoothedCacheRef.current;
      // No per-mount cache (a fresh mount / (Re)generate): try the fingerprinted
      // localStorage layout cache first — a hit deserializes the precompute (~0.1s)
      // and skips the 3.7s-158s octi run. The key IS the digest of the live inputs
      // (geography incl.), so a stale layout can never match. A miss runs octi and
      // queues a write (deferred below, off the render). Label/station toggles fall
      // through to the cheap redraw, reusing the per-mount cache.
      if (!cache) {
        const input = buildInput();
        const city = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
        const fp = fingerprintInputs(input as never).fp;
        const force = forceRegenRef.current; // Regenerate → recompute fresh, ignore cache
        forceRegenRef.current = false;
        const hit = !force && city ? readCachedPre(city, fp) : null;
        currentCityRef.current = city;
        currentFpRef.current = fp;
        // A real generate establishes the live city as the one the displayed settings belong
        // to — re-enabling the per-mode settings persist that a cross-city file load disabled.
        settingsCityRef.current = city;
        if (hit != null) {
          cache = { pre: hit };
          genMsRef.current = 0; // restored from cache (≈instant)
          cacheWriteRef.current = null;
        } else {
          const t0 = performance.now();
          cache = { pre: precomputeSmoothedSchematic(input) };
          genMsRef.current = performance.now() - t0;
          // Queue the (heavy) serialize+write for after render, not in the memo.
          cacheWriteRef.current = city ? { city, fp, pre: cache.pre } : null;
        }
        // Restore the detail areas drawn on THIS layout. readSelections is gated on the
        // fp, so areas reinstate only when the layout is provably the one they were drawn
        // on — a cache hit, or a deterministic regenerate / pre-eviction with unchanged
        // inputs. A real input change ⇒ different fp ⇒ null ⇒ no restore, and the inject
        // effect clears the now-stale boxes instead. Queued for the inject effect to
        // install after the layout settles (reuses the file-load restore path).
        const savedSel = city ? (readSelections(city, fp) as Selection[] | null) : null;
        if (savedSel && savedSel.length) {
          restoreSelectionsRef.current = savedSel;
          selCountRef.current = savedSel.reduce((mx, sel) => {
            const n = Number(/sel-(\d+)/.exec(sel.id)?.[1]);
            return Number.isFinite(n) ? Math.max(mx, n + 1) : mx;
          }, selCountRef.current);
        }
        smoothedCacheRef.current = cache;
      }
      // The cache object is stable across label/station toggles — exactly the
      // identity the inject effect needs.
      layoutIdRef.current = cache;
      const pre = cache.pre;
      if (typeof pre === 'string') return pre;
      // Capture the Scene IR the draw emits directly (Phase 3), so the canvas
      // inject path can paint this display list instead of re-parsing the svg.
      const out: SceneOut = { scene: null };
      const drawn = drawSmoothedSchematic(pre, { showLabels, showStations }, out);
      emittedSceneRef.current = { svg: drawn, scene: out.scene };
      return drawn;
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

  // Flush a queued layout-cache write (set by the svg memo on an octi MISS only).
  // Runs in an effect (after paint, so the map shows first); the ~MB serializePre
  // is a one-time cost that only follows a (much slower) octi run — a cache HIT
  // sets nothing here, so the fast path does no serialize.
  useEffect(() => {
    const pending = cacheWriteRef.current;
    if (!pending) return;
    cacheWriteRef.current = null;
    writeCachedPre(pending.city, pending.fp, pending.pre);
  }, [svg]);

  // Persist the user's detail areas so a reload can restore them. Keyed on the
  // selections (so draws/edits/deletes are captured) and written under the active
  // layout's fingerprint (set by the svg memo on generate); readSelections gates restore
  // on that fp. Guarded to smoothed mode via modeRef so switching to geographic — which
  // clears the areas — doesn't overwrite the saved set with an empty list.
  useEffect(() => {
    if (modeRef.current !== 'smoothed') return;
    // A queued restore (file load / fresh generate) is mid-flight: applyBundle resets
    // selections to [] and the inject effect installs the saved areas a beat later. Under
    // batched updates this effect can fire on that transient [] BEFORE the inject restores —
    // which would writeSelections([]) and pruneSubPres([]), wiping the just-seeded areas and
    // their cached sub-layouts. Skip while a restore is pending; the restore itself re-fires
    // this effect (with restoreSelectionsRef cleared) and persists the real areas.
    if (restoreSelectionsRef.current) return;
    // Snapshot the live smoothed areas (BEFORE the fp guard, so a file-loaded layout with
    // a null fp is still captured) — the inject restores this on a geographic round-trip.
    // Runs only on a real selections change, so the transient [] during a return-to-smoothed
    // render (selections unchanged → effect skipped) can't clobber it; and it's mode-guarded
    // so the →geographic clear (modeRef already geographic) doesn't either.
    lastSmoothedSelRef.current = selections;
    const city = currentCityRef.current;
    const fp = currentFpRef.current;
    if (city && fp) {
      writeSelections(city, fp, selections);
      // Keep the per-area sub-layout cache aligned with the live areas: drop entries for
      // boxes that were deleted or bounds-edited away (the surviving boxes keep their
      // cached re-sim, so they still restore instantly).
      pruneSubPres(city, fp, selections.map((s) => `${s.box.x0},${s.box.y0},${s.box.x1},${s.box.y1}`));
    }
  }, [selections]);

  // Persist appearance settings per city so a reload restores the sliders/toggles — and
  // thus reproduces the fingerprint a customized layout's cached `pre` was built under,
  // so Generate hits (and its areas restore). City-scoped + unconditional (not layout-
  // gated; the `pre` stays fp-gated). On mount this writes back the just-restored values
  // (idempotent); `applied` only changes on Apply/Save, so draft slider drags don't churn.
  useEffect(() => {
    // Only persist while still on the city these settings were restored for — guards a
    // live city switch (no remount) from writing the displayed sliders under another city —
    // AND while the displayed settings belong to that same city (settingsCityRef), so a
    // file load for a different city than the live game can't clobber the live city's saved
    // settings with the loaded file's values.
    const city = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
    if (city && city === mountCity && city === settingsCityRef.current) {
      // Per-mode visual settings (toggles + appearance + label size) under the CURRENT mode,
      // and the shared export prefs separately. modeRef (not a dep) so a mode switch alone
      // doesn't write — switchMode changes the visual state, which re-triggers this under the
      // new mode.
      writeModeSettings(city, modeRef.current, { showStations, showLabels, applied, labelScale });
      writeSettings(city, { rasterScale, jpegQuality, exportFormat });
    }
  }, [showStations, showLabels, applied, rasterScale, jpegQuality, exportFormat, labelScale, mountCity]);

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

    // Match the on-screen label size: the panel scales the .imp-lbl-s groups by
    // labelScale at display time, so bake the same scale into the export markup.
    const scaleExportLabels = (rootEl: Element) => {
      if (labelScale === 1) return;
      for (const g of Array.from(rootEl.querySelectorAll('.imp-lbl-s'))) {
        g.setAttribute('transform', `scale(${labelScale})`);
      }
    };

    // No areas → original behaviour: crop to the geography frame.
    if (areas.length === 0) {
      root.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.w} ${frame.h}`);
      root.setAttribute('width', String(frame.w));
      root.setAttribute('height', String(frame.h));
      root.removeAttribute('data-frame');
      scaleExportLabels(root);
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
    if (labelScale !== 1) main = main.replace(/<g class="imp-lbl-s">/g, `<g class="imp-lbl-s" transform="scale(${labelScale})">`);
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
      const label = a.s.name.trim();
      // Match the on-screen label size: bake the same labelScale into the panel's labels.
      const sub = labelScale === 1 ? a.subSvg : a.subSvg.replace(/<g class="imp-lbl-s">/g, `<g class="imp-lbl-s" transform="scale(${labelScale})">`);
      const nested = sub.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" x="${r.x}" y="${r.y + headerH}" width="${r.w}" height="${r.h - headerH}" viewBox="${gf.x} ${gf.y} ${gf.w} ${gf.h}" preserveAspectRatio="xMidYMid meet">`);
      parts.push(
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${bg}" stroke="${a.s.color}" stroke-width="${r.w * 0.006}"/>`,
        nested,
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${headerH}" fill="${a.s.color}" opacity="0.32"/>`,
        label ? `<text x="${r.x + headerH * 0.4}" y="${r.y + headerH * 0.7}" font-family="sans-serif" font-size="${fontPx}" font-weight="600" fill="${dark ? '#e5e5e5' : '#1a1a1a'}">${esc(label)}</text>` : '',
      );
    }

    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${EW} ${EH}" width="${EW}" height="${EH}">${parts.join('')}</svg>`;
    return { markup, width: EW, height: EH };
  }, [svg, selections, labelScale]);

  // Trigger a browser download for a generated blob.
  const triggerDownload = useCallback((blob: Blob, ext: string, name?: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name ? `${name}.${ext}` : `improvedschematics-${mode}.${ext}`;
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

  // Save the generated map to a JSON file, so reloading the mod can restore it instantly
  // instead of re-running the octi pipeline. The file mirrors EVERYTHING the per-city
  // localStorage cache holds — the precompute (`pre`), the layout fingerprint (`fp`), the
  // detail areas (`selections`), the per-mode visual settings (`modeSettings`), and the
  // per-area sub-layout cache (`subs`) — so a load reseeds the cache and behaves exactly
  // like a cache hit (areas restore without re-simulating; a later Generate hits). The
  // debug input dump (live render inputs + per-area cropped sub-inputs) rides along under
  // `inputDump`; it's for offline repro and is ignored on load.
  const exportMap = useCallback(() => {
    const pre = smoothedCacheRef.current?.pre;
    if (mode !== 'smoothed' || !pre) { setMapMsg('Generate a smoothed map first'); return; }
    // Stamp the file with the city the DISPLAYED layout belongs to (settingsCityRef tracks it
    // across generate/adopt/non-adopt loads), not the live game city — otherwise loading a
    // foreign-city file then re-saving without Generate would mislabel it (and read the wrong
    // city's mode settings). Falls back to the live city when nothing's been loaded.
    const city = settingsCityRef.current || modState.cityCode || api.utils.getCityCode?.() || 'map';
    const settings = { mode, showStations, showLabels, applied, rasterScale, jpegQuality, exportFormat, labelScale };
    const fp = currentFpRef.current ?? undefined;
    // Mirror the rest of the per-city cache: per-mode visual settings + the sub-layout cache
    // (fp-gated, so only the subs that belong to THIS layout are captured).
    const modeSettings: Record<string, unknown> = {};
    for (const m of ['geographic', 'smoothed']) {
      const v = readModeSettings(city, m);
      if (v != null) modeSettings[m] = v;
    }
    const subs = fp ? (readAllSubPres(city, fp) ?? undefined) : undefined;
    try {
      const json = serializeMap({
        version: 1, city, settings, selections, modeSettings, fp, subs, pre,
        inputDump: buildInputDump(),
      });
      triggerDownload(new Blob([json], { type: 'application/json' }), 'json', `improvedschematics-map-${city}`);
      setMapMsg(`Saved · ${(json.length / 1024 / 1024).toFixed(1)} MB`);
    } catch {
      setMapMsg('Save failed');
    }
  }, [mode, showStations, showLabels, applied, rasterScale, jpegQuality, exportFormat, labelScale, selections, triggerDownload, modState, buildInputDump]);

  // Install a loaded/restored map: settings + precompute + detail areas, drawing
  // from cache without recomputing. The fresh `applied` object forces the svg memo
  // to redraw. When the file carries the layout fingerprint (`fp`) AND that fingerprint
  // still matches the live game (same network/geography, recomputed below), it loads
  // EXACTLY like a cache hit: we adopt the saved city/fp and reseed the per-city
  // localStorage cache (pre, areas, per-mode settings, sub-layouts) so detail areas restore
  // from their saved sub-layouts instead of re-simulating, and a later remount+Generate
  // hits. If the live inputs have moved (or the file predates fingerprints), it still
  // displays from `pre` but does NOT adopt the fp — areas re-simulate and nothing is cached
  // under a stale key. The debug `inputDump` field is ignored here. Used by file-load.
  const applyBundle = useCallback((bundle: import('../render/persist').MapBundle) => {
    const s = (bundle.settings ?? {}) as {
      showStations?: boolean;
      showLabels?: boolean;
      applied?: typeof applied;
      rasterScale?: number;
      jpegQuality?: number;
      exportFormat?: ExportFormat;
      labelScale?: number;
    };
    // Clamp every loaded numeric to its slider's LIVE range before applying it. An older
    // (or hand-edited) file can carry a value outside the current bounds — e.g. a labelScale
    // saved before the [0.2, 1.5] range existed, or an out-of-range warp position — which
    // would otherwise render a broken control and a distorted layout. A non-finite/absent
    // field (a pre-boxWarpPos legacy file, or a truncated hand-edit) falls back to its default
    // rather than clamping to NaN (clamp(undefined) → NaN → a broken controlled slider).
    const num = (v: unknown, lo: number, hi: number, def: number) =>
      Number.isFinite(v as number) ? clamp(v as number, lo, hi) : def;
    const clampedApplied = s.applied && {
      lineWidth: num(s.applied.lineWidth, 1, 8, DEFAULT_LINE_WIDTH),
      stationRadius: num(s.applied.stationRadius, 1, 6, DEFAULT_STATION_RADIUS),
      mapMargin: num(s.applied.mapMargin, 0, 0.15, DEFAULT_MAP_MARGIN),
      warpPos: num(s.applied.warpPos, -1, 1, DEFAULT_REALISM_POS),
      linePos: num(s.applied.linePos, -1, 1, DEFAULT_REALISM_POS),
      boxWarpPos: num(s.applied.boxWarpPos, -1, 1, DEFAULT_REALISM_POS),
      boxFrac: num(s.applied.boxFrac, BOX_FRAC_MIN, BOX_FRAC_MAX, DEFAULT_BOX_FRAC),
    };
    if (typeof s.showStations === 'boolean') setShowStations(s.showStations);
    if (typeof s.showLabels === 'boolean') setShowLabels(s.showLabels);
    if (s.rasterScale != null) setRasterScale(clamp(s.rasterScale, 1, 4));
    if (s.jpegQuality != null) setJpegQuality(clamp(s.jpegQuality, 0.5, 1));
    if (s.exportFormat && FORMATS.some((f) => f.id === s.exportFormat)) setExportFormat(s.exportFormat);
    if (s.labelScale != null) setLabelScale(clamp(s.labelScale, LABEL_SCALE_MIN, LABEL_SCALE_MAX));
    if (clampedApplied) {
      setLineWidth(clampedApplied.lineWidth);
      setStationRadius(clampedApplied.stationRadius);
      setMapMargin(clampedApplied.mapMargin);
      setWarpPos(clampedApplied.warpPos);
      setLinePos(clampedApplied.linePos);
      setBoxWarpPos(clampedApplied.boxWarpPos);
      setBoxFrac(clampedApplied.boxFrac);
    }
    // Queue the saved detail areas; the inject effect restores them after the new
    // layout settles (instead of clearing). Bump the id counter past the restored
    // ids so freshly drawn areas don't collide / reuse colors.
    const restored = Array.isArray(bundle.selections) ? (bundle.selections as Selection[]) : [];
    restoreSelectionsRef.current = restored;
    selCountRef.current = restored.reduce((mx, sel) => {
      const n = Number(/sel-(\d+)/.exec(sel.id)?.[1]);
      return Number.isFinite(n) ? Math.max(mx, n + 1) : mx;
    }, selCountRef.current);
    smoothedCacheRef.current = { pre: bundle.pre };
    // Adopt-as-cache-hit ONLY when the file provably matches the LIVE game. A saved file
    // carries the fingerprint (`fp`) its layout was built under; recompute that same
    // fingerprint from the live game network + backdrop combined with the file's own
    // (clamped) render settings, and adopt the saved city/fp — reseeding the per-city cache
    // so detail areas restore from their saved sub-layouts and a later Generate hits — ONLY
    // if it matches. On ANY mismatch (the network or geography changed since the save, a
    // different city, or the backdrop hasn't loaded yet so the live fp reads `nogeo`) fall
    // back to the legacy null-fp path: the map still DISPLAYS from the in-memory `pre`, but
    // currentFpRef stays null so getSubCacheKey returns null — areas re-simulate locally and
    // nothing is written under a fingerprint that may not match the live inputs. This keeps
    // the in-memory layer as fp-honest as the (already fp-gated) localStorage layer.
    const loadCity = bundle.city || currentCityRef.current;
    const fp = bundle.fp;
    const ap = clampedApplied ?? {
      lineWidth: DEFAULT_LINE_WIDTH,
      stationRadius: DEFAULT_STATION_RADIUS,
      mapMargin: DEFAULT_MAP_MARGIN,
      warpPos: DEFAULT_REALISM_POS,
      linePos: DEFAULT_REALISM_POS,
      boxWarpPos: DEFAULT_REALISM_POS,
      boxFrac: DEFAULT_BOX_FRAC,
    };
    const dark = api.ui.getResolvedTheme() === 'dark';
    const liveFp = fp
      ? fingerprintInputs({
          routes: api.gameState.getRoutes(),
          tracks: api.gameState.getTracks(),
          stations: api.gameState.getStations(),
          stationGroups: resolveStationGroupsFromGameState(api.gameState),
          geography: geographyRef.current,
          options: {
            padding: ap.mapMargin,
            warpAlpha: warpAlphaFromPos(ap.warpPos),
            geographicAffinity: affinityFromPos(ap.linePos),
            boxExpand: boxExpandFromPos(ap.boxWarpPos),
            boxGrowth: boxGrowthFromPos(ap.boxWarpPos),
            boxFrac: ap.boxFrac,
            dark,
            theme: { lineWidth: ap.lineWidth },
          },
        } as never).fp
      : null;
    if (fp && loadCity && liveFp === fp) {
      currentCityRef.current = loadCity;
      currentFpRef.current = fp;
      settingsCityRef.current = loadCity; // file matches the live game → its settings are the live city's
      try {
        writeCachedPre(loadCity, fp, bundle.pre);
        writeSelections(loadCity, fp, restored);
        if (bundle.subs) writeAllSubPres(loadCity, fp, bundle.subs);
        if (bundle.modeSettings) {
          for (const [m, v] of Object.entries(bundle.modeSettings)) writeModeSettings(loadCity, m, v);
        }
      } catch {
        /* best-effort cache seed — the map still loads from the in-memory pre above */
      }
    } else {
      // No adoption: don't auto-persist areas/subs under a fingerprint that may not match the
      // live inputs (the legacy null-fp behaviour). Point settingsCityRef at the file's own
      // city so the per-mode settings-persist effect stays disabled while the displayed
      // settings belong to a city other than the live game's; a later Generate re-enables it.
      currentFpRef.current = null;
      settingsCityRef.current = bundle.city || '';
    }
    if (modeRef.current !== 'smoothed') skipModeBlankRef.current = true; // single settle, no blank
    setSelections([]); // drop any current areas; the inject effect installs the saved ones
    setGenerating(false);
    setSmoothedReady(true);
    setMode('smoothed');
    setApplied((a) => ({ ...(clampedApplied ?? a) })); // new ref → svg memo redraws from cache
    setRestoreNonce((n) => n + 1); // force the inject to run even if the layout is unchanged
  }, []);

  const importMap = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyBundle(deserializeMap(String(reader.result)));
        setSettingsOpen(false);
        setMapMsg('Loaded ✓');
      } catch {
        setMapMsg('Not a valid map file');
      }
    };
    reader.onerror = () => setMapMsg('Could not read file');
    reader.readAsText(file);
  }, [applyBundle]);

  // Wipe the current city's cached LAYOUT (the localStorage :fp:/:pre:/:sel:/:sub: entries) —
  // an escape hatch when a city's cached layout is stale or wrong. Keeps the saved appearance
  // settings (:set:) so clearing doesn't reset the user's preferences. Non-destructive to the
  // current session: the on-screen map stays, but a reload (or the next Generate) now starts
  // fresh. We also drop the in-memory layout fingerprint so the area-persist and cache-write
  // effects (both gated on currentFpRef) can't immediately re-seed the just-cleared cache;
  // the next Generate recomputes the fp and re-enables caching normally.
  const clearCache = useCallback(() => {
    const city = currentCityRef.current || modState.cityCode || api.utils.getCityCode?.() || '';
    if (!city) { setMapMsg('No city to clear'); return; }
    clearCityLayout(city);
    currentFpRef.current = null;
    cacheWriteRef.current = null;
    setCacheHit(false);
    setMapMsg(`Cache cleared · ${city}`);
  }, [modState]);

  // (Auto-persist + deferred-restore removed with the auto-cache. A generated map
  // lives only in smoothedCacheRef for the session; use Save map to keep it.)

  // Auto-clear the save/load status line.
  useEffect(() => {
    if (!mapMsg) return;
    const t = setTimeout(() => setMapMsg(null), 4000);
    return () => clearTimeout(t);
  }, [mapMsg]);

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
  // The active layout's sub-layout cache key (city + fingerprint), read fresh so each
  // DetailInset can persist/restore its cropped re-sim. Null when there's no stable fp
  // (a file-loaded layout sets currentFpRef=null), so those areas just re-simulate.
  const getSubCacheKey = useCallback(
    () => (currentCityRef.current && currentFpRef.current ? { city: currentCityRef.current, fp: currentFpRef.current } : null),
    [],
  );
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
  // Bounds-edit: the DetailInset reports its in-progress (working) box here on each corner
  // drag; ✓ applies it (a new `box` → one re-sim), ✗ discards. Kept in a ref so per-drag
  // updates don't re-render. The draft is cleared when entering edit, so a no-drag ✓ is a
  // no-op (id won't match / no draft).
  const boundsDraftRef = useRef<{ id: string; box: Box } | null>(null);
  const onBoundsChange = useCallback((id: string, box: Box) => {
    boundsDraftRef.current = { id, box };
  }, []);
  // Persist a popout panel's position/zoom onto its area (rides the :sel: cache + restore).
  // box identity is untouched, so this never re-simulates; called on drag-end / debounced
  // wheel, so it's at most one write per interaction.
  const onRectChange = useCallback((id: string, rect: { x: number; y: number; w: number; h: number }) => {
    updateSelection(id, { rect });
  }, [updateSelection]);
  const commitEdit = useCallback(() => {
    setEditingId((cur) => {
      const d = boundsDraftRef.current;
      if (cur && d && d.id === cur) updateSelection(cur, { box: { ...d.box } });
      boundsDraftRef.current = null;
      return null;
    });
  }, [updateSelection]);
  const cancelEdit = useCallback(() => {
    boundsDraftRef.current = null;
    setEditingId(null);
  }, []);
  const clearSelections = useCallback(() => {
    repositionFns.current.clear();
    exportFns.current.clear();
    setSelections([]);
  }, []);

  // Drop bounds-edit mode if the edited area is gone (deleted, cleared, or a layout
  // change restored/cleared the set) — otherwise the ✓/✗ row would point at nothing.
  useEffect(() => {
    if (editingId && !selections.some((s) => s.id === editingId)) setEditingId(null);
  }, [selections, editingId]);

  // Mirror of `selections` for the imperative (dep-[]) paths below.
  selectionsRef.current = selections;
  // (Label-overlap hiding — labels in/over a detail area — is done by the canvas
  // renderer in drawScene/isLabelHidden, covering both the station-inside-box and
  // text-spill-over-box cases; no separate DOM pass needed.)

  // Repaint the canvas at the current view. Pan/zoom in canvas mode is exactly
  // this: a camera transform + one redraw — no viewBox, no per-node counter-scale
  // writes, no whole-SVG repaint. Sizes the backing store to the viewport × DPR.
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
    const view = viewRef.current;
    if (!canvas || !vp || !view) return;
    const cssW = vp.clientWidth;
    const cssH = vp.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const prepared = sceneRef.current;
    if (!prepared) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      return;
    }
    // Warp-box overlay: only in smoothed mode (it's a smoothed-layout feature), only
    // when the toggle is on and the precompute carries the boxes (older cached layouts
    // lack them → none drawn until the next Generate).
    const pre = smoothedCacheRef.current?.pre;
    const warpBoxes =
      showWarpBoxesRef.current && modeRef.current === 'smoothed' && pre && typeof pre !== 'string'
        ? pre.denseBoxesPx
        : undefined;
    drawScene(ctx, prepared, view, {
      dpr,
      cssWidth: cssW,
      cssHeight: cssH,
      clipBoxes: selectionsRef.current.map((s) => s.box),
      warpBoxes,
      labelScale: labelScaleRef.current,
    });
  }, []);

  // Repaint at the current view: a single drawCanvas + keep the overlays glued.
  // (`_updateSizes` is vestigial from the old SVG path's counter-scale pass — canvas
  // redraws everything each frame, so it's ignored; kept so the rAF callers' signature
  // is unchanged.)
  const applyToDom = useCallback((_updateSizes: boolean) => {
    drawCanvas();
    positionBox();
    for (const fn of repositionFns.current.values()) fn();
  }, [drawCanvas, positionBox]);

  // Coalesce gesture-driven redraws to one applyToDom per animation frame.
  // pointermove/wheel mutate viewRef synchronously (cheap math) and call this;
  // the actual DOM write is batched. A frame that saw any zoom does the full
  // updateSizes pass (counter-scale); a pure-pan frame skips it.
  const scheduleDraw = useCallback((updateSizes: boolean) => {
    if (updateSizes) drawSizesRef.current = true;
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      const sizes = drawSizesRef.current;
      drawSizesRef.current = false;
      applyToDom(sizes);
    });
  }, [applyToDom]);
  // Cancel a pending coalesced draw on unmount.
  useEffect(() => () => { if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current); }, []);

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

  // Rebuild the smoothed map from current game state, discarding the cached one.
  // Forces a fresh octi run (bypasses the layout cache) and overwrites it.
  const regenerate = useCallback(() => {
    smoothedCacheRef.current = null;
    forceRegenRef.current = true;
    setCacheHit(false); // Regenerate always recomputes
    setSmoothedReady(false);
    setGenerating(true);
  }, []);

  // Install the render: parse the SVG string into a Scene IR and paint it to the canvas
  // (no live DOM). The shared tail below fits/preserves the view and runs the area
  // lifecycle, so all the callers (toggles, mode switch, restore) are unchanged.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    if (svg) {
      // Prefer the Scene IR the smoothed draw emitted directly for THIS svg (Phase 3) —
      // skip the capture-parse. Geographic/schematic and restore-from-cache (no emitted
      // scene, or a stale one) parse the string.
      const emitted = emittedSceneRef.current;
      const scene = emitted && emitted.svg === svg && emitted.scene ? emitted.scene : sceneFromSvg(svg);
      sceneRef.current = prepareScene(scene);
      const w = scene.width || GEO_SIZE;
      const h = scene.height || GEO_SIZE;
      // Fit/export frame: prefer the renderer's data-frame (geography extent), else full canvas.
      fitBoxRef.current =
        scene.frame && scene.frame.w > 0 && scene.frame.h > 0
          ? { x: scene.frame.x, y: scene.frame.y, w: scene.frame.w, h: scene.frame.h }
          : { x: 0, y: 0, w, h };
    } else {
      sceneRef.current = null;
    }
    // Preserve the current pan/zoom when only the SVG CONTENT changed (a
    // label/station toggle redraws the SAME layout). Re-fit only when the
    // layout identity changes — mode switch, (re)generation, or water reframe.
    if (viewRef.current && layoutIdRef.current === lastLayoutIdRef.current) {
      applyToDom(true); // keep the current view, repaint the new content
    } else {
      fit();
    }
    lastLayoutIdRef.current = layoutIdRef.current;
    // Detail-area lifecycle — DECOUPLED from the view branch above (areas live in render-
    // pixel coords; the cache OBJECT churns on every (re)generate and viewRef is briefly
    // null on first paint, so keying the area reset on those wiped freshly-drawn areas and
    // clobbered the durable store). The decision is a pure, unit-tested function keyed on
    // the layout FINGERPRINT plus a queued restore and the in-memory smoothed snapshot —
    // see areaLifecycle.ts for the full case analysis (round-trip, file-load, delete-all,
    // genuine fp change, spurious re-render).
    const areaKey = mode === 'smoothed' ? `s:${currentFpRef.current ?? ''}` : `m:${mode}`;
    const restore = restoreSelectionsRef.current;
    restoreSelectionsRef.current = null; // consumed below, or discarded (same layout)
    const action = decideAreaAction<Selection>({
      queuedRestore: restore,
      prevKey: lastAreaKeyRef.current,
      nextKey: areaKey,
      isSmoothed: mode === 'smoothed',
      snapshot: lastSmoothedSelRef.current,
    });
    if (action.kind === 'restore') setSelections(action.selections);
    else if (action.kind === 'clear') clearSelections();
    // 'keep' → leave the on-screen areas untouched.
    lastAreaKeyRef.current = areaKey;
    // Surface the smoothed build time (geographic renders are cheap + auto).
    setGenMs(mode === 'smoothed' ? genMsRef.current : null);
    // The map is in the DOM now — drop the generating spinner.
    if (svg) setGenerating(false);
  }, [svg, mode, restoreNonce, fit, applyToDom, clearSelections]);

  // The cutout depends only on the box GEOMETRY, so key the effect on that — not
  // the whole `selections` array — so editing a color/name doesn't rebuild (and
  // briefly flash) the clip on every keystroke.
  const cutoutKey = selections.map((s) => `${s.box.x0},${s.box.y0},${s.box.x1},${s.box.y1}`).join('|');
  // Repaint when the detail-area boxes change: the cut-out (edges/stops clipped to
  // outside the boxes, backdrop left visible) and the label hiding (labels in/over a
  // box) both live inside drawScene now, so this is just a canvas redraw.
  useEffect(() => {
    drawCanvas();
  }, [cutoutKey, drawCanvas]);

  // Label-size setting is display-time: repaint instantly (canvas redraw) without
  // rebuilding the scene.
  useEffect(() => {
    applyToDom(true);
  }, [labelScale, applyToDom]);

  // Warp-box overlay is display-only: toggling it just repaints (no scene rebuild).
  useEffect(() => {
    applyToDom(true);
  }, [showWarpBoxes, applyToDom]);

  // Resize the backing store + repaint when the viewport resizes.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => drawCanvas());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [drawCanvas]);

  // Re-fit on mode switch (different layout shape). Smoothed always lands on the
  // Generate Map button (nothing is auto-restored), so just blank the gate and
  // re-fit; a FILE load sets skipModeBlankRef to avoid blanking the loaded map.
  useEffect(() => {
    // A map load already installed a ready cache + mode='smoothed'; don't blank it.
    if (skipModeBlankRef.current) { skipModeBlankRef.current = false; return; }
    setSmoothedReady(false);
    setGenerating(false);
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
      scheduleDraw(true);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [scheduleDraw]);

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
    scheduleDraw(false);
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
        setSelections((xs) => [...xs, { id: `sel-${n}`, box: b, color: SEL_COLORS[n % SEL_COLORS.length], name: '', locked: false }]);
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

  // Same for the detail-areas manager popover — EXCEPT while editing an area's bounds:
  // the corner-handle drags land on the map (outside the menu), which would otherwise
  // close it, stranding the ✓/✗ controls. Keep it open until the edit is committed/cancelled.
  useEffect(() => {
    if (!areasOpen) return;
    const onDown = (e: MouseEvent) => {
      if (editingId) return; // bounds-edit in progress — keep the menu open
      if (!areasRef.current?.contains(e.target as Node)) setAreasOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [areasOpen, editingId]);

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
  // Shared style for the area-row icon buttons (SVG <Icon> children). `as const` keeps the
  // union-typed fields (display/alignItems) as literals so the object stays assignable to
  // the style prop; per-button overrides (opacity/color) spread on top.
  const iconBtn = {
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.65,
    padding: 2,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
  } as const;

  // Clamp each top-bar popover within the panel so a narrow/wrapped top bar
  // can't push it off the left edge (or below the bottom). Re-measures when the
  // menu's content changes size (areas list, smoothed-only sliders).
  const areasPopRef = useClampedPopover(areasOpen, rootRef, `areas:${selections.length}`, 290, 360);
  const settingsPopRef = useClampedPopover(settingsOpen, rootRef, `settings:${mode}`, 230);

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {/* position+zIndex so the toolbar (and its popovers) always stack above the
          map layer's detail-area panels. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
        {/* Spinner keyframes — defined once here so both the small rerender
            spinner and the generating overlay can use it regardless of mode. */}
        <style>{`@keyframes imp-spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ display: 'flex', gap: 4 }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => switchMode(m.id)}
              disabled={geoLoading}
              style={{ ...toggleStyle(mode === m.id), ...(geoLoading ? { cursor: 'not-allowed', opacity: 0.4 } : null) }}
              title={geoLoading ? 'Geography loading…' : undefined}
            >
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
          <button onClick={regenerate} style={toggleStyle(false)} title="Regenerate — rebuild the smoothed map from current game state" aria-label="Regenerate">
            ↻
          </button>
        )}
        {mode === 'smoothed' && smoothedReady && (
          <button
            onClick={() => setShowWarpBoxes((v) => !v)}
            style={toggleStyle(showWarpBoxes)}
            title="Outline the dense-core regions the box-warp magnified (overlay only; Regenerate to populate on maps cached before this)"
          >
            {showWarpBoxes ? '✓ Warp boxes' : 'Warp boxes'}
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
        {geoLoading && (
          <span style={{ color: '#888', fontSize: 11 }}>Geography loading, please wait</span>
        )}
        <span style={{ flex: 1 }} />
        {mode === 'smoothed' && genMs != null && (
          <span style={{ color: '#888', fontSize: 11 }}>
            {genMs === 0 ? 'Cache used' : `Finished in ${(genMs / 1000).toFixed(2)}s`}
          </span>
        )}
        {/* Build marker: proves which bundle the game actually loaded. */}
        <span style={{ opacity: 0.35, fontSize: 10 }}>v{MOD_VERSION}</span>
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
                ref={areasPopRef}
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
                      placeholder="Name…"
                      onChange={(e) => updateSelection(s.id, { name: e.target.value })}
                      title={`Name for area ${i + 1} (blank = no label)`}
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
                      onClick={() => updateSelection(s.id, { locked: !s.locked })}
                      title={s.locked ? 'Unlock (allow moving this area)' : 'Lock (pin it; pan/zoom passes through)'}
                      aria-label={s.locked ? 'Unlock area' : 'Lock area'}
                      style={{ ...iconBtn, opacity: s.locked ? 1 : 0.55 }}
                    >
                      <Icon name={s.locked ? 'lock' : 'unlock'} />
                    </button>
                    {editingId === s.id ? (
                      <>
                        <button
                          onClick={commitEdit}
                          title="Apply the new bounds"
                          aria-label="Apply bounds"
                          style={{ ...iconBtn, color: '#4ade80', opacity: 1 }}
                        >
                          <Icon name="check" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          title="Cancel — keep the original bounds"
                          aria-label="Cancel edit"
                          style={{ ...iconBtn, color: '#f87171', opacity: 1 }}
                        >
                          <Icon name="x" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => { boundsDraftRef.current = null; setEditingId(s.id); }}
                        title="Edit bounds — drag the corner handles on the map"
                        aria-label="Edit area bounds"
                        style={iconBtn}
                      >
                        <Icon name="edit" />
                      </button>
                    )}
                    <button
                      onClick={() => closeSelection(s.id)}
                      title="Delete this area"
                      aria-label="Delete this area"
                      style={iconBtn}
                    >
                      <Icon name="trash" />
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
            disabled={geoLoading}
            style={{ ...toggleStyle(settingsOpen), display: 'inline-flex', alignItems: 'center', padding: '4px 8px', ...(geoLoading ? { cursor: 'not-allowed', opacity: 0.4 } : null) }}
            title={geoLoading ? 'Geography loading…' : 'Settings'}
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >
            <Icon name="settings" />
          </button>
          {settingsOpen && (
            <div
              ref={settingsPopRef}
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
              {/* Label size is display-time (world size × this; labels scale with
                  the map), so it applies LIVE — no Save/redraw, unlike the above. */}
              <Slider
                label="Label size"
                value={labelScale}
                min={LABEL_SCALE_MIN}
                max={LABEL_SCALE_MAX}
                step={0.1}
                display={`${labelScale.toFixed(1)}×`}
                onChange={setLabelScale}
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
                  {/* Density cutoff for which clusters become warp boxes: lower = looser
                      cutoff → more/larger boxes; higher = only the densest cores → fewer.
                      Toggle "Warp boxes" in the top bar to see the effect. */}
                  <Slider
                    label="Box density cutoff"
                    value={boxFrac}
                    min={BOX_FRAC_MIN}
                    max={BOX_FRAC_MAX}
                    step={0.05}
                    display={`${boxFrac.toFixed(2)}${boxFrac < DEFAULT_BOX_FRAC ? ' · more' : boxFrac > DEFAULT_BOX_FRAC ? ' · fewer' : ' · default'}`}
                    onChange={setBoxFrac}
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
                    setBoxFrac(DEFAULT_BOX_FRAC);
                    setApplied({
                      lineWidth: DEFAULT_LINE_WIDTH,
                      stationRadius: DEFAULT_STATION_RADIUS,
                      mapMargin: DEFAULT_MAP_MARGIN,
                      warpPos: DEFAULT_REALISM_POS,
                      linePos: DEFAULT_REALISM_POS,
                      boxWarpPos: DEFAULT_REALISM_POS,
                      boxFrac: DEFAULT_BOX_FRAC,
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
                    setApplied({ lineWidth, stationRadius, mapMargin, warpPos, linePos, boxWarpPos, boxFrac });
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
              {/* Map file: save the generated layout + settings, reload instantly. */}
              <div style={{ borderTop: '1px solid rgba(136,136,136,0.25)', marginTop: 4, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', opacity: 0.55 }}>Map file</span>
                <span style={{ fontSize: 11, opacity: 0.55 }}>Save a generated map and load it back to skip the rebuild on reload.</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={exportMap}
                    disabled={mode !== 'smoothed' || !svg || generating}
                    title="Save the generated map (layout + settings) to a file"
                    style={{ flex: 1, fontSize: 12, fontWeight: 600, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(136,136,136,0.4)', background: 'transparent', color: 'inherit', cursor: mode !== 'smoothed' || !svg || generating ? 'default' : 'pointer', opacity: mode !== 'smoothed' || !svg || generating ? 0.5 : 1 }}
                  >
                    ⭳ Save map
                  </button>
                  <button
                    onClick={() => mapFileRef.current?.click()}
                    title="Load a saved map file"
                    style={{ flex: 1, fontSize: 12, fontWeight: 600, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(136,136,136,0.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                  >
                    ⭱ Load map
                  </button>
                </div>
                {/* Clear the saved layout cache for this city — escape hatch for a stale/wrong
                    cached layout; the on-screen map stays, but reload/next Generate rebuilds. */}
                <button
                  onClick={clearCache}
                  title="Delete this city's saved layout cache (forces a fresh rebuild on next Generate or reload)"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(192,90,80,0.5)', background: 'transparent', color: '#cf5b52', cursor: 'pointer' }}
                >
                  <Icon name="trash" size={13} /> Clear cache
                </button>
                {mapMsg && <span style={{ fontSize: 11, opacity: 0.7 }}>{mapMsg}</span>}
                <input
                  ref={mapFileRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importMap(f); e.target.value = ''; }}
                />
              </div>
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
        >
          {/* The canvas render surface (the only renderer). */}
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        </div>
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
            colored outline over its map region + a draggable re-sim panel. Gated on a
            SHOWN smoothed map: `selections` can be non-empty before the map is generated
            (the restore repopulates it while a mode switch has blanked smoothedReady) and
            briefly during a switch to geographic (before the clear lands). Rendering then
            painted areas over the Generate button and re-simulated against a missing pre,
            and flickered on geographic — so only mount the insets when the map is up. */}
        {mode === 'smoothed' && smoothedReady && selections.map((s) => (
          <DetailInset
            key={s.id}
            sel={s}
            getView={getView}
            registerReposition={registerReposition}
            getMainPre={getMainPre}
            getCacheKey={getSubCacheKey}
            buildInput={buildInput}
            baseSvg={svg}
            showStations={showStations}
            showLabels={showLabels}
            labelScale={labelScale}
            editing={editingId === s.id}
            onBoundsChange={onBoundsChange}
            onRectChange={onRectChange}
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
                // Fresh build: drop any per-mount layout from a prior generation.
                smoothedCacheRef.current = null;
                // Peek the fingerprinted cache (cheap, fp-only) so the spinner can
                // say whether this Generate will reuse the cache or run octi.
                try {
                  const city = modState.cityCode ?? api.utils.getCityCode?.() ?? '';
                  setCacheHit(!!city && peekCache(city, fingerprintInputs(buildInput() as never).fp));
                } catch {
                  setCacheHit(false);
                }
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
            <span style={{ color: '#888', fontSize: 12 }}>{cacheHit ? 'Cache used' : 'This may take a while'}</span>
            <style>{`@keyframes imp-spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
      </div>
    </div>
  );
}
