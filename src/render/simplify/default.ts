import type { SimplifiedStyle } from './types';

/** A bare de-emphasized line: quarter width, no casing, no markers, no capsule
 *  membership, no labels. The lane slot keeps its full width and position, so the
 *  thin stroke reads as a line set back from its bundle mates with clear space
 *  either side. */
export const simplifiedDefault: SimplifiedStyle = {
  id: 'default',
  name: 'Default',
  lineWidthScale: 0.25,
  casing: false,
  stationMarks: false,
  capsuleMember: false,
  labels: false,
};
