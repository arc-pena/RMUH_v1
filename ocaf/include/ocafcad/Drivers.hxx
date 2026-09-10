// TFunction drivers - the executable half of the parametric model.
//
// A driver is registered once per session against the GUID carried by the
// feature's TFunction_Function attribute.  TFunction_Iterator walks the
// dependency graph built from Arguments()/Results() and asks each driver, in
// topological order, whether the logbook says it must run.
#ifndef ocafcad_Drivers_HeaderFile
#define ocafcad_Drivers_HeaderFile

#include <TFunction_Driver.hxx>

#include <TCollection_AsciiString.hxx>
#include <TopoDS_Shape.hxx>

namespace ocafcad {

//! Shared behaviour: where the arguments live, where the result goes, and how a
//! build failure is recorded.  Subclasses only implement Build().
class FeatureDriver : public TFunction_Driver
{
public:
  //! Every argument label of the feature. For a reference argument the graph
  //! must depend on the *result* of the referenced feature, not on the
  //! reference attribute itself, so that editing a cube re-runs its fillet.
  Standard_EXPORT void Arguments(TDF_LabelList& args) const Standard_OVERRIDE;

  Standard_EXPORT void Results(TDF_LabelList& res) const Standard_OVERRIDE;

  //! True when the user touched this feature itself, or when the logbook shows
  //! one of its arguments changed or one of its inputs was rebuilt. The base
  //! class only inspects the arguments, so the first case is added here.
  Standard_EXPORT Standard_Boolean MustExecute(const Handle(TFunction_Logbook)& log) const Standard_OVERRIDE;

  //! Builds the shape and stores it as a TNaming_NamedShape on the result
  //! label. A failing build keeps the last valid shape and records the message,
  //! which is what a history-based modeller does with an over-sized fillet.
  Standard_EXPORT Standard_Integer Execute(Handle(TFunction_Logbook)& log) const Standard_OVERRIDE;

  DEFINE_STANDARD_RTTIEXT(FeatureDriver, TFunction_Driver)

protected:
  //! Returns 0 on success, non-zero with \p error filled in on failure.
  virtual Standard_Integer Build(const TDF_Label&         feature,
                                 TopoDS_Shape&            shape,
                                 TCollection_AsciiString& error) const = 0;
};
DEFINE_STANDARD_HANDLE(FeatureDriver, TFunction_Driver)

//! Registers one driver per catalogue entry in TFunction_DriverTable.
//! Idempotent, so it is safe to call from every entry point.
void RegisterDrivers();

} // namespace ocafcad

#endif
