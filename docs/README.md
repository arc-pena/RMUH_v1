# The interface

A CAD front-end for the OCAF parametric model: a specification tree, a 3D view,
and a definition panel where a feature's OCAF arguments sit on sliders.

Published as an Artifact, and served by the native kernel at `/` when you run
`ocafcad serve --ui docs/parametric-cad.html`.

## It owns no geometry

A kernel holds the document — the label tree, the parameters, the B-Rep — and
this page mirrors that tree and draws the triangles it is handed. Editing a
parameter re-executes only the functions downstream of the edit; each rebuilt
feature's revision moves, and the page re-fetches the triangle stream for those
shapes and no others.

Two kernels answer exactly the same calls, and nothing above `kernel` in the
code learns which one it got:

| | |
|---|---|
| **the page kernel** | OpenCascade compiled to WebAssembly, running in the browser. Real B-Rep — a filleted box has twelve cylindrical faces and eight spherical corners — with the OCAF document model (labels, attributes, drivers, logbook, solver) in JavaScript. Needs nothing installed. |
| **a native kernel** | `ocafcad serve` or `python -m ocafpy serve` over HTTP. A real `TDocStd_Document`: OCAF attributes, `TFunction` drivers, `TNaming` results, `.cbf` persistence, STEP and OBJ export. |

The two catalogues have drifted: the written features and everything under
**Numbers are features too** below are page-kernel features, and `ocaf/`'s
`Schema.cxx` still carries only the original ten. A model using the rest is
browser-only until that catches up.

The Kernel chip in the toolbar switches between them and carries the part
across.

## A feature you write

`Script` is a feature whose body is code. The source lives on the feature as a
`TDataStd_AsciiString`; the script declares its own parameters, and each one
gets a label of its own carrying a `TDataStd_Real`, exactly as a catalogue
argument would. So a script's parameters are edited, regenerated, undone and
saved like any other feature's — the panel draws a slider per declaration and
the solver re-runs the feature when one moves.

```js
({
  params: [{ key: "size", label: "Size", def: 60, min: 10, max: 200, step: 1 }],
  build(p, k) { return k.fillet(k.box(p.size, p.size, p.size), p.size / 8); }
})
```

`k` is a small surface over the kernel.

| | |
|---|---|
| solids | `box`, `cylinder` (a pie slice when given an angle), `sphere`, `sector` |
| curves | `helix`, `ellipse`, `circle`, `rectangle`, `polyline`, `face` |
| sweeping | `sweep`, `loft`, `prism` |
| placing | `move`, `rotate` |
| combining | `cut`, `fuse`, `common`, `fillet`, `compound` |
| chained | `beam`, `tube` |

`move` and `rotate` go through `TopoDS_Shape::Moved`, so repeating a shape costs
a location rather than a rebuild.

`helix` builds its spine the way OpenCascade does: a straight line in the *(u,v)*
parameter space of a `Geom_CylindricalSurface`, which maps to a helix in space,
then `BRepLib::BuildCurve3d` to give the edge a 3D curve. `sweep` runs
`BRepOffsetAPI_MakePipeShell` with a **constant binormal** rather than a Frenet
frame — a handrail does not roll over as it turns — and `loft` is
`BRepOffsetAPI_ThruSections`, the operation behind the neck thread of the
OpenCascade bottle.

Anything with a constant section is swept, not chained: the stair's handrail is
one elliptical solid and its stringer one rectangular solid, each swept along
its own helix. That is 13,836 triangles for the whole stair against 54,104 when
the same two runs were built from segments.

Two buttons give you the same feature from two different starting points, so you
can reach for either without one replacing the other:

| | |
|---|---|
| **Script** | a spiral stair — centre pole, treads, risers, stringer and handrail |
| **Ribbon** | a lofted shell taken in bands, after Heydar Aliyev |
| **Center** | the Heydar Aliyev Center: roof and glazed facade |

A declared parameter that names its alternatives becomes a switch rather than a
slider, and the panel draws it as a segmented control:

```js
{ key: "direction", label: "Ribbon direction", options: ["U", "V"], def: 0 }
```

