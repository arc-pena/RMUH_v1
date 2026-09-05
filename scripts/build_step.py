"""STEP via XCAF - a named, coloured assembly tree rather than a flat solid dump."""
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorSurf
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_StepModelType
from OCP.Interface import Interface_Static
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.TopLoc import TopLoc_Location
import rmuh as R

COLOUR = {
    "Column":  (0.38,0.38,0.41), "Slab":    (0.61,0.59,0.55),
    "Glazing": (0.59,0.78,0.86), "Mullion": (0.23,0.23,0.25),
    "Transom": (0.31,0.31,0.33), "Roof":    (0.96,0.96,0.94),
    "Site":    (0.77,0.75,0.71),
}

def main():
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    root = st.NewShape()
    TDataStd_Name.Set_s(root, TCollection_ExtendedString("RMUH_v1"))
    cats, counts = {}, {}

    def cat_label(cat):
        if cat not in cats:
            l = st.NewShape()
            TDataStd_Name.Set_s(l, TCollection_ExtendedString(cat))
            st.AddComponent(root, l, TopLoc_Location())
            cats[cat] = l
        return cats[cat]

    def put(shape, name, cat):
        l = st.AddShape(shape, False)
        TDataStd_Name.Set_s(l, TCollection_ExtendedString(name))
        ct.SetColor(l, Quantity_Color(*COLOUR[cat], Quantity_TOC_RGB), XCAFDoc_ColorSurf)
        st.AddComponent(cat_label(cat), l, TopLoc_Location())
        counts[cat] = counts.get(cat, 0) + 1

    for tag, cx, cy, stq, z0 in R.pavilions():
        for e in R.elements(tag, cx, cy, stq):
            put(R.prism(e["loop"], e["height"]), e["name"], e["cat"])
        put(R.canopy_solid(cx, cy, z0), f"{tag}-CANOPY", "Roof")

    x0, x1, y0, y1 = R.site_bounds()
    put(R.prism(R.rect((x0+x1)/2, (y0+y1)/2, (x1-x0)/2, (y1-y0)/2, -0.5*R.M), 0.5*R.M),
        "SITE-TERRAIN", "Site")

    st.UpdateAssemblies()
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    Interface_Static.SetIVal_s("write.step.assembly", 1)
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    w = STEPCAFControl_Writer(); w.SetColorMode(True); w.SetNameMode(True)
    w.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
    ok = w.Write("../out/RMUH_v1.step") == IFSelect_ReturnStatus.IFSelect_RetDone
    print("STEP written:", ok)
    for k, v in sorted(counts.items()): print(f"   {k:<10} {v:>5}")

if __name__ == "__main__":
    main()
