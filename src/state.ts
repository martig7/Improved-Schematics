// Tiny shared mod state + constants, kept in its own module so main.ts and the
// panel can both reference them without a circular import.

// `saveName` (from the game's onGameLoaded/onGameSaved hooks) scopes the layout cache
// per save, so two saves on the SAME seed/city don't share cached layout/areas/settings.
// Null until a save loads; the cache falls back to city-only scoping when unknown.
export const modState: { cityCode: string | null; saveName: string | null } = { cityCode: null, saveName: null };

export const PANEL_ID = 'improved-schematic-panel';

/** localStorage key the game's FloatingPanel uses to persist our panel's
 *  size/position. Clearing it forces the next mount to use our defaults. */
export const PANEL_STORAGE_KEY = `floating-panel-${PANEL_ID}`;
