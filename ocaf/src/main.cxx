// ocafcad - the parametric runtime.
//
//   ocafcad build   model.ocaf.json ...   build an OCAF document from the neutral file
//   ocafcad set     part.cbf Cube.1.dz=140 ...   edit a parameter and regenerate
//   ocafcad tree    part.cbf              print the feature tree
//   ocafcad schema                        print the feature catalogue
//   ocafcad demo    ...                   write the built-in cube + fillet example
#include <ocafcad/Document.hxx>
#include <ocafcad/Feature.hxx>
#include <ocafcad/Schema.hxx>
#include <ocafcad/Server.hxx>

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using namespace ocafcad;

namespace {

struct Options
{
  std::string              docOut;   //!< --save-doc / -o
  std::string              jsonOut;  //!< --json
  std::string              meshOut;  //!< --mesh
  std::string              stepOut;  //!< --step
  std::string              stlOut;   //!< --stl
  bool                     tree = false;
  double                   deflection = 0.0;
  std::string              host = "127.0.0.1";
  int                      port = 8787;
  std::string              uiFile;
  std::vector<std::string> positional;
};

void Usage()
{
  std::cout <<
    "ocafcad - OpenCascade OCAF parametric runtime\n"
    "\n"
    "  ocafcad build <model.ocaf.json> [outputs]\n"
    "      Builds the OCAF document from the neutral parametric file and runs\n"
    "      every function once.\n"
    "\n"
    "  ocafcad set <part.cbf> <Feature>.<param>=<value> [...] [outputs]\n"
    "      Opens a stored document, edits parameters and regenerates. Only the\n"
    "      functions downstream of the edit are re-executed.\n"
    "\n"
    "  ocafcad serve [<model.ocaf.json|part.cbf>] [--port 8787] [--ui <file.html>]\n"
    "      Holds the document in memory and serves it over HTTP. The browser\n"
    "      mirrors the label tree and asks for a shape's triangles only when\n"
    "      that shape's revision moves.\n"
    "\n"
    "  ocafcad tree <part.cbf|model.ocaf.json>\n"
    "  ocafcad schema\n"
    "  ocafcad demo [outputs]\n"
    "\n"
    "Outputs (any combination):\n"
    "  -o, --save-doc <part.cbf|part.xml>   native OCAF document\n"
    "      --json     <model.ocaf.json>     parametric model + computed state\n"
    "      --mesh     <mesh.json>           triangles and edges for a 3D viewer\n"
    "      --step     <part.step>           STEP AP214\n"
    "      --stl      <part.stl>            binary STL\n"
    "      --deflection <mm>                tessellation tolerance\n"
    "      --tree                           print the feature tree\n";
}

bool ParseOptions(int argc, char** argv, int from, Options& options, std::string& error)
{
  for (int i = from; i < argc; ++i)
  {
    const std::string a = argv[i];
    auto              next = [&](std::string& target) {
      if (i + 1 >= argc) { error = a + " needs a value"; return false; }
      target = argv[++i];
      return true;
    };

    if (a == "-o" || a == "--save-doc") { if (!next(options.docOut)) return false; }
    else if (a == "--json")             { if (!next(options.jsonOut)) return false; }
    else if (a == "--mesh")             { if (!next(options.meshOut)) return false; }
    else if (a == "--step")             { if (!next(options.stepOut)) return false; }
    else if (a == "--stl")              { if (!next(options.stlOut)) return false; }
    else if (a == "--deflection")
    {
      std::string value;
      if (!next(value)) return false;
      options.deflection = std::atof(value.c_str());
    }
    else if (a == "--host") { if (!next(options.host)) return false; }
    else if (a == "--port")
    {
      std::string value;
      if (!next(value)) return false;
      options.port = std::atoi(value.c_str());
    }
    else if (a == "--ui") { if (!next(options.uiFile)) return false; }
    else if (a == "--tree") { options.tree = true; }
    else if (!a.empty() && a[0] == '-')
    {
      error = "unknown option " + a;
      return false;
    }
    else
    {
      options.positional.push_back(a);
    }
  }
  return true;
}

void ReportRegen(const RegenReport& report)
{
  std::cout << "regenerated " << report.executed.size() << " of " << report.functions
            << " function" << (report.functions == 1 ? "" : "s");
  if (!report.skipped.empty()) std::cout << ", " << report.skipped.size() << " up to date";
  std::cout << "\n";

  for (const RegenEntry& e : report.executed) std::cout << "  + " << e.name << "\n";
  for (const RegenEntry& e : report.skipped)  std::cout << "  = " << e.name << " (unchanged)\n";
  for (const RegenEntry& e : report.failed)   std::cout << "  ! " << e.name << ": " << e.message << "\n";
}

bool WriteJsonFile(const std::string& path, const Json& value)
{
  std::ofstream out(path, std::ios::binary);
  if (!out) { std::cerr << "ocafcad: cannot write " << path << "\n"; return false; }
  out << value.Dump() << "\n";
  return true;
}

bool WriteOutputs(Document& doc, const Options& options)
{
  bool ok = true;
  std::string error;

  if (!options.docOut.empty())
  {
    if (doc.SaveNative(options.docOut, error)) std::cout << "wrote " << options.docOut << "\n";
    else { std::cerr << "ocafcad: " << error << "\n"; ok = false; }
  }
  if (!options.jsonOut.empty())
  {
    if (doc.SaveJsonFile(options.jsonOut, /*withState*/ true, error))
      std::cout << "wrote " << options.jsonOut << "\n";
    else { std::cerr << "ocafcad: " << error << "\n"; ok = false; }
  }
  if (!options.meshOut.empty())
  {
    if (WriteJsonFile(options.meshOut, TessellateToJson(doc, options.deflection)))
      std::cout << "wrote " << options.meshOut << "\n";
    else ok = false;
  }
  if (!options.stepOut.empty())
  {
    if (WriteStep(doc, options.stepOut, error)) std::cout << "wrote " << options.stepOut << "\n";
    else { std::cerr << "ocafcad: " << error << "\n"; ok = false; }
  }
  if (!options.stlOut.empty())
  {
    if (WriteStl(doc, options.stlOut, options.deflection, error))
      std::cout << "wrote " << options.stlOut << "\n";
    else { std::cerr << "ocafcad: " << error << "\n"; ok = false; }
  }
  if (options.tree) std::cout << "\n" << doc.DumpTree();
  return ok;
}

//! The example the browser front-end opens with: a cube on the XY plane,
//! rounded by a fillet, plus the datums the cube is built on.
const char* kDemoModel = R"JSON({
  "format": "ocaf-parametric-model",
  "version": 1,
  "name": "Cube and Fillet",
  "units": "mm",
  "features": [
    { "id": "PT1", "type": "Point",  "name": "Origin",
      "args": { "x": 0, "y": 0, "z": 0 } },
    { "id": "VZ",  "type": "Vector", "name": "Z Direction",
      "args": { "dx": 0, "dy": 0, "dz": 1 } },
    { "id": "PL1", "type": "Plane",  "name": "XY Plane",
      "args": { "origin": { "ref": "PT1" }, "normal": { "ref": "VZ" }, "size": 200 } },
    { "id": "CB1", "type": "Cube",   "name": "Cube.1",
      "args": { "origin": { "ref": "PT1" }, "plane": { "ref": "PL1" },
                "dx": 80, "dy": 80, "dz": 80 } },
    { "id": "FL1", "type": "Fillet", "name": "Fillet.1",
      "args": { "body": { "ref": "CB1" }, "radius": 12 } }
  ]
})JSON";

