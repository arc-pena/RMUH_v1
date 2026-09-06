#include <ocafcad/Server.hxx>

#include <ocafcad/Document.hxx>
#include <ocafcad/Feature.hxx>
#include <ocafcad/Json.hxx>
#include <ocafcad/Schema.hxx>

#include <arpa/inet.h>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <netinet/in.h>
#include <sstream>
#include <sys/socket.h>
#include <unistd.h>

#include <map>
#include <vector>

#include <TDataStd_Name.hxx>
#include <TCollection_ExtendedString.hxx>

namespace ocafcad {

namespace {

volatile std::sig_atomic_t g_stop = 0;
void OnInterrupt(int) { g_stop = 1; }

struct Request
{
  std::string                        method;
  std::string                        path;
  std::map<std::string, std::string> query;
  std::string                        body;

  std::string Param(const std::string& key, const std::string& fallback = "") const
  {
    const auto it = query.find(key);
    return it == query.end() ? fallback : it->second;
  }
};

std::string UrlDecode(const std::string& text)
{
  std::string out;
  for (size_t i = 0; i < text.size(); ++i)
  {
    if (text[i] == '+') { out.push_back(' '); }
    else if (text[i] == '%' && i + 2 < text.size())
    {
      out.push_back((char)std::strtol(text.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    }
    else { out.push_back(text[i]); }
  }
  return out;
}

std::vector<std::string> Split(const std::string& text, char separator)
{
  std::vector<std::string> parts;
  std::string              current;
  std::istringstream       stream(text);
  while (std::getline(stream, current, separator))
    if (!current.empty()) parts.push_back(current);
  return parts;
}

bool ReadRequest(int client, Request& request)
{
  std::string buffer;
  char        chunk[4096];

  // Headers first: read until the blank line that ends them.
  while (buffer.find("\r\n\r\n") == std::string::npos)
  {
    const ssize_t got = ::recv(client, chunk, sizeof(chunk), 0);
    if (got <= 0) return false;
    buffer.append(chunk, (size_t)got);
    if (buffer.size() > (1u << 22)) return false;
  }

  const size_t headerEnd = buffer.find("\r\n\r\n");
  std::string  head      = buffer.substr(0, headerEnd);
  std::string  rest      = buffer.substr(headerEnd + 4);

  std::istringstream lines(head);
  std::string        line;
  std::getline(lines, line);
  {
    std::istringstream first(line);
    std::string        target, version;
    first >> request.method >> target >> version;

    const size_t mark = target.find('?');
    request.path      = UrlDecode(mark == std::string::npos ? target : target.substr(0, mark));
    if (mark != std::string::npos)
      for (const std::string& pair : Split(target.substr(mark + 1), '&'))
      {
        const size_t equals = pair.find('=');
        if (equals == std::string::npos) request.query[UrlDecode(pair)] = "";
        else request.query[UrlDecode(pair.substr(0, equals))] = UrlDecode(pair.substr(equals + 1));
      }
  }

  size_t contentLength = 0;
  while (std::getline(lines, line))
  {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string name = line.substr(0, colon);
    for (char& c : name) c = (char)std::tolower((unsigned char)c);
    if (name == "content-length") contentLength = (size_t)std::strtoul(line.c_str() + colon + 1, nullptr, 10);
  }

  while (rest.size() < contentLength)
  {
    const ssize_t got = ::recv(client, chunk, sizeof(chunk), 0);
    if (got <= 0) break;
    rest.append(chunk, (size_t)got);
  }
  request.body = rest.substr(0, contentLength);
  return true;
}

void Send(int client, int status, const std::string& reason, const std::string& contentType,
          const std::string& body)
{
  std::ostringstream head;
  head << "HTTP/1.1 " << status << " " << reason << "\r\n"
       << "Content-Type: " << contentType << "\r\n"
       << "Content-Length: " << body.size() << "\r\n"
       // The published front-end is served from another origin, and a page on
       // https may only reach a local server that says so out loud.
       << "Access-Control-Allow-Origin: *\r\n"
       << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
       << "Access-Control-Allow-Headers: Content-Type\r\n"
       << "Access-Control-Allow-Private-Network: true\r\n"
       << "Access-Control-Max-Age: 86400\r\n"
       << "Cache-Control: no-store\r\n"
       << "Connection: close\r\n\r\n";

  const std::string headers = head.str();
  ::send(client, headers.data(), headers.size(), MSG_NOSIGNAL);
  if (!body.empty()) ::send(client, body.data(), body.size(), MSG_NOSIGNAL);
}

void SendJson(int client, const Json& value, int status = 200)
{
  Send(client, status, status == 200 ? "OK" : "Bad Request", "application/json; charset=utf-8",
       value.Dump(0));
}

void SendError(int client, const std::string& message, int status = 400)
{
  Json out = Json::MakeObject();
  out.Set("ok", Json::Bln(false));
  out.Set("error", Json::Str(message));
  SendJson(client, out, status);
}

bool ParseBody(const Request& request, Json& body, std::string& error)
{
  if (request.body.empty()) { body = Json::MakeObject(); return true; }
  return Json::Parse(request.body, body, error);
}

} // namespace

// --------------------------------------------------------------------------

int RunServer(Document& doc, const ServerOptions& options)
{
  std::signal(SIGINT, OnInterrupt);
  std::signal(SIGTERM, OnInterrupt);
  std::signal(SIGPIPE, SIG_IGN);

  const int listener = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) { std::cerr << "ocafcad: cannot open a socket\n"; return 1; }

  int reuse = 1;
  ::setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port   = htons((uint16_t)options.port);
  if (::inet_pton(AF_INET, options.host.c_str(), &address.sin_addr) != 1)
  {
    std::cerr << "ocafcad: '" << options.host << "' is not an address to bind to\n";
    ::close(listener);
    return 1;
  }
  if (::bind(listener, (sockaddr*)&address, sizeof(address)) != 0)
  {
    std::cerr << "ocafcad: port " << options.port << " is already in use\n";
    ::close(listener);
    return 1;
  }
  ::listen(listener, 16);

  std::cout << "ocafcad serving http://" << options.host << ":" << options.port << "\n"
            << "  document: " << doc.Title() << " (" << doc.Features().size() << " features)\n";
  if (!options.uiFile.empty()) std::cout << "  interface: " << options.uiFile << "\n";
  std::cout << "  stop with Ctrl+C\n" << std::flush;

  //! Reads the whole document back to the client, plus what the last edit did.
  auto stateJson = [&](const RegenReport& report) {
    Json out = Json::MakeObject();
    out.Set("ok", Json::Bln(true));
    out.Set("tree", TreeToJson(doc));
    out.Set("report", RegenReportToJson(report));
    return out;
  };

  while (!g_stop)
  {
    const int client = ::accept(listener, nullptr, nullptr);
    if (client < 0) { if (g_stop) break; continue; }

    Request request;
    if (!ReadRequest(client, request)) { ::close(client); continue; }

    if (request.method == "OPTIONS") { Send(client, 204, "No Content", "text/plain", ""); ::close(client); continue; }

    const std::string& path = request.path;
    std::string        error;

    if (path == "/" || path == "/index.html")
    {
      if (options.uiFile.empty())
      {
        Send(client, 404, "Not Found", "text/plain",
             "ocafcad is running headless. Start it with --ui <file.html> to serve the interface.");
      }
      else
      {
        std::ifstream in(options.uiFile, std::ios::binary);
        if (!in)
        {
          Send(client, 500, "Server Error", "text/plain", "cannot read " + options.uiFile);
        }
        else
        {
          std::ostringstream page;
          page << in.rdbuf();
          Send(client, 200, "OK", "text/html; charset=utf-8", page.str());
        }
      }
    }
    else if (path == "/api/schema")
    {
      SendJson(client, SchemaToJson());
    }
    else if (path == "/api/tree")
    {
      Json out = Json::MakeObject();
      out.Set("ok", Json::Bln(true));
      out.Set("tree", TreeToJson(doc));
      SendJson(client, out);
    }
    else if (path == "/api/mesh")
    {
      // The whole point of the revision counter: the client names the shapes it
      // no longer has up to date, and gets only those.
      const std::string ids = request.Param("ids", request.Param("id"));
      Json              features = Json::MakeArray();
      if (ids.empty())
      {
        for (const TDF_Label& f : doc.Features()) features.Push(FeatureMeshToJson(f, options.deflection));
      }
      else
      {
        for (const std::string& id : Split(ids, ','))
        {
          const TDF_Label f = doc.FindFeature(id);
          if (f.IsNull()) continue;
          features.Push(FeatureMeshToJson(f, options.deflection));
        }
      }
      Json out = Json::MakeObject();
      out.Set("ok", Json::Bln(true));
      out.Set("features", features);
      SendJson(client, out);
    }
    else if (path == "/api/param" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      const std::string id  = body.StringOr("id", "");
      const std::string key = body.StringOr("key", "");
      const Json*       raw = body.Find("value");
      if (!raw || raw->type != Json::Number)
      {
        SendError(client, "value must be a number");
        ::close(client);
        continue;
      }
      if (!doc.SetParameter(id, key, raw->number, error)) { SendError(client, error); ::close(client); continue; }
      SendJson(client, stateJson(doc.Recompute(false)));
    }
    else if (path == "/api/reference" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      if (!doc.SetReference(body.StringOr("id", ""), body.StringOr("key", ""),
                            body.StringOr("target", ""), error))
      {
        SendError(client, error);
        ::close(client);
        continue;
      }
      SendJson(client, stateJson(doc.Recompute(false)));
    }
    else if (path == "/api/feature" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      const TDF_Label feature =
        doc.AddFeature(body.StringOr("type", ""), body.StringOr("id", ""), body.StringOr("name", ""), error);
      if (feature.IsNull()) { SendError(client, error); ::close(client); continue; }

      const Json* refs  = body.Find("refs");
      bool        wired = true;
      if (refs && refs->type == Json::Object)
        for (const auto& member : refs->members)
        {
          if (member.second.type != Json::String) continue;
          const TDF_Label target = doc.FindFeature(member.second.text);
          if (target.IsNull())
          {
            error = "cannot point " + member.first + " at unknown feature '" + member.second.text + "'";
            wired = false;
            break;
          }
          Feature::SetReference(feature, member.first, target);
        }
      if (!wired)
      {
        std::string ignored;
        doc.DeleteFeature(Feature::Id(feature), ignored);
        SendError(client, error);
        ::close(client);
        continue;
      }

      Json out = stateJson(doc.Recompute(false));
      out.Set("id", Json::Str(Feature::Id(feature)));
      SendJson(client, out);
    }
    else if (path == "/api/delete" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      if (!doc.DeleteFeature(body.StringOr("id", ""), error)) { SendError(client, error); ::close(client); continue; }
      SendJson(client, stateJson(doc.Recompute(false)));
    }
    else if (path == "/api/rename" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      const TDF_Label feature = doc.FindFeature(body.StringOr("id", ""));
      const std::string name  = body.StringOr("name", "");
      if (feature.IsNull() || name.empty()) { SendError(client, "no such feature, or an empty name"); ::close(client); continue; }
      TDataStd_Name::Set(feature, TCollection_ExtendedString(name.c_str()));
      SendJson(client, stateJson(RegenReport()));
    }
    else if (path == "/api/model")
    {
      if (request.method == "POST")
      {
        if (!doc.LoadJsonText(request.body, error)) { SendError(client, error); ::close(client); continue; }
        SendJson(client, stateJson(doc.Recompute(true)));
      }
      else
      {
        SendJson(client, doc.ToJson(false));
      }
    }
    else if (path == "/api/step")
    {
      // The browser asks for the text; the kernel writes it once to a scratch
      // file, because that is the only thing STEPControl_Writer knows how to do.
      const std::string scratch = "/tmp/ocafcad-export.step";
      if (!WriteStep(doc, scratch, error)) { SendError(client, error); ::close(client); continue; }

      std::ifstream in(scratch, std::ios::binary);
      std::ostringstream text;
      text << in.rdbuf();
      in.close();
      std::remove(scratch.c_str());

      int solids = 0;
      for (const TDF_Label& f : doc.Features())
        if (Feature::IsVisible(f) && !Feature::Shape(f).IsNull()) ++solids;

      Json out = Json::MakeObject();
      out.Set("ok", Json::Bln(true));
      out.Set("text", Json::Str(text.str()));
      out.Set("solids", Json::Num(solids));
      out.Set("name", Json::Str(doc.Title()));
      out.Set("units", Json::Str(doc.Units()));
      SendJson(client, out);
    }
    else if (path == "/api/save" && request.method == "POST")
    {
      Json body;
      if (!ParseBody(request, body, error)) { SendError(client, error); ::close(client); continue; }
      const std::string file = body.StringOr("path", "part.cbf");
      const bool json = file.size() > 5 && file.compare(file.size() - 5, 5, ".json") == 0;
      const bool ok   = json ? doc.SaveJsonFile(file, false, error) : doc.SaveNative(file, error);
      if (!ok) { SendError(client, error); ::close(client); continue; }
      Json out = Json::MakeObject();
      out.Set("ok", Json::Bln(true));
      out.Set("path", Json::Str(file));
      SendJson(client, out);
      std::cout << "wrote " << file << "\n" << std::flush;
    }
    else
    {
      SendError(client, "no route for " + request.method + " " + path, 404);
    }

    ::close(client);
  }

  ::close(listener);
  std::cout << "\nocafcad stopped\n";
  return 0;
}

} // namespace ocafcad
