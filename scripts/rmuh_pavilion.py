"""RMUH_v1 - pavilion campus generator.

Architectural language (abstracted from the reference image):
  glazed pavilion boxes, each capped by a large white canopy whose four
  corners sweep upward, cantilevering well beyond the glass line; the
  pavilions are staggered on a grid at varying heights so the canopies
  overlap and step.

Each canopy = 4 hyperbolic-paraboloid quadrants.  A hypar is a ruled
surface, so it is represented EXACTLY - as NURBS in .3dm, as a B-rep
solid in STEP - with no faceting anywhere.

All geometry is authored in MILLIMETRES at real-world 1:1 scale.
"""
import math, rhino3dm as r3

M = 1000.0                     # metres -> model units (mm)

# ------------------------------------------------------------ parameters
GRID        = 25.0 * M         # pavilion centre-to-centre spacing (canopies overlap)
ROOF_A      = 13.0 * M         # canopy half-width  -> 26.0 m square
ROOF_RISE   =  2.6 * M        # corner lift above the low point
ROOF_T      =  0.40 * M        # canopy structural depth
BOX_A       =  9.0 * M         # glass box half-width -> 18.0 m square
STOREY      =  5.4 * M         # floor-to-floor
SLAB_T      =  0.35 * M
SLAB_OS     =  0.60 * M        # slab oversail past the glass line
COL         =  0.45 * M        # column, square
MUL_W, MUL_D = 0.07 * M, 0.22 * M
GLASS_T     =  0.028 * M       # IGU
MUL_SPACING =  3.0 * M

# (col, row, storeys) - staggered rows, varied heights => overlapping canopies
MODULES = [
    (0,0,2), (1,0,1), (2,0,3), (3,0,1),
    (0,1,1), (1,1,3), (2,1,1), (3,1,2),
    (0,2,3), (1,2,1), (2,2,2), (3,2,1),
]

model = r3.File3dm()
model.ApplicationName = "RMUH_v1 pavilion generator"
model.Settings.ModelUnitSystem = r3.UnitSystem.Millimeters

# ---------------------------------------------------------------- layers
def layer(name, rgb, parent=None):
    L = r3.Layer(); L.Name = name; L.Color = (*rgb, 255)
    if parent is not None: L.ParentLayerId = model.Layers[parent].Id
    return model.Layers.Add(L)

L_SITE = layer("00_SITE",        (196,192,180))
L_TER  = layer("Terrain",        (205,201,188), L_SITE)
L_STR  = layer("01_STRUCTURE",   (128,128,138))
L_COL  = layer("Columns",        ( 96, 96,104), L_STR)
L_SLB  = layer("Slabs",          (156,151,141), L_STR)
L_ENV  = layer("02_ENVELOPE",    ( 70,130,180))
L_MUL  = layer("Mullions",       ( 58, 58, 64), L_ENV)
L_MULV = layer("Vertical",       ( 58, 58, 64), L_MUL)
L_MULH = layer("Transoms",       ( 78, 78, 84), L_MUL)
L_GLZ  = layer("Glazing",        (150,200,220), L_ENV)
L_RF   = layer("03_ROOF",        (245,245,242))
L_RFT  = layer("Canopy_Top",     (250,250,248), L_RF)
L_RFS  = layer("Canopy_Soffit",  (226,226,222), L_RF)
L_RFF  = layer("Canopy_Fascia",  (236,236,232), L_RF)

# ------------------------------------------------------------- primitives
solids = []           # (kind, params) records replayed by the STEP/STL build

def add_extrusion(loop, height, li, name, props):
    pl = r3.Polyline()
    for p in loop: pl.Add(*p)
    ext = r3.Extrusion.Create(pl.ToNurbsCurve(), height, True)
    att = r3.ObjectAttributes(); att.LayerIndex = li; att.Name = name
    for k, v in props.items(): att.SetUserString(k, str(v))
    model.Objects.AddExtrusion(ext, att)
    solids.append((loop, height, name, props.get("Category","")))

def add_surface(p00, p10, p01, p11, li, name, props):
    """Ruled (bilinear) patch through 4 corners -> exact hypar when warped."""
    A = r3.LineCurve(r3.Point3d(*p00), r3.Point3d(*p10))
    B = r3.LineCurve(r3.Point3d(*p01), r3.Point3d(*p11))
    srf = r3.NurbsSurface.CreateRuledSurface(A, B)
    att = r3.ObjectAttributes(); att.LayerIndex = li; att.Name = name
    for k, v in props.items(): att.SetUserString(k, str(v))
    model.Objects.AddSurface(srf, att)

