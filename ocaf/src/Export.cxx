#include <ocafcad/Document.hxx>

#include <ocafcad/Feature.hxx>
#include <ocafcad/Schema.hxx>

#include <BRepAdaptor_Curve.hxx>
#include <algorithm>
#include <iomanip>
#include <map>
#include <TDF_Tool.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <Geom_Surface.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Writer.hxx>
#include <StlAPI_Writer.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <BRep_Builder.hxx>

namespace ocafcad {

namespace {

//! A deflection proportional to the model size keeps the triangle count sane
//! whether the part is 10 mm or 10 m across.
double AutoDeflection(const TopoDS_Shape& shape)
{
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) return 0.1;
  double xmin, ymin, zmin, xmax, ymax, zmax;
  box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
  const double diagonal = gp_Pnt(xmin, ymin, zmin).Distance(gp_Pnt(xmax, ymax, zmax));
  return (std::max)(1.0e-3, diagonal * 2.0e-3);
}

std::string EntryOf(const TDF_Label& label)
{
  if (label.IsNull()) return std::string();
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return entry.ToCString();
}

std::string ShapeKind(const TopoDS_Shape& shape)
{
  switch (shape.ShapeType())
  {
    case TopAbs_VERTEX: return "vertex";
    case TopAbs_EDGE:   return "edge";
    case TopAbs_WIRE:   return "wire";
    case TopAbs_FACE:   return "face";
    case TopAbs_SHELL:  return "shell";
    case TopAbs_SOLID:  return "solid";
    default:            return "compound";
  }
}

void AddFaces(const TopoDS_Shape& shape, Json& positions, Json& normals, Json& index)
{
  int base = (int)positions.items.size() / 3;

  for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next())
  {
    const TopoDS_Face          face = TopoDS::Face(exp.Current());
    TopLoc_Location            loc;
    Handle(Poly_Triangulation) mesh = BRep_Tool::Triangulation(face, loc);
    if (mesh.IsNull()) continue;

    const gp_Trsf              trsf     = loc.Transformation();
    const bool                 reversed = face.Orientation() == TopAbs_REVERSED;
    Handle(Geom_Surface)       surface  = BRep_Tool::Surface(face);
    const bool                 hasUV    = mesh->HasUVNodes() && !surface.IsNull();

    for (int i = 1; i <= mesh->NbNodes(); ++i)
    {
      gp_Pnt p = mesh->Node(i).Transformed(trsf);
      positions.Push(Json::Num(p.X()));
      positions.Push(Json::Num(p.Y()));
      positions.Push(Json::Num(p.Z()));

      gp_Dir n(0, 0, 1);
      if (hasUV)
      {
        const gp_Pnt2d uv = mesh->UVNode(i);
        gp_Pnt         at;
        gp_Vec         du, dv;
        surface->D1(uv.X(), uv.Y(), at, du, dv);
        const gp_Vec cross = du.Crossed(dv);
        if (cross.SquareMagnitude() > 1.0e-20) n = gp_Dir(cross);
      }
      n.Transform(trsf);
      if (reversed) n.Reverse();
      normals.Push(Json::Num(n.X()));
      normals.Push(Json::Num(n.Y()));
      normals.Push(Json::Num(n.Z()));
    }

    for (int t = 1; t <= mesh->NbTriangles(); ++t)
    {
      int a, b, c;
      mesh->Triangle(t).Get(a, b, c);
      if (reversed) std::swap(b, c);
      index.Push(Json::Num(base + a - 1));
      index.Push(Json::Num(base + b - 1));
      index.Push(Json::Num(base + c - 1));
    }
    base += mesh->NbNodes();
  }
}

void AddEdges(const TopoDS_Shape& shape, double deflection, Json& segments)
{
  for (TopExp_Explorer exp(shape, TopAbs_EDGE); exp.More(); exp.Next())
  {
    const TopoDS_Edge edge = TopoDS::Edge(exp.Current());
    BRepAdaptor_Curve curve(edge);
    try
    {
      GCPnts_QuasiUniformDeflection sampler(curve, deflection);
      if (!sampler.IsDone() || sampler.NbPoints() < 2) continue;
      for (int i = 1; i < sampler.NbPoints(); ++i)
      {
        const gp_Pnt a = sampler.Value(i);
        const gp_Pnt b = sampler.Value(i + 1);
        segments.Push(Json::Num(a.X())); segments.Push(Json::Num(a.Y())); segments.Push(Json::Num(a.Z()));
        segments.Push(Json::Num(b.X())); segments.Push(Json::Num(b.Y())); segments.Push(Json::Num(b.Z()));
      }
    }
    catch (const Standard_Failure&)
    {
      // A degenerate edge simply contributes nothing to the display.
    }
  }
}

} // namespace

