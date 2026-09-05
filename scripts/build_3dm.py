"""Structured Rhino .3dm.

Prismatic elements are true Extrusion objects.  The canopy is a doubly-curved
NURBS surface that rhino3dm cannot author directly (its control points are
read-only), so it is emitted as ruled strips between exact NURBS isocurves
sampled off the OpenCascade surface - each strip a real NURBS surface, and the
set joins in Rhino into a smooth polysurface.
"""
import rhino3dm as r3
import rmuh as R

model = r3.File3dm()
model.ApplicationName = "RMUH_v1"
model.Settings.ModelUnitSystem = r3.UnitSystem.Millimeters

def layer(name, rgb, parent=None):
    L = r3.Layer(); L.Name = name; L.Color = (*rgb, 255)
    if parent is not None: L.ParentLayerId = model.Layers[parent].Id
    return model.Layers.Add(L)

_site = layer("00_SITE", (196,192,180))
_str  = layer("01_STRUCTURE", (128,128,138))
_env  = layer("02_ENVELOPE", (70,130,180))
_mul  = layer("Mullions", (58,58,64), _env)
_rf   = layer("03_ROOF", (245,245,242))
LAY = {
    "Terrain":            layer("Terrain", (205,201,188), _site),
    "Columns":            layer("Columns", (96,96,104), _str),
    "Slabs":              layer("Slabs", (156,151,141), _str),
    "Mullions_Vertical":  layer("Vertical", (58,58,64), _mul),
    "Mullions_Transoms":  layer("Transoms", (78,78,84), _mul),
    "Glazing":            layer("Glazing", (150,200,220), _env),
    "Canopy_Top":         layer("Canopy_Top", (250,250,248), _rf),
    "Canopy_Soffit":      layer("Canopy_Soffit", (226,226,222), _rf),
    "Canopy_Fascia":      layer("Canopy_Fascia", (236,236,232), _rf),
}

def attrs(li, name, props):
    a = r3.ObjectAttributes(); a.LayerIndex = li; a.Name = name
    for k, v in props.items(): a.SetUserString(k, str(v))
    return a

def add_extrusion(loop, height, li, name, props):
    pl = r3.Polyline()
    for p in loop: pl.Add(*p)
    model.Objects.AddExtrusion(r3.Extrusion.Create(pl.ToNurbsCurve(), height, True),
                               attrs(li, name, props))

def add_strip(ptsA, ptsB, li, name, props):
    mk = lambda pts: r3.NurbsCurve.Create(False, 3, [r3.Point3d(*p) for p in pts])
    model.Objects.AddSurface(r3.NurbsSurface.CreateRuledSurface(mk(ptsA), mk(ptsB)),
                             attrs(li, name, props))

def grid_of(surf, nu, nv):
    out = []
    for i in range(nu+1):
        u = i/nu
        out.append([(lambda p: (p.X(), p.Y(), p.Z()))(surf.Value(u, j/nv)) for j in range(nv+1)])
    return out

def main():
    for tag, cx, cy, st, z0 in R.pavilions():
        for e in R.elements(tag, cx, cy, st):
            add_extrusion(e["loop"], e["height"], LAY[e["layer"]], e["name"], e["props"])

        sol  = R.canopy_solid(cx, cy, z0)
        tsrf, _ = R.canopy_top_surface(sol)
        ssrf = R.canopy_surface(cx, cy, z0)
        top  = grid_of(tsrf, R.CV-1, R.STRIPS)
        sof  = grid_of(ssrf, R.CV-1, R.STRIPS)
        props = {"Module":tag, "Category":"Roof", "IfcClass":"IfcRoof",
                 "Material":"White GRC on steel frame",
                 "Geometry":"Bicubic NURBS, true normal offset",
                 "Span_mm":2*R.ROOF_A, "CornerRise_mm":R.ROOF_RISE,
                 "Thickness_mm":R.ROOF_T, "Storeys":st}
        for j in range(R.STRIPS):
            A = [row[j] for row in top]; B = [row[j+1] for row in top]
            add_strip(A, B, LAY["Canopy_Top"], f"{tag}-CANOPY-TOP-{j+1:02d}", props)
            A = [row[j] for row in sof]; B = [row[j+1] for row in sof]
            add_strip(A, B, LAY["Canopy_Soffit"], f"{tag}-CANOPY-SOF-{j+1:02d}", props)
        for lbl, sl in (("W", lambda g: g[0]), ("E", lambda g: g[-1])):
            add_strip(sl(sof), sl(top), LAY["Canopy_Fascia"], f"{tag}-CANOPY-FAS-{lbl}", props)
        for lbl, k in (("S", 0), ("N", -1)):
            add_strip([r[k] for r in sof], [r[k] for r in top],
                      LAY["Canopy_Fascia"], f"{tag}-CANOPY-FAS-{lbl}", props)

    x0, x1, y0, y1 = R.site_bounds()
    add_extrusion(R.rect((x0+x1)/2, (y0+y1)/2, (x1-x0)/2, (y1-y0)/2, -0.5*R.M), 0.5*R.M,
                  LAY["Terrain"], "SITE-TERRAIN",
                  {"Category":"Site", "IfcClass":"IfcSite", "Material":"Landscape/paving",
                   "Extent_X_m":round((x1-x0)/R.M,1), "Extent_Y_m":round((y1-y0)/R.M,1)})

    model.Write("../out/RMUH_v1.3dm", 7)
    print(f".3dm: {len(model.Objects)} objects on {len(model.Layers)} layers")

if __name__ == "__main__":
    main()
