# RMUH_v1 — pavilion campus

Parametric architectural model: glazed pavilion boxes, each capped by a large
white canopy whose four corners sweep upward and cantilever past the glass line.
Pavilions are staggered on a grid at varying heights so the canopies overlap and
step. Abstracted from a reference image — an architectural *language*, not a
reproduction of a specific building.

Geometry is built directly on **OpenCascade** (via `OCP`, the kernel inside
build123d), which is what makes the canopy a real doubly-curved NURBS solid
rather than an approximation.

## Deliverables (`out/`)

| File | Use |
|---|---|
| `RMUH_v1.3dm` | **Rhino**, structured: layer tree, named objects, semantic metadata |
| `RMUH_v1.step` | **Rhino / any CAD** — named *and coloured* assembly tree, 1306 solids |
| `RMUH_v1.stl` | Full mesh, 1:1, 52k triangles |
| `RMUH_v1_print_1-500.stl` | Physical model at 1:500 — 227 × 152 × 38 mm, 150/150 watertight |
| `RMUH_v1_preview.png` | Axonometric |

## Scale

Authored in **millimetres at real-world 1:1**. Both `.3dm` and `.step` carry
millimetre units, so neither asks on import.

| | |
|---|---|
| Building extent | 113.5 × 76.0 m (129.5 × 92.0 m incl. site) |
| Canopy | 26.0 m square, 2.6 m corner rise, 0.40 m thick |
| Glass box | 18.0 m square |
| Cantilever | 4.0 m every side |
| Floor-to-floor | 5.4 m |
| Tallest pavilion | 19.1 m |
| Pavilions | 12, of 1–3 storeys, on a 25.0 m grid |

An 18 m square column-free floor plate is a gallery, not a kiosk.

## The canopy

A single **bicubic NURBS surface** — degree 3×3, interpolated through a 9×9 grid
by `GeomAPI_PointsToBSplineSurface` with C2 continuity. Smooth and continuous:
no crease, no quadrant seam, no faceting.

Thickness comes from `BRepOffsetAPI_MakeThickSolid` — a **true normal offset**,
not a vertical shift. The shell is 400 mm measured perpendicular to the surface,
which reads as 348 mm vertically where the surface tilts 21.8° at the corners.
That is what a constant-thickness shell actually does.

The profile is low at the centre and at both edge midpoints, lifting only toward
the corners — which is what produces the upswept corners and dipping eaves.

## Structure

Nothing is a dumb mesh. Every element is a true solid or surface, on a named
layer, carrying metadata.

```
00_SITE::Terrain          01_STRUCTURE::Columns     02_ENVELOPE::Mullions::Vertical
01_STRUCTURE::Slabs       02_ENVELOPE::Glazing      02_ENVELOPE::Mullions::Transoms
03_ROOF::Canopy_Top       03_ROOF::Canopy_Soffit    03_ROOF::Canopy_Fascia
```

- **1293 Extrusions** — columns, slabs, mullions, transoms, glazing.
- **Canopies** — bicubic NURBS solids in STEP; ruled strips in `.3dm` (below).

Every object has a mark (`P-A1-COL-03`, `P-B2-CANOPY`) and user strings readable
in Rhino's Properties panel or via `GetUserText`:

```
Category = Column          IfcClass = IfcColumn      Profile = 450x450
Material = Steel, painted white                      Height_mm = 11339.7
HeadFollows = canopy soffit
```

Glazing panels carry `Area_m2`, so a façade schedule is a metadata query.

### Why the columns are not boolean-cut

The soffit is doubly curved, so a column meeting it should in principle be cut
against that surface. Doing so would turn every column into a generic trimmed
Brep and destroy the extrusion identity that makes the model readable.

Instead each vertical element takes its height from the **lowest soffit point
over its own footprint**. Corner columns run to 11339.7 mm and mid-edge columns
to 10934.9 mm in a two-storey pavilion — each following the canopy, each still a
genuine `Extrusion` with an editable profile. The residual step across a single
450 mm column footprint is a few millimetres.

The same applies to mullions, glazing and head transoms.

## Format notes

**STEP is the better Rhino file.** Written through **XCAF**
(`STEPCAFControl_Writer`), so it carries a real assembly tree *with colours*:

```
RMUH_v1 → Column → P-A1-COL-01
        → Roof   → P-A1-CANOPY
        → Glazing, Mullion, Transom, Slab, Site
```

AP214, millimetres, 1306 `MANIFOLD_SOLID_BREP`, 72 B-spline surfaces (12
canopies × 6 faces), 1306 `STYLED_ITEM`.

**The `.3dm` canopy is a strip approximation.** rhino3dm cannot author an
arbitrary NURBS surface — `NurbsSurfacePointList` is read-only, and the
`Encode()` payload is an opaque base64 openNURBS blob. Its only general surface
constructor is `CreateRuledSurface`. So each canopy is emitted as 16 ruled
strips between exact NURBS isocurves sampled off the OpenCascade surface, at 33
control points each.

Measured worst-case deviation from the true surface: **20.8 mm over a 26 m span
(0.08%)**. Select a canopy's strips and `Join` for a smooth polysurface. The
STEP carries the exact surface if you need it.

Note that `NurbsCurve.Create` treats supplied points as *control points*, not
interpolation points — with 9 points the edge curve misses the true surface by
99 mm, which is why 33 are used.

**Meshing.** Earlier revisions built the canopy from bilinear (ruled) patches,
and OpenCascade would not subdivide them: straight isolines measure zero
deflection, so `BRepMesh` emitted 2 triangles and flattened the roof into a
plane through its corners. Tightening tolerance changed nothing. A genuine
bicubic surface has real curvature along its isolines, so `BRepMesh` now
subdivides correctly and the STL comes straight off the kernel.

**Print set.** At 1:500 the mullions (0.14 mm) and glazing (0.06 mm) fall below
any nozzle, so the print variant reads the pavilions as massing: canopy, slabs,
columns and a solid glazed volume per storey. The one marginal feature is the
0.70 mm slab, whose 1.2 mm oversail is a thin ledge.

## The modeller

`docs/` holds a second thing entirely: a parametric CAD modeller built on
OpenCascade's OCAF, running in the browser. A specification tree, a sketcher, a
node graph, solids and polymeshes, file exchange, and packages for climate
analysis and pedestrian flow. Its own README is in `docs/README.md`.

`docs/index.html` is that modeller built as a website — the page, the source
modules, and the WebAssembly kernel as files beside them. It is what GitHub
Pages serves, and `python3 docs/build.py` regenerates it. The `index.html` at
the root of this repository is one line of redirect into it, so the site works
whether Pages is pointed at `/docs` or at the root.

## Regenerating

```bash
pip install build123d rhino3dm trimesh numpy matplotlib networkx
cd scripts && python build_all.py
```

| file | role |
|---|---|
| `rmuh.py` | parameters, canopy surface/solid, composition, element generator |
| `build_3dm.py` | structured Rhino file |
| `build_step.py` | XCAF named + coloured STEP |
| `build_stl.py` | BRepMesh → 1:1 STL and the 1:500 print set |
| `preview.py` | axonometric |

All dimensions are constants at the top of `scripts/rmuh.py`; `MODULES` is the
`(col, row, storeys)` composition list.