Json TessellateShape(const TopoDS_Shape& shape, double deflection)
{
  Json out = Json::MakeObject();
  if (shape.IsNull()) return out;

  out.Set("shape", Json::Str(ShapeKind(shape)));

  const double d = deflection > 0.0 ? deflection : AutoDeflection(shape);
  out.Set("deflection", Json::Num(d));

  BRepMesh_IncrementalMesh mesher(shape, d, Standard_False, 0.3, Standard_True);
  (void)mesher;

  Json positions = Json::MakeArray();
  Json normals   = Json::MakeArray();
  Json index     = Json::MakeArray();
  AddFaces(shape, positions, normals, index);
  if (!index.items.empty())
  {
    out.Set("positions", positions);
    out.Set("normals", normals);
    out.Set("index", index);
    out.Set("triangles", Json::Num((double)(index.items.size() / 3)));
  }

  Json segments = Json::MakeArray();
  AddEdges(shape, d, segments);
  if (!segments.items.empty()) out.Set("edges", segments);

  if (shape.ShapeType() == TopAbs_VERTEX)
  {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(shape));
    Json         point = Json::MakeArray();
    point.Push(Json::Num(p.X()));
    point.Push(Json::Num(p.Y()));
    point.Push(Json::Num(p.Z()));
    out.Set("point", point);
  }
  return out;
}

Json FeatureMeshToJson(const TDF_Label& feature, double deflection)
{
  const TypeSpec* spec = Feature::Type(feature);
  Json            out  = spec ? TessellateShape(Feature::Shape(feature), deflection) : Json::MakeObject();

  out.Set("id", Json::Str(Feature::Id(feature)));
  out.Set("revision", Json::Num(Feature::Revision(feature)));
  out.Set("built", Json::Bln(!Feature::Shape(feature).IsNull()));
  if (spec) out.Set("type", Json::Str(spec->type));
  return out;
}

Json TreeToJson(const Document& doc)
{
  Json out = Json::MakeObject();
  out.Set("format", Json::Str("ocaf-tree"));
  out.Set("version", Json::Num(1));
  out.Set("name", Json::Str(doc.Title()));
  out.Set("units", Json::Str(doc.Units()));

  // Which features an operation has swallowed, so the tree can grey them out.
  std::map<std::string, std::string> consumedBy;
  for (const TDF_Label& f : doc.Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;
    for (const ArgSpec& arg : spec->args)
    {
      if (arg.kind != ArgKind::Ref || !arg.consumes) continue;
      const TDF_Label source = Feature::Reference(f, arg.key);
      if (!source.IsNull()) consumedBy[Feature::Id(source)] = Feature::Id(f);
    }
  }

  Json features = Json::MakeArray();
  for (const TDF_Label& f : doc.Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;

    Json entry = Json::MakeObject();
    entry.Set("id", Json::Str(Feature::Id(f)));
    entry.Set("name", Json::Str(Feature::Name(f)));
    entry.Set("type", Json::Str(spec->type));
    entry.Set("category", Json::Str(spec->category == Category::Datum  ? "datum"
                                    : spec->category == Category::Body ? "body"
                                                                       : "operation"));
    entry.Set("entry", Json::Str(EntryOf(f)));
    entry.Set("visible", Json::Bln(Feature::IsVisible(f)));
    entry.Set("revision", Json::Num(Feature::Revision(f)));
    entry.Set("built", Json::Bln(!Feature::Shape(f).IsNull()));

    const std::string message = Feature::Error(f);
    if (!message.empty()) entry.Set("error", Json::Str(message));

    const auto consumer = consumedBy.find(Feature::Id(f));
    if (consumer != consumedBy.end()) entry.Set("consumedBy", Json::Str(consumer->second));

    Json values = Json::MakeObject();
    Json refs   = Json::MakeObject();
    Json paths  = Json::MakeObject();
    for (const ArgSpec& arg : spec->args)
    {
      const TDF_Label argLabel = Feature::ArgLabel(f, arg.key);
      if (!argLabel.IsNull()) paths.Set(arg.key, Json::Str(EntryOf(argLabel)));
      if (arg.kind == ArgKind::Real)
      {
        values.Set(arg.key, Json::Num(Feature::Real(f, arg.key, arg.def)));
      }
      else
      {
        const TDF_Label source = Feature::Reference(f, arg.key);
        refs.Set(arg.key, source.IsNull() ? Json() : Json::Str(Feature::Id(source)));
      }
    }
    entry.Set("values", values);
    entry.Set("refs", refs);
    entry.Set("labels", paths);

    features.Push(entry);
  }
  out.Set("features", features);
  return out;
}

