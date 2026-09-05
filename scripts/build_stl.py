"""STL via BRepMesh.

The canopy is now a genuine bicubic surface, so BRepMesh subdivides it on
curvature - the earlier hand-rolled sampling workaround is no longer needed.
"""
import numpy as np, trimesh
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer
import rmuh as R

DEFLECTION, ANGULAR = 12.0, 0.25
SCALE = 1/500.0
MIN_FEATURE_MM = 0.8

def compound(shapes):
    c = TopoDS_Compound(); b = BRep_Builder(); b.MakeCompound(c)
    for s in shapes: b.Add(c, s)
    return c

def write(shapes, path, defl=DEFLECTION):
    c = compound(shapes)
    BRepMesh_IncrementalMesh(c, defl, False, ANGULAR, True)
    w = StlAPI_Writer(); w.ASCIIMode = False
    w.Write(c, path)
    return trimesh.load(path)

def main():
    full, mass = [], []
    for tag, cx, cy, st, z0 in R.pavilions():
        can = R.canopy_solid(cx, cy, z0)
        full.append(can); mass.append(can)
        for e in R.elements(tag, cx, cy, st):
            full.append(R.prism(e["loop"], e["height"]))
            if e["cat"] in ("Slab", "Column"):
                mass.append(R.prism(e["loop"], e["height"]))
        for k in range(st):                      # glazed volume, massed for printing
            z = k*R.STOREY + R.SLAB_T
            zt = (k+1)*R.STOREY if k < st-1 else z0
            mass.append(R.prism(R.rect(cx, cy, R.BOX_A, R.BOX_A, z), zt-z))

    m = write(full, "../out/RMUH_v1.stl")
    print(f"1:1 STL      : {len(m.faces)} tris | bbox m {np.round(m.extents/1000,1)}")

    p = write(mass, "/tmp/mass.stl")
    p.apply_scale(SCALE); p.apply_translation(-p.bounds[0])
    p.export("../out/RMUH_v1_print_1-500.stl")
    print(f"print 1:500  : {len(p.faces)} tris | {p.extents[0]:.0f} x {p.extents[1]:.0f} x {p.extents[2]:.0f} mm")
    for lbl, v in (("canopy thickness", R.ROOF_T), ("slab", R.SLAB_T),
                   ("slab oversail", R.SLAB_OS), ("column", R.COL)):
        s = v*SCALE
        print(f"   {lbl:<18} {s:5.2f} mm  {'OK' if s >= MIN_FEATURE_MM else 'marginal'}")

if __name__ == "__main__":
    main()
