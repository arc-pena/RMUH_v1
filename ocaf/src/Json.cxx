#include <ocafcad/Json.hxx>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace ocafcad {

void Json::Set(const std::string& key, const Json& value)
{
  type = Object;
  for (auto& m : members)
    if (m.first == key) { m.second = value; return; }
  members.emplace_back(key, value);
}

const Json* Json::Find(const std::string& key) const
{
  for (const auto& m : members)
    if (m.first == key) return &m.second;
  return nullptr;
}

double Json::NumberOr(const std::string& key, double fallback) const
{
  const Json* j = Find(key);
  return (j && j->type == Number) ? j->number : fallback;
}

std::string Json::StringOr(const std::string& key, const std::string& fallback) const
{
  const Json* j = Find(key);
  return (j && j->type == String) ? j->text : fallback;
}

bool Json::BoolOr(const std::string& key, bool fallback) const
{
  const Json* j = Find(key);
  return (j && j->type == Bool) ? j->boolean : fallback;
}

// ---------------------------------------------------------------- writing

static void EscapeTo(std::ostringstream& os, const std::string& s)
{
  os << '"';
  for (unsigned char c : s)
  {
    switch (c)
    {
      case '"':  os << "\\\""; break;
      case '\\': os << "\\\\"; break;
      case '\n': os << "\\n";  break;
      case '\r': os << "\\r";  break;
      case '\t': os << "\\t";  break;
      default:
        if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof(buf), "\\u%04x", c); os << buf; }
        else          { os << (char)c; }
    }
  }
  os << '"';
}

static void NumberTo(std::ostringstream& os, double v)
{
  if (!std::isfinite(v)) { os << "0"; return; }
  if (v == (long long)v && std::fabs(v) < 1e15) { os << (long long)v; return; }
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%.10g", v);
  os << buf;
}

static void DumpTo(std::ostringstream& os, const Json& j, int indent, int depth)
{
  const std::string pad  (indent > 0 ? (depth + 1) * indent : 0, ' ');
  const std::string pad0 (indent > 0 ? depth * indent : 0, ' ');
  const char*       nl = indent > 0 ? "\n" : "";

  switch (j.type)
  {
    case Json::Null:   os << "null"; break;
    case Json::Bool:   os << (j.boolean ? "true" : "false"); break;
    case Json::Number: NumberTo(os, j.number); break;
    case Json::String: EscapeTo(os, j.text); break;
    case Json::Array:
      if (j.items.empty()) { os << "[]"; break; }
      os << '[' << nl;
      for (size_t i = 0; i < j.items.size(); ++i)
      {
        os << pad;
        DumpTo(os, j.items[i], indent, depth + 1);
        if (i + 1 < j.items.size()) os << ',';
        os << nl;
      }
      os << pad0 << ']';
      break;
    case Json::Object:
      if (j.members.empty()) { os << "{}"; break; }
      os << '{' << nl;
      for (size_t i = 0; i < j.members.size(); ++i)
      {
        os << pad;
        EscapeTo(os, j.members[i].first);
        os << ':' << (indent > 0 ? " " : "");
        DumpTo(os, j.members[i].second, indent, depth + 1);
        if (i + 1 < j.members.size()) os << ',';
        os << nl;
      }
      os << pad0 << '}';
      break;
  }
}

std::string Json::Dump(int indent) const
{
  std::ostringstream os;
  DumpTo(os, *this, indent, 0);
  return os.str();
}

// ---------------------------------------------------------------- parsing

namespace {

struct Parser
{
  const std::string& s;
  size_t             i = 0;
  std::string        error;

  explicit Parser(const std::string& in) : s(in) {}

  bool Fail(const char* what)
  {
    std::ostringstream os;
    os << what << " at offset " << i;
    error = os.str();
    return false;
  }

  void Skip()
  {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }

  bool Literal(const char* lit)
  {
    size_t n = 0;
    while (lit[n]) ++n;
    if (s.compare(i, n, lit) != 0) return Fail("bad literal");
    i += n;
    return true;
  }

  bool String(std::string& out)
  {
    if (i >= s.size() || s[i] != '"') return Fail("expected string");
    ++i;
    out.clear();
    while (i < s.size() && s[i] != '"')
    {
      char c = s[i++];
      if (c != '\\') { out.push_back(c); continue; }
      if (i >= s.size()) return Fail("truncated escape");
      char e = s[i++];
      switch (e)
      {
        case '"':  out.push_back('"');  break;
        case '\\': out.push_back('\\'); break;
        case '/':  out.push_back('/');  break;
        case 'b':  out.push_back('\b'); break;
        case 'f':  out.push_back('\f'); break;
        case 'n':  out.push_back('\n'); break;
        case 'r':  out.push_back('\r'); break;
        case 't':  out.push_back('\t'); break;
        case 'u':
        {
          if (i + 4 > s.size()) return Fail("truncated \\u escape");
          unsigned code = (unsigned)std::strtoul(s.substr(i, 4).c_str(), nullptr, 16);
          i += 4;
          // The schema is ASCII; encode as UTF-8 so round-tripping stays lossless.
          if (code < 0x80) out.push_back((char)code);
          else if (code < 0x800)
          {
            out.push_back((char)(0xC0 | (code >> 6)));
            out.push_back((char)(0x80 | (code & 0x3F)));
          }
          else
          {
            out.push_back((char)(0xE0 | (code >> 12)));
            out.push_back((char)(0x80 | ((code >> 6) & 0x3F)));
            out.push_back((char)(0x80 | (code & 0x3F)));
          }
          break;
        }
        default: return Fail("unknown escape");
      }
    }
    if (i >= s.size()) return Fail("unterminated string");
    ++i;
    return true;
  }

  bool Value(Json& out)
  {
    Skip();
    if (i >= s.size()) return Fail("unexpected end of input");
    char c = s[i];
    if (c == '{')
    {
      out = Json::MakeObject();
      ++i;
      Skip();
      if (i < s.size() && s[i] == '}') { ++i; return true; }
      for (;;)
      {
        Skip();
        std::string key;
        if (!String(key)) return false;
        Skip();
        if (i >= s.size() || s[i] != ':') return Fail("expected ':'");
        ++i;
        Json v;
        if (!Value(v)) return false;
        out.Set(key, v);
        Skip();
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        if (i < s.size() && s[i] == '}') { ++i; return true; }
        return Fail("expected ',' or '}'");
      }
    }
    if (c == '[')
    {
      out = Json::MakeArray();
      ++i;
      Skip();
      if (i < s.size() && s[i] == ']') { ++i; return true; }
      for (;;)
      {
        Json v;
        if (!Value(v)) return false;
        out.items.push_back(v);
        Skip();
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        if (i < s.size() && s[i] == ']') { ++i; return true; }
        return Fail("expected ',' or ']'");
      }
    }
    if (c == '"')
    {
      out.type = Json::String;
      return String(out.text);
    }
    if (c == 't') { if (!Literal("true"))  return false; out = Json::Bln(true);  return true; }
    if (c == 'f') { if (!Literal("false")) return false; out = Json::Bln(false); return true; }
    if (c == 'n') { if (!Literal("null"))  return false; out = Json();           return true; }

    char*  end   = nullptr;
    double value = std::strtod(s.c_str() + i, &end);
    if (end == s.c_str() + i) return Fail("expected value");
    i   = (size_t)(end - s.c_str());
    out = Json::Num(value);
    return true;
  }
};

} // namespace

bool Json::Parse(const std::string& input, Json& result, std::string& error)
{
  Parser p(input);
  if (!p.Value(result)) { error = p.error; return false; }
  p.Skip();
  if (p.i != input.size()) { error = "trailing characters after JSON value"; return false; }
  return true;
}

} // namespace ocafcad
