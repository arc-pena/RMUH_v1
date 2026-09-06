#include <ocafcad/Drivers.hxx>

#include <ocafcad/Feature.hxx>
#include <ocafcad/Schema.hxx>

#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRep_Builder.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Ax1.hxx>
#include <gp_Trsf.hxx>
#include <cmath>
#include <algorithm>
#include <vector>
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

//! The smallest extent of any single solid in a shape. A fillet radius has to
//! fit the body it rounds, not the bounding box of an array of them.
double SmallestSolidExtent(const TopoDS_Shape& shape)
{
  double smallest = RealLast();
  for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next())
  {
    Bnd_Box box;
    BRepBndLib::Add(exp.Current(), box);
    if (box.IsVoid()) continue;
    double xmin, ymin, zmin, xmax, ymax, zmax;
    box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    smallest = (std::min)(smallest,
      (std::min)(xmax - xmin, (std::min)(ymax - ymin, zmax - zmin)));
  }
  return smallest;
}

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

    // OpenCascade cannot be trusted to reject an over-sized radius: on an 80 mm
    // cube it accepts 39.9, rejects 40, then accepts 40.6 and 60 again. So the
    // radius is judged against the geometry before the kernel is asked.
    const double smallest = SmallestSolidExtent(body);
    if (smallest < RealLast() && radius >= smallest / 2.0)
    {
      TCollection_AsciiString limit(smallest / 2.0);
      TCollection_AsciiString across(smallest);
      error = TCollection_AsciiString("radius does not fit: the body is only ") + across
            + " mm across, so the limit is " + limit + " mm";
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

//! Beyond this the kernel is asked to mesh more than a viewer can carry.
constexpr int INSTANCE_LIMIT = 1000;

class ArrayDriver : public FeatureDriver
{
protected:
  //! Every placement of the arrayed feature. The first is the identity, so the
  //! source stays exactly where it was drawn.
  static std::vector<gp_Trsf> Placements(const TDF_Label& f)
  {
    std::vector<gp_Trsf> placements;

    if (Feature::Choice(f, "mode") == 0)
    {
      const int nx = (std::max)(1, (int)std::lround(Feature::Real(f, "countX", 3)));
      const int ny = (std::max)(1, (int)std::lround(Feature::Real(f, "countY", 1)));
      const int nz = (std::max)(1, (int)std::lround(Feature::Real(f, "countZ", 1)));
      const double sx = Feature::Real(f, "spacingX", 120);
      const double sy = Feature::Real(f, "spacingY", 120);
      const double sz = Feature::Real(f, "spacingZ", 120);

      for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j)
          for (int k = 0; k < nz; ++k)
          {
            gp_Trsf trsf;
            if (i || j || k) trsf.SetTranslation(gp_Vec(i * sx, j * sy, k * sz));
            placements.push_back(trsf);
          }
      return placements;
    }

    const int    count = (std::max)(1, (int)std::lround(Feature::Real(f, "count", 6)));
    const double sweep = Feature::Real(f, "angle", 360);

    gp_Pnt centre(0, 0, 0);
    Feature::PointOf(Feature::Reference(f, "center"), centre);
    gp_Dir direction(0, 0, 1);
    Feature::DirOf(Feature::Reference(f, "axis"), direction);
    const gp_Ax1 axis(centre, direction);

    // A full turn closes on itself, so the last copy would land on the first.
    const bool   closed = std::abs(std::abs(sweep) - 360.0) < 1e-6;
    const double stride = count < 2 ? 0.0 : (closed ? sweep / count : sweep / (count - 1));
    for (int i = 0; i < count; ++i)
    {
      gp_Trsf trsf;
      if (i) trsf.SetRotation(axis, stride * i * M_PI / 180.0);
      placements.push_back(trsf);
    }
    return placements;
  }

  Standard_Integer Build(const TDF_Label& f, TopoDS_Shape& shape, TCollection_AsciiString& error) const override
  {
    const TDF_Label    sourceFeature = Feature::Reference(f, "source");
    const TopoDS_Shape source        = Feature::Shape(sourceFeature);
    if (source.IsNull())
    {
      error = "the feature to array has not been built";
      return 2;
    }

    const std::vector<gp_Trsf> placements = Placements(f);
    if ((int)placements.size() > INSTANCE_LIMIT)
    {
      error = TCollection_AsciiString((int)placements.size())
            + " copies is more than this kernel will build at once (limit "
            + TCollection_AsciiString(INSTANCE_LIMIT) + ")";
      return 2;
    }

    BRep_Builder    builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);

    // An instance is the same shape at a different location, not a copy of it:
    // TopoDS_Shape::Moved swaps the TopLoc_Location and leaves the underlying
    // TShape shared, so the B-Rep is built once and triangulated once however
    // many instances there are.
    for (const gp_Trsf& trsf : placements)
      builder.Add(compound, source.Moved(TopLoc_Location(trsf)));

    shape = compound;
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
  if (type == "Array")  return new ArrayDriver();
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
