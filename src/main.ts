/**
 * Improved Schematics — entry point.
 *
 * Registers a floating panel that renders a geographic schematic of the
 * player's transit system with land/water context, plus an escape-menu button
 * to open it.
 */

import { SchematicPanel } from './ui/SchematicPanel';
import { modState, PANEL_ID, PANEL_STORAGE_KEY } from './state';
import { warmGeography } from './geography/warm';

const MOD_VERSION = '0.1.0';
const TAG = '[ImprovedSchematics]';

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found!`);
} else {
  console.log(`${TAG} v${MOD_VERSION} | API v${api.version}`);

  // Forget any persisted panel size/position from a previous session, so a
  // fresh game launch always opens the panel at our defaults.
  try {
    localStorage.removeItem(PANEL_STORAGE_KEY);
  } catch {
    /* localStorage may be unavailable in some embeddings; ignore. */
  }

  // Track the current city so the panel can load that city's water layer, and start
  // harvesting its geography in the background right away — decoupled from the panel, so
  // the per-city cache is warm by the time the user opens it (and the harvest's retry
  // survives the panel being closed before its inputs were ready). See geography/warm.ts.
  api.hooks.onCityLoad((cityCode) => {
    modState.cityCode = cityCode;
    warmGeography(cityCode);
  });

  // onMapReady can fire multiple times (city load/switch); guard init.
  let initialized = false;

  api.hooks.onMapReady(() => {
    if (initialized) return;
    initialized = true;

    try {
      api.ui.addFloatingPanel({
        id: PANEL_ID,
        title: 'Improved Schematic',
        icon: 'Waypoints',
        defaultWidth: 840,
        defaultHeight: 880,
        render: SchematicPanel,
      });

      api.ui.addButton('escape-menu', {
        id: 'improved-schematic-button',
        label: 'Improved Schematic',
        icon: 'Waypoints',
        onClick: () => {
          api.ui.showNotification('Open the Improved Schematic panel from the toolbar.', 'info');
        },
      });

      console.log(`${TAG} Initialized.`);
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification('Improved Schematics failed to load. Check console.', 'error');
    }
  });
}
