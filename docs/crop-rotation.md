# Crop rotation

The crop box gains an orientation, so a city whose network runs diagonally can be
framed along its own grain instead of being fitted into an upright square.

## Why

The canvas is fitted to the **network** extent (`computeBounds` runs over the
route lines, not the geography). A network's bounding box is rarely square, so
fitting it into a square canvas letterboxes it: the shorter axis is left with
empty margin, and the content is smaller than the canvas could carry.

How square that box is depends on the angle the map is drawn at, which is what an
orientation control gives the user. Measured over the pinned corpus, as the
fraction of a square canvas the network's own bbox fills:

| map | fills | best angle |
| --- | --- | --- |
| SEA | 41% | −36° → 100% |
| HOR | 55% | −21° → 100% |
| LON | 64% | −40° → 99% |
| NYC (at its 23° bearing) | 76% | −30° → 99% |
| SF | 80% | +15° → 100% |
| TPE | 92% | +4° → 99% |

Two things worth noting. The city bearing is already doing real work — NYC starts
better framed than most north-up cities. And the largest gains are on cities with
**no** bearing at all, so this is not a rotated-city feature.

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
(`rotateCoord` / `unrotateCoord` / `reframeCoord`).

The sign is the part worth stating explicitly, since getting it backwards would
crop the wrong region rather than fail: a box drawn turned by θ (canvas sense,
y down) over a map at angle A is upright in the frame at **A + θ**. Committing a
tilt therefore commits a new angle, and the four drawn corners carried into that
frame come out level and plumb, so their bounding box reproduces the selection
exactly. `cropTilt.test.ts` pins this by checking that the drawn box and the
committed bbox select the same ground.

## Interaction

The crop editor draws over the cached full map, and that backdrop is **always at
true north**, whatever the crop is angled to. That is what makes the editor free:
the upright layout has one fingerprint regardless of the crop's angle, so turning
the box can never invalidate it and can never trigger a re-run. A city with a
bearing therefore keeps two layouts, its own oriented one (the map it shows) and
this upright one (the map it is edited on). The upright one is built lazily, on
first entry to the editor, so a user who never crops never pays for it.

A box stored at angle A reads as a rectangle turned by A on that backdrop, so
opening the editor on a turned map shows the frame sitting over the north-up
city, and dragging the tilt to 0 rights it.

- **Tilt handle.** A double-arrow control set diagonally outside the box's
  top-right corner, clear of the four resize handles. Dragging it turns the box
  about its centre; the centre and size are untouched, so tilting only re-orients.
  Because the backdrop is upright, the box's tilt *is* the orientation it commits.
- **Snapping.** Two octilinear families, each within a few degrees: the plain 45°
  multiples off true north, and the 45° multiples measured off the city's own
  bearing. A city's grain is as good a reference as north, so the map can be
  turned square to it, or a quarter or half turn off it, and land exactly.
- **Resizing a turned box** runs in the box's own frame, so it grows along its own
  edges, and the result is slid back so the grabbed corner holds still on screen.
- **Clamping.** An upright box is clamped to the map frame. A turned one clamps
  its centre only: the corners of a turned rectangle legitimately reach past the
  frame's AABB, and the dim mask already shows what falls outside.
- **An untouched edit is a no-op.** Applying without having moved anything keeps
  the stored crop verbatim rather than re-deriving it. Carrying the box onto the
  upright backdrop and back runs it through an iterative unproject, which lands
  within a metre but not within the equality tolerance, so re-deriving would mark
  the crop changed and re-run the layout every time the editor was merely opened.
- **Clearing the crop** also returns the angle to north, so "no crop" is exactly
  the upright full map, which is the one already cached.

## Default framing for a city with a bearing

Such a city opens already turned to its grain *and* framed to it: the crop seeds
to the network's own extent in that orientation, with the crop aspect set to
match, so the first Generate produces the intended map rather than a square one
the user has to crop by hand.

The frame is the network's full extent plus a small margin, so nothing meaningful
is cut. What it buys is the letterboxing: the canvas is fitted to the network, and
NYC's network is 0.760 wide-to-tall at its bearing, so a square canvas leaves a
quarter of itself empty. Shaping the canvas to 10:13 instead takes the fill from
**76% to 99%**, which is the real form of the "diagonal city in a square area"
problem.

An earlier pass instead seeded the largest square inscribed in the rotated harvest
region, on the theory that rotation left data-void corners on the canvas. That was
removed: `computeBounds` fits the canvas to the route lines, not the geography, so
the harvest region is clipped by the viewport and those corners never render. The
seeded crop was larger than the network's own frame and would have zoomed out.
