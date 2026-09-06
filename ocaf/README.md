# ocafcad — a parametric kernel on OpenCascade OCAF

A minimal but real feature-based modeller: features are OCAF **functions**,
parameters are OCAF **attributes**, and changing a parameter re-executes only
the functions downstream of the edit.

Two halves ship together and speak the same file format:

| | |
|---|---|
| `ocaf/` | this kernel — C++ on OpenCascade 7.6, drivers + runtime + HTTP server |
| `docs/` | the front-end — a CATIA-style tree, 3D view and parameter panel. It also carries OpenCascade compiled to WebAssembly, so it runs with no kernel installed; see `docs/README.md` |

## The model

Everything lives on labels of a `TDocStd_Document`:

```
0:1                       document root      TDataStd_Name = title
0:1:1                     features container
0:1:1:n                   one feature
    TDataStd_Name         "Cube.1"                — display name
    TDataStd_AsciiString  "CB1"                   — stable id used by the JSON file
    TDataStd_Integer      1                       — shown in 3D
    TFunction_Function    <driver GUID>           — this is what makes it a feature
  0:1:1:n:1 … :k          one label per argument, in catalogue order
    TDataStd_Name         "dx"
    TDataStd_Real         80                      — a number a slider drives
    TDF_Reference         0:1:1:3                 — or a link to another feature
  0:1:1:n:100             TNaming_NamedShape      — the computed B-Rep
  0:1:1:n:101             TDataStd_AsciiString    — last build error, if any
```

`TFunction_IFunction::NewFunction` enrols each feature in the document's
`TFunction_Scope`, which is what the solver iterates.

## The functions

One `TFunction_Driver` subclass per feature type, registered in
`TFunction_DriverTable` against the type's GUID.

| Type | Category | Arguments | Result |
|---|---|---|---|
| `Point` | datum | `x` `y` `z` | `TopoDS_Vertex` |
| `Vector` | datum | `dx` `dy` `dz` | `TopoDS_Edge` (drawn from the world origin) |
| `Line` | datum | → point, → vector, `length` | `TopoDS_Edge` |
| `Plane` | datum | → point, → vector, `size` | `TopoDS_Face` |
| `Cube` | body | → point, → plane, `dx` `dy` `dz` | `TopoDS_Solid` |
| `Sphere` | body | → point, `radius` | `TopoDS_Solid` |
| `Fillet` | operation | → body, `radius` | `TopoDS_Solid` |

`FeatureDriver::Arguments()` reports, for a reference argument, the **result
label of the referenced feature** — so editing a cube re-runs its fillet, and
`TFunction_Iterator` gets a correct dependency order for free.

A feature consumed by an operation (the cube under a fillet) stays in the tree
but its `TDataStd_Integer` visibility flag goes to 0 — exactly the behaviour of
a history-based modeller.

## Regeneration

```
TFunction_IFunction::UpdateDependencies(main);   // rebuild the graph
log->SetTouched(editedParameterLabel);           // what the user changed
TFunction_Iterator solver(main);                 // topological order
  driver->MustExecute(log) ? driver->Execute(log) : skip
```

`Execute()` writes the shape through `TNaming_Builder` and marks the result
label impacted, which is what makes the *next* function in the chain rebuild. A
failed build (an over-sized fillet, say) keeps the last valid shape and records
the message, so the rest of the tree still regenerates.

## Building

```sh
sudo apt-get install -y libocct-foundation-dev libocct-modeling-algorithms-dev \
    libocct-modeling-data-dev libocct-ocaf-dev libocct-data-exchange-dev libtbb-dev
cmake -S ocaf -B ocaf/build -DCMAKE_BUILD_TYPE=Release
cmake --build ocaf/build -j
```

## Serving the model

The interface holds no geometry of its own. The kernel keeps the document and
hands over triangles; the browser mirrors the label tree and draws what it is
sent.

```sh
ocafcad serve examples/cube_fillet.ocaf.json --ui ../docs/parametric-cad.html
# ocafcad serving http://127.0.0.1:8787
```

| Route | |
|---|---|
| `GET /api/schema` | the feature catalogue the toolbar and sliders are built from |
| `GET /api/tree` | every feature: arguments, references, visibility, error, revision |
| `GET /api/mesh?ids=A,B` | triangles and edge polylines for named shapes |
| `POST /api/param` | `{id, key, value}` → the regeneration report and the new tree |
| `POST /api/feature` | `{type, refs}` → adds a feature and regenerates |
| `POST /api/delete`, `/api/reference`, `/api/rename`, `/api/model` | |

Every feature carries a **revision**, bumped only when its driver actually
re-executed. That is the whole traffic rule: after an edit the client compares
revisions and asks for the shapes that moved, and nothing else. Editing a
fillet radius on the demo part re-meshes one shape; editing the cube re-meshes
two; moving the origin point re-meshes none of the solids that did not change.

## Using the runtime

```sh
# build the OCAF document from the neutral parametric file
ocafcad build examples/cube_fillet.ocaf.json -o part.cbf --mesh mesh.json --step part.step

# edit a parameter — only the fillet rebuilds
ocafcad set part.cbf Fillet.1.radius=25 -o part.cbf
#   regenerated 1 of 5 functions, 4 up to date
#     + Fillet.1
#     = Origin (unchanged)  = Z Direction (unchanged)  = XY Plane (unchanged)  = Cube.1 (unchanged)

# edit the cube — the change cascades downstream, the datums do not move
ocafcad set part.cbf Cube.1.dz=140 -o part.cbf
#   regenerated 2 of 5 functions, 3 up to date
#     + Cube.1
#     + Fillet.1

ocafcad tree part.cbf      # the feature tree with values and references
ocafcad schema             # the feature catalogue the front-end is built from
```

`-o part.xml` stores the same document as `XmlOcaf` instead of `BinOcaf`, which
is useful when you want to read the label tree by eye.

## Files

| | |
|---|---|
| `include/ocafcad/Schema.hxx`, `src/Schema.cxx` | the feature catalogue — types, GUIDs, parameters, slider ranges |
| `include/ocafcad/Feature.hxx`, `src/Feature.cxx` | reading and writing a feature label |
| `include/ocafcad/Drivers.hxx`, `src/Drivers.cxx` | the `TFunction_Driver` subclasses |
| `include/ocafcad/Document.hxx`, `src/Document.cxx` | document facade: load, edit, regenerate, save |
| `src/Export.cxx` | tessellation to JSON, STEP, STL, catalogue JSON |
| `src/main.cxx` | the `ocafcad` command line runtime |
| `src/Json.cxx` | the small JSON reader/writer the neutral format uses |

## The neutral file

`.ocaf.json` is the parametric model without geometry — the format the browser
front-end reads and writes, and the input to `ocafcad build`. It is deliberately
plain:

```json
{ "id": "CB1", "type": "Cube", "name": "Cube.1",
  "args": { "origin": {"ref": "PT1"}, "plane": {"ref": "PL1"},
            "dx": 80, "dy": 80, "dz": 80 } }
```

A model drawn in the browser rebuilds on the real kernel with
`ocafcad build model.ocaf.json --step part.step`.
