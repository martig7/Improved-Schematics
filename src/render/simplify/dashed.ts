import type { SimplifiedStyle } from './types';

/** The de-emphasis of the default style, but the thin stroke is broken into
 *  dashes, so the route reads as secondary even where it runs alone with nothing
 *  to be thin against. Dash length is in world px (map distance), so the pattern
 *  holds its proportions as the view zooms. */
export const simplifiedDashed: SimplifiedStyle = {
  id: 'dashed',
  name: 'Dashed',
  lineWidthScale: 0.25,
  casing: false,
  stationMarks: 'intersection',
  labels: 'intersection',
  settings: [{ key: 'dashLength', label: 'Dash length', min: 2, max: 40, step: 1, default: 10 }],
  dash: { lengthSetting: 'dashLength', gapRatio: 1 },
};
