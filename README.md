# RMUH_v1 — pavilion campus

Parametric architectural model: glazed pavilion boxes, each capped by a large
white canopy whose four corners sweep upward and cantilever past the glass line.
Pavilions are staggered on a grid at varying heights so the canopies overlap and
step. Abstracted from a reference image — an architectural *language*, not a
reproduction of a specific building.

## Deliverables (`out/`)

| File | Use |
|---|---|
| `RMUH_v1.3dm` | **Rhino**, structured: layer tree, named objects, semantic metadata |
| `RMUH_v1.step` | **Rhino / any CAD** — 1342 B-rep solids as a named assembly tree |
| `RMUH_v1.stl` | Full mesh, 1:1, 135k triangles |
| `RMUH_v1_print_1-500.stl` | Physical model at 1:500 — 227 × 152 × 38 mm |
| `RMUH_v1_preview.png` | Axonometric |

## Scale

Authored in **millimetres at real-world 1:1**. Both `.3dm` and `.step` carry
millimetre units, so neither asks on import.

| | |
|---|---|
| Site extent | 129.5 × 92.0 m |
| Canopy | 26.0 m square, 2.6 m corner rise, 0.40 m deep |
| Glass box | 18.0 m square |
| Cantilever | 4.0 m every side |
| Floor-to-floor | 5.4 m |
| Tallest pavilion | 19.2 m to canopy corner |
| Pavilions | 12, of 1–3 storeys, on a 25.0 m grid |

Museum-scale: an 18 m square column-free floor plate is a gallery, not a kiosk.

## Structure

Nothing is a dumb mesh. Every object is a true solid or surface, on a named
layer, carrying metadata.

```
00_SITE::Terrain          01_STRUCTURE::Columns     02_ENVELOPE::Mullions::Vertical
01_STRUCTURE::Slabs       02_ENVELOPE::Glazing      02_ENVELOPE::Mullions::Transoms
03_ROOF::Canopy_Top       03_ROOF::Canopy_Soffit    03_ROOF::Canopy_Fascia
```

- **1294 Extrusions** — columns, slabs, mullions, transoms, glazing. Real
  extrusion objects: a column is a profile swept along its height, so Rhino
  reports it as an extrusion with an editable profile.
- **192 NURBS surfaces** — the canopies.

Every object has a mark (`P-A1-COL-03`, `P-B2-ROOF-NE-TOP`) and user strings
readable in Rhino's Properties panel or via `GetUserText`:

```
Category = Roof            IfcClass = IfcRoof        Quadrant  = NE
Material = White GRC on steel frame                  Span_mm   = 13000
SubType  = Hypar canopy quadrant                     Thickness_mm = 400
```

Glazing panels carry `Area_m2`, so a façade area schedule is a metadata query,
not a measuring exercise.

## The canopies

Each canopy is four **hyperbolic-paraboloid quadrants**. A hypar is a ruled
surface, so it is stored *exactly* — as a degree-1×1 NURBS in `.3dm`, as a
B-rep in STEP. No faceting, no approximation.

The quadrant is low at the centre and at both edge midpoints, lifting only at
the outer corner — which is what produces the upswept corners and the dipping
eaves. It is also how such roofs get panelised in reality.

## Notes

- **STEP is the better Rhino file.** It carries the canopies as closed solids
  with a named assembly tree. The `.3dm` carries the richer metadata but holds
  canopies as surfaces — select a canopy's 16 surfaces and `Join` for a closed
  polysurface.
- **Meshing.** OpenCascade will not subdivide a bilinear patch (straight
  isolines ⇒ zero measured deflection ⇒ 2 triangles, flattening the canopy).
  The STL path therefore samples the hypar analytically on a 24×24 grid. All 48
  canopy panels verify watertight.
- **Print set.** At 1:500 the mullions (0.14 mm) and glazing (0.06 mm) fall
  below any nozzle, so the print variant reads the pavilions as massing:
  canopy + slabs + a solid glazed volume per storey. The one marginal feature
  is the 0.70 mm slab, whose 1.2 mm oversail is a thin ledge.

## Regenerating

```bash
pip install build123d rhino3dm trimesh numpy matplotlib networkx
cd scripts
python build_solids.py   # .3dm + .step
python build_mesh.py     # .stl at 1:1
python build_print.py    # scaled print .stl
python preview.py        # preview.png
```

All dimensions are constants at the top of `scripts/rmuh_pavilion.py`; `MODULES`
is the `(col, row, storeys)` composition list.
