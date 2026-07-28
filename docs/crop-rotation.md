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
- **Resizing a turned box** runs in the box's own frame, so it grows along its own
  edges, and the result is slid back so the grabbed corner holds still on screen.
- **Clamping.** An upright box is clamped to the map frame. A turned one clamps
  its centre only: the corners of a turned rectangle legitimately reach past the
  frame's AABB, and the dim mask already shows what falls outside.

## Not done: a default frame for rotated cities

An earlier pass seeded rotated cities with the largest square inscribed in the
rotated harvest region, on the theory that rotation left data-void triangles in
the corners. It was removed: the canvas is fitted to the network, not to the
harvest region, so those corners are never on screen and the seeded crop would
have zoomed *out* rather than in.

The measurement above suggests the honest version of that idea is about the crop
**aspect** rather than rotation: a canvas shaped to the network's bbox would
recover the letterboxed margin without turning anything. That is a separate
feature and is not implemented here.
