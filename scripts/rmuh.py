"""RMUH_v1 - core model definition.

The canopy is a smooth bicubic NURBS surface built with OpenCascade
(GeomAPI_PointsToBSplineSurface) and given real thickness by a true normal
offset (BRepOffsetAPI_MakeThickSolid).  Its soffit is doubly curved, so every
vertical element takes its height from the soffit above its own footprint -
each stays a genuine Extrusion rather than becoming a boolean-cut Brep.
"""
import math
from OCP.gp import gp_Pnt
from OCP.TColgp import TColgp_Array2OfPnt
from OCP.GeomAPI import GeomAPI_PointsToBSplineSurface
from OCP.GeomAbs import GeomAbs_C2
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon
from OCP.gp import gp_Vec
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.BRep import BRep_Tool
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp

M = 1000.0
GRID        = 25.0 * M
ROOF_A      = 13.0 * M          # canopy half-width -> 26.0 m square
ROOF_RISE   =  2.6 * M          # corner lift
ROOF_T      =  0.40 * M
BOX_A       =  9.0 * M
STOREY      =  5.4 * M
SLAB_T      =  0.35 * M
SLAB_OS     =  0.60 * M
COL         =  0.45 * M
MUL_W, MUL_D = 0.07 * M, 0.22 * M
GLASS_T     =  0.028 * M
MUL_SPACING =  3.0 * M
FIT_N       = 9                 # surface fit grid
CV          = 33                # control points per .3dm isocurve
STRIPS      = 16                # ruled strips per canopy surface

MODULES = [
    (0,0,2), (1,0,1), (2,0,3), (3,0,1),
    (0,1,1), (1,1,3), (2,1,1), (3,1,2),
    (0,2,3), (1,2,1), (2,2,2), (3,2,1),
]

def module_origin(c, r):
    return c*GRID + (r % 2)*GRID/2, r*GRID

# ------------------------------------------------------------ canopy form
def rise_at(s, t):
    """Normalised canopy profile: centre low, corners lifted, edges dipping."""
    s = max(-1.0, min(1.0, s)); t = max(-1.0, min(1.0, t))
    return ROOF_RISE * (((s*s + t*t) / 2.0) ** 2)

def soffit_z(x, y, cx, cy, z0):
    return z0 + rise_at((x-cx)/ROOF_A, (y-cy)/ROOF_A)

def soffit_min_over(cx, cy, z0, x0, y0, x1, y1):
    """Lowest soffit height over a footprint - keeps elements clear of the roof."""
    return min(soffit_z(x, y, cx, cy, z0)
               for x in (x0, (x0+x1)/2, x1) for y in (y0, (y0+y1)/2, y1))

# ------------------------------------------------------- OCC canopy solid
def canopy_surface(cx, cy, z0):
    arr = TColgp_Array2OfPnt(1, FIT_N, 1, FIT_N)
    for i in range(FIT_N):
        for j in range(FIT_N):
            s = -1 + 2*i/(FIT_N-1); t = -1 + 2*j/(FIT_N-1)
            arr.SetValue(i+1, j+1, gp_Pnt(cx + ROOF_A*s, cy + ROOF_A*t, z0 + rise_at(s, t)))
    return GeomAPI_PointsToBSplineSurface(arr, 3, 3, GeomAbs_C2, 1e-3).Surface()

def canopy_solid(cx, cy, z0):
    """Soffit surface thickened upward by a true normal offset."""
    face = BRepBuilderAPI_MakeFace(canopy_surface(cx, cy, z0), 1e-6).Face()
    mk = BRepOffsetAPI_MakeThickSolid()
    mk.MakeThickSolidBySimple(face, ROOF_T)
    return mk.Shape()

