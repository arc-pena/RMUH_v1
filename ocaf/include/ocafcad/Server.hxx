// The kernel as a service.
//
// The document lives here; the browser holds no geometry of its own. It mirrors
// the label tree, and asks for a shape's triangles only when that shape's
// revision moves - which happens exactly when a driver re-executed.
#ifndef ocafcad_Server_HeaderFile
#define ocafcad_Server_HeaderFile

#include <string>

namespace ocafcad {

class Document;

struct ServerOptions
{
  std::string host = "127.0.0.1";
  int         port = 8787;
  std::string uiFile;          //!< served at "/", so the whole thing is same-origin
  double      deflection = 0.0; //!< 0 = scale the tolerance to the model
};

//! Blocks until the process is interrupted. Returns a process exit code.
int RunServer(Document& doc, const ServerOptions& options);

} // namespace ocafcad

#endif
