// Minimal JSON value / parser / writer.
//
// The parametric document is exchanged as JSON so that the OCAF runtime and the
// browser front-end read and write the very same file.  OCCT ships no JSON
// parser, and the schema here is small, so a ~200 line reader/writer is
// preferable to a third-party dependency.
#ifndef ocafcad_Json_HeaderFile
#define ocafcad_Json_HeaderFile

#include <string>
#include <utility>
#include <vector>

namespace ocafcad {

class Json
{
public:
  enum Type { Null, Bool, Number, String, Array, Object };

  Type                                     type = Null;
  bool                                     boolean = false;
  double                                   number = 0.0;
  std::string                              text;
  std::vector<Json>                        items;    // Array
  std::vector<std::pair<std::string, Json>> members; // Object, insertion ordered

  Json() = default;
  static Json MakeObject() { Json j; j.type = Object; return j; }
  static Json MakeArray()  { Json j; j.type = Array;  return j; }
  static Json Str(const std::string& s) { Json j; j.type = String; j.text = s; return j; }
  static Json Num(double v)             { Json j; j.type = Number; j.number = v; return j; }
  static Json Bln(bool v)               { Json j; j.type = Bool;   j.boolean = v; return j; }

  // Object access.  Set() overwrites an existing member, keeping its position.
  void        Set(const std::string& key, const Json& value);
  const Json* Find(const std::string& key) const;
  bool        Has(const std::string& key) const { return Find(key) != nullptr; }
  double      NumberOr(const std::string& key, double fallback) const;
  std::string StringOr(const std::string& key, const std::string& fallback) const;
  bool        BoolOr(const std::string& key, bool fallback) const;

  void Push(const Json& value) { type = Array; items.push_back(value); }

  std::string Dump(int indent = 2) const;

  //! Parses \p input.  On failure returns false and fills \p error with a
  //! message that carries the offset of the offending character.
  static bool Parse(const std::string& input, Json& result, std::string& error);
};

} // namespace ocafcad

#endif
