/**
 * Station design surface types. A design is one pure function
 * paint(scene, ctx) -> Glyph[]; the same draw list drives the map SVG, the
 * canvas Prim scene, and the picker preview. Placement (design-agnostic
 * geometry) produces StopScene; designs only decide appearance.
 */

export type Point = [number, number];

/** One stopping line at a station. */
export interface StopLine {
  lineId: string;
  color: string;      // route color (hex)
  bullet: string;     // route bullet text (may be '')
  textColor: string;  // route text color (hex), or '' when the route has none
  pos: Point;         // solved dot center, world px
  chain: number;      // order within the capsule spine
  seq?: number;       // station number (1-based stop index along the line), when known
  axis?: number;      // octilinear run-axis of the line at this stop (0=-, 1=/, 2=|, 3=\), mod 180 deg
  dir?: Point;        // exact unit tangent of the line at this stop (unquantized); tick markers strike strictly perpendicular to it
  terminus?: boolean; // the line ends at this stop (loops have no terminus); tick markers cap it with a full two-sided tick
  outward?: Point;    // unit vector from the bundle's drawn centerline toward this lane; a one-sided tick strikes toward it (away from co-running lanes). Absent for a centered/isolated lane
  end?: Point;        // unit vector pointing OFF THE END of a terminus, away from the track it arrives on. Set only on termini; `dir` cannot serve, being a tangent defined only up to sign

}

/** Design-agnostic capsule (interchange) geometry, from placement. */
export type Capsule =
  | { kind: 'none' }
  | { kind: 'pill'; points: Point[]; smooth: boolean;
      /** Where the capsule's lanes were found to cross at a single point, from the
       *  compute-time solve over the drawn ribbons. Set only under a crossing
       *  regime; a design that marks a junction as a point reads it instead of
       *  re-deriving one from the mark positions. */
      cross?: Point }
  | { kind: 'ring'; cx: number; cy: number; r: number }
  | { kind: 'rectRows';
      box: number;                                   // box side length (world px)
      groups: Array<{ x: number; y: number; w: number; h: number; rx: number }>; // one rounded-rect per aligned row
      connectors: Array<{ points: Point[] }>;        // octilinear polyline (2 pts = 1 segment, 3 = one bend)
      /** Compute-time extruded neck paths for the connectors; absent for a
       *  capsule cached before the field existed (paint re-extrudes then). */
      necks?: string[];
    }
  | { kind: 'londonBubbles';                         // one white bubble per pair of lines, chained by connector bars
      bubbles: Array<{ x: number; y: number; r: number }>;
      necks: Array<{ x0: number; y0: number; x1: number; y1: number; w: number }>;
    }
  | { kind: 'dcMarks';                               // marks + line-end symbols, solved over the whole map
      /** Each mark: where it stands, how far its ink reaches, and whether it is the
       *  interchange ring or the plain stop circle. */
      marks: Array<{ at: Point; r: number; ring: boolean; lineId?: string }>;
      /** Each terminating line: where its tail is cut, and where its symbol sits. */
      ends: Array<{ lineId: string; cut: Point; at: Point }>;
      /** The capsule spine, when the station is wide enough to need one drawn. */
      spine?: Point[];
    };

/** Everything a design needs to paint one station. `lines` is the set of dots
 *  to draw. */
export interface StopScene {
  nodeId: string;
  lines: StopLine[];
  capsule: Capsule;
  anchor: Point;     // marker anchor (imp-stop group / label)
  dotRadius: number; // solved dot radius (full, or capsule-shrunk)
}

/** Theme + toggles handed to every paint(). */
export interface PaintCtx {
  dark: boolean;
  showBullets: boolean; // stations toggle; when false, omit bullet text glyphs
  /** The land colour the routes' casings are drawn in. A design that continues a
   *  line itself has to case it the same way, and the colour is not derivable from
   *  the theme alone: a colorset supplies its own. Absent falls back to the theme. */
  land?: string;
}

/** Design-level, backend-agnostic marker vocabulary. No layer/worldScale —
 *  serialize.ts adds those. */
export type Glyph =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke: string; strokeWidth: number; data?: Record<string, string> }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number; fill: string; stroke: string; strokeWidth: number }
  | { kind: 'path'; d: string; fill: string; stroke: string; strokeWidth: number; lineCap: 'round' | 'butt' | 'square'; lineJoin: 'round' | 'miter' | 'bevel' }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { kind: 'text'; x: number; y: number; text: string; fontSize: number; fontWeight: string; fill: string; align: 'start' | 'middle' | 'end';
      /** Optional font-family stack; absent = the renderer's default stack. */
      fontFamily?: string };

export interface ExampleStation { bullet: string; color: string; textColor: string }

export interface StationDesign {
  id: string;
  name: string;
  blurb?: string;
  /** Interchange capsule regime the design wants placement to produce. Default
   *  'pill'. 'rectRows' triggers the upright-box rectangle seating;
   *  'londonBubbles' the paired ticket-hall bubbles; 'toronto' and 'dc' both run
   *  the point-crossing collapse but differ in what the scene carries (see
   *  PlacementCtx.capsuleMode). */
  capsule?: 'pill' | 'rectRows' | 'londonBubbles' | 'toronto' | 'dc';
  /** Paint one station into a draw list (capsule glyphs first, dots/bullets
   *  after, so dots render on top). Pure. */
  paint: (scene: StopScene, ctx: PaintCtx) => Glyph[];
  /** What the preview tile depicts. 'single' (default) = one dot; 'interchange'
   *  = a two-line station so a capsule-distinct design shows its capsule;
   *  'onLine' = one stop drawn on a horizontal route line (for a tick marker
   *  that only reads against the line it strikes); 'lineEnd' = the end of a route,
   *  for a design whose terminus is its most distinctive mark. */
  previewKind?: 'single' | 'interchange' | 'onLine' | 'lineEnd';
}
