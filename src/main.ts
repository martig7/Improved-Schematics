/**
 * Improved Schematics — entry point.
 *
 * Registers a floating panel that renders a geographic schematic of the
 * player's transit system with land/water context, plus an escape-menu button
 * to open it.
 */

import { SchematicPanel } from './ui/SchematicPanel';
import { modState, PANEL_ID, PANEL_STORAGE_KEY } from './state';

const MOD_VERSION = '1.2.0';
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

  // Track the current city so the panel can load that city's water layer. (Geography is
  // harvested lazily — see geography/warm.ts, kicked off when the panel first opens, NOT
  // at city load: harvesting during the game's heavy first-load gets "Unusable"/404 tiles
  // and contends with the basemap. The warm-up still runs module-level, so it survives the
  // panel being closed and a reopen picks up the cached result.)
  api.hooks.onCityLoad((cityCode) => {
    modState.cityCode = cityCode;
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
