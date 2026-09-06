#include <ocafcad/Drivers.hxx>

#include <ocafcad/Feature.hxx>
#include <ocafcad/Schema.hxx>

#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <Precision.hxx>
#include <Standard_ErrorHandler.hxx>
#include <Standard_Failure.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_LabelList.hxx>
#include <TDF_Reference.hxx>
#include <TFunction_DriverTable.hxx>
#include <TFunction_Function.hxx>
#include <TFunction_Logbook.hxx>
#include <TNaming_Builder.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Edge.hxx>
#include <gp_Pln.hxx>

IMPLEMENT_STANDARD_RTTIEXT(ocafcad::FeatureDriver, TFunction_Driver)

namespace ocafcad {

// ------------------------------------------------------------- graph wiring

void FeatureDriver::Arguments(TDF_LabelList& args) const
{
  const TDF_Label feature = Label();
  for (TDF_ChildIterator it(feature); it.More(); it.Next())
  {
    const TDF_Label child = it.Value();
    if (child.Tag() == RESULT_TAG || child.Tag() == Feature::ERROR_TAG
        || child.Tag() == Feature::REVISION_TAG)
      continue;

    Handle(TDF_Reference) ref;
    if (child.FindAttribute(TDF_Reference::GetID(), ref))
    {
      const TDF_Label source = Feature::ResultLabel(ref->Get(), /*create*/ true);
      if (!source.IsNull()) args.Append(source);
      // The reference attribute itself matters too: re-pointing an argument at
      // another feature must re-run this one.
      args.Append(child);
    }
    else
    {
      args.Append(child);
    }
  }
}

void FeatureDriver::Results(TDF_LabelList& res) const
{
  const TDF_Label result = Feature::ResultLabel(Label(), /*create*/ true);
  if (!result.IsNull()) res.Append(result);
}

Standard_Boolean FeatureDriver::MustExecute(const Handle(TFunction_Logbook)& log) const
{
  if (log->IsModified(Label())) return Standard_True;
  return TFunction_Driver::MustExecute(log);
}

Standard_Integer FeatureDriver::Execute(Handle(TFunction_Logbook)& log) const
{
  const TDF_Label feature = Label();

  Handle(TFunction_Function) function;
  feature.FindAttribute(TFunction_Function::GetID(), function);

  TopoDS_Shape            shape;
  TCollection_AsciiString error;
  Standard_Integer        status = 0;

  try
  {
    OCC_CATCH_SIGNALS
    status = Build(feature, shape, error);
  }
  catch (const Standard_Failure& failure)
  {
    status = 1;
    error  = TCollection_AsciiString("kernel error: ") + failure.GetMessageString();
  }

  if (status == 0 && shape.IsNull())
  {
    status = 1;
    if (error.IsEmpty()) error = "the driver produced no shape";
  }

  if (status != 0)
  {
    Feature::SetError(feature, error.ToCString());
    if (!function.IsNull()) function->SetFailure(status);
    return status;
  }

  const TDF_Label result = Feature::ResultLabel(feature, /*create*/ true);
  TNaming_Builder builder(result);
  builder.Generated(shape);

  Feature::SetError(feature, std::string());
  Feature::BumpRevision(feature);
  if (!function.IsNull()) function->SetFailure(0);

  log->SetImpacted(result);
  log->SetImpacted(feature);
  return 0;
}

// ------------------------------------------------------------------ drivers

namespace {

class PointDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString&) const override
  {
    const gp_Pnt p(Feature::Real(f, "x"), Feature::Real(f, "y"), Feature::Real(f, "z"));
    shape = BRepBuilderAPI_MakeVertex(p).Vertex();
    return 0;
  }
};

class VectorDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    const gp_Vec v(Feature::Real(f, "dx"), Feature::Real(f, "dy"), Feature::Real(f, "dz"));
    if (v.Magnitude() < Precision::Confusion())
    {
      error = "a vector needs a non-zero direction";
      return 2;
    }
    // A vector is data. Its shape exists only to be seen, so it is drawn at a
    // readable length along the direction rather than at the raw magnitude -
    // the magnitude stays in dx/dy/dz, where the parameters are read from.
    const gp_Dir d(v);
    shape = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0),
                                    gp_Pnt(0, 0, 0).Translated(gp_Vec(d) * 100.0)).Edge();
    return 0;
  }
};

class LineDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    gp_Pnt origin(0, 0, 0);
    if (!Feature::PointOf(Feature::Reference(f, "origin"), origin))
    {
      error = "start point is missing";
      return 2;
    }
    gp_Dir dir(0, 0, 1);
    if (!Feature::DirOf(Feature::Reference(f, "direction"), dir))
    {
      error = "direction vector is missing or null";
      return 2;
    }
    const double length = Feature::Real(f, "length", 100.0);
    if (length <= Precision::Confusion())
    {
      error = "length must be positive";
      return 2;
    }
    shape = BRepBuilderAPI_MakeEdge(origin, origin.Translated(gp_Vec(dir) * length)).Edge();
    return 0;
  }
};

class PlaneDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    gp_Ax2 ax2;
    if (!Feature::PlaneOf(f, ax2))
    {
      error = "origin point or normal vector is missing";
      return 2;
    }
    const double half = 0.5 * Feature::Real(f, "size", 160.0);
    if (half <= Precision::Confusion())
    {
      error = "display size must be positive";
      return 2;
    }
    shape = BRepBuilderAPI_MakeFace(gp_Pln(ax2), -half, half, -half, half).Face();
    return 0;
  }
};

class CubeDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    gp_Pnt corner(0, 0, 0);
    if (!Feature::PointOf(Feature::Reference(f, "origin"), corner))
    {
      error = "corner point is missing";
      return 2;
    }

    // The plane supplies the orientation only; the point supplies the position.
    gp_Ax2 placement(corner, gp_Dir(0, 0, 1));
    gp_Ax2 planeAxis;
    if (Feature::PlaneOf(Feature::Reference(f, "plane"), planeAxis))
      placement = gp_Ax2(corner, planeAxis.Direction(), planeAxis.XDirection());

    const double dx = Feature::Real(f, "dx", 80.0);
    const double dy = Feature::Real(f, "dy", 80.0);
    const double dz = Feature::Real(f, "dz", 80.0);
    if (dx <= Precision::Confusion() || dy <= Precision::Confusion() || dz <= Precision::Confusion())
    {
      error = "every side length must be positive";
      return 2;
    }

    shape = BRepPrimAPI_MakeBox(placement, dx, dy, dz).Shape();
    return 0;
  }
};

class SphereDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    gp_Pnt centre(0, 0, 0);
    if (!Feature::PointOf(Feature::Reference(f, "center"), centre))
    {
      error = "centre point is missing";
      return 2;
    }
    const double radius = Feature::Real(f, "radius", 50.0);
    if (radius <= Precision::Confusion())
    {
      error = "radius must be positive";
      return 2;
    }
    shape = BRepPrimAPI_MakeSphere(gp_Ax2(centre, gp_Dir(0, 0, 1)), radius).Shape();
    return 0;
  }
};

class FilletDriver : public FeatureDriver
{
protected:
  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    const TDF_Label    bodyFeature = Feature::Reference(f, "body");
    const TopoDS_Shape body        = Feature::Shape(bodyFeature);
    if (body.IsNull())
    {
      error = "the body to fillet has not been built";
      return 2;
    }

    const double radius = Feature::Real(f, "radius", 10.0);
    if (radius <= Precision::Confusion())
    {
      error = "radius must be positive";
      return 2;
    }

    BRepFilletAPI_MakeFillet fillet(body);
    Standard_Integer         edges = 0;
    for (TopExp_Explorer exp(body, TopAbs_EDGE); exp.More(); exp.Next())
    {
      fillet.Add(radius, TopoDS::Edge(exp.Current()));
      ++edges;
    }
    if (edges == 0)
    {
      error = "the body has no edges to round";
      return 2;
    }

    fillet.Build();
    if (!fillet.IsDone())
    {
      error = "the fillet failed - the radius is too large for this body";
      return 3;
    }

    // ChFi3d hands back a compound wrapping the single result solid; unwrap it
    // so downstream features and the STEP writer see a solid.
    shape = fillet.Shape();
    if (shape.ShapeType() == TopAbs_COMPOUND)
    {
      TopoDS_Iterator inner(shape);
      if (inner.More())
      {
        const TopoDS_Shape only = inner.Value();
        inner.Next();
        if (!inner.More()) shape = only;
      }
    }
    return 0;
  }
};

Handle(FeatureDriver) MakeDriver(const std::string& type)
{
  if (type == "Point")  return new PointDriver();
  if (type == "Vector") return new VectorDriver();
  if (type == "Line")   return new LineDriver();
  if (type == "Plane")  return new PlaneDriver();
  if (type == "Cube")   return new CubeDriver();
  if (type == "Sphere") return new SphereDriver();
  if (type == "Fillet") return new FilletDriver();
  return Handle(FeatureDriver)();
}

} // namespace

void RegisterDrivers()
{
  Handle(TFunction_DriverTable) table = TFunction_DriverTable::Get();
  for (const TypeSpec& spec : Catalogue())
  {
    const Standard_GUID guid = spec.Guid();
    if (table->HasDriver(guid)) continue;
    Handle(FeatureDriver) driver = MakeDriver(spec.type);
    if (!driver.IsNull()) table->AddDriver(guid, driver);
  }
}

} // namespace ocafcad
