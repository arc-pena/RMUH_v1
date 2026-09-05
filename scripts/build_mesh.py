"""Meshing for fabrication.

OCC will not subdivide a bilinear (ruled) patch - its isolines are straight,
so the mesher sees zero deflection and emits 2 triangles, flattening the
canopy.  The STEP/.3dm keep the exact surface; here the hypar is sampled
analytically instead so the printed roof really is curved.
"""
import numpy as np, trimesh
from build123d import *
import rmuh_pavilion as R

N = 24                     # hypar sampling grid per quadrant

def hypar_solid_mesh(x0, y0, x1, y1, zc, ze, T, n=N):
    u = np.linspace(0, 1, n+1)
    U, V = np.meshgrid(u, u, indexing="ij")
    X = x0 + (x1-x0)*U
    Y = y0 + (y1-y0)*V
    Z = zc + (ze-zc)*U*V                      # exact hypar
    top = np.stack([X, Y, Z+T], -1).reshape(-1, 3)
    bot = np.stack([X, Y, Z],   -1).reshape(-1, 3)
    verts = np.vstack([top, bot]); off = len(top)
    idx = lambda i, j: i*(n+1) + j
    f = []
    for i in range(n):
        for j in range(n):
            a,b,c,d = idx(i,j), idx(i+1,j), idx(i+1,j+1), idx(i,j+1)
            f += [[a,b,c], [a,c,d]]                                  # top
            f += [[off+a, off+c, off+b], [off+a, off+d, off+c]]      # bottom
    for i in range(n):                                               # side walls
        for (a,b) in ((idx(i,0), idx(i+1,0)), (idx(i+1,n), idx(i,n))):
            f += [[a,b,off+b], [a,off+b,off+a]]
        for (a,b) in ((idx(0,i+1), idx(0,i)), (idx(n,i), idx(n,i+1))):
            f += [[a,b,off+b], [a,off+b,off+a]]
    m = trimesh.Trimesh(vertices=verts, faces=np.array(f), process=True)
    trimesh.repair.fix_normals(m)
    return m

if __name__ == "__main__":
    R.main()
    T = R.ROOF_T
    roofs = [hypar_solid_mesh(*p[:6], T) for p in R.roof_patches]
    bad = [i for i, m in enumerate(roofs) if not m.is_watertight]
    print(f"roof panels: {len(roofs)} | watertight: {len(roofs)-len(bad)}/{len(roofs)} | tris each: {len(roofs[0].faces)}")

    # everything else is planar-faced, so OCC tessellates it exactly
    others = [extrude(Face(Wire.make_polygon([tuple(p) for p in loop[:-1]], close=True)),
                      amount=h) for loop, h, _, _ in R.solids]
    export_stl(Compound(children=others), "/tmp/others.stl", tolerance=1.0, angular_tolerance=0.2)
    full = trimesh.util.concatenate([trimesh.load("/tmp/others.stl")] + roofs)
    full.export("../out/RMUH_v1.stl")
    print(f"full model  : {len(full.faces)} tris | bbox m {np.round(full.extents/1000,1)}")
