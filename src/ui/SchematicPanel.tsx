/**
 * SchematicPanel — the in-game floating panel that renders the improved
 * schematic from live game state.
 *
 * Generates an SVG string with useMemo (following the game's own
 * SchematicMapMenu pattern), then injects it via innerHTML into a container ref.
 * A mode selector switches between the geographic, smoothed, and octilinear
 * (schematic) renderers; labels and station markers are toggleable.
 *
 * Water is currently an optional input. Runtime water generation from the city's
 * ocean_depth_index is a separate milestone; until then modes render without it.
 */

import { useMemo, useRef, useEffect, useState } from 'react';
import { generateSchematicSVG } from '../render/schematic';
import type { RenderMode, WaterCollection } from '../render/types';
import { generateWater } from '../water/oceanIndex';
import { modState } from '../state';

const api = window.SubwayBuilderAPI;

const MODES: { id: RenderMode; label: string }[] = [
  { id: 'geographic', label: 'Geographic' },
  { id: 'smoothed', label: 'Smoothed' },
  { id: 'schematic', label: 'Schematic' },
];

export function SchematicPanel() {
  const [mode, setMode] = useState<RenderMode>('geographic');
  const [showStations, setShowStations] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Water for the current city, generated from its ocean_depth_index on first
  // open and cached. Undefined until it resolves (or if the city has none).
  const [water, setWater] = useState<WaterCollection | undefined>(undefined);
  useEffect(() => {
    const city = modState.cityCode;
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
      options: { mode, width: 900, height: 900, showStations, showLabels, dark },
    });
  }, [mode, showStations, showLabels, water]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.innerHTML = svg;
  }, [svg]);

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
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 6 }}
      />
    </div>
  );
}
