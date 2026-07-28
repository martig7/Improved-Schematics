# Crop rotation

The crop box gains an orientation, so a city whose network runs diagonally can be
framed along its own grain instead of being fitted into an upright square.

## Why

A city with a non-zero map bearing is already rotated at assembly, so its harvest
rect lands in the render frame as a diamond with data-void triangles at the
corners (`rotateInput.ts` stamps that region as `hull` and the renderer paints
only inside it). The square canvas is then fitted to the diamond's extremes, so a
large share of the canvas carries no data and the network itself is squeezed into
the middle band. Cropping to a rectangle inscribed in the diamond spends the whole
canvas on real content.

## Model

One new option: `cropAngle` (degrees). It is the **total** rotation applied to the
input at assembly, replacing the city bearing as the argument to
`rotateSchematicInput`. Absent means "the city's own bearing", so every existing
map renders exactly as before.

This is deliberately *not* a rotated rectangle in the pipeline. The render frame
stays axis-aligned and `cropBbox` stays an axis-aligned rect within it; turning
the crop turns the *frame*, which is the one rotation seam the pipeline already
supports. Nothing downstream of `buildInput` learns a new concept.

Consequences:

- **No schema bump.** The angle reaches the fingerprint the same way the bearing
  does: it changes every station/track coordinate, and those coordinates are the
  fingerprinted content. Existing caches stay valid because the default angle is
  the bearing.
- **`cropBbox` is frame-relative.** A box is only meaningful together with the
  angle it was drawn at, so the two are always committed together.

### Converting between angles

Both frames are rotations of the same underlying geography about the same centre,
so a point moves between them by unrotating one and rotating the other.
`rotateInput.ts` exports the frame (`rotationFrameOf`) and the per-point map
(`rotateCoord` / `unrotateCoord`) that `rotateSchematicInput` already used
internally. A box drawn at angle A and committed at angle B is converted corner by
corner; because the drawn rectangle is turned by exactly B − A, it is axis-aligned
in frame B and its corner AABB reproduces it exactly.

## Default framing for non-north cities

When a city has a bearing and no crop has been chosen, the crop seeds to the
largest 1:1 rectangle inscribed in the rotated hull.

- **1:1, not the 16:9 crop default.** The auto-frame's whole job is to remove the
  void corners; keeping the canvas square means that is the *only* thing it
  changes. The aspect stays editable in the crop editor.
- **The hull, not the network extent.** "Largest possible crop" — the frame is
  bounded by where data exists, not by where track happens to run. Fringe stations
  outside the inscribed rect are trimmed, which is the intended slight crop.
- **Centred is optimal here.** The hull is a rotated rectangle, so it is centrally
  symmetric, and for a centrally symmetric convex region the largest inscribed
  rectangle of a fixed aspect can always be taken about the centre. The solver is
  a fixed-iteration binary search on scale, which keeps it deterministic.

## Interaction

The crop editor draws over the *cached full map*, which is rendered at the applied
angle. Re-rendering under the working angle would mean re-running the layout on
every drag, so instead the box is drawn rotated over an upright map: the tilt is
previewed as the frame the content will be turned into.

- **Tilt handle.** A double-arrow control set diagonally outside the box's
  top-right corner, clear of the four resize handles. Dragging it turns the box
  about its centre; the centre and size are untouched, so tilting only re-orients.
- **Snapping.** The *absolute* angle snaps within a few degrees to 45° multiples
  and to the city's own bearing, so both true north and the city's grain are easy
  to land on exactly.
- **Clamping.** An upright box is clamped to the map frame. A tilted one clamps
  its centre only: the corners of a turned rectangle legitimately reach past the
  frame's AABB, and the dim mask already shows what falls outside.
