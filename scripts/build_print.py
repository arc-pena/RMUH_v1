"""Scaled physical model.

Mullions (70mm) and glazing (28mm) fall below any nozzle at model scale, so
the print set reads the pavilions as massing: canopy + slabs + a solid glazed
volume per storey.  Columns sit inside that volume and are omitted.
"""
import numpy as np, trimesh
import rmuh_pavilion as R
from build_mesh import hypar_solid_mesh

SCALE = 1/500.0
MIN_FEATURE_MM = 0.8            # ~2 perimeters at a 0.4mm nozzle

def box(cx, cy, hw, hd, z, h):
    m = trimesh.creation.box(extents=(2*hw, 2*hd, h))
    m.apply_translation((cx, cy, z + h/2)); return m

if __name__ == "__main__":
    R.main()
    parts = [hypar_solid_mesh(*p[:6], R.ROOF_T) for p in R.roof_patches]
    for (c, r, st) in R.MODULES:
        cx = c*R.GRID + (r % 2)*R.GRID/2; cy = r*R.GRID
        top = st*R.STOREY
        for k in range(st):
            z = k*R.STOREY
            parts.append(box(cx, cy, R.BOX_A+R.SLAB_OS, R.BOX_A+R.SLAB_OS, z, R.SLAB_T))
            zt = (k+1)*R.STOREY if k < st-1 else top
            parts.append(box(cx, cy, R.BOX_A, R.BOX_A, z+R.SLAB_T, zt-z-R.SLAB_T))

    m = trimesh.util.concatenate(parts)
    m.apply_scale(SCALE)
    m.apply_translation(-m.bounds[0])                 # sit on the bed at origin
    m.export("../out/RMUH_v1_print_1-500.stl")

    ext = m.extents
    print(f"print scale   : 1:{int(1/SCALE)}")
    print(f"print size    : {ext[0]:.0f} x {ext[1]:.0f} x {ext[2]:.0f} mm")
    print(f"triangles     : {len(m.faces)}")
    print(f"bodies        : {len(m.split(only_watertight=False))}")
    print("\nminimum features at scale:")
    for label, mm in (("canopy thickness", R.ROOF_T), ("slab thickness", R.SLAB_T),
                      ("slab oversail", R.SLAB_OS), ("column", R.COL),
                      ("mullion (omitted)", R.MUL_W), ("glazing (massed)", R.GLASS_T)):
        v = mm*SCALE
        print(f"  {label:<20} {v:5.2f} mm  {'OK' if v >= MIN_FEATURE_MM else 'below nozzle'}")
