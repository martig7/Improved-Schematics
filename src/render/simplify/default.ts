import type { SimplifiedStyle } from './types';

/** A de-emphasized line: quarter width, no casing, and a marker plus a name only
 *  where the route is worth reading, namely its ENDS and the stations where it
 *  meets other lines. The lane slot keeps its full width and position, so the
 *  thin stroke reads as a line set back from its bundle mates with clear space
 *  either side. */
export const simplifiedDefault: SimplifiedStyle = {
  id: 'default',
  name: 'Default',
  lineWidthScale: 0.25,
  casing: false,
  stationMarks: 'intersection',
  labels: 'intersection',
};
