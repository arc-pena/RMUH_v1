// OpenCascade in the page.
//
// The same kernel the native runtime uses, compiled to WebAssembly. It builds
// the real B-Rep - a filleted box here has twelve cylindrical faces and eight
// spherical corners, exactly as it does in the STEP file - and hands back the
// triangles OpenCascade meshed from it.
//
// Failure is the interesting part. OpenCascade reports trouble three different
// ways and only one of them is an exception, so every driver is guarded three
// times over:
//
//   1. a precondition, checked against the geometry before the kernel is
//      called at all - this is what stops an over-sized fillet radius, which
//      OpenCascade will otherwise answer with IsDone() == true and a shape
//      that is quietly wrong;
//   2. a try/catch around the call, because Standard_Failure crosses the
//      WebAssembly boundary as a number, a pointer or an Error depending on
//      where it was raised;
//   3. a check of the result - IsDone(), a non-null shape, and faces on it.
//
// A feature that fails keeps its last good shape and records the message, so
// one bad radius never takes the model, or the page, down with it.

import { CATALOGUE, Doc, Driver, F, kernelMessage, schemaJson, typeSpec } from "./ocaf.js";

const CONFUSION = 1e-7;

export async function createWasmKernel({ initModule, wasmBinary, instantiateWasm, onProgress }) {
  if (onProgress) onProgress("starting OpenCascade");
  const oc = await initModule(instantiateWasm ? { instantiateWasm } : { wasmBinary });
  if (onProgress) onProgress("kernel ready");

  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;

  /* ------------------------------------------------------------ helpers */

  const pnt = p => new oc.gp_Pnt(p[0], p[1], p[2]);
  const dir = d => new oc.gp_Dir(d[0], d[1], d[2]);

  const length = v => Math.hypot(v[0], v[1], v[2]);
  const readPoint = f => (f && F.spec(f) && F.spec(f).type === "Point")
    ? [F.real(f, "x"), F.real(f, "y"), F.real(f, "z")] : null;
  const readVector = f => (f && F.spec(f) && F.spec(f).type === "Vector")
    ? [F.real(f, "dx"), F.real(f, "dy"), F.real(f, "dz")] : null;

  //! A plane datum resolved to a gp_Ax2, or null when its inputs are missing.
  function planeAxis(planeFeature) {
    if (!planeFeature || F.spec(planeFeature).type !== "Plane") return null;
    const origin = readPoint(F.reference(planeFeature, "origin"));
    const normal = readVector(F.reference(planeFeature, "normal"));
    if (!origin || !normal || length(normal) < CONFUSION) return null;
    return new oc.gp_Ax2(pnt(origin), dir(normal));
  }

  function countSubShapes(shape, kind) {
    const explorer = new oc.TopExp_Explorer(shape, kind, ANY);
    let n = 0;
    while (explorer.More()) { n++; explorer.Next(); }
    explorer.delete();
    return n;
  }

  //! The extents of a shape, used both to size the tessellation and to judge
  //! whether a fillet radius can possibly fit.
  function extents(shape) {
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, box, true);
    if (box.IsVoid()) { box.delete(); return null; }
    const lo = box.CornerMin(), hi = box.CornerMax();
    const size = [hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()];
    box.delete();
    return { size, smallest: Math.min(...size), diagonal: Math.hypot(...size) };
  }

  const deflectionFor = shape => {
    const box = extents(shape);
    return Math.max(1e-3, (box ? box.diagonal : 100) * 2e-3);
  };

  /* ------------------------------------------------------------ drivers */

  const release = shape => { try { shape.delete(); } catch (e) { /* already gone */ } };

  //! A Standard_Failure raised inside WebAssembly arrives as a
  //! WebAssembly.Exception carrying the OpenCascade message; unwrap it so the
  //! panel shows what the kernel actually said.
  function describeError(err) {
    if (err && typeof err.message === "string" && err.message) return err.message;
    try {
      if (typeof WebAssembly !== "undefined" && WebAssembly.Exception &&
          err instanceof WebAssembly.Exception && oc.getExceptionMessage) {
        const [kind, text] = oc.getExceptionMessage(err);
        const message = text ? "OpenCascade: " + text : String(kind);
        if (oc.decrementExceptionRefcount) oc.decrementExceptionRefcount(err);
        return message;
      }
    } catch (ignored) { /* fall through to the generic wording */ }
    return kernelMessage(err);
  }

  const builders = {
    Point: {
      build: f => new oc.BRepBuilderAPI_MakeVertex(
        pnt([F.real(f, "x"), F.real(f, "y"), F.real(f, "z")])).Shape(),
    },

    Vector: {
      precondition: f => length([F.real(f, "dx"), F.real(f, "dy"), F.real(f, "dz")]) < CONFUSION
        ? "a vector needs a non-zero direction" : null,
      // Drawn at a readable length along the direction; the magnitude stays in
      // the parameters, where it is read from.
      build: f => {
        const v = [F.real(f, "dx"), F.real(f, "dy"), F.real(f, "dz")];
        const unit = v.map(c => (c / length(v)) * 100);
        return new oc.BRepBuilderAPI_MakeEdge(pnt([0, 0, 0]), pnt(unit)).Shape();
      },
    },

    Line: {
      precondition: f => {
        if (!readPoint(F.reference(f, "origin"))) return "start point is missing";
        const v = readVector(F.reference(f, "direction"));
        if (!v || length(v) < CONFUSION) return "direction vector is missing or null";
        if (F.real(f, "length", 100) <= CONFUSION) return "length must be positive";
        return null;
      },
      build: f => {
        const origin = readPoint(F.reference(f, "origin"));
        const v = readVector(F.reference(f, "direction"));
        const scale = F.real(f, "length", 100) / length(v);
        const end = [origin[0] + v[0] * scale, origin[1] + v[1] * scale, origin[2] + v[2] * scale];
        return new oc.BRepBuilderAPI_MakeEdge(pnt(origin), pnt(end)).Shape();
      },
    },

    Plane: {
      precondition: f => {
        if (!planeAxis(f)) return "origin point or normal vector is missing";
        if (F.real(f, "size", 160) <= CONFUSION) return "display size must be positive";
        return null;
      },
      build: f => {
        const axis = planeAxis(f);
        const half = F.real(f, "size", 160) / 2;
        const plane = new oc.gp_Pln(new oc.gp_Ax3(axis));
        return new oc.BRepBuilderAPI_MakeFace(plane, -half, half, -half, half).Shape();
      },
    },

    Cube: {
      precondition: f => {
        if (!readPoint(F.reference(f, "origin"))) return "corner point is missing";
        for (const key of ["dx", "dy", "dz"])
          if (F.real(f, key, 80) <= CONFUSION) return "every side length must be positive";
        return null;
      },
      build: f => {
        const corner = readPoint(F.reference(f, "origin"));
        // The plane supplies the orientation, the point the position.
        const plane = planeAxis(F.reference(f, "plane"));
        const placement = plane
          ? new oc.gp_Ax2(pnt(corner), plane.Direction(), plane.XDirection())
          : new oc.gp_Ax2(pnt(corner), dir([0, 0, 1]));
        return new oc.BRepPrimAPI_MakeBox(placement,
          F.real(f, "dx", 80), F.real(f, "dy", 80), F.real(f, "dz", 80)).Shape();
      },
    },

    Sphere: {
      precondition: f => {
        if (!readPoint(F.reference(f, "center"))) return "centre point is missing";
        if (F.real(f, "radius", 50) <= CONFUSION) return "radius must be positive";
        return null;
      },
      build: f => new oc.BRepPrimAPI_MakeSphere(
        new oc.gp_Ax2(pnt(readPoint(F.reference(f, "center"))), dir([0, 0, 1])),
        F.real(f, "radius", 50)).Shape(),
    },

    Fillet: {
      //! The guard that matters. On an 80 mm cube OpenCascade answers r = 39.9
      //! with IsDone() == true, r = 40 with false, and r = 60 with true again -
      //! so IsDone() cannot be trusted on its own. A radius has to clear half
      //! the body's smallest extent before the kernel is asked at all.
      precondition: f => {
        const source = F.reference(f, "body");
        if (!source) return "no body selected";
        const body = F.shape(source);
        if (!body) return "the body to fillet has not been built";

        const radius = F.real(f, "radius", 10);
        if (radius <= CONFUSION) return "radius must be positive";
        if (countSubShapes(body, EDGE) === 0) return "this body has no edges to round";

        const box = extents(body);
        if (box && radius >= box.smallest / 2)
          return "radius " + trim(radius) + " mm does not fit: the body is only "
               + trim(box.smallest) + " mm across, so the limit is " + trim(box.smallest / 2) + " mm";
        return null;
      },
      build: f => {
        const body = F.shape(F.reference(f, "body"));
        const radius = F.real(f, "radius", 10);

        const maker = new oc.BRepFilletAPI_MakeFillet(body, oc.ChFi3d_FilletShape.ChFi3d_Rational);
        const explorer = new oc.TopExp_Explorer(body, EDGE, ANY);
        while (explorer.More()) { maker.Add(radius, oc.TopoDS.Edge(explorer.Current())); explorer.Next(); }
        explorer.delete();

        maker.Build(new oc.Message_ProgressRange());
        if (!maker.IsDone()) throw new Error("the fillet did not converge at " + trim(radius) + " mm");

        const shape = maker.Shape();
        if (!shape || shape.IsNull() || countSubShapes(shape, FACE) === 0)
          throw new Error("the fillet produced an empty shape at " + trim(radius) + " mm");
        return shape;
      },
    },
  };

  const trim = v => (Math.round(v * 10) / 10).toString();

  const drivers = new Map();
  for (const spec of CATALOGUE) {
    const builder = builders[spec.type];
    if (!builder) continue;
    drivers.set(spec.guid, new Driver(spec, { ...builder, release, describeError }));
  }

  /* ---------------------------------------------------------- meshing */

  //! Copies a run of floats out of the WebAssembly heap. The view has to be
  //! made fresh every time: growing the heap detaches any earlier one.
  const readFloats = (ptr, size) =>
    size ? Array.from(new Float32Array(oc.wasmMemory.buffer, ptr, size)) : [];
  const readInts = (ptr, size) =>
    size ? Array.from(new Uint32Array(oc.wasmMemory.buffer, ptr, size)) : [];

  //! B-Rep in, vertex stream out - the whole contract with the viewer.
  function tessellate(shape, deflection) {
    const out = {};
    if (!shape || shape.IsNull()) return out;

    const tolerance = deflection > 0 ? deflection : deflectionFor(shape);
    out.deflection = tolerance;

    if (countSubShapes(shape, FACE) > 0) {
      const faces = oc.ReplicadMeshExtractor.extract(shape, tolerance, 0.3, false);
      out.positions = readFloats(faces.getVerticesPtr(), faces.getVerticesSize());
      out.normals = readFloats(faces.getNormalsPtr(), faces.getNormalsSize());
      out.index = readInts(faces.getTrianglesPtr(), faces.getTrianglesSize());
      out.triangles = out.index.length / 3;
      faces.delete();
    }

    if (countSubShapes(shape, EDGE) > 0) {
      const edges = oc.ReplicadEdgeMeshExtractor.extract(shape, tolerance, 0.3);
      out.edges = readFloats(edges.getLinesPtr(), edges.getLinesSize());
      edges.delete();
    }

    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(shape));
      out.point = [p.X(), p.Y(), p.Z()];
    }
    return out;
  }

  /* ----------------------------------------------------------- kernel */

  let doc = new Doc(drivers);

  const state = report => ({ ok: true, tree: doc.treeJson(), report });

  return {
    kind: "wasm",
    description: "OpenCascade (WebAssembly), in this page",

    async schema() { return schemaJson(); },
    async tree() { return { ok: true, tree: doc.treeJson() }; },
    async model() { return doc.modelJson(); },

    async loadModel(model) {
      const parsed = typeof model === "string" ? JSON.parse(model) : model;
      const replacement = Doc.fromModel(drivers, parsed);
      for (const f of doc.features()) {                 // free the old B-Rep
        const shape = F.shape(f);
        if (shape) release(shape);
      }
      doc = replacement;
      return state(doc.recompute(true));
    },

    async setParameter(id, key, value) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.setParameter(f, key, value);
      return state(doc.recompute(false));
    },

    async setReference(id, key, target) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.setReference(f, key, target ? doc.find(target) : null);
      return state(doc.recompute(false));
    },

    async addFeature(type, refs = {}) {
      const spec = typeSpec(type);
      if (!spec) throw new Error('unknown feature type "' + type + '"');
      const f = doc.addFeature(type);
      try {
        for (const [key, id] of Object.entries(refs)) {
          if (!id) continue;
          const target = doc.find(id);
          if (!target) throw new Error("cannot point " + key + " at unknown feature '" + id + "'");
          doc.setReference(f, key, target);
        }
      } catch (err) {
        doc.deleteFeature(f);
        throw err;
      }
      return { ...state(doc.recompute(false)), id: F.id(f) };
    },

    async deleteFeature(id) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.deleteFeature(f);
      return state(doc.recompute(false));
    },

    async rename(id, name) {
      const f = doc.find(id);
      if (!f || !name) throw new Error("no such feature, or an empty name");
      f.attr.TDataStd_Name = name;
      return state({ functions: 0, executed: [], skipped: [], failed: [] });
    },

    //! Only the shapes the caller names, which is only ever the shapes whose
    //! revision moved.
    async mesh(ids) {
      const wanted = ids && ids.length ? ids : doc.features().map(F.id);
      const features = [];
      for (const id of wanted) {
        const f = doc.find(id);
        if (!f) continue;
        const spec = F.spec(f);
        const shape = F.shape(f);
        let mesh = {};
        try {
          mesh = tessellate(shape, 0);
        } catch (err) {
          mesh = { meshError: describeError(err) };
        }
        features.push({
          id, type: spec.type, name: F.name(f), revision: F.revision(f),
          built: !!shape, visible: F.visible(f), ...mesh,
        });
      }
      return { ok: true, features };
    },
  };
}
