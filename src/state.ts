// Tiny shared mod state + constants, kept in its own module so main.ts and the
// panel can both reference them without a circular import.

export const modState: { cityCode: string | null } = { cityCode: null };

export const PANEL_ID = 'improved-schematic-panel';

/** localStorage key the game's FloatingPanel uses to persist our panel's
 *  size/position. Clearing it forces the next mount to use our defaults. */
export const PANEL_STORAGE_KEY = `floating-panel-${PANEL_ID}`;
