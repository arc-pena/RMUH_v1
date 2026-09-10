#include <ocafcad/Schema.hxx>

namespace ocafcad {

const ArgSpec* TypeSpec::Arg(const std::string& key) const
{
  for (const auto& a : args)
    if (a.key == key) return &a;
  return nullptr;
}

int TypeSpec::ArgTag(const std::string& key) const
{
  for (size_t i = 0; i < args.size(); ++i)
    if (args[i].key == key) return FIRST_ARG_TAG + (int)i;
  return -1;
}

namespace {

ArgSpec Real(const char* key, const char* label, double def, double min, double max,
             double step, const char* unit = "mm")
{
  ArgSpec a;
  a.key = key; a.label = label; a.kind = ArgKind::Real;
  a.def = def; a.min = min; a.max = max; a.step = step; a.unit = unit;
  return a;
}

ArgSpec Ref(const char* key, const char* label, const char* accepts, bool consumes = false)
{
  ArgSpec a;
  a.key = key; a.label = label; a.kind = ArgKind::Ref;
  a.accepts = accepts; a.consumes = consumes;
  return a;
}

ArgSpec Choice(const char* key, const char* label, std::vector<std::string> options, int def = 0)
{
  ArgSpec a;
  a.key = key; a.label = label; a.kind = ArgKind::Choice;
  a.options = std::move(options); a.def = def;
  return a;
}

//! Marks an argument as belonging to one alternative of a choice.
ArgSpec When(ArgSpec a, const char* key, int equals)
{
  a.whenKey = key; a.whenEquals = equals;
  return a;
}

std::vector<TypeSpec> BuildCatalogue()
{
  std::vector<TypeSpec> c;

  TypeSpec point{"Point", "9a1b2c30-0001-4c00-9e00-caf000000001", Category::Datum,
                 "A location in space. Drives origins and centres.",
                 {Real("x", "X", 0, -500, 500, 0.5),
                  Real("y", "Y", 0, -500, 500, 0.5),
                  Real("z", "Z", 0, -500, 500, 0.5)}};

  TypeSpec vector{"Vector", "9a1b2c30-0002-4c00-9e00-caf000000002", Category::Datum,
                  "A direction (and magnitude). Orients lines and planes.",
                  {Real("dx", "dX", 0, -100, 100, 0.1, ""),
                   Real("dy", "dY", 0, -100, 100, 0.1, ""),
                   Real("dz", "dZ", 1, -100, 100, 0.1, "")}};

  TypeSpec line{"Line", "9a1b2c30-0003-4c00-9e00-caf000000003", Category::Datum,
                "A bounded line: a start point, a direction, a length.",
                {Ref("origin", "Start point", "Point"),
                 Ref("direction", "Direction", "Vector"),
                 Real("length", "Length", 100, 1, 1000, 1)}};

  TypeSpec plane{"Plane", "9a1b2c30-0004-4c00-9e00-caf000000004", Category::Datum,
                 "A planar datum: an origin point and a normal vector.",
                 {Ref("origin", "Origin", "Point"),
                  Ref("normal", "Normal", "Vector"),
                  Real("size", "Display size", 160, 10, 1000, 5)}};

  TypeSpec cube{"Cube", "9a1b2c30-0010-4c00-9e00-caf000000010", Category::Body,
                "A box placed at a point, oriented by a plane, sized in three axes.",
                {Ref("origin", "Corner point", "Point"),
                 Ref("plane", "Placement plane", "Plane"),
                 Real("dx", "Length X", 80, 1, 500, 1),
                 Real("dy", "Length Y", 80, 1, 500, 1),
                 Real("dz", "Length Z", 80, 1, 500, 1)}};

  TypeSpec sphere{"Sphere", "9a1b2c30-0011-4c00-9e00-caf000000011", Category::Body,
                  "A sphere centred on a point.",
                  {Ref("center", "Centre point", "Point"),
                   Real("radius", "Radius", 50, 1, 400, 1)}};

  TypeSpec fillet{"Fillet", "9a1b2c30-0020-4c00-9e00-caf000000020", Category::Operation,
                  "Rounds every edge of a body. The body stays in the tree but "
                  "leaves the 3D view - the fillet result replaces it.",
                  {Ref("body", "Body", "Cube,Sphere,Fillet,Array", /*consumes*/ true),
                   Real("radius", "Radius", 10, 0.1, 200, 0.5)}};

  TypeSpec array{"Array", "9a1b2c30-0021-4c00-9e00-caf000000021", Category::Operation,
                 "Repeats a body in a grid or around an axis. One feature in the "
                 "tree, however many copies it makes.",
                 {Ref("source", "Feature", "Cube,Sphere,Fillet,Array", /*consumes*/ true),
                  Choice("mode", "Pattern", {"Rectangular", "Polar"}, 0),
                  When(Real("countX", "Count X", 3, 1, 40, 1, ""), "mode", 0),
                  When(Real("spacingX", "Spacing X", 120, -600, 600, 1), "mode", 0),
                  When(Real("countY", "Count Y", 1, 1, 40, 1, ""), "mode", 0),
                  When(Real("spacingY", "Spacing Y", 120, -600, 600, 1), "mode", 0),
                  When(Real("countZ", "Count Z", 1, 1, 20, 1, ""), "mode", 0),
                  When(Real("spacingZ", "Spacing Z", 120, -600, 600, 1), "mode", 0),
                  When(Ref("center", "Centre", "Point"), "mode", 1),
                  When(Ref("axis", "Axis", "Vector"), "mode", 1),
                  When(Real("count", "Count", 6, 1, 120, 1, ""), "mode", 1),
                  When(Real("angle", "Sweep", 360, -360, 360, 5, "\u00b0"), "mode", 1)}};

  c.push_back(point);
  c.push_back(vector);
  c.push_back(line);
  c.push_back(plane);
  c.push_back(cube);
  c.push_back(sphere);
  c.push_back(array);
  c.push_back(fillet);
  return c;
}

} // namespace

const std::vector<TypeSpec>& Catalogue()
{
  static const std::vector<TypeSpec> table = BuildCatalogue();
  return table;
}

const TypeSpec* FindType(const std::string& type)
{
  for (const auto& t : Catalogue())
    if (t.type == type) return &t;
  return nullptr;
}

const TypeSpec* FindTypeByGuid(const Standard_GUID& guid)
{
  for (const auto& t : Catalogue())
    if (t.Guid() == guid) return &t;
  return nullptr;
}

} // namespace ocafcad