int CommandBuild(const std::string& source, const Options& options)
{
  Document    doc;
  std::string error;
  if (!doc.LoadJsonFile(source, error))
  {
    std::cerr << "ocafcad: " << error << "\n";
    return 1;
  }
  const RegenReport report = doc.Recompute(/*all*/ true);
  ReportRegen(report);
  const bool written = WriteOutputs(doc, options);
  return (report.Ok() && written) ? 0 : 1;
}

int CommandDemo(const Options& options)
{
  Document    doc;
  std::string error;
  if (!doc.LoadJsonText(kDemoModel, error))
  {
    std::cerr << "ocafcad: " << error << "\n";
    return 1;
  }
  const RegenReport report = doc.Recompute(/*all*/ true);
  ReportRegen(report);
  const bool written = WriteOutputs(doc, options);
  return (report.Ok() && written) ? 0 : 1;
}

//! "Cube.1.dz=140" -> feature "Cube.1", parameter "dz", value 140.
bool SplitAssignment(const std::string& text, std::string& feature, std::string& key,
                     double& value, std::string& error)
{
  const size_t equals = text.find('=');
  if (equals == std::string::npos)
  {
    error = "expected <Feature>.<param>=<value>, got '" + text + "'";
    return false;
  }
  const std::string left = text.substr(0, equals);
  const size_t      dot  = left.rfind('.');
  if (dot == std::string::npos)
  {
    error = "expected <Feature>.<param>=<value>, got '" + text + "'";
    return false;
  }
  feature = left.substr(0, dot);
  key     = left.substr(dot + 1);
  value   = std::atof(text.c_str() + equals + 1);
  return true;
}

