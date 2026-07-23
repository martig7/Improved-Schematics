/**
 * Simplified-route style surface. A style is a DECLARATIVE descriptor rather
 * than a paint function: line drawing is global and layered (unlike a station
 * design, which owns one station's glyphs), so each field maps to exactly one
 * decision point in the draw. Adding a style is one entry in SIMPLIFIED_STYLES.
 *
 * Nothing here moves a line. Bundle membership and lane position are untouched,
 * so a simplified route keeps the map's structure intact.
 */

/** How much of a simplified route still draws a given per-stop element, widest
 *  first. Each scope contains the ones after it: 'intersection' also keeps the
 *  ends, so a route shows where it starts, where it finishes, and where it meets
 *  other lines. An intersection is a station served by more than one line,
 *  measured on the FULL membership (a simplified neighbour still counts) and
 *  unioned across the platform-split units of one station. */
export type SimplifiedScope = 'all' | 'intersection' | 'termini' | 'none';

/** One user-tunable number a style exposes, with everything a control needs to
 *  render and everything a loader needs to clamp a stored value. Values are kept
 *  per route, so two routes on the same style can be tuned apart. */
export interface SimplifiedSettingSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Suffix for the displayed value, when the number alone is ambiguous
   *  (a percentage against a raw pixel length). */
  unit?: string;
  /** How the value is presented. Absent is a plain range slider. 'shade' is a
   *  black-to-white value shown as a swatch that opens a gradient picker, and is
   *  only in effect while its `enableKey` is on. */
  control?: 'shade';
  /** 'shade' only: the companion on/off key, stored as 0 or 1. Defaults to off,
   *  so a style carrying the setting does not change how it draws until asked. */
  enableKey?: string;
}

/** A route's simplified display: which style, plus that style's tunables. The
 *  bare-string form is the shorthand for "this style, all defaults". */
export type SimplifiedSetting = { style: string; params?: Record<string, number> };

export interface SimplifiedStyle {
  id: string;
  name: string;
  /** The style's intended stroke weight as a fraction of normal. Every style
   *  carries a user-tunable Line width setting and this is its DEFAULT, so a
   *  style declares its weight once instead of restating the control. The lane
   *  SLOT keeps its full width and position, so a thinner stroke leaves clear
   *  space either side: separation from its bundle mates without moving the
   *  line. */
  lineWidthScale: number;
  /** Draw the background casing halo. Off leaves the slot's spare width clear. */
  casing: boolean;
  /** Which of the route's stops get a marker. A stop with no marker also leaves
   *  its interchange capsule, since the capsule seats markers; a kept marker
   *  joins one normally (a stop inside a station group takes its place in the
   *  capsule rather than drawing a lone dot). */
  stationMarks: SimplifiedScope;
  /** Which of the route's stops contribute a station label, on the same scale.
   *  Independent of stationMarks, though a style normally keeps them in step so
   *  a label has a marker to hang off. A station labels itself when ANY route
   *  serving it still contributes one, which is what names an interchange shared
   *  by several simplified routes. */
  labels: SimplifiedScope;
  /** Numbers this style lets the user tune. Absent = nothing to configure. */
  settings?: SimplifiedSettingSpec[];
  /** Dashed stroke. The ON run is the named setting's value in world px and the
   *  gap is that length times gapRatio, so the pattern is stated in map distance
   *  and stays put as the view zooms. */
  dash?: { lengthSetting: string; gapRatio: number };
}