def canopy_top_surface(solid):
    """The offset face of a canopy solid.

    Identified by surface type: MakeThickSolid leaves the original soffit as a
    B-spline and produces the new face as a Geom_OffsetSurface.  (Centroid
    height is not a valid test - the side walls sit higher than either.)
    """
    from OCP.Geom import Geom_OffsetSurface
    best, ba = None, -1.0
    ex = TopExp_Explorer(solid, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        if isinstance(BRep_Tool.Surface_s(f), Geom_OffsetSurface):
            p = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, p)
            if p.Mass() > ba:
                ba, best = p.Mass(), f
        ex.Next()
    if best is None:
        raise RuntimeError("no offset face found on canopy solid")
    return BRep_Tool.Surface_s(best), best

def sample_face_surface(surf, face, nu, nv):
    """Grid-sample a face's surface across its parameter range."""
    from OCP.BRepTools import BRepTools
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    out = []
    for i in range(nu+1):
        u = u0 + (u1-u0)*i/nu
        row = []
        for j in range(nv+1):
            v = v0 + (v1-v0)*j/nv
            p = surf.Value(u, v); row.append((p.X(), p.Y(), p.Z()))
        out.append(row)
    return out

def prism(loop, height):
    """Planar closed loop extruded along +Z-normal by height -> TopoDS solid."""
    poly = BRepBuilderAPI_MakePolygon()
    for p in loop[:-1]:
        poly.Add(gp_Pnt(*p))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire()).Face()
    n = _loop_normal(loop)
    return BRepPrimAPI_MakePrism(face, gp_Vec(n[0]*height, n[1]*height, n[2]*height)).Shape()

def _loop_normal(loop):
    (ax,ay,az),(bx,by,bz),(cx_,cy_,cz) = loop[0], loop[1], loop[2]
    ux,uy,uz = bx-ax, by-ay, bz-az
    vx,vy,vz = cx_-bx, cy_-by, cz-bz
    nx,ny,nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
    L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
    return nx/L, ny/L, nz/L

# ------------------------------------------------------------- composition
def rect(cx, cy, hw, hd, z):
    return [(cx-hw,cy-hd,z),(cx+hw,cy-hd,z),(cx+hw,cy+hd,z),(cx-hw,cy+hd,z),(cx-hw,cy-hd,z)]