def box_xy(cx, cy, hw, hd, z, h, li, name, props):
    loop = [(cx-hw,cy-hd,z),(cx+hw,cy-hd,z),(cx+hw,cy+hd,z),(cx-hw,cy+hd,z),(cx-hw,cy-hd,z)]
    add_extrusion(loop, h, li, name, props)

# ------------------------------------------------------------- a pavilion
QUAD = [(1,1,"NE"), (-1,1,"NW"), (-1,-1,"SW"), (1,-1,"SE")]
roof_patches = []      # (cx, cy, sx, sy, z_soffit) for the solid build

def pavilion(tag, cx, cy, storeys):
    top = storeys * STOREY                     # canopy soffit at the low point
    common = {"Module": tag, "Storeys": storeys}

    # --- slabs, one per floor level (ground slab + each upper floor)
    for k in range(storeys):
        z = k * STOREY
        box_xy(cx, cy, BOX_A+SLAB_OS, BOX_A+SLAB_OS, z, SLAB_T, L_SLB,
               f"{tag}-SLB-L{k+1:02d}",
               {**common, "Category":"Slab", "IfcClass":"IfcSlab",
                "Material":"Reinforced concrete C40/50", "Level":f"L{k+1:02d}",
                "Thickness_mm":SLAB_T, "Span_mm":2*(BOX_A+SLAB_OS)})

    # --- columns: box corners + mid-points of each side (8 per pavilion)
    pos, n = [], 0
    for sx in (-1,0,1):
        for sy in (-1,0,1):
            if sx==0 and sy==0: continue
            pos.append((cx+sx*BOX_A, cy+sy*BOX_A))
    for (px,py) in pos:
        n += 1
        box_xy(px, py, COL/2, COL/2, 0.0, top, L_COL, f"{tag}-COL-{n:02d}",
               {**common, "Category":"Column", "IfcClass":"IfcColumn",
                "Material":"Steel, painted white", "Profile":f"{COL:.0f}x{COL:.0f}",
                "Height_mm":top, "GridRef":tag})

    # --- envelope: glazing + mullions on all four faces, per storey
    faces = [("N", 0, 1), ("S", 0, -1), ("E", 1, 0), ("W", -1, 0)]
    for (fname, ux, uy) in faces:
        horiz = (ux == 0)                    # face runs along X when normal is Y
        ax, ay = (1, 0) if horiz else (0, 1)
        def hwhd(along, across):
            return (along/2, across/2) if horiz else (across/2, along/2)
        fx, fy = cx + ux*BOX_A, cy + uy*BOX_A
        nbays = int(round(2*BOX_A / MUL_SPACING))
        for k in range(storeys):
            z0 = k*STOREY + SLAB_T
            zt = (k+1)*STOREY if k < storeys-1 else top
            h  = zt - z0
            for b in range(nbays):
                t = -BOX_A + b*MUL_SPACING + MUL_SPACING/2
                hw, hd = hwhd(MUL_SPACING, GLASS_T)
                box_xy(fx + ax*t, fy + ay*t, hw, hd, z0, h, L_GLZ,
                       f"{tag}-GL-{fname}-L{k+1:02d}-{b+1:02d}",
                       {**common, "Category":"Glazing", "IfcClass":"IfcPlate",
                        "Material":"IGU 8/16Ar/8 Low-E, low-iron",
                        "Facade":fname, "Level":f"L{k+1:02d}", "Bay":b+1,
                        "Thickness_mm":GLASS_T, "Width_mm":MUL_SPACING, "Height_mm":h,
                        "Area_m2":round(MUL_SPACING*h/1e6,2)})
            for b in range(nbays+1):
                t = -BOX_A + b*MUL_SPACING
                hw, hd = hwhd(MUL_W, MUL_D)
                box_xy(fx + ax*t, fy + ay*t, hw, hd, z0, h, L_MULV,
                       f"{tag}-MUL-{fname}-L{k+1:02d}-{b+1:02d}",
                       {**common, "Category":"Mullion", "SubType":"Vertical",
                        "IfcClass":"IfcMember", "Material":"Aluminium, anodised",
                        "Profile":f"{MUL_W:.0f}x{MUL_D:.0f}", "Facade":fname,
                        "Level":f"L{k+1:02d}", "Length_mm":h})
            hw, hd = hwhd(2*BOX_A, MUL_D)
            box_xy(fx, fy, hw, hd, zt - MUL_W, MUL_W, L_MULH,
                   f"{tag}-TRN-{fname}-L{k+1:02d}",
                   {**common, "Category":"Transom", "SubType":"Horizontal",
                    "IfcClass":"IfcMember", "Material":"Aluminium, anodised",
                    "Facade":fname, "Level":f"L{k+1:02d}", "Elevation_mm":zt})

    # --- canopy: four hypar quadrants, corners sweeping up
    for (sx, sy, qn) in QUAD:
        zc, ze = top, top + ROOF_RISE          # low point / lifted corner
        x0, y0 = cx, cy
        x1, y1 = cx + sx*ROOF_A, cy + sy*ROOF_A
        props = {**common, "Category":"Roof", "SubType":"Hypar canopy quadrant",
                 "IfcClass":"IfcRoof", "Material":"White GRC on steel frame",
                 "Quadrant":qn, "Span_mm":ROOF_A, "CornerRise_mm":ROOF_RISE,
                 "Thickness_mm":ROOF_T, "Geometry":"Hyperbolic paraboloid (ruled)"}
        # top surface: z = zc+T at centre & both edge-midpoints, zc+T+rise at corner
        add_surface((x0,y0,zc+ROOF_T), (x1,y0,zc+ROOF_T),
                    (x0,y1,zc+ROOF_T), (x1,y1,ze+ROOF_T),
                    L_RFT, f"{tag}-ROOF-{qn}-TOP", props)
        add_surface((x0,y0,zc), (x1,y0,zc), (x0,y1,zc), (x1,y1,ze),
                    L_RFS, f"{tag}-ROOF-{qn}-SOF", props)
        # fascia along the two outer edges of the quadrant
        add_surface((x1,y0,zc), (x1,y1,ze), (x1,y0,zc+ROOF_T), (x1,y1,ze+ROOF_T),
                    L_RFF, f"{tag}-ROOF-{qn}-FAS-A", props)
        add_surface((x0,y1,zc), (x1,y1,ze), (x0,y1,zc+ROOF_T), (x1,y1,ze+ROOF_T),
                    L_RFF, f"{tag}-ROOF-{qn}-FAS-B", props)
        roof_patches.append((x0,y0,x1,y1,zc,ze,f"{tag}-ROOF-{qn}"))