The value stored is still a number — the index — so storage, regeneration, the
model file and undo are untouched; only the panel knows the difference.

`Center` is the most literal. Its roof is one loft through section curves laid
the way the building draws them: up into a rolled lip that sits *lower than the
mid-point*, down the long slope into a valley that touches the ground, then a
rise through a 45-degree tangent to the peak and a steep drop behind it. Those
three marked points are parameters; the rest of the control polygon follows from
them. How the section changes across the width — settling, rippling into lobes,
the ends drawing back — is what makes a roofscape rather than an extrusion. The
steep face behind the peak is not shell but a grid of mullions, each member
following the surface so the grid leans and stretches with it.

It is an interpretation, not a reconstruction: the section rules come from a
sketch and the massing from photographs, with no plan drawing to work from.

`Ribbon` is the more instructive of the other two. The driver surface is never built:
it is defined as a loft through CV curves — a section control polygon carried
along the length by Catmull-Rom through height, width and drift — and because a
band is only a strip of that definition, the strips are read straight off it
rather than slicing a surface that would be thrown away. Each band is a run of
closed sections, the strip's width across the surface given thickness along the
surface normal, lofted along the run: every band a solid, and the whole thing
exportable as STEP. A ribbon is constant in one surface parameter and runs the
length of the other, so which is which is the only thing the **U / V** switch
changes — along the building, or wrapped over it.

A new Script feature starts as a **spiral stair** — centre pole, treads,
risers, stringer and handrail as separate solids, thirteen parameters on
sliders. The treads and risers are modelled once and instanced up the helix.
Edit the code and the feature becomes something else; the parameters follow
what the new code declares, keeping the values of any that survive.

Compiling is part of the precondition, so a script that will not compile never
reaches the kernel, and a syntax error reads as one rather than as a modelling
failure. `Script` is a page-kernel feature: the native kernels hold a real OCAF
document but cannot run JavaScript, so a model containing one is browser-only.

## One way in, two ways to look

Everything the interface can do to the document is one JSON edit, and there is
no second path. A toolbar button is a literal, `{"op":"add","type":"Cube"}`. A
slider is a literal, `{"op":"set","id":"CB1","key":"dx","value":92}`. A wire
dragged in the node graph is `{"op":"connect","id":"FI1","key":"body",
"from":"CB1"}`. A line drawn in the sketcher is `{"op":"draw","id":"SK1",
"type":"line","at":[[0,0],[120,0]]}`. `src/mdl.js` holds the sixteen of them
and the channel they all go through; nothing else may touch the kernel.

| | |
|---|---|
| `add` `delete` `rename` | features |
| `vertex` | one vertex of a mesh, moved by an offset — what a handle writes |
| `set` | one number — a catalogue argument, or a parameter a script declared |
| `connect` `disconnect` | one reference: one wire |
| `code` | the source of a written feature |
| `sketch` | a whole drawing at once |
| `draw` `erase` `relate` | one element of a drawing, or one relation over it — what a click in the sketcher writes |
| `appearance` | a finish; redraws, does not rebuild |
| `model` | the whole document at once — every one above is a small edit of the text this one writes wholesale |
| `move` `select` | view state, through the same channel, recorded and marked as not rebuilding anything |

`add` without `refs` wires its inputs the way pressing the button does — the
selected body for an operation, the first datum of the right type for the rest
— so `{"op":"add","type":"Fillet"}` typed into a console does what the toolbar
does.

## Numbers are features too

Half the catalogue builds no geometry. It computes, and what it computes is
wired into the sliders of the features that do build — which is the other half
of what makes this a graph rather than a tree.

**Every numeric input takes a wire.** `F.real` resolves it, so a slider driven
from somewhere else reports what is arriving and the literal underneath is kept
but not read; pull the wire off and the old value comes back. No driver in the
kernel knows this is happening.

