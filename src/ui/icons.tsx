// Detail-area control icons, resolved from the game's bundled Lucide set
// (window.SubwayBuilderAPI.utils.icons — the same source the panel/menu icons use, e.g.
// `icon: 'Waypoints'` in main.ts). Using the real Lucide components keeps these controls
// visually consistent with the rest of the game UI rather than hand-rolled glyphs/SVGs.
//
// Lucide is loaded by stroke="currentColor", so each icon inherits the button's text color
// (and opacity) for free — exactly what the row's other controls expect.

export type IconName = 'lock' | 'unlock' | 'edit' | 'check' | 'x' | 'trash';

// Each semantic name → ordered Lucide candidates; the first one present in the game's set
// wins. Names drift across Lucide versions (Unlock → LockOpen, Edit → SquarePen, etc.), so
// list the likely aliases and resolve defensively.
const LUCIDE: Record<IconName, string[]> = {
  lock: ['Lock'],
  unlock: ['Unlock', 'LockOpen'],
  edit: ['Pencil', 'SquarePen', 'PenLine', 'Edit3', 'Edit'],
  check: ['Check'],
  x: ['X'],
  trash: ['Trash2', 'Trash'],
};

/** A Lucide icon from the game's set. Renders nothing if none of the candidates exist
 *  (all of these are core Lucide icons, so that's a defensive fallback only). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  const set = window.SubwayBuilderAPI?.utils?.icons;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let C: any = null;
  if (set) {
    for (const candidate of LUCIDE[name]) {
      if (set[candidate]) { C = set[candidate]; break; }
    }
  }
  if (!C) return null;
  return <C size={size} />;
}
