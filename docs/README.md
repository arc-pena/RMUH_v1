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
| `src/app.js` | tree, viewport, definition panel, regeneration log |
| `build.py` | assembles the single file |
| `test/kernel.test.mjs` | drives the page kernel headlessly under node |

```sh
node docs/test/kernel.test.mjs
```

builds the model, edits it, checks that only the downstream functions re-run,
and walks through every way a fillet can fail.
