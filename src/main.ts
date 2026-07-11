/**
 * Improved Schematics entry point.
 *
 * Registers a floating panel that renders a geographic schematic of the
 * player's transit system with land/water context, plus an escape-menu button
 * to open it.
 *
 * Registration follows the verified mod-UI lifecycle (see the Induced Demand
 * mod's docs/MODDING_UI.md): mod UI is cleared by reloadMods() and by
 * returning to the main menu, and the loader can execute this script more
 * than once per reload wave. So the panel is (re)registered from onMapReady
 * and onGameLoaded through one idempotent ensure function, and every hook
 * body is guarded by a monotonic generation counter on window so only the
 * newest script execution acts.
 */

import { SchematicPanel } from './ui/SchematicPanel';
import { modState, PANEL_ID, PANEL_STORAGE_KEY } from './state';
import { MOD_VERSION } from './version';

const TAG = '[ImprovedSchematics]';

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found!`);
} else {
  // Generation guard: each script execution claims a generation; callbacks
  // from any but the latest execution no-op (newest wins, hot-reload-safe).
  const GEN_KEY = '__improvedSchematicsGeneration__';
  const w = window as unknown as Record<string, number | undefined>;
  const myGen = (w[GEN_KEY] = (w[GEN_KEY] ?? 0) + 1);
  const isCurrent = (): boolean => w[GEN_KEY] === myGen;

  console.log(`${TAG} v${MOD_VERSION} | API v${api.version} | gen ${myGen}`);

  // Forget any persisted panel size/position from a previous session, so a
  // fresh game LAUNCH opens the panel at our defaults. Only the first script
  // execution of the page does this: a mod reload mid-session must not throw
  // away where the player put the panel.
  if (myGen === 1) {
    try {
      localStorage.removeItem(PANEL_STORAGE_KEY);
    } catch {
      /* localStorage may be unavailable in some embeddings; ignore. */
    }
  }

  const BUTTON_ID = 'improved-schematic-button';
  let announced = false;

  /**
   * Idempotent panel + button registration. Called from every lifecycle hook
   * that can follow a UI clear (reloadMods, return to main menu), and safe to
   * call repeatedly within one reload wave: unregister-before-add keeps both
   * components single-instance regardless of each add-call's dedupe behavior.
   */
  function ensurePanel(): void {
    if (!isCurrent()) return;
    try {
      try {
        api.ui.unregisterComponent('top-bar', PANEL_ID);
      } catch {
        /* nothing registered yet */
      }
      try {
        api.ui.unregisterComponent('escape-menu', BUTTON_ID);
      } catch {
        /* nothing registered yet */
      }

      api.ui.addFloatingPanel({
        id: PANEL_ID,
        title: 'Improved Schematic',
        icon: 'Waypoints',
        defaultWidth: 840,
        defaultHeight: 880,
        render: SchematicPanel,
      });

      api.ui.addButton('escape-menu', {
        id: BUTTON_ID,
        label: 'Improved Schematic',
        icon: 'Waypoints',
        onClick: () => {
          api.ui.showNotification('Open the Improved Schematic panel from the toolbar.', 'info');
        },
      });

      if (!announced) {
        announced = true;
        console.log(`${TAG} Initialized.`);
      }
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification('Improved Schematics failed to load. Check console.', 'error');
    }
  }

  // Track the current city so the panel can load that city's water layer. Geography is
  // harvested lazily (see geography/warm.ts), kicked off when the panel first opens rather
  // than at city load. Harvesting during the game's heavy first-load yields unusable/404
  // tiles and contends with the basemap. The warm-up still runs module-level, so it survives
  // the panel being closed and a reopen picks up the cached result.
  api.hooks.onCityLoad((cityCode) => {
    if (!isCurrent()) return;
    modState.cityCode = cityCode;
  });

  // onMapReady re-fires on city load/switch, after reloadMods, and when
  // re-entering a game from the main menu (where mod UI was cleared).
  // onGameLoaded is the backup for save loads onto a different city|mode and
  // immediate-invokes when a save is already loaded, which ensurePanel absorbs.
  api.hooks.onMapReady(() => {
    ensurePanel();
  });
  api.hooks.onGameLoaded(() => {
    ensurePanel();
  });
}