# ------------------------------------------------------------------ build
def main():
    xs, ys = [], []
    for (c, r, st) in MODULES:
        cx = c*GRID + (r % 2)*GRID/2          # stagger alternate rows
        cy = r*GRID
        pavilion(f"P-{chr(65+c)}{r+1}", cx, cy, st)
        xs += [cx-ROOF_A, cx+ROOF_A]; ys += [cy-ROOF_A, cy+ROOF_A]

    pad = 8.0*M
    x0, x1, y0, y1 = min(xs)-pad, max(xs)+pad, min(ys)-pad, max(ys)+pad
    box_xy((x0+x1)/2, (y0+y1)/2, (x1-x0)/2, (y1-y0)/2, -0.5*M, 0.5*M, L_TER,
           "SITE-TERRAIN",
           {"Category":"Site", "IfcClass":"IfcSite", "Material":"Landscape/paving",
            "Extent_X_m":round((x1-x0)/M,1), "Extent_Y_m":round((y1-y0)/M,1)})

    model.Write("../out/RMUH_v1.3dm", 7)

    hmax = max(st*STOREY for _,_,st in MODULES) + ROOF_RISE + ROOF_T
    print(f"objects            : {len(model.Objects)}")
    print(f"layers             : {len(model.Layers)}")
    print(f"pavilions          : {len(MODULES)}")
    print(f"site extent        : {(x1-x0)/M:.1f} x {(y1-y0)/M:.1f} m")
    print(f"canopy span        : {2*ROOF_A/M:.1f} m square, corner rise {ROOF_RISE/M:.1f} m")
    print(f"glass box          : {2*BOX_A/M:.1f} m square")
    print(f"cantilever         : {(ROOF_A-BOX_A)/M:.1f} m on every side")
    print(f"floor-to-floor     : {STOREY/M:.1f} m")
    print(f"tallest pavilion   : {hmax/M:.1f} m to canopy corner")

if __name__ == "__main__":
    main()