Json TessellateToJson(const Document& doc, double deflection)
{
  Json out = Json::MakeObject();
  out.Set("format", Json::Str("ocaf-tessellation"));
  out.Set("version", Json::Num(1));
  out.Set("units", Json::Str(doc.Units()));
  out.Set("name", Json::Str(doc.Title()));

  Json features = Json::MakeArray();
  for (const TDF_Label& f : doc.Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;
    Json entry = FeatureMeshToJson(f, deflection);
    entry.Set("name", Json::Str(Feature::Name(f)));
    entry.Set("visible", Json::Bln(Feature::IsVisible(f)));
    const std::string message = Feature::Error(f);
    if (!message.empty()) entry.Set("error", Json::Str(message));
    features.Push(entry);
  }
  out.Set("features", features);
  return out;
}

namespace {

//! Everything the 3D view would show, as one compound.
TopoDS_Shape VisibleSolids(const Document& doc, int& count)
{
  BRep_Builder    builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  count = 0;
  for (const TDF_Label& f : doc.Features())
  {
    if (!Feature::IsVisible(f)) continue;
    const TopoDS_Shape shape = Feature::Shape(f);
    if (shape.IsNull()) continue;
    // Datums (vertices, edges, the plane's face) are construction geometry and
    // never reach a solid exchange format.
    if (!TopExp_Explorer(shape, TopAbs_SOLID).More() &&
        !TopExp_Explorer(shape, TopAbs_SHELL).More())
      continue;
    builder.Add(compound, shape);
    ++count;
  }
  return compound;
}

} // namespace

bool WriteStep(const Document& doc, const std::string& path, std::string& error)
{
  int                count = 0;
  const TopoDS_Shape shape = VisibleSolids(doc, count);
  if (count == 0)
  {
    error = "the model has no visible solid to export";
    return false;
  }

  STEPControl_Writer writer;
  Interface_Static::SetCVal("write.step.unit", doc.Units() == "m" ? "M" : "MM");
  if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone)
  {
    error = "STEP transfer failed";
    return false;
  }
  if (writer.Write(path.c_str()) != IFSelect_RetDone)
  {
    error = "cannot write " + path;
    return false;
  }
  return true;
}

bool WriteStl(const Document& doc, const std::string& path, double deflection, std::string& error)
{
  int                count = 0;
  const TopoDS_Shape shape = VisibleSolids(doc, count);
  if (count == 0)
  {
    error = "the model has no visible solid to export";
    return false;
  }

  const double d = deflection > 0.0 ? deflection : AutoDeflection(shape);
  BRepMesh_IncrementalMesh mesher(shape, d, Standard_False, 0.3, Standard_True);
  (void)mesher;

  StlAPI_Writer writer;
  if (!writer.Write(shape, path.c_str()))
  {
    error = "cannot write " + path;
    return false;
  }
  return true;
}

Json RegenReportToJson(const RegenReport& report)
{
  auto list = [](const std::vector<RegenEntry>& entries) {
    Json array = Json::MakeArray();
    for (const RegenEntry& e : entries)
    {
      Json item = Json::MakeObject();
      item.Set("id", Json::Str(e.id));
      item.Set("name", Json::Str(e.name));
      item.Set("revision", Json::Num(e.revision));
      if (!e.message.empty()) item.Set("message", Json::Str(e.message));
      array.Push(item);
    }
    return array;
  };

  Json out = Json::MakeObject();
  out.Set("functions", Json::Num(report.functions));
  out.Set("executed", list(report.executed));
  out.Set("skipped", list(report.skipped));
  out.Set("failed", list(report.failed));
  return out;
}

