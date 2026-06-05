/**
 * SchematicPanel — the in-game floating panel that renders the improved
 * schematic from live game state.
 *
 * Follows the game's own SchematicMapMenu pattern: generate an SVG string with
 * useMemo, then inject it via innerHTML into a container ref.
 *
 * Water is currently an optional input. Runtime water generation from the
 * city's ocean_depth_index is the next milestone; until then the panel renders
 * route lines on the land background.
 */

import { useMemo, useRef, useEffect, useState } from 'react';
import { generateSchematicSVG } from '../render/schematic';
import type { WaterCollection } from '../render/types';

const api = window.SubwayBuilderAPI;

export function SchematicPanel() {
  const [showStations, setShowStations] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Water for the current city. Populated by the runtime generator (TODO);
  // undefined for now → lines render on the land background.
  const water: WaterCollection | undefined = undefined;

  const svg = useMemo(() => {
    const routes = api.gameState.getRoutes();
    const tracks = api.gameState.getTracks();
    const stations = api.gameState.getStations().map((s) => ({
      id: s.id,
      name: s.name,
      coords: s.coords,
    }));

    if (routes.length === 0) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800"><rect width="800" height="800" fill="#f2eadb"/><text x="400" y="400" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#888">Build at least one route to see a schematic.</text></svg>';
    }

    return generateSchematicSVG({
      routes,
      tracks,
      stations,
      water,
      options: { width: 800, height: 800, showStations, showLabels: false },
    });
  }, [showStations, water]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.innerHTML = svg;
  }, [svg]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={() => setShowStations((v) => !v)}
          style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
        >
          {showStations ? '✓ Stations' : 'Stations'}
        </button>
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 6 }}
      />
    </div>
  );
}
