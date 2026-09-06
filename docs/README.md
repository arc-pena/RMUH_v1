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