bool WriteObj(const Document& doc, const std::string& path, double deflection, std::string& error)
{
  std::ofstream out(path, std::ios::binary);
  if (!out)
  {
    error = "cannot write " + path;
    return false;
  }

  out << "# " << doc.Title() << " - exported from ocafcad (OpenCascade OCAF)\n"
      << "# units: " << doc.Units() << "\n";

  int  vertexBase = 1; // OBJ indices are 1-based and run across the whole file
  int  written    = 0;
  for (const TDF_Label& f : doc.Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    // Datums are construction geometry: they orient the model, they are not
    // part of it, so they stay out of an exchange file.
    if (!spec || spec->category == Category::Datum) continue;
    if (!Feature::IsVisible(f)) continue;
    const TopoDS_Shape shape = Feature::Shape(f);
    if (shape.IsNull()) continue;
    if (!TopExp_Explorer(shape, TopAbs_FACE).More()) continue;

    const double d = deflection > 0.0 ? deflection : AutoDeflection(shape);
    BRepMesh_IncrementalMesh mesher(shape, d, Standard_False, 0.3, Standard_True);
    (void)mesher;

    Json positions = Json::MakeArray();
    Json normals   = Json::MakeArray();
    Json index     = Json::MakeArray();
    AddFaces(shape, positions, normals, index);
    if (index.items.empty()) continue;

    out << "\no " << Feature::Name(f) << "\n";

    out << std::fixed << std::setprecision(6);
    for (size_t i = 0; i + 2 < positions.items.size(); i += 3)
      out << "v " << positions.items[i].number << " " << positions.items[i + 1].number << " "
          << positions.items[i + 2].number << "\n";
    for (size_t i = 0; i + 2 < normals.items.size(); i += 3)
      out << "vn " << normals.items[i].number << " " << normals.items[i + 1].number << " "
          << normals.items[i + 2].number << "\n";

    for (size_t i = 0; i + 2 < index.items.size(); i += 3)
    {
      const int a = vertexBase + (int)index.items[i].number;
      const int b = vertexBase + (int)index.items[i + 1].number;
      const int c = vertexBase + (int)index.items[i + 2].number;
      out << "f " << a << "//" << a << " " << b << "//" << b << " " << c << "//" << c << "\n";
    }

    vertexBase += (int)(positions.items.size() / 3);
    ++written;
  }

  if (written == 0)
  {
    error = "the model has no visible surface to export";
    return false;
  }
  return true;
}

Json SchemaToJson()
{
  Json out = Json::MakeObject();
  out.Set("format", Json::Str("ocaf-feature-catalogue"));
  out.Set("version", Json::Num(1));

  Json types = Json::MakeArray();
  for (const TypeSpec& spec : Catalogue())
  {
    Json entry = Json::MakeObject();
    entry.Set("type", Json::Str(spec.type));
    entry.Set("guid", Json::Str(spec.guid));
    entry.Set("category", Json::Str(spec.category == Category::Datum       ? "datum"
                                    : spec.category == Category::Body      ? "body"
                                                                           : "operation"));
    entry.Set("summary", Json::Str(spec.summary));

    Json args = Json::MakeArray();
    int  tag  = FIRST_ARG_TAG;
    for (const ArgSpec& arg : spec.args)
    {
      Json a = Json::MakeObject();
      a.Set("key", Json::Str(arg.key));
      a.Set("label", Json::Str(arg.label));
      a.Set("tag", Json::Num(tag++));
      if (arg.kind == ArgKind::Real)
      {
        a.Set("kind", Json::Str("real"));
        a.Set("default", Json::Num(arg.def));
        a.Set("min", Json::Num(arg.min));
        a.Set("max", Json::Num(arg.max));
        a.Set("step", Json::Num(arg.step));
        a.Set("unit", Json::Str(arg.unit));
      }
      else
      {
        a.Set("kind", Json::Str("ref"));
        a.Set("accepts", Json::Str(arg.accepts));
        a.Set("consumes", Json::Bln(arg.consumes));
      }
      args.Push(a);
    }
    entry.Set("args", args);
    types.Push(entry);
  }
  out.Set("types", types);
  return out;
}

} // namespace ocafcad
