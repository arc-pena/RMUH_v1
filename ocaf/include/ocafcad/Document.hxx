// The parametric document: an OCAF TDocStd_Document plus the operations a CAD
// front-end needs - add a feature, edit a parameter, regenerate, save.
#ifndef ocafcad_Document_HeaderFile
#define ocafcad_Document_HeaderFile

#include <ocafcad/Json.hxx>

#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <TopoDS_Shape.hxx>

#include <string>
#include <vector>

namespace ocafcad {

struct RegenEntry
{
  std::string id;
  std::string name;
  std::string message;  //!< failures only
  int         revision = 0;
};

//! What a regeneration did. The point of a parametric kernel is that this list
//! is short: only the features downstream of the edit are rebuilt, and only
//! those need their triangles sent again.
struct RegenReport
{
  std::vector<RegenEntry> executed;  //!< rebuilt, in dependency order
  std::vector<RegenEntry> skipped;   //!< up to date, not touched by the edit
  std::vector<RegenEntry> failed;
  int                     functions = 0;

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
  std::string UniqueName(const std::string& type) const;
  std::string UniqueId(const std::string& type) const;

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

  //! Refuses while another feature still reads from this one.
  bool DeleteFeature(const std::string& featureRef, std::string& error);

  //! Every feature that references \p feature.
  std::vector<TDF_Label> Dependents(const TDF_Label& feature) const;

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

//! Meshes a B-Rep shape and returns its triangles - positions, normals and
//! indices - plus its edge polylines. This is the whole contract between the
//! kernel and any viewer: OpenCascade owns the geometry, the client draws the
//! triangles it is handed.
Json TessellateShape(const TopoDS_Shape& shape, double deflection = 0.0);

//! One feature's triangle stream, tagged with the revision it was built at so
//! a client can cache it and re-fetch only what changed.
Json FeatureMeshToJson(const TDF_Label& feature, double deflection = 0.0);

//! The document the front-end mirrors: every feature with its arguments,
//! references, visibility, error and revision.
Json TreeToJson(const Document& doc);

//! Triangulated features as JSON: positions / normals / indices plus edge
//! polylines, ready for a WebGL viewer.
Json TessellateToJson(const Document& doc, double deflection = 0.0);

bool WriteStep(const Document& doc, const std::string& path, std::string& error);
bool WriteStl(const Document& doc, const std::string& path, double deflection, std::string& error);

//! Wavefront OBJ - one group per visible feature, with the vertex normals the
//! surfaces actually have, so a fillet arrives smooth and a flat face arrives
//! flat. This is the format to open in Blender.
bool WriteObj(const Document& doc, const std::string& path, double deflection, std::string& error);

//! The feature catalogue as JSON - the same table the front-end builds its
//! toolbar and its sliders from.
Json SchemaToJson();

Json RegenReportToJson(const RegenReport& report);

} // namespace ocafcad

#endif