int CommandSet(const std::vector<std::string>& positional, const Options& options)
{
  Document    doc;
  std::string error;
  const std::string& source = positional[0];

  const bool json = source.size() > 5 && source.compare(source.size() - 5, 5, ".json") == 0;
  if (!(json ? doc.LoadJsonFile(source, error) : doc.OpenNative(source, error)))
  {
    std::cerr << "ocafcad: " << error << "\n";
    return 1;
  }
  if (json) doc.Recompute(/*all*/ true); // a neutral file carries no geometry yet

  if (positional.size() < 2)
  {
    std::cerr << "ocafcad: nothing to set\n";
    return 2;
  }

  for (size_t i = 1; i < positional.size(); ++i)
  {
    std::string feature, key;
    double      value = 0.0;
    if (!SplitAssignment(positional[i], feature, key, value, error))
    {
      std::cerr << "ocafcad: " << error << "\n";
      return 2;
    }
    if (!doc.SetParameter(feature, key, value, error))
    {
      std::cerr << "ocafcad: " << error << "\n";
      return 2;
    }
    std::cout << "set " << feature << "." << key << " = " << value << "\n";
  }

  const RegenReport report = doc.Recompute(/*all*/ false);
  ReportRegen(report);
  const bool written = WriteOutputs(doc, options);
  return (report.Ok() && written) ? 0 : 1;
}

//! Opens whatever it is handed - a neutral model, a stored document, or
//! nothing at all - and serves it.
int CommandServe(const std::vector<std::string>& positional, const Options& options)
{
  Document    doc;
  std::string error;

  if (positional.empty())
  {
    if (!doc.LoadJsonText(kDemoModel, error))
    {
      std::cerr << "ocafcad: " << error << "\n";
      return 1;
    }
  }
  else
  {
    const std::string& source = positional[0];
    const bool json = source.size() > 5 && source.compare(source.size() - 5, 5, ".json") == 0;
    if (!(json ? doc.LoadJsonFile(source, error) : doc.OpenNative(source, error)))
    {
      std::cerr << "ocafcad: " << error << "\n";
      return 1;
    }
  }

  const RegenReport report = doc.Recompute(true);
  ReportRegen(report);

  ServerOptions server;
  server.host       = options.host;
  server.port       = options.port;
  server.uiFile     = options.uiFile;
  server.deflection = options.deflection;
  return RunServer(doc, server);
}

int CommandTree(const std::string& source)
{
  Document    doc;
  std::string error;
  const bool  json = source.size() > 5 && source.compare(source.size() - 5, 5, ".json") == 0;
  if (!(json ? doc.LoadJsonFile(source, error) : doc.OpenNative(source, error)))
  {
    std::cerr << "ocafcad: " << error << "\n";
    return 1;
  }
  if (json) doc.Recompute(/*all*/ true);
  else      doc.UpdateVisibility();
  std::cout << doc.DumpTree();
  return 0;
}

} // namespace

int main(int argc, char** argv)
{
  if (argc < 2 || std::strcmp(argv[1], "-h") == 0 || std::strcmp(argv[1], "--help") == 0)
  {
    Usage();
    return argc < 2 ? 2 : 0;
  }

  Document::Init();

  const std::string command = argv[1];
  Options           options;
  std::string       error;
  if (!ParseOptions(argc, argv, 2, options, error))
  {
    std::cerr << "ocafcad: " << error << "\n";
    return 2;
  }

  if (command == "schema")
  {
    std::cout << SchemaToJson().Dump() << "\n";
    return 0;
  }
  if (command == "demo")  return CommandDemo(options);
  if (command == "serve") return CommandServe(options.positional, options);

  if (options.positional.empty())
  {
    std::cerr << "ocafcad: " << command << " needs an input file\n";
    return 2;
  }
  if (command == "build") return CommandBuild(options.positional[0], options);
  if (command == "set")   return CommandSet(options.positional, options);
  if (command == "tree")  return CommandTree(options.positional[0]);

  std::cerr << "ocafcad: unknown command '" << command << "'\n";
  Usage();
  return 2;
}
