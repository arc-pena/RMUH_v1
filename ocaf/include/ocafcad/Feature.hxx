// Reading and writing a feature label.
//
// Label layout, rooted at the features container (0:1:1):
//
//   0:1:1:n                      one feature
//     TDataStd_Name              display name, e.g. "Cube.1"
//     TDataStd_AsciiString       stable id used by the JSON file, e.g. "C1"
//     TDataStd_Integer           1 when the feature is shown in 3D
//     TFunction_Function         the driver GUID - this is what makes it a feature
//     0:1:1:n:1 .. :k            one label per argument, in catalogue order
//        TDataStd_Name           argument key
//        TDataStd_Real           value           (ArgKind::Real)
//        TDF_Reference           source feature  (ArgKind::Ref)
//     0:1:1:n:100                TNaming_NamedShape - the computed result
//     0:1:1:n:101                TDataStd_AsciiString - last error, if any
#ifndef ocafcad_Feature_HeaderFile
#define ocafcad_Feature_HeaderFile

#include <ocafcad/Schema.hxx>

#include <TDF_Label.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <string>

namespace ocafcad {
namespace Feature {

inline constexpr int ERROR_TAG = 101;

const TypeSpec* Type(const TDF_Label& feature);

std::string Name(const TDF_Label& feature);
std::string Id(const TDF_Label& feature);
bool        IsVisible(const TDF_Label& feature);
void        SetVisible(const TDF_Label& feature, bool visible);

//! The argument label for \p key; a null label when the key is unknown.
TDF_Label ArgLabel(const TDF_Label& feature, const std::string& key, bool create = false);

double    Real(const TDF_Label& feature, const std::string& key, double fallback = 0.0);
void      SetReal(const TDF_Label& feature, const std::string& key, double value);
TDF_Label Reference(const TDF_Label& feature, const std::string& key);
void      SetReference(const TDF_Label& feature, const std::string& key, const TDF_Label& target);

TDF_Label    ResultLabel(const TDF_Label& feature, bool create = false);
TopoDS_Shape Shape(const TDF_Label& feature);

std::string Error(const TDF_Label& feature);
void        SetError(const TDF_Label& feature, const std::string& message);

//! Datum readers. They fall back to sensible defaults so a driver can report a
//! useful message instead of throwing on a half-built model.
bool PointOf(const TDF_Label& pointFeature, gp_Pnt& result);
bool DirOf(const TDF_Label& vectorFeature, gp_Dir& result, double* magnitude = nullptr);
bool PlaneOf(const TDF_Label& planeFeature, gp_Ax2& result);

} // namespace Feature
} // namespace ocafcad

#endif
