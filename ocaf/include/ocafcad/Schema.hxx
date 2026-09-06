// The feature catalogue: every feature type, its driver GUID and its parameters.
//
// One table drives everything - the OCAF driver registration, the label layout
// (an argument's tag is its index in this table), the JSON reader/writer and the
// slider ranges published to the user interface.  Adding a feature type means
// adding a row here plus a driver in Drivers.cxx.
#ifndef ocafcad_Schema_HeaderFile
#define ocafcad_Schema_HeaderFile

#include <Standard_GUID.hxx>

#include <string>
#include <vector>

namespace ocafcad {

//! Argument tags start at 1 and follow the order of ArgSpec in TypeSpec.
inline constexpr int FIRST_ARG_TAG = 1;
//! The TNaming_NamedShape of a feature lives on this child label.
inline constexpr int RESULT_TAG = 100;

enum class ArgKind
{
  Real,  //!< a TDataStd_Real - the thing a slider drives
  Ref,   //!< a TDF_Reference to another feature label
  Choice //!< a TDataStd_Integer indexing a fixed set of alternatives
};

//! What a feature contributes to the model, which decides how the tree draws it
//! and whether consuming it hides it from the 3D view.
enum class Category
{
  Datum,     //!< point, vector, line, plane - construction geometry
  Body,      //!< a solid
  Operation  //!< consumes a body and replaces it (fillet)
};

struct ArgSpec
{
  std::string key;      //!< JSON key and TDataStd_Name of the argument label
  std::string label;    //!< human readable, shown next to the slider
  ArgKind     kind = ArgKind::Real;
  double      def  = 0.0;
  double      min  = 0.0;   //!< slider bounds (Real only)
  double      max  = 0.0;
  double      step = 0.0;
  std::string unit;         //!< "mm", "" for pure numbers
  std::string accepts;      //!< Ref only: comma separated feature types
  bool        consumes = false; //!< Ref only: taking this argument hides the source body

  std::vector<std::string> options; //!< Choice only, in index order

  //! Set when this argument belongs to one alternative of a Choice: it is shown,
  //! and read, only while that choice holds. It is how one feature carries two
  //! patterns without becoming two features.
  std::string whenKey;
  int         whenEquals = 0;
  bool        HasCondition() const { return !whenKey.empty(); }
};

struct TypeSpec
{
  std::string          type;   //!< "Cube", "Fillet", ...
  std::string          guid;   //!< driver GUID, stored in TFunction_Function
  Category             category = Category::Datum;
  std::string          summary;
  std::vector<ArgSpec> args;

  const ArgSpec* Arg(const std::string& key) const;
  int            ArgTag(const std::string& key) const; //!< -1 when unknown
  Standard_GUID  Guid() const { return Standard_GUID(guid.c_str()); }
};

//! The catalogue, in the order features are offered in the toolbar.
const std::vector<TypeSpec>& Catalogue();

const TypeSpec* FindType(const std::string& type);
const TypeSpec* FindTypeByGuid(const Standard_GUID& guid);

} // namespace ocafcad

#endif
