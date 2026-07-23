/**
 * Simplified-route style surface. A style is a DECLARATIVE descriptor rather
 * than a paint function: line drawing is global and layered (unlike a station
 * design, which owns one station's glyphs), so each field maps to exactly one
 * decision point in the draw. Adding a style is one entry in SIMPLIFIED_STYLES.
 *
 * Nothing here moves a line. Bundle membership and lane position are untouched,
 * so a simplified route keeps the map's structure intact.
 */

export interface SimplifiedStyle {
  id: string;
  name: string;
  /** Multiplies the drawn stroke width. The lane SLOT keeps its full width and
   *  position, so a thinner stroke leaves clear space either side: separation
   *  from its bundle mates without moving the line. */
  lineWidthScale: number;
  /** Draw the background casing halo. Off leaves the slot's spare width clear. */
  casing: boolean;
  /** Contribute station markers. */
  stationMarks: boolean;
  /** May join an interchange capsule. Only meaningful alongside stationMarks:
   *  a route with no markers has nothing to seat in a capsule either way. */
  capsuleMember: boolean;
  /** Contribute station labels. A station whose every serving route declines
   *  labels draws none. */
  labels: boolean;
}
