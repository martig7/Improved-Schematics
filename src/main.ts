/**
 * Improved Schematics — entry point.
 *
 * Registers a floating panel that renders a geographic schematic of the
 * player's transit system with land/water context, plus an escape-menu button
 * to open it.
 */

import { SchematicPanel } from './ui/SchematicPanel';
import { modState } from './state';

const MOD_VERSION = '0.1.0';
const TAG = '[ImprovedSchematics]';

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found!`);
} else {
  console.log(`${TAG} v${MOD_VERSION} | API v${api.version}`);

  // Track the current city so the panel can load that city's water layer.
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
        id: 'improved-schematic-panel',
        title: 'Improved Schematic',
        icon: 'Map',
        defaultWidth: 840,
        defaultHeight: 880,
        render: SchematicPanel,
      });

      api.ui.addButton('escape-menu', {
        id: 'improved-schematic-button',
        label: 'Improved Schematic',
        icon: 'Map',
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
