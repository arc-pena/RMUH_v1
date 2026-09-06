// The same kernel interface, over HTTP.
//
// Talks to `ocafcad serve` (C++) or `python -m ocafpy serve`. Those hold a real
// TDocStd_Document - OCAF labels, TFunction drivers, TNaming results, native
// .cbf persistence and STEP export - which is more than the page can carry on
// its own. When one is reachable the interface uses it in place of the in-page
// kernel, and neither the tree nor the panel can tell the difference.

export async function createHttpKernel(base) {
  const kernel = {
    kind: "http",
    base: base || "",
    description: base ? "OpenCascade at " + base : "OpenCascade, same origin",

    async request(path, options) {
      const response = await fetch(this.base + path, options);
      const payload = await response.json();
      if (!response.ok || payload.ok === false)
        throw new Error(payload.error || response.status + " " + response.statusText);
      return payload;
    },
    get(path) { return this.request(path); },
    post(path, body) {
      return this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },

    schema() { return this.get("/api/schema"); },
    tree() { return this.get("/api/tree"); },
    model() { return this.get("/api/model"); },
    loadModel(model) {
      return this.post("/api/model", typeof model === "string" ? model : JSON.stringify(model));
    },
    setParameter(id, key, value) { return this.post("/api/param", { id, key, value }); },
    setReference(id, key, target) { return this.post("/api/reference", { id, key, target }); },
    setCode(id, key, text) { return this.post("/api/code", { id, key, text }); },
    addFeature(type, refs) { return this.post("/api/feature", { type, refs }); },
    deleteFeature(id) { return this.post("/api/delete", { id }); },
    rename(id, name) { return this.post("/api/rename", { id, name }); },
    mesh(ids) {
      return this.get("/api/mesh" + (ids && ids.length
        ? "?ids=" + encodeURIComponent(ids.join(",")) : ""));
    },
    //! Only the native kernels can do this: write the document to disk beside
    //! the model, as OCAF's own format or as STEP.
    save(path) { return this.post("/api/save", { path }); },
  };

  // A kernel that cannot answer for itself is not a kernel.
  await kernel.schema();
  return kernel;
}