| | |
|---|---|
| **numbers** | `Number` one on a slider of its own · `Series` start, step, count · `Range` evenly between two bounds · `Math` two inputs and an operation · `Expression` a formula over `a`, `b`, `c`, with `i` and `n` bound to the position in a list · `Panel` shows what is wired into it |
| **curves** | `Circle` on a plane · `Polyline` through a list of points · `Interpolate` a smooth curve through them |
| **analysis** | `EvaluateCurve` the point at a parameter, tangent drawn · `DivideCurve` equal lengths, as points · `EvaluateSurface` the point at (u, v), normal drawn · `Measure` length, area, volume or bounding size, back out as a number |
| **operations** | `Extrude` a profile along a direction · `Loft` a skin through sections, in the order they are wired · `Boolean` union, difference, intersection · `Project` a curve pulled onto a surface |

Inputs say what a source may **produce** — `number`, `point`, `vector`,
`curve`, `plane`, `solid`, `text` — not which feature types they accept, so a
component added later is taken by every input its output makes sense for
without any of them being told about it.

### Lists

A `Series` wired into a coordinate of a `Point` makes a row of points; an
`Interpolate` through those points is one curve; a `DivideCurve` of that curve
is a list of points again. Where two lists meet, the shorter repeats its last
item until the longer is exhausted, which is Grasshopper's longest-list rule.

Lists travel through the data components and the components that take points.
Everything else — `Cube`, `Sphere`, `Fillet` — reads the first item and says so
on the slider. Making a hundred cubes from a hundred numbers wants a data tree,
and this is not one.

### Two honest approximations

`Interpolate` is a Catmull–Rom spline sampled into a fine run of segments.
OpenCascade's B-spline fitter needs a `TColgp_Array1OfPnt`, which this
WebAssembly build does not export; the curve is drawn, lofted and divided as
what it is.

`Project` samples the curve, pulls each sample to the nearest point on the
target's surfaces, and re-fits. An exact projected curve wants
`BRepProj_Projection`, which this kernel does not carry either. The nearest
point is exact at every sample, and the sample count is a parameter.

## Samples

The **Samples** button loads a worked example whole. It takes two clicks — the
list, then the entry — because it replaces what is open, and the list says so.

### Hillside town

A landform with six villas terraced across it: pool decks, balustrades, glazed
faces with mullions, hipped roofs. **47 nodes and not one script**, ~150 ms to
build, and the whole document is 5.9 kB.

The chain reads left to right in the graph:

| | |
|---|---|
| **the hill** | `MeshGrid` → `MeshDisplace`, one formula in one node, → `Subdivide`. Its width, depth and height are `Number` features wired into those sliders, so the hill is a fixed surface whose size and height you drive from three places. |
| **the plan** | a `Numbers` list — `-1450, 0, 1450` — into the `x` of a `Point`, with `y` a plain slider. Two of those are the two terrace rows. Flat, two-dimensional, and it never mentions z. |
| **the projection** | `Drape` drops each plan point straight down onto the hill and hands back where it landed. That is the whole of "project the plan onto the mountain", in one wire. |
| **the villa** | after Zaha Hadid Architects' **Rock**, below. Twenty-nine nodes, built once. |
| **the town** | `PlaceAt` puts that one villa at every draped site, turned by an angle from a second `Numbers` list. Retype `0, 16, -12` and three nodes rebuild, not forty-seven. |

Individual control is the two typed lists: bay positions in plan, and a turn
per villa. Everything else is a slider.

### The villa, after ZHA's "Rock"

Reverse-engineered from the published drawings of the Dubrovnik golf and spa
resort prototype — which the practice describes as inspired by Croatian karst,
"a rock, partly sunken into the ground". Four moves, and every one of them is
the same lens resized:

| | |
|---|---|
| **a plan** | a lens pointed at both ends — six numbers in `Lens x`, six in `Lens y`. Nothing else in the villa holds a plan. |
| **a batter** | `Math` multiplies that lens by `Batter` and a `Point` drops it below grade, so the walls lean in as they go down and the mass sits into the slope. One `Loft` between the two is the whole body. |
| **a lid** | `Math` multiplies the lens by `Roof oversail`, twice, a plate thickness apart. A second `Loft` is a thin roof that oversails the wall on a crisp edge. |
| **a sinkhole** | a four-sided wedge `Loft`ed from the terrace up through the sky, cut out of both, leaving the terrace and the lap pool in the hole. |

