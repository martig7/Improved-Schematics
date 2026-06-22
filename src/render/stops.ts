// Per-station markers, NYC-subway-map style: EVERY stopping line gets a dot
// on its own lane in all cases, and the capsule is an outline that SURROUNDS
// the dots (real-map Canal St model) rather than replacing them — so a
// capsule can never mislead about which lines actually stop. Capsule iff the
// station has multiple member stations (group) OR multiple stopping lines at
// one station (express/local pairs). Each dot prints its line's name (route
// bullet) inside, upright, toggled by the stations toggle.

import type { Pixel, StopMark } from './layout/types';
import { LINE_WIDTH, LINE_GAP, MEGA_BOXES, MARKER_SCALE } from './constants';
import { escapeXml } from './escape';
import { rdpSimplify } from './layout/chainPlace';
import type { Prim } from './sceneIR';

export function renderStops(
  stopsByNode: Map<string, StopMark[]>,
  dark: boolean,
  membersByNode?: Map<string, number>,
  degByNode?: Map<string, number>,
  showNames?: boolean,
  prims?: Prim[],
): string[] {
  const out: string[] = [];
  const r = LINE_WIDTH * 0.7;
  // Option C — shrink the rendered marker ONLY inside capsules (multi-line
  // stations), where corner-flanking / multi-arm bullet rings overlap; single
  // standalone dots stay full size. Layout/spacing is unchanged — only the
  // rendered dot radius + ring stroke + capsule width + font shrink. The rigid-
  // row solver floors intra-capsule dot gaps at this SAME scaled ring diameter
  // (MARKER_SCALE lives in constants.ts so the two can't drift).
  const rCap = r * MARKER_SCALE; // dot/capsule radius INSIDE a capsule
  const spacing = LINE_WIDTH + LINE_GAP; // lane pitch — a compact capsule is ~markCount·spacing
  const fill = dark ? '#18181b' : '#ffffff';
  const stroke = dark ? '#e4e4e7' : '#111111';
  const nameFill = dark ? '#ffffff' : '#111111';

  // Each marker is wrapped in an anchored group (class imp-stop, data-ax/-ay
  // = the marker's anchor point); markers are pure map objects (no panel
  // counter-scaling) but the class also excludes them from stroke scaling.
  const wrap = (ax: number, ay: number, inner: string): string =>
    '<g class="imp-stop" data-ax="' + ax.toFixed(1) + '" data-ay="' + ay.toFixed(1) + '">' +
    inner + '</g>';

  // One dot per stopping line: hollow disc on the line's own lane, ring in
  // the line's color, route bullet centered inside (always upright/north-up).
  // Scene prims (when a sink is passed) accumulate into `dotPrims` so the caller
  // can flush them at the EXACT concatenation point of the dots string — the
  // dots come AFTER the capsule/ring border in the markup, and the mega branch
  // emits no dots at all, so pushing eagerly would mis-order or over-emit.
  const dotPrims: Prim[] = [];
  const dotOf = (mk: StopMark, dr: number): string => {
    const dStroke = 1.5 * (dr / r); // ring stroke scales with the dot
    let s =
      '<circle cx="' + mk.pos[0].toFixed(1) + '" cy="' + mk.pos[1].toFixed(1) +
      '" r="' + dr.toFixed(1) + '" fill="' + fill + '" stroke="' + escapeXml(mk.color) +
      '" stroke-width="' + dStroke.toFixed(2) + '" data-line="' + escapeXml(mk.lineId) + '"/>';
    // Scene prim alongside the dot circle (same numbers as the string). Coords
    // are rounded to .1 to match what the parser reads back from the markup.
    if (prims) dotPrims.push({
      kind: 'circle',
      cx: +mk.pos[0].toFixed(1), cy: +mk.pos[1].toFixed(1), r: +dr.toFixed(1),
      fill, stroke: mk.color, strokeWidth: +dStroke.toFixed(2),
      layer: 'stops', worldScale: true,
    });
    if (showNames && mk.name) {
      const fs = mk.name.length <= 1 ? dr * 1.7 : Math.min(dr * 1.7, (2 * dr * 0.92) / (0.6 * mk.name.length));
      const ty = +(mk.pos[1] + fs * 0.36).toFixed(1);
      s +=
        '<text x="' + mk.pos[0].toFixed(1) + '" y="' + (mk.pos[1] + fs * 0.36).toFixed(1) +
        '" text-anchor="middle" font-family="Helvetica, &quot;Helvetica Neue&quot;, Arial, sans-serif"' +
        ' font-size="' + fs.toFixed(2) + '" font-weight="bold" fill="' + nameFill + '">' +
        escapeXml(mk.name) + '</text>';
      // Bullet text prim: route-bullet name, worldScale TRUE (inside .imp-stop).
      // x/y are the world position (ax=ay=0 since the wrap uses data-ax/-ay, not
      // a transform=translate the parser would accumulate).
      if (prims) dotPrims.push({
        kind: 'text',
        text: mk.name,
        x: +mk.pos[0].toFixed(1), y: ty, ax: 0, ay: 0,
        fontSize: +fs.toFixed(2), fontWeight: 'bold', align: 'center',
        fill: nameFill, layer: 'stops', worldScale: true,
      });
    }
    return s;
  };
  // Move the dots' accumulated prims into the output sink, in build order.
  const flushDots = (): void => {
    if (prims) for (const p of dotPrims) prims.push(p);
  };

  for (const [nodeId, marks] of stopsByNode) {
    if (marks.length === 0) continue;
    dotPrims.length = 0; // dots accumulate per node; reset before this marker
    const members = membersByNode?.get(nodeId);
    const capsule = marks.length > 1 || (members !== undefined && members > 1);

    // Farthest pair of marks defines the marker axis (marks per station are
    // the lane fan across a bundle, so they are near-collinear).
    let ai = 0;
    let best = 0;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const d = Math.sqrt(
          (marks[i].pos[0] - marks[j].pos[0]) ** 2 +
          (marks[i].pos[1] - marks[j].pos[1]) ** 2,
        ); // correctly-rounded cross-V8 (hypot is not)
        if (d > best) { best = d; ai = i; }
      }
    }
    const a = marks[ai].pos;
    const lineIds = marks.map((m) => m.lineId).join(',');
    const attrs =
      ' data-stops="' + escapeXml(lineIds) + '" data-station-id="' + escapeXml(nodeId) + '"';
    const dots = marks.map((mk) => dotOf(mk, capsule ? rCap : r)).join(''); // shrink only capsule dots

    if (!capsule) {
      // single line at a single station: just its dot
      out.push(wrap(a[0], a[1],
        '<g' + attrs + '>' + dots + '</g>',
      ));
      flushDots(); // the dot is the whole marker
      continue;
    }

    // mega eligibility mirrors the pre-dots rule exactly: group-driven
    // capsules (members known) need >1 members; legacy callers need >1 marks
    const megaEligible = members !== undefined ? members > 1 : marks.length > 1;
    // mega fires per-station when the rigid-row solver found no feasible
    // configuration (spec v2 §3), or via the dormant global MEGA_BOXES rule
    if (marks.some((m) => m.mega) || (MEGA_BOXES && megaEligible && (degByNode?.get(nodeId) ?? 0) >= 12)) {
      // Mega capsule for huge interchanges (user rule): the junction's whole
      // footprint becomes the marker — a rounded rectangle covering the
      // marks with padding — so lines may reverse/cross/weave freely
      // underneath it and read as passing straight through the station.
      // generous padding: connector chords and lane reversals at the junction
      // happen within ~half a grid cell of the marks — cover them
      const pad = r + 7;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const mk of marks) {
        x0 = Math.min(x0, mk.pos[0]); y0 = Math.min(y0, mk.pos[1]);
        x1 = Math.max(x1, mk.pos[0]); y1 = Math.max(y1, mk.pos[1]);
      }
      // Cap the box to the compact size its marks would occupy seated (~markCount
      // lanes), centered on the per-axis MEDIAN of the marks (robust to a stray
      // far stop). A boxed station's marks can fling far apart — two stops beyond
      // the chain extent become a slab spanning the gap — ballooning the rect over
      // its neighbours. Mega draws NO dots, so clamping the bound only shrinks the
      // cover, never hides a marker.
      const cap = Math.max(2 * r, marks.length * spacing * 1.5);
      const medOf = (vals: number[]) => { const s = vals.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
      const mx = medOf(marks.map((m) => m.pos[0]));
      const my = medOf(marks.map((m) => m.pos[1]));
      x0 = Math.max(x0, mx - cap / 2); x1 = Math.min(x1, mx + cap / 2);
      y0 = Math.max(y0, my - cap / 2); y1 = Math.min(y1, my + cap / 2);
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      const minSide = 2 * r + 3;
      if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
      if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
      if (typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.OCTI_PLACE_DEBUG === '1') {
        let cx = 0, cy = 0; for (const m of marks) { cx += m.pos[0]; cy += m.pos[1]; }
        cx /= marks.length; cy /= marks.length;
        const ds = marks.map((m) => Math.sqrt((m.pos[0] - cx) ** 2 + (m.pos[1] - cy) ** 2)).sort((a, b) => a - b);
        console.error(`[megabox] ${nodeId} marks=${marks.length} box=${(x1 - x0).toFixed(0)}x${(y1 - y0).toFixed(0)} centroidDist med=${ds[ds.length >> 1].toFixed(0)} p90=${ds[Math.floor(ds.length * 0.9)].toFixed(0)} max=${ds[ds.length - 1].toFixed(0)}`);
      }
      // No internal bullet circles: a boxed station is a genuine crossing where
      // the stops converge at the crossing point, so the per-line dots overlap
      // into an unreadable cluster (user: "leave them as boxes but remove the
      // station circles"). The box alone marks the interchange; the crossing
      // lines read through it.
      out.push(wrap((x0 + x1) / 2, (y0 + y1) / 2,
        '<rect x="' + x0.toFixed(1) + '" y="' + y0.toFixed(1) +
        '" width="' + (x1 - x0).toFixed(1) + '" height="' + (y1 - y0).toFixed(1) +
        '" rx="' + (r + 1.5).toFixed(1) + '" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="3"' + attrs + '/>',
      ));
      // Mega draws NO dots — emit only the rect prim; dotPrims are discarded.
      prims?.push({
        kind: 'rect',
        x: +x0.toFixed(1), y: +y0.toFixed(1),
        w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1), rx: +(r + 1.5).toFixed(1),
        fill, stroke, strokeWidth: 3,
        layer: 'stops', worldScale: true,
      });
      continue;
    }

    if (best < 1e-3) {
      // marks coincide: capsule degenerates to a ring around the (stacked) dot
      out.push(wrap(a[0], a[1],
        '<circle cx="' + a[0].toFixed(1) + '" cy="' + a[1].toFixed(1) + '" r="' + (r + 3).toFixed(1) +
        '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' + attrs + '/>' +
        dots,
      ));
      // markup order: ring border circle, THEN the stacked dots.
      prims?.push({
        kind: 'circle',
        cx: +a[0].toFixed(1), cy: +a[1].toFixed(1), r: +(r + 3).toFixed(1),
        fill, stroke, strokeWidth: 1.5,
        layer: 'stops', worldScale: true,
      });
      flushDots();
      continue;
    }

    // Spine capsule (dots-on-lanes model, spec 2026-06-12): the marker is
    // the chain of dots in solved order; the capsule is the RDP-simplified
    // polyline through the dot centers, stroked round — border then fill.
    // Dots are on the spine by construction (P3), so containment is
    // structural and lateral widening no longer exists.
    const ordered = [...marks].sort((m1, m2) => (m1.chain ?? 0) - (m2.chain ?? 0));
    // rigid-row model: pair boundaries contribute a derived elbow vertex
    // between the facing end-dots; RDP keeps corners (genuine bends)
    const vertices: Pixel[] = [];
    for (const mk of ordered) {
      vertices.push(mk.pos);
      if (mk.cornerAfter) vertices.push(mk.cornerAfter);
    }
    const spine = rdpSimplify(vertices, 0.75);
    const dAttr = 'M ' + spine.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ');
    const pathSvg = (color: string, w: number, withAttrs: boolean): string => {
      // Capsule border/fill path prim alongside the string (border then fill,
      // matching call order); d is the EXACT same string the markup writes.
      prims?.push({
        kind: 'path',
        d: dAttr, fill: 'none', stroke: color, strokeWidth: +w.toFixed(1),
        lineCap: 'round', lineJoin: 'round',
        layer: 'stops', worldScale: true,
      });
      return '<path d="' + dAttr + '" fill="none" stroke="' + color +
        '" stroke-width="' + w.toFixed(1) +
        '" stroke-linecap="round" stroke-linejoin="round"' +
        (withAttrs ? attrs : '') + '/>';
    };
    // scale the capsule padding too, so the platform hugs the shrunk dots with
    // the same proportional gap/outline as a full-size capsule (not a loose one)
    const inner = pathSvg(stroke, 2 * rCap + 6 * MARKER_SCALE, false) + pathSvg(fill, 2 * rCap + 3 * MARKER_SCALE, true);
    const cx = spine.reduce((acc, p) => acc + p[0], 0) / spine.length;
    const cy = spine.reduce((acc, p) => acc + p[1], 0) / spine.length;
    out.push(wrap(cx, cy, inner + dots));
    flushDots(); // markup order: border path, fill path, THEN dots
  }
  return out;
}
