// The parametric document: an OCAF TDocStd_Document plus the operations a CAD
// front-end needs - add a feature, edit a parameter, regenerate, save.
#ifndef ocafcad_Document_HeaderFile
#define ocafcad_Document_HeaderFile

#include <ocafcad/Json.hxx>

#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>

#include <string>
#include <vector>

namespace ocafcad {

//! What a regeneration did. The point of a parametric kernel is that this list
//! is short: only the features downstream of the edit are rebuilt.
struct RegenReport
{
  std::vector<std::string> executed;  //!< feature names, in dependency order
  std::vector<std::string> skipped;   //!< up to date, not touched by the edit
  std::vector<std::string> failed;    //!< name + ": " + message
  int                      functions = 0;

  bool Ok() const { return failed.empty(); }
};

class Document
{
public:
  //! Registers the drivers and the persistence formats once per process.
  static void Init();

  Document();

  //! An empty document with a features container.
  void NewDocument(const std::string& name = "Untitled");

  // ------------------------------------------------------------ persistence

  //! Reads the neutral .ocaf.json model - the format shared with the browser
  //! front-end. Builds the OCAF labels; does not regenerate.
  bool LoadJsonText(const std::string& text, std::string& error);
  bool LoadJsonFile(const std::string& path, std::string& error);

  //! Writes the parametric model back out. With \p withState the computed
  //! visibility, errors and mass properties are included as well.
  Json ToJson(bool withState = false) const;
  bool SaveJsonFile(const std::string& path, bool withState, std::string& error) const;

  //! Native OCAF persistence (BinOcaf .cbf / XmlOcaf .xml, chosen by extension).
  //! This keeps the computed B-Rep alongside the parameters.
  bool SaveNative(const std::string& path, std::string& error);
  bool OpenNative(const std::string& path, std::string& error);

  // ---------------------------------------------------------------- editing

  TDF_Label              FeaturesRoot() const;
  std::vector<TDF_Label> Features() const;
  //! Accepts an id ("C1"), a name ("Cube.1") or an OCAF entry ("0:1:1:4").
  TDF_Label FindFeature(const std::string& reference) const;

  //! Creates the feature label, its argument labels (defaults from the
  //! catalogue) and its TFunction_Function.
  TDF_Label AddFeature(const std::string& type,
                       const std::string& id,
                       const std::string& name,
                       std::string&       error);

  bool SetParameter(const std::string& featureRef,
                    const std::string& key,
                    double             value,
                    std::string&       error);

  bool SetReference(const std::string& featureRef,
                    const std::string& key,
                    const std::string& targetRef,
                    std::string&       error);

  // ----------------------------------------------------------- regeneration

  //! Solves the function graph. \p all forces a full rebuild; otherwise only
  //! the functions the logbook marks as touched or impacted are executed.
  RegenReport Recompute(bool all = false);

  //! A body consumed by an operation stays in the tree but leaves the 3D view.
  void UpdateVisibility();

  const Handle(TDocStd_Document)& Handle_() const { return myDoc; }
  std::string                     Title() const { return myTitle; }
  std::string                     Units() const { return myUnits; }

  std::string DumpTree() const;

private:
  //! Marks a label as edited by the user so the next Recompute() picks it up.
  void Touch(const TDF_Label& label);

  Handle(TDocStd_Document) myDoc;
  std::string              myTitle = "Untitled";
  std::string              myUnits = "mm";
};

// ------------------------------------------------------------------ exports

//! Triangulated features as JSON: positions / normals / indices plus edge
//! polylines, ready for a WebGL viewer.
Json TessellateToJson(const Document& doc, double deflection = 0.0);

bool WriteStep(const Document& doc, const std::string& path, std::string& error);
bool WriteStl(const Document& doc, const std::string& path, double deflection, std::string& error);

//! The feature catalogue as JSON - the same table the front-end builds its
//! toolbar and its sliders from.
Json SchemaToJson();

} // namespace ocafcad

#endif
