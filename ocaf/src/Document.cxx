#include <ocafcad/Document.hxx>

#include <ocafcad/Drivers.hxx>
#include <ocafcad/Feature.hxx>
#include <ocafcad/Schema.hxx>

#include <BinDrivers.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_ListIteratorOfLabelList.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_AsciiString.hxx>
#include <TDataStd_Integer.hxx>
#include <TDataStd_Name.hxx>
#include <TDataStd_Real.hxx>
#include <TDocStd_Application.hxx>
#include <TFunction_DriverTable.hxx>
#include <TFunction_Function.hxx>
#include <TFunction_IFunction.hxx>
#include <TFunction_ExecutionStatus.hxx>
#include <TFunction_Iterator.hxx>
#include <TFunction_Logbook.hxx>
#include <XmlDrivers.hxx>

#include <algorithm>
#include <cmath>
#include <set>
#include <fstream>
#include <sstream>

namespace ocafcad {

namespace {

//! Tag of the features container under the document root.
constexpr int FEATURES_TAG = 1;

Handle(TDocStd_Application)& TheApplication()
{
  static Handle(TDocStd_Application) app;
  return app;
}

std::string Entry(const TDF_Label& label)
{
  if (label.IsNull()) return std::string();
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return entry.ToCString();
}

std::string Lower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

bool ReadWholeFile(const std::string& path, std::string& out, std::string& error)
{
  std::ifstream in(path, std::ios::binary);
  if (!in)
  {
    error = "cannot open " + path;
    return false;
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  out = buffer.str();
  return true;
}

} // namespace

// ---------------------------------------------------------------- lifecycle

void Document::Init()
{
  if (!TheApplication().IsNull()) return;
  Handle(TDocStd_Application) app = new TDocStd_Application();
  BinDrivers::DefineFormat(app);
  XmlDrivers::DefineFormat(app);
  TheApplication() = app;
  RegisterDrivers();
}

Document::Document()
{
  Init();
  NewDocument();
}

void Document::NewDocument(const std::string& name)
{
  if (!myDoc.IsNull()) TheApplication()->Close(myDoc);
  TheApplication()->NewDocument("BinOcaf", myDoc);
  myDoc->SetUndoLimit(64);
  myTitle = name;

  TDF_Label root = myDoc->Main();
  TDataStd_Name::Set(root, TCollection_ExtendedString(name.c_str()));
  TDataStd_AsciiString::Set(root, TCollection_AsciiString(myUnits.c_str()));
  root.FindChild(FEATURES_TAG, Standard_True);
}

TDF_Label Document::FeaturesRoot() const
{
  return myDoc->Main().FindChild(FEATURES_TAG, Standard_True);
}

std::vector<TDF_Label> Document::Features() const
{
  std::vector<TDF_Label> features;
  for (TDF_ChildIterator it(FeaturesRoot()); it.More(); it.Next())
    if (it.Value().IsAttribute(TFunction_Function::GetID())) features.push_back(it.Value());
  return features;
}

TDF_Label Document::FindFeature(const std::string& reference) const
{
  if (reference.empty()) return TDF_Label();
  for (const TDF_Label& f : Features())
    if (Feature::Id(f) == reference || Feature::Name(f) == reference || Entry(f) == reference)
      return f;
  return TDF_Label();
}

// ------------------------------------------------------------------ editing

//! CAD naming: Cube.1, Cube.2 ... with a short stable id, CB1, CB2 ...
std::string Document::UniqueName(const std::string& type) const
{
  std::set<std::string> used;
  for (const TDF_Label& f : Features()) used.insert(Feature::Name(f));
  for (int i = 1;; ++i)
  {
    const std::string candidate = type + "." + std::to_string(i);
    if (!used.count(candidate)) return candidate;
  }
}

std::string Document::UniqueId(const std::string& type) const
{
  std::set<std::string> used;
  for (const TDF_Label& f : Features()) used.insert(Feature::Id(f));
  std::string stem = type.substr(0, 2);
  for (char& c : stem) c = (char)std::toupper((unsigned char)c);
  for (int i = 1;; ++i)
  {
    const std::string candidate = stem + std::to_string(i);
    if (!used.count(candidate)) return candidate;
  }
}

TDF_Label Document::AddFeature(const std::string& type,
                               const std::string& id,
                               const std::string& name,
                               std::string&       error)
{
  const TypeSpec* spec = FindType(type);
  if (!spec)
  {
    error = "unknown feature type '" + type + "'";
    return TDF_Label();
  }
  if (!id.empty() && !FindFeature(id).IsNull())
  {
    error = "duplicate feature id '" + id + "'";
    return TDF_Label();
  }

  TDF_Label feature = FeaturesRoot().NewChild();

  // The function attribute must come first: everything else looks the feature's
  // type up through its driver GUID.  NewFunction() also enrols the label in the
  // document's TFunction_Scope, which is what TFunction_Iterator walks.
  if (!TFunction_IFunction::NewFunction(feature, spec->Guid()))
  {
    error = "OCAF refused to create a function on " + Entry(feature);
    return TDF_Label();
  }

  const std::string finalId   = id.empty() ? UniqueId(type) : id;
  const std::string finalName = name.empty() ? UniqueName(type) : name;
  TDataStd_AsciiString::Set(feature, TCollection_AsciiString(finalId.c_str()));
  TDataStd_Name::Set(feature, TCollection_ExtendedString(finalName.c_str()));
  Feature::SetVisible(feature, true);

  for (const ArgSpec& arg : spec->args)
  {
    TDF_Label argLabel = Feature::ArgLabel(feature, arg.key, /*create*/ true);
    if (arg.kind == ArgKind::Real) TDataStd_Real::Set(argLabel, arg.def);
    else if (arg.kind == ArgKind::Choice) TDataStd_Integer::Set(argLabel, (int)arg.def);
  }
  Feature::ResultLabel(feature, /*create*/ true);

  Touch(feature);
  return feature;
}

bool Document::SetParameter(const std::string& featureRef,
                            const std::string& key,
                            double             value,
                            std::string&       error)
{
  TDF_Label feature = FindFeature(featureRef);
  if (feature.IsNull())
  {
    error = "no feature '" + featureRef + "'";
    return false;
  }
  const TypeSpec* spec = Feature::Type(feature);
  const ArgSpec*  arg  = spec ? spec->Arg(key) : nullptr;
  if (!arg || arg->kind == ArgKind::Ref)
  {
    error = "'" + featureRef + "' has no parameter '" + key + "'";
    return false;
  }

  myDoc->NewCommand(); // one undoable step per edit
  TDF_Label argLabel = Feature::ArgLabel(feature, key, /*create*/ true);
  if (arg->kind == ArgKind::Choice)
  {
    const int last  = (int)arg->options.size() - 1;
    const int index = (int)std::lround(value);
    TDataStd_Integer::Set(argLabel, index < 0 ? 0 : (index > last ? last : index));
  }
  else
  {
    // Out-of-range values reach the kernel as nonsense; stop them at the door.
    const double clamped = value < arg->min ? arg->min : (value > arg->max ? arg->max : value);
    TDataStd_Real::Set(argLabel, clamped);
  }
  Touch(argLabel);
  return true;
}

bool Document::SetReference(const std::string& featureRef,
                            const std::string& key,
                            const std::string& targetRef,
                            std::string&       error)
{
  TDF_Label feature = FindFeature(featureRef);
  TDF_Label target  = FindFeature(targetRef);
  if (feature.IsNull() || target.IsNull())
  {
    error = "no feature '" + (feature.IsNull() ? featureRef : targetRef) + "'";
    return false;
  }
  const TypeSpec* spec = Feature::Type(feature);
  const ArgSpec*  arg  = spec ? spec->Arg(key) : nullptr;
  if (!arg || arg->kind != ArgKind::Ref)
  {
    error = "'" + featureRef + "' has no reference argument '" + key + "'";
    return false;
  }

  myDoc->NewCommand();
  Feature::SetReference(feature, key, target);
  Touch(Feature::ArgLabel(feature, key));
  return true;
}

std::vector<TDF_Label> Document::Dependents(const TDF_Label& feature) const
{
  std::vector<TDF_Label> readers;
  for (const TDF_Label& other : Features())
  {
    const TypeSpec* spec = Feature::Type(other);
    if (!spec) continue;
    for (const ArgSpec& arg : spec->args)
      if (arg.kind == ArgKind::Ref && Feature::Reference(other, arg.key) == feature)
      {
        readers.push_back(other);
        break;
      }
  }
  return readers;
}

bool Document::DeleteFeature(const std::string& featureRef, std::string& error)
{
  TDF_Label feature = FindFeature(featureRef);
  if (feature.IsNull())
  {
    error = "no feature '" + featureRef + "'";
    return false;
  }
  const std::vector<TDF_Label> readers = Dependents(feature);
  if (!readers.empty())
  {
    error = Feature::Name(readers.front()) + " still reads from " + Feature::Name(feature);
    return false;
  }

  myDoc->NewCommand();
  // OCAF labels are not removed, they are emptied: the function leaves the
  // scope and the label stops answering as a feature.
  TFunction_IFunction::DeleteFunction(feature);
  feature.ForgetAllAttributes(Standard_True);
  return true;
}

void Document::Touch(const TDF_Label& label)
{
  if (label.IsNull()) return;
  Handle(TFunction_Logbook) log = TFunction_Logbook::Set(myDoc->Main());
  log->SetTouched(label);
}

// ------------------------------------------------------------- regeneration

RegenReport Document::Recompute(bool all)
{
  RegenReport report;

  TDF_Label access = myDoc->Main();
  TFunction_IFunction::UpdateDependencies(access);

  Handle(TFunction_Logbook)     log   = TFunction_Logbook::Set(access);
  Handle(TFunction_DriverTable) table = TFunction_DriverTable::Get();

  if (all)
    for (const TDF_Label& f : Features()) log->SetTouched(f);

  // The iterator hands back the functions whose inputs are already resolved, so
  // walking it with the execution status enabled gives dependency order: no
  // feature is offered before the features it reads from.
  for (const TDF_Label& f : Features()) TFunction_IFunction(f).SetStatus(TFunction_ES_NotExecuted);

  TFunction_Iterator solver(access);
  solver.SetUsageOfExecutionStatus(Standard_True);

  for (; solver.More(); solver.Next())
  {
    const TDF_LabelList level = solver.Current();
    for (TDF_ListIteratorOfLabelList it(level); it.More(); it.Next())
    {
      const TDF_Label feature = it.Value();

      Handle(TFunction_Function) function;
      if (!feature.FindAttribute(TFunction_Function::GetID(), function)) continue;

      Handle(TFunction_Driver) driver;
      if (!table->FindDriver(function->GetDriverGUID(), driver))
      {
        solver.SetStatus(feature, TFunction_ES_Failed);
        continue;
      }

      ++report.functions;
      driver->Init(feature);

      RegenEntry entry;
      entry.id   = Feature::Id(feature);
      entry.name = Feature::Name(feature);

      if (!driver->MustExecute(log))
      {
        entry.revision = Feature::Revision(feature);
        report.skipped.push_back(entry);
        driver->Validate(log);
        solver.SetStatus(feature, TFunction_ES_Succeeded);
        continue;
      }

      const Standard_Integer status = driver->Execute(log);
      if (status == 0)
      {
        entry.revision = Feature::Revision(feature);
        report.executed.push_back(entry);
        driver->Validate(log);
        solver.SetStatus(feature, TFunction_ES_Succeeded);
      }
      else
      {
        entry.revision = Feature::Revision(feature);
        entry.message  = Feature::Error(feature);
        report.failed.push_back(entry);
        // A failed feature keeps its last good shape, so the features after it
        // are still worth building.
        solver.SetStatus(feature, TFunction_ES_Succeeded);
      }
    }
  }

  log->Clear();
  UpdateVisibility();
  return report;
}

void Document::UpdateVisibility()
{
  const std::vector<TDF_Label> features = Features();
  for (const TDF_Label& f : features) Feature::SetVisible(f, true);

  // A body that another feature consumes is replaced by that feature's result,
  // so it drops out of the 3D view while staying in the tree.
  for (const TDF_Label& f : features)
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;
    for (const ArgSpec& arg : spec->args)
    {
      if (arg.kind != ArgKind::Ref || !arg.consumes) continue;
      TDF_Label source = Feature::Reference(f, arg.key);
      if (!source.IsNull()) Feature::SetVisible(source, false);
    }
  }
}

// -------------------------------------------------------------- JSON import

bool Document::LoadJsonText(const std::string& text, std::string& error)
{
  Json model;
  if (!Json::Parse(text, model, error)) return false;
  if (model.type != Json::Object)
  {
    error = "the model file must be a JSON object";
    return false;
  }

  const Json* features = model.Find("features");
  if (!features || features->type != Json::Array)
  {
    error = "the model file has no \"features\" array";
    return false;
  }

  myUnits = model.StringOr("units", "mm");
  NewDocument(model.StringOr("name", "Untitled"));

  // Pass 1 - create every feature, so references can point forwards or back.
  for (const Json& entry : features->items)
  {
    const std::string type = entry.StringOr("type", "");
    const std::string id   = entry.StringOr("id", "");
    const std::string name = entry.StringOr("name", "");
    if (AddFeature(type, id, name, error).IsNull()) return false;
  }

  // Pass 2 - fill in the arguments.
  for (const Json& entry : features->items)
  {
    const std::string id      = entry.StringOr("id", "");
    TDF_Label         feature = FindFeature(id);
    const TypeSpec*   spec    = Feature::Type(feature);
    if (!spec) continue;

    const Json* args = entry.Find("args");
    if (!args || args->type != Json::Object) continue;

    for (const auto& member : args->members)
    {
      const ArgSpec* arg = spec->Arg(member.first);
      if (!arg)
      {
        error = spec->type + " has no argument '" + member.first + "'";
        return false;
      }
      if (arg->kind == ArgKind::Real)
      {
        if (member.second.type != Json::Number)
        {
          error = "argument '" + member.first + "' of " + id + " must be a number";
          return false;
        }
        Feature::SetReal(feature, member.first, member.second.number);
      }
      else if (arg->kind == ArgKind::Choice)
      {
        int index = -1;
        if (member.second.type == Json::Number) index = (int)member.second.number;
        else
          for (size_t i = 0; i < arg->options.size(); ++i)
            if (arg->options[i] == member.second.text) index = (int)i;
        if (index < 0 || index >= (int)arg->options.size())
        {
          error = "argument '" + member.first + "' of " + id + " must be one of ";
          for (size_t i = 0; i < arg->options.size(); ++i)
            error += (i ? ", " : "") + arg->options[i];
          return false;
        }
        Feature::SetChoice(feature, member.first, index);
      }
      else
      {
        const std::string target = member.second.type == Json::String
                                     ? member.second.text
                                     : member.second.StringOr("ref", "");
        TDF_Label         source = FindFeature(target);
        if (source.IsNull())
        {
          error = id + "." + member.first + " references unknown feature '" + target + "'";
          return false;
        }
        Feature::SetReference(feature, member.first, source);
      }
    }
  }

  return true;
}

bool Document::LoadJsonFile(const std::string& path, std::string& error)
{
  std::string text;
  if (!ReadWholeFile(path, text, error)) return false;
  return LoadJsonText(text, error);
}

// -------------------------------------------------------------- JSON export

Json Document::ToJson(bool withState) const
{
  Json model = Json::MakeObject();
  model.Set("format", Json::Str("ocaf-parametric-model"));
  model.Set("version", Json::Num(1));
  model.Set("name", Json::Str(myTitle));
  model.Set("units", Json::Str(myUnits));

  Json features = Json::MakeArray();
  for (const TDF_Label& f : Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;

    Json entry = Json::MakeObject();
    entry.Set("id", Json::Str(Feature::Id(f)));
    entry.Set("type", Json::Str(spec->type));
    entry.Set("name", Json::Str(Feature::Name(f)));

    Json args = Json::MakeObject();
    for (const ArgSpec& arg : spec->args)
    {
      if (arg.kind == ArgKind::Real)
      {
        args.Set(arg.key, Json::Num(Feature::Real(f, arg.key, arg.def)));
      }
      else if (arg.kind == ArgKind::Choice)
      {
        // Written as the option's name so the file reads as a model, not indices.
        const int index = Feature::Choice(f, arg.key, (int)arg.def);
        args.Set(arg.key, Json::Str(index >= 0 && index < (int)arg.options.size()
                                      ? arg.options[index] : arg.options.front()));
      }
      else
      {
        TDF_Label source = Feature::Reference(f, arg.key);
        if (source.IsNull()) continue;
        Json ref = Json::MakeObject();
        ref.Set("ref", Json::Str(Feature::Id(source)));
        args.Set(arg.key, ref);
      }
    }
    entry.Set("args", args);

    if (withState)
    {
      Json state = Json::MakeObject();
      state.Set("entry", Json::Str(Entry(f)));
      state.Set("visible", Json::Bln(Feature::IsVisible(f)));
      state.Set("revision", Json::Num(Feature::Revision(f)));
      state.Set("built", Json::Bln(!Feature::Shape(f).IsNull()));
      const std::string message = Feature::Error(f);
      if (!message.empty()) state.Set("error", Json::Str(message));
      entry.Set("state", state);
    }

    features.Push(entry);
  }
  model.Set("features", features);
  return model;
}

bool Document::SaveJsonFile(const std::string& path, bool withState, std::string& error) const
{
  std::ofstream out(path, std::ios::binary);
  if (!out)
  {
    error = "cannot write " + path;
    return false;
  }
  out << ToJson(withState).Dump() << "\n";
  return true;
}

// ------------------------------------------------------- native persistence

bool Document::SaveNative(const std::string& path, std::string& error)
{
  const std::string lower = Lower(path);
  const bool        xml   = lower.size() > 4 && lower.compare(lower.size() - 4, 4, ".xml") == 0;
  myDoc->ChangeStorageFormat(xml ? "XmlOcaf" : "BinOcaf");

  const PCDM_StoreStatus status =
    TheApplication()->SaveAs(myDoc, TCollection_ExtendedString(path.c_str()));
  if (status != PCDM_SS_OK)
  {
    error = "OCAF could not store " + path;
    return false;
  }
  return true;
}

bool Document::OpenNative(const std::string& path, std::string& error)
{
  Handle(TDocStd_Document) opened;
  const PCDM_ReaderStatus  status =
    TheApplication()->Open(TCollection_ExtendedString(path.c_str()), opened);
  if (status != PCDM_RS_OK || opened.IsNull())
  {
    error = "OCAF could not open " + path;
    return false;
  }

  if (!myDoc.IsNull()) TheApplication()->Close(myDoc);
  myDoc = opened;
  myDoc->SetUndoLimit(64);

  Handle(TDataStd_Name) title;
  if (myDoc->Main().FindAttribute(TDataStd_Name::GetID(), title))
    myTitle = TCollection_AsciiString(title->Get()).ToCString();
  Handle(TDataStd_AsciiString) units;
  if (myDoc->Main().FindAttribute(TDataStd_AsciiString::GetID(), units))
    myUnits = units->Get().ToCString();

  return true;
}

// --------------------------------------------------------------------- dump

std::string Document::DumpTree() const
{
  std::ostringstream os;
  os << myTitle << "  [" << myUnits << "]\n";
  for (const TDF_Label& f : Features())
  {
    const TypeSpec* spec = Feature::Type(f);
    if (!spec) continue;

    const TopoDS_Shape shape   = Feature::Shape(f);
    const std::string  message = Feature::Error(f);

    os << "  " << Entry(f) << "  " << Feature::Name(f) << "  <" << spec->type << ">"
       << (Feature::IsVisible(f) ? "" : "  (hidden - consumed)")
       << (shape.IsNull() ? "  (not built)" : "") << "\n";

    for (const ArgSpec& arg : spec->args)
    {
      if (!Feature::Applies(f, arg)) continue;
      os << "      " << arg.key << " = ";
      if (arg.kind == ArgKind::Real)
      {
        os << Feature::Real(f, arg.key, arg.def);
        if (!arg.unit.empty()) os << " " << arg.unit;
      }
      else if (arg.kind == ArgKind::Choice)
      {
        const int index = Feature::Choice(f, arg.key, (int)arg.def);
        os << (index >= 0 && index < (int)arg.options.size() ? arg.options[index] : "?");
      }
      else
      {
        TDF_Label source = Feature::Reference(f, arg.key);
        os << (source.IsNull() ? std::string("<unset>")
                               : Feature::Name(source) + " (" + Entry(source) + ")");
      }
      os << "\n";
    }
    if (!message.empty()) os << "      ! " << message << "\n";
  }
  return os.str();
}

} // namespace ocafcad