Retype the twelve numbers of the lens and the body, the lid and the batter all
follow, because they are all that lens.

**One thing that bit, worth knowing.** The mass and the lid were first gathered
by `Join` and cut once. That silently did nothing: a boolean argument that is a
compound of two solids which touch is self-intersecting, and OpenCascade
answers by handing back what it was given — no error, no cut, and the volume
identical to the input. Each solid is now cut on its own. If a `Boolean` ever
appears to do nothing, measure it.

## Four primitives, so a graph can compose

Before these, a definition of any size fell back to a written feature — and a
written feature takes no inputs, so it stops being part of the graph at all.
These four are what a node editor needs to stand on its own:

| | |
|---|---|
| `Numbers` | a list you type. Where `Series` gives an even run, this gives the ones you meant. |
| `Join` | several shapes as one, compounded rather than fused — the group of a node editor. |
| `Drape` | points dropped straight down onto a surface, a solid or a mesh. The highest hit wins, so a point over an overhang lands on top of it. |
| `PlaceAt` | one shape at every point in a list, turned by an angle from another. The shape is built once and each copy is the same `TopoDS_Shape` under a different `TopLoc_Location` — the instancing `Array` uses, so the hundredth copy costs a matrix rather than a rebuild. |

`Numbers` introduced a `text` argument kind: one line, a `TDataStd_AsciiString`
like code, with a field rather than an editor. It shows on the node itself,
because a list of numbers is short enough to read and change without opening
anything.

## The sketch

Every CAD modeller has one, and it is the same idea in all of them: a drawing
in two dimensions, and a plane to put it on. Nothing in the drawing knows where
that plane is. `{"id":"e1","type":"line","a":[0,0],"b":[100,0]}` is a hundred
millimetres along the sketch's own **u**, and that is all it is. Point the
sketch at a different plane, or wire a different point into its origin, and
every line, arc and spline in it goes with it — while the JSON does not change
by one character. That is not a convenience; it is what a sketch *is*, and the
test that matters says exactly that:

```
ok   the drawing does not change when the plane does
ok   but the geometry does
```

`src/sketch.js` is the drawing's semantics and nothing else — no OpenCascade,
no DOM. The kernel reads it to build edges; the viewport reads the same
functions to draw what you are drawing and to decide what your cursor is
snapping to. One definition, two readers.

| | |
|---|---|
| elements | `point` `line` `arc` `circle` `ellipse` `oblong` `spline` |
| relations | `coincident` `horizontal` `vertical` `parallel` `perpendicular` `tangent` |
| arguments | a plane, an origin, the drawing, and whether closed loops become faces |

### Drawing is an edit like any other

Double-click a sketch — in the tree, in the viewport, or on its node — and the
viewport becomes a drawing board: the camera goes square on to the plane and
stops orbiting, and the tool rail steps aside for the seven things a drawing is
made of. A click is then no longer a click on a solid. It is a point on the
plane, in the plane's own two numbers, and when enough of them have been
collected the element they make is written as one line of the model description
language:

```json
{ "op": "draw", "id": "SK1", "type": "line", "at": [[0, 0], [120, 0]] }
```

which goes down the same road a slider and a wire go down. Drawing a line in
the viewport and typing that line into the model file are the same edit,
because there is only one of them. `draw`, `erase`, `relate` and `sketch` are
the four ops; the first three read the drawing, change one thing and write it
back, because the drawing is one string on one label.

A click that lands on the end of something already drawn snaps to it and writes
a `coincident` relation as well, so the corner stays a corner when either side
of it moves.

### Adding the sketcher moved two other things

`Extrude` gained the loops rule below, and the page gained a `<meta
charset="utf-8">`. The Artifact wrapper supplies one, so the middle dots and
en-dashes read correctly there; the same file opened from disk or served by
`ocafcad serve --ui` had none and showed them as mojibake.