def elements(tag, cx, cy, storeys):
    """Yield every prismatic element of one pavilion as an extrusion record."""
    z0 = storeys * STOREY                      # canopy soffit datum (its low point)
    base = {"Module": tag, "Storeys": storeys}
    E = lambda **kw: kw

    for k in range(storeys):
        z = k*STOREY
        yield E(kind="extrusion", layer="Slabs", cat="Slab",
                name=f"{tag}-SLB-L{k+1:02d}", height=SLAB_T,
                loop=rect(cx, cy, BOX_A+SLAB_OS, BOX_A+SLAB_OS, z),
                props={**base, "Category":"Slab", "IfcClass":"IfcSlab",
                       "Material":"Reinforced concrete C40/50", "Level":f"L{k+1:02d}",
                       "Thickness_mm":SLAB_T, "Span_mm":2*(BOX_A+SLAB_OS)})

    n = 0
    for sx in (-1,0,1):
        for sy in (-1,0,1):
            if sx == 0 and sy == 0: continue
            n += 1
            px, py = cx+sx*BOX_A, cy+sy*BOX_A
            h = soffit_min_over(cx, cy, z0, px-COL/2, py-COL/2, px+COL/2, py+COL/2)
            yield E(kind="extrusion", layer="Columns", cat="Column",
                    name=f"{tag}-COL-{n:02d}", height=h,
                    loop=rect(px, py, COL/2, COL/2, 0.0),
                    props={**base, "Category":"Column", "IfcClass":"IfcColumn",
                           "Material":"Steel, painted white",
                           "Profile":f"{COL:.0f}x{COL:.0f}", "Height_mm":round(h,1),
                           "HeadFollows":"canopy soffit"})

    for (fn, ux, uy) in (("N",0,1), ("S",0,-1), ("E",1,0), ("W",-1,0)):
        horiz = (ux == 0)
        ax, ay = (1,0) if horiz else (0,1)
        hwhd = lambda a, b: (a/2, b/2) if horiz else (b/2, a/2)
        fx, fy = cx+ux*BOX_A, cy+uy*BOX_A
        nbays = int(round(2*BOX_A/MUL_SPACING))
        for k in range(storeys):
            zs = k*STOREY + SLAB_T
            last = (k == storeys-1)
            for b in range(nbays):
                t = -BOX_A + b*MUL_SPACING + MUL_SPACING/2
                gx, gy = fx+ax*t, fy+ay*t
                hw, hd = hwhd(MUL_SPACING, GLASS_T)
                zt = (soffit_min_over(cx, cy, z0, gx-hw, gy-hd, gx+hw, gy+hd)
                      if last else (k+1)*STOREY)
                yield E(kind="extrusion", layer="Glazing", cat="Glazing",
                        name=f"{tag}-GL-{fn}-L{k+1:02d}-{b+1:02d}", height=zt-zs,
                        loop=rect(gx, gy, hw, hd, zs),
                        props={**base, "Category":"Glazing", "IfcClass":"IfcPlate",
                               "Material":"IGU 8/16Ar/8 Low-E, low-iron", "Facade":fn,
                               "Level":f"L{k+1:02d}", "Bay":b+1, "Thickness_mm":GLASS_T,
                               "Width_mm":MUL_SPACING, "Height_mm":round(zt-zs,1),
                               "Area_m2":round(MUL_SPACING*(zt-zs)/1e6,2)})
            for b in range(nbays+1):
                t = -BOX_A + b*MUL_SPACING
                mx, my = fx+ax*t, fy+ay*t
                hw, hd = hwhd(MUL_W, MUL_D)
                zt = (soffit_min_over(cx, cy, z0, mx-hw, my-hd, mx+hw, my+hd)
                      if last else (k+1)*STOREY)
                yield E(kind="extrusion", layer="Mullions_Vertical", cat="Mullion",
                        name=f"{tag}-MUL-{fn}-L{k+1:02d}-{b+1:02d}", height=zt-zs,
                        loop=rect(mx, my, hw, hd, zs),
                        props={**base, "Category":"Mullion", "SubType":"Vertical",
                               "IfcClass":"IfcMember", "Material":"Aluminium, anodised",
                               "Profile":f"{MUL_W:.0f}x{MUL_D:.0f}", "Facade":fn,
                               "Level":f"L{k+1:02d}", "Length_mm":round(zt-zs,1)})
            hw, hd = hwhd(2*BOX_A, MUL_D)
            zt = (soffit_min_over(cx, cy, z0, fx-hw, fy-hd, fx+hw, fy+hd)
                  if last else (k+1)*STOREY)
            yield E(kind="extrusion", layer="Mullions_Transoms", cat="Transom",
                    name=f"{tag}-TRN-{fn}-L{k+1:02d}", height=MUL_W,
                    loop=rect(fx, fy, hw, hd, zt-MUL_W),
                    props={**base, "Category":"Transom", "SubType":"Horizontal",
                           "IfcClass":"IfcMember", "Material":"Aluminium, anodised",
                           "Facade":fn, "Level":f"L{k+1:02d}", "Elevation_mm":round(zt,1)})

def pavilions():
    for (c, r, st) in MODULES:
        cx, cy = module_origin(c, r)
        yield f"P-{chr(65+c)}{r+1}", cx, cy, st, st*STOREY

def site_bounds(pad=8.0*M):
    xs = [p[1] for p in pavilions()]; ys = [p[2] for p in pavilions()]
    return (min(xs)-ROOF_A-pad, max(xs)+ROOF_A+pad,
            min(ys)-ROOF_A-pad, max(ys)+ROOF_A+pad)
