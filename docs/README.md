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

A new Script feature starts as a **spiral stair** — centre pole, treads,
risers, stringer and handrail as separate solids, thirteen parameters on
sliders. The treads and risers are modelled once and instanced up the helix.
Edit the code and the feature becomes something else; the parameters follow
what the new code declares, keeping the values of any that survive.

Compiling is part of the precondition, so a script that will not compile never
reaches the kernel, and a syntax error reads as one rather than as a modelling
failure. `Script` is a page-kernel feature: the native kernels hold a real OCAF
document but cannot run JavaScript, so a model containing one is browser-only.

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