### The constraints are a relaxation, not a solver

Every relation knows how to move the handles it governs the shortest way to
satisfy itself, and they are run in turn until nothing moves. That converges on
the sketches people draw, it fights itself when a sketch is over-constrained,
and — the part that matters — it reports how far off it finished rather than
pretending. It is not a degree-of-freedom solver and does not claim to be. The
drawing on the label is what you drew; what the relations make of it is
computed at build time and never written back, so nothing drifts by being
rebuilt twice.

### A loop inside a loop is a hole

A loop drawn inside another is a hole in it, and a loop drawn inside that hole
is solid again. Nothing declares this: the loops' own 2D outlines are counted —
a loop with an odd number of loops around it is a hole in the innermost of them
— and the hole wire is added to the face **reversed**, because OpenCascade
otherwise reads it as a second outline and hands back a face that is bigger
rather than smaller. A 200 mm square with two 18 mm circles in it padded 40 mm
measures 1 518 570 mm³, which is the square less the two circles, times the
thickness, to four significant figures.

### A closed loop is a face

The chain walker takes the elements that have ends and walks them end to end
until a walk comes back where it started; circles, ellipses and slots are
already a loop on their own. Every loop that closes becomes a planar face —
`BRepBuilderAPI_MakeFace(wire, true)` — and everything left over stays a wire.
So a sketch is pad-ready the moment it closes, without anyone asking for a
surface.

Two millimetre-scale details make that work rather than nearly work. A drawing
made by clicking is full of hundredth-of-a-millimetre gaps and **a wire will
not close over one**: `BRepBuilderAPI_MakeWire` simply returns `IsDone() ==
false`. So the ends of a chain are welded first — the meeting point is the
middle of the two ends and both sides are given that exact point — and every
edge is then built *through the points the walk hands over* rather than from
each element's own arithmetic. An arc is built with `GC_MakeArcOfCircle`
through three of its own points, which means its ends are exactly the welded
ones whatever that did to its radius, and it is still a real arc rather than a
run of segments.

### Solid or surface is a real choice

`Extrude` used to take the first face it found. It now sweeps **every** face
the profile offers, so a sketch of six closed loops pads into six bodies rather
than one; on `Surface` it sweeps the wires instead, taking them back off the
faces when the profile arrived as faces. A sketch of a square 100 mm on a side,
padded 40 mm, measures 400 000 mm³ and 36 000 mm² as a solid and 16 000 mm² as
a surface — the two ends, present or absent. That is the whole difference
between a body and a skin, and it is worth measuring rather than assuming.

## Polymesh

A different kind of geometry from everything above. A B-Rep has a surface under
every face and OpenCascade owns it; a polymesh is a list of points and a list of
faces of any number of sides, and nothing owns it but `wasm-kernel.js`. That is
what makes it something you can shove a vertex around in, and what makes
Catmull–Clark possible at all.

A mesh is a **data** result, not a shape: a flat `TDataStd_RealArray` of
vertices beside a `TDataStd_IntegerArray` packed `[sides, i, j, …]`. So it
travels in the model file, it has no B-Rep behind it, and it is drawn from its
own polygons — n-gons fanned into triangles for display only, with every
polygon edge sent as a line so the cage reads as the cage.

| | |
|---|---|
| `MeshBox` `MeshGrid` | cages to start from, divided as finely as you like |
| `MeshFromShape` | tessellates a solid and welds it, so anything the B-Rep side builds crosses over |
| `EditMesh` | the mesh with vertices moved by hand |
| `Subdivide` | Catmull–Clark, 1–4 levels, on or off, boundary sharp or smooth |
| `Weld` | merges vertices closer than a distance and drops what collapses |
| `FillHoles` | chains the open edges into loops and closes each one |
| `MeshMerge` | amalgamates two cages: removes the faces where they meet and bridges the openings |
| `MeshTransform` `MeshDisplace` | move, turn, scale; or push every vertex along a direction by a formula over its own position |

### Editing by hand is still parametric

Select an `EditMesh`, click a cage vertex, drag an axis. What that writes is
not a position — it is an **offset** from wherever the mesh upstream put that
vertex:

```json
{ "op": "vertex", "id": "ED1", "index": 12, "x": 4, "y": 0, "z": -2 }
```

and it lands in the model file under `moves`. So the edit survives a change
upstream, reads as text, can be typed into the panel or the graph console
instead of dragged, and is undone by setting it back to zero. The handles show
the cage even when the cage is consumed and only the subdivided result is
visible — which is the whole point of a cage.

While a mesh is being edited by hand the viewport belongs to its handles: a
click that misses one drops the vertex rather than walking off to whatever
solid was behind it. Esc leaves.

### Merging two cages is not a boolean

`MeshMerge` is the operation a subdivision workflow actually wants when two
cages meet, and it is deliberately not CSG. A boolean would cut the two against
each other exactly and hand back a seam of triangles — right for a solid,
useless as a cage, because Catmull–Clark wants quads and a triangle fan round
the join pinches under it. So `MeshMerge` does what a modeller does by hand:

1. finds the faces that are in the way — either **inside the other** mesh (a
   ray cast from each face's middle, odd crossings means inside) or **facing it
   within a distance** (nearest point on the other surface, and the face's
   normal pointing at it);
2. removes them, leaving an opening in each cage;
3. walks the open edges into loops, pairs each opening on A with the nearest
   one left on B, rotates one until the two line up, and **bridges** them.

Equal loops give quads all the way round. Unequal ones walk both loops in step
and drop in a triangle wherever one side has to catch up — eight against four
is four quads and four triangles, and one level of subdivision turns them all
into quads anyway. `Twist` steps the pairing round by hand and `Bridge
direction` reverses it, because a bridge between two loops is never quite
automatic.

The bridge is wound *against* the loops it joins, not with them: a boundary
loop follows the free directed edges of the faces around it, so a bridge that
runs the same way leaves each edge free a second time and the rim silently
stays open. The test for that is the one that matters — filling the holes of
the merged mesh must add nothing at all.

It is refused before it starts if the two cages together are more than about
6,000 faces: every face is compared against the whole of the other mesh, which
is nothing for two cages and a different algorithm entirely for two
tessellations. Merge the cages, then subdivide.

**If you want a true boolean**, do it on the B-Rep side and come back:
`Boolean` → `MeshFromShape` → `Weld`. That gives the exact solid and a
tessellation of it — a good mesh to look at, and a poor one to subdivide.

### Catmull–Clark

Written out rather than linked in — OpenSubdiv is not in this WebAssembly build
and would not fit beside it. The standard rules, for faces of any number of
sides: a face point is the average of its vertices; an edge point the average
of its two ends and the two face points beside it, or the midpoint on an open
edge; a vertex moves to `(F + 2R + (n−3)V) / n`, or `(E₁ + 6V + E₂) / 8` on the
boundary. Every face becomes one quad per corner, so a cube at level 1 is 24
quads and 26 vertices, and level 2 is 96.

`Subdivide` is refused before it starts if the level asked for would come out
past about 150k faces — the same rule the fillet radius follows: judge it
against the geometry rather than find out afterwards. `Weld` is refused the
same way if the distance is more than a quarter of the mesh.

## The node graph

**Nodes** opens the same document as a graph. The specification tree reads it
top to bottom, in the order the solver executes; the canvas reads it left to
right, along the references that put it in that order. One acyclic graph, two
drawings of it. A slider on a node and the same slider in the definition panel
are the same edit arriving by two routes, and each redraws the other.

It opens in a window of its own where the browser allows one, so it can sit on a
second screen. Inside a sandboxed frame — an Artifact — `window.open` gives back
nothing to write into, and it becomes a floating panel instead: dragged by its
bar, resized from the corner, rolled up to the bar alone, and able to try for a
real window again.

* drag an output port onto an input to wire it; drag a wired input into empty
  space to clear it
* drag a node by its header — where it lands is a `move` edit, and the layout
  travels in the model file under `"layout"`, so a part opens laid out the way
  it was left
* **Tidy** re-columns by rank and reports every move as an edit
* double-click a node to open it in the definition panel, which is where a
  written feature's code is edited
* the console below is not a transcript, it is the way in: it shows every edit
  as it happens and takes one — or an array of them — typed straight in. The
  **Model file** tab shows the document as text, updating as you drag.

That console is the surface an external driver would speak to. It already takes
the whole language; what is missing is only the transport.

## Getting the scene out

The **STEP** button writes every visible solid with `STEPControl_Writer` — each
feature transferred as its own root, so the parts arrive separate rather than as
one lump — and offers the file to the viewer through the `downloads` capability.

The viewer's save allowlist has no `.step` in it, so the page asks for `.step`
first and, if that comes back `rejected_extension`, sends the same text as
`.step.txt` to be renamed. Where there is no save surface at all — served by a
local kernel, or opened as a file — it hands over the text to copy instead. A
connected native kernel writes a real `.step` straight to disk, either from
`/api/save` or from the `ocafcad build --step` command line.

## Handling OpenCascade's failures

`IsDone()` is not a reliable gate. On an 80 mm cube OpenCascade accepts a 39.9 mm
fillet, rejects 40, then accepts 40.6 and 60 again. So every driver is guarded
three times: a **precondition** checked against the geometry before the kernel is
called at all (a radius must clear half the body's smallest extent), a
**try/catch** around the call, and a **check of the result** — `IsDone()`, a
non-null shape, and faces on it.

A `Standard_Failure` raised inside WebAssembly arrives as a
`WebAssembly.Exception`; it is unwrapped so the panel shows what OpenCascade
actually said. A feature that fails keeps its last good shape and records the
message, so one bad radius never takes the model down.

## Building

```sh
python3 docs/build.py          # fetches the kernel from npm on first run
```

Everything ends up in one file: an Artifact may load scripts from a few CDNs but
may not fetch anything at runtime, and the WebAssembly module is a runtime fetch.
So the kernel travels inside the page — 22 MB of wasm gzipped to ~9 MB of text,
which the browser inflates and stream-compiles on load.

The generated `docs/parametric-cad.html` is not committed; it is 9 MB and
reproducible from `docs/src/`.

| | |
|---|---|
| `src/index.html` | markup and stylesheet |
| `src/ocaf.js` | the OCAF document: labels, attributes, drivers, logbook, solver, catalogue |
| `src/wasm-kernel.js` | OpenCascade in the page — geometry drivers, preconditions, meshing |
| `src/http-kernel.js` | the same interface over HTTP |
| `src/mdl.js` | the model description language: every edit, and the one channel they go through |
| `src/graph.js` | the node editor — its own window, or a floating one |
| `test/components.test.mjs` | the data half of the catalogue against a real kernel |
| `test/mesh.test.mjs` | polymesh, subdivision, welding, filling, and the hand edits |
| `test/samples.test.mjs` | the four composition primitives, and the worked example end to end |
| `src/showroom.js` | the PlayCanvas stage: finishes, environments, procedural lighting |
| `src/app.js` | tree, viewport, definition panel, regeneration log |
| `build.py` | assembles the single file |
| `test/kernel.test.mjs` | drives the page kernel headlessly under node |
| `test/mdl.test.mjs` | every edit against a real kernel, the refusals, the round trip through the file |

```sh
node docs/test/kernel.test.mjs
node docs/test/mdl.test.mjs
node docs/test/components.test.mjs
node docs/test/mesh.test.mjs
node docs/test/samples.test.mjs
```

The first builds the model, edits it, checks that only the downstream functions
re-run, and walks through every way a fillet can fail. The second runs every
edit in the language against a real kernel, checks that the refusals are refused
and recorded rather than swallowed, and that the file the graph writes rebuilds
the part and its layout. The third builds a definition out of the data
components — a series into a point into a spline into divisions into a panel —
and checks the arithmetic, the measurements, the list rule, and that only the
functions downstream of an edit re-run. The fourth checks Catmull–Clark against
its known answers, that a hand edit is an offset that survives the file, and
that welding and filling do what they say.
