"""Replay the .3dm definition as true B-rep solids -> STEP (Rhino NURBS) + STL (print)."""
import time, rhino3dm  # noqa
from build123d import *
import rmuh_pavilion as R

t0 = time.time()
R.main()                                   # populates R.solids / R.roof_patches, writes .3dm
print(f"--- building solids from {len(R.solids)} extrusions + {len(R.roof_patches)} roof panels")

groups = {}
def put(cat, shape, name):
    shape.label = name
    groups.setdefault(cat, []).append(shape)

for loop, height, name, cat in R.solids:
    face = Face(Wire.make_polygon([tuple(p) for p in loop[:-1]], close=True))
    put(cat or "Misc", extrude(face, amount=height), name)

T = R.ROOF_T
for (x0, y0, x1, y1, zc, ze, name) in R.roof_patches:
    def hypar(dz):
        return Face.make_surface_from_curves(
            Edge.make_line((x0, y0, zc+dz), (x1, y0, zc+dz)),
            Edge.make_line((x0, y1, zc+dz), (x1, y1, ze+dz)))
    def quad(*pts):
        return Face(Wire.make_polygon(list(pts), close=True))
    faces = [hypar(T), hypar(0),
             quad((x0,y0,zc), (x0,y1,zc), (x0,y1,zc+T), (x0,y0,zc+T)),
             quad((x0,y0,zc), (x1,y0,zc), (x1,y0,zc+T), (x0,y0,zc+T)),
             quad((x1,y0,zc), (x1,y1,ze), (x1,y1,ze+T), (x1,y0,zc+T)),
             quad((x0,y1,zc), (x1,y1,ze), (x1,y1,ze+T), (x0,y1,zc+T))]
    put("Roof", Solid(Shell(faces)), name)

children = []
for cat, shapes in sorted(groups.items()):
    c = Compound(children=shapes); c.label = cat; children.append(c)
    print(f"    {cat:<10} {len(shapes):>5} solids")
root = Compound(children=children); root.label = "RMUH_v1"

export_step(root, "../out/RMUH_v1.step")
print(f"STEP written  ({time.time()-t0:.0f}s)")
export_stl(root, "../out/RMUH_v1.stl", tolerance=8.0, angular_tolerance=0.3)
print(f"STL written   ({time.time()-t0:.0f}s)")
print("total volume m3:", round(sum(s.volume for g in groups.values() for s in g)/1e9, 1))
