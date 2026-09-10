#include <ocafcad/Feature.hxx>

#include <Precision.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Reference.hxx>
#include <TDataStd_AsciiString.hxx>
#include <TDataStd_Integer.hxx>
#include <TDataStd_Name.hxx>
#include <TDataStd_Real.hxx>
#include <TFunction_Function.hxx>
#include <TNaming_NamedShape.hxx>
#include <TNaming_Tool.hxx>

namespace ocafcad {
namespace Feature {

const TypeSpec* Type(const TDF_Label& feature)
{
  if (feature.IsNull()) return nullptr;
  Handle(TFunction_Function) fn;
  if (!feature.FindAttribute(TFunction_Function::GetID(), fn)) return nullptr;
  return FindTypeByGuid(fn->GetDriverGUID());
}

std::string Name(const TDF_Label& feature)
{
  Handle(TDataStd_Name) name;
  if (!feature.IsNull() && feature.FindAttribute(TDataStd_Name::GetID(), name))
    return TCollection_AsciiString(name->Get()).ToCString();
  return std::string();
}

std::string Id(const TDF_Label& feature)
{
  Handle(TDataStd_AsciiString) id;
  if (!feature.IsNull() && feature.FindAttribute(TDataStd_AsciiString::GetID(), id))
    return id->Get().ToCString();
  return std::string();
}

bool IsVisible(const TDF_Label& feature)
{
  Handle(TDataStd_Integer) flag;
  if (!feature.IsNull() && feature.FindAttribute(TDataStd_Integer::GetID(), flag))
    return flag->Get() != 0;
  return true;
}

void SetVisible(const TDF_Label& feature, bool visible)
{
  TDataStd_Integer::Set(feature, visible ? 1 : 0);
}

TDF_Label ArgLabel(const TDF_Label& feature, const std::string& key, bool create)
{
  const TypeSpec* spec = Type(feature);
  if (!spec) return TDF_Label();
  const int tag = spec->ArgTag(key);
  if (tag < 0) return TDF_Label();
  TDF_Label arg = feature.FindChild(tag, create ? Standard_True : Standard_False);
  if (create && !arg.IsNull())
    TDataStd_Name::Set(arg, TCollection_ExtendedString(key.c_str()));
  return arg;
}

double Real(const TDF_Label& feature, const std::string& key, double fallback)
{
  TDF_Label arg = ArgLabel(feature, key);
  Handle(TDataStd_Real) value;
  if (!arg.IsNull() && arg.FindAttribute(TDataStd_Real::GetID(), value)) return value->Get();
  return fallback;
}

void SetReal(const TDF_Label& feature, const std::string& key, double value)
{
  TDF_Label arg = ArgLabel(feature, key, /*create*/ true);
  if (!arg.IsNull()) TDataStd_Real::Set(arg, value);
}

int Choice(const TDF_Label& feature, const std::string& key, int fallback)
{
  TDF_Label                arg = ArgLabel(feature, key);
  Handle(TDataStd_Integer) value;
  if (!arg.IsNull() && arg.FindAttribute(TDataStd_Integer::GetID(), value)) return value->Get();
  return fallback;
}

void SetChoice(const TDF_Label& feature, const std::string& key, int index)
{
  TDF_Label arg = ArgLabel(feature, key, /*create*/ true);
  if (!arg.IsNull()) TDataStd_Integer::Set(arg, index);
}

bool Applies(const TDF_Label& feature, const ArgSpec& arg)
{
  if (!arg.HasCondition()) return true;
  return Choice(feature, arg.whenKey, 0) == arg.whenEquals;
}

TDF_Label Reference(const TDF_Label& feature, const std::string& key)
{
  TDF_Label arg = ArgLabel(feature, key);
  Handle(TDF_Reference) ref;
  if (!arg.IsNull() && arg.FindAttribute(TDF_Reference::GetID(), ref)) return ref->Get();
  return TDF_Label();
}

void SetReference(const TDF_Label& feature, const std::string& key, const TDF_Label& target)
{
  TDF_Label arg = ArgLabel(feature, key, /*create*/ true);
  if (!arg.IsNull() && !target.IsNull()) TDF_Reference::Set(arg, target);
}

TDF_Label ResultLabel(const TDF_Label& feature, bool create)
{
  if (feature.IsNull()) return TDF_Label();
  return feature.FindChild(RESULT_TAG, create ? Standard_True : Standard_False);
}

TopoDS_Shape Shape(const TDF_Label& feature)
{
  TDF_Label result = ResultLabel(feature);
  Handle(TNaming_NamedShape) ns;
  if (!result.IsNull() && result.FindAttribute(TNaming_NamedShape::GetID(), ns))
    return TNaming_Tool::GetShape(ns);
  return TopoDS_Shape();
}

std::string Error(const TDF_Label& feature)
{
  if (feature.IsNull()) return std::string();
  TDF_Label errorLabel = feature.FindChild(ERROR_TAG, Standard_False);
  Handle(TDataStd_AsciiString) message;
  if (!errorLabel.IsNull() && errorLabel.FindAttribute(TDataStd_AsciiString::GetID(), message))
    return message->Get().ToCString();
  return std::string();
}

void SetError(const TDF_Label& feature, const std::string& message)
{
  TDF_Label errorLabel = feature.FindChild(ERROR_TAG, Standard_True);
  if (message.empty())
    errorLabel.ForgetAttribute(TDataStd_AsciiString::GetID());
  else
    TDataStd_AsciiString::Set(errorLabel, TCollection_AsciiString(message.c_str()));
}

int Revision(const TDF_Label& feature)
{
  if (feature.IsNull()) return 0;
  TDF_Label            label = feature.FindChild(REVISION_TAG, Standard_False);
  Handle(TDataStd_Integer) value;
  if (!label.IsNull() && label.FindAttribute(TDataStd_Integer::GetID(), value)) return value->Get();
  return 0;
}

void BumpRevision(const TDF_Label& feature)
{
  TDataStd_Integer::Set(feature.FindChild(REVISION_TAG, Standard_True), Revision(feature) + 1);
}

bool PointOf(const TDF_Label& pointFeature, gp_Pnt& result)
{
  const TypeSpec* spec = Type(pointFeature);
  if (!spec || spec->type != "Point") return false;
  result = gp_Pnt(Real(pointFeature, "x"), Real(pointFeature, "y"), Real(pointFeature, "z"));
  return true;
}

bool DirOf(const TDF_Label& vectorFeature, gp_Dir& result, double* magnitude)
{
  const TypeSpec* spec = Type(vectorFeature);
  if (!spec || spec->type != "Vector") return false;
  const gp_Vec v(Real(vectorFeature, "dx"), Real(vectorFeature, "dy"), Real(vectorFeature, "dz"));
  if (v.Magnitude() < Precision::Confusion()) return false;
  if (magnitude) *magnitude = v.Magnitude();
  result = gp_Dir(v);
  return true;
}

bool PlaneOf(const TDF_Label& planeFeature, gp_Ax2& result)
{
  const TypeSpec* spec = Type(planeFeature);
  if (!spec || spec->type != "Plane") return false;

  gp_Pnt origin(0, 0, 0);
  PointOf(Reference(planeFeature, "origin"), origin);

  gp_Dir normal(0, 0, 1);
  DirOf(Reference(planeFeature, "normal"), normal);

  result = gp_Ax2(origin, normal);
  return true;
}

} // namespace Feature
} // namespace ocafcad
