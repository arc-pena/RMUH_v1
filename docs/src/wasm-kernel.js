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

import { CATALOGUE, Doc, Driver, F, clampTo, dataLines, kernelMessage, meshFaces,
         parseNumbers, schemaJson,
         typeSpec } from "./ocaf.js";
import { sketchArcPoint, sketchChainEnds, sketchEnds, sketchLoops, sketchNesting,
         sketchOutline, solveSketch, splinePoints } from "./sketch.js";

const CONFUSION = 1e-7;

export async function createWasmKernel({ initModule, wasmBinary, instantiateWasm, onProgress }) {
  if (onProgress) onProgress("starting OpenCascade");
  const oc = await initModule(instantiateWasm ? { instantiateWasm } : { wasmBinary });
  if (onProgress) onProgress("kernel ready");

  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;

  /* ------------------------------------------------------------ helpers */

  const Feature_choice = (f, key) => F.choice(f, key, 0);

  const pnt = p => new oc.gp_Pnt(p[0], p[1], p[2]);
  const dir = d => new oc.gp_Dir(d[0], d[1], d[2]);

  const length = v => Math.hypot(v[0], v[1], v[2]);
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return l < 1e-9 ? null : V.scale(a, 1 / l); },
  };
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

  //! The smallest extent of any single solid in a shape. A fillet radius has to
  //! fit the individual body, not the bounding box of a whole array of them.
  function smallestSolidExtent(shape) {
    let smallest = Infinity;
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, ANY);
    while (explorer.More()) {
      const box = extents(explorer.Current());
      if (box) smallest = Math.min(smallest, box.smallest);
      explorer.Next();
    }
    explorer.delete();
    if (smallest !== Infinity) return smallest;
    const whole = extents(shape);
    return whole ? whole.smallest : Infinity;
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
    //! Wire a list of numbers into a coordinate and one point becomes a row of
    //! them: the shortest list repeats its last value, which is the rule
    //! everything downstream of here follows.
    Point: {
      build: f => {
        const rows = zip([F.reals(f, "x", 0), F.reals(f, "y", 0), F.reals(f, "z", 0)]);
        const shape = rows.length === 1
          ? new oc.BRepBuilderAPI_MakeVertex(pnt(rows[0])).Shape()
          : compoundOf(rows.map(vertexAt));
        return { shape, data: points(rows) };
      },
    },

    Vector: {
      precondition: f => length([F.real(f, "dx"), F.real(f, "dy"), F.real(f, "dz")]) < CONFUSION
        ? "a vector needs a non-zero direction" : null,
      // Drawn at a readable length along the direction; the magnitude stays in
      // the parameters, where it is read from.
      build: f => {
        const v = [F.real(f, "dx"), F.real(f, "dy"), F.real(f, "dz")];
        const unit = v.map(c => (c / length(v)) * 100);
        return { shape: new oc.BRepBuilderAPI_MakeEdge(pnt([0, 0, 0]), pnt(unit)).Shape(),
                 data: vectors([v]) };
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

        const smallest = smallestSolidExtent(body);
        if (Number.isFinite(smallest) && radius >= smallest / 2)
          return "radius " + trim(radius) + " mm does not fit: the body is only "
               + trim(smallest) + " mm across, so the limit is " + trim(smallest / 2) + " mm";
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

  //! Instances are cheap - what costs is the vertex stream they mesh down to.
  const INSTANCE_LIMIT = 1000;

  //! Every placement of an arrayed feature, as a list of transforms. The first
  //! is the identity, so the source stays exactly where it was drawn.
  function arrayPlacements(f) {
    const placements = [];
    if (Feature_choice(f, "mode") === 0) {
      const nx = Math.max(1, Math.round(F.real(f, "countX", 3)));
      const ny = Math.max(1, Math.round(F.real(f, "countY", 1)));
      const nz = Math.max(1, Math.round(F.real(f, "countZ", 1)));
      const sx = F.real(f, "spacingX", 120);
      const sy = F.real(f, "spacingY", 120);
      const sz = F.real(f, "spacingZ", 120);
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
          for (let k = 0; k < nz; k++) {
            const trsf = new oc.gp_Trsf();
            if (i || j || k) trsf.SetTranslation(new oc.gp_Vec(i * sx, j * sy, k * sz));
            placements.push(trsf);
          }
      return placements;
    }

    const count = Math.max(1, Math.round(F.real(f, "count", 6)));
    const sweep = F.real(f, "angle", 360);
    const centre = readPoint(F.reference(f, "center")) || [0, 0, 0];
    const direction = readVector(F.reference(f, "axis"));
    const axis = new oc.gp_Ax1(pnt(centre),
      direction && length(direction) > CONFUSION ? dir(direction) : dir([0, 0, 1]));

    // A full turn closes on itself, so the last copy would land on the first.
    const closed = Math.abs(Math.abs(sweep) - 360) < 1e-6;
    const stride = count < 2 ? 0 : (closed ? sweep / count : sweep / (count - 1));
    for (let i = 0; i < count; i++) {
      const trsf = new oc.gp_Trsf();
      if (i) trsf.SetRotation(axis, (stride * i) * Math.PI / 180);
      placements.push(trsf);
    }
    return placements;
  }

  builders.Array = {
    precondition: f => {
      const source = F.reference(f, "source");
      if (!source) return "no feature selected to array";
      if (!F.shape(source)) return "the feature to array has not been built";

      if (Feature_choice(f, "mode") === 0) {
        const nx = Math.round(F.real(f, "countX", 3));
        const ny = Math.round(F.real(f, "countY", 1));
        const nz = Math.round(F.real(f, "countZ", 1));
        const total = Math.max(1, nx) * Math.max(1, ny) * Math.max(1, nz);
        if (total > INSTANCE_LIMIT)
          return total + " copies is more than this kernel will build at once (limit "
               + INSTANCE_LIMIT + ")";
        // Copies stacked on top of each other are a modelling mistake, not a shape.
        const box = extents(F.shape(source));
        if (box) {
          const pairs = [["countX", "spacingX", 0], ["countY", "spacingY", 1], ["countZ", "spacingZ", 2]];
          for (const [countKey, spacingKey, axis] of pairs)
            if (Math.round(F.real(f, countKey, 1)) > 1 &&
                Math.abs(F.real(f, spacingKey, 0)) < box.size[axis] * 0.02)
              return "spacing along " + spacingKey.slice(-1)
                   + " is too small - the copies would sit inside each other";
        }
      } else {
        const count = Math.round(F.real(f, "count", 6));
        if (count > INSTANCE_LIMIT)
          return count + " copies is more than this kernel will build at once (limit "
               + INSTANCE_LIMIT + ")";
        const direction = readVector(F.reference(f, "axis"));
        if (direction && length(direction) < CONFUSION)
          return "the axis vector has no direction";
      }
      return null;
    },
    build: f => {
      const source = F.shape(F.reference(f, "source"));
      const builder = new oc.TopoDS_Builder();
      const compound = new oc.TopoDS_Compound();
      builder.MakeCompound(compound);

      // An instance is the same shape at a different location, not a copy of it.
      // TopoDS_Shape::Moved swaps the TopLoc_Location and leaves the underlying
      // TShape shared, so the B-Rep is built once and triangulated once however
      // many instances there are: at 200 copies of a filleted box that is 4 ms
      // instead of 72 to build, and 49 ms instead of 1698 to mesh.
      for (const trsf of arrayPlacements(f))
        builder.Add(compound, source.Moved(new oc.TopLoc_Location(trsf)));
      return compound;
    },
  };

  /* ------------------------------------------------- the scripting surface

     What a Script feature is handed. Small on purpose: solids, placement and
     booleans, in the units the document is drawn in. Placement goes through
     TopoDS_Shape::Moved, so repeating a shape costs a location and not a
     rebuild - a stair with thirteen identical treads models one.            */

  function axisSystem(opts = {}) {
    const at = opts.at || [0, 0, 0];
    const up = opts.axis || [0, 0, 1];
    if (opts.xdir) return new oc.gp_Ax2(pnt(at), dir(up), dir(opts.xdir));
    return new oc.gp_Ax2(pnt(at), dir(up));
  }

  const asNumber = (value, name) => {
    if (!Number.isFinite(value)) throw new Error(name + " must be a number, got " + value);
    return value;
  };
  const positive = (value, name) => {
    if (!Number.isFinite(value) || value <= CONFUSION)
      throw new Error(name + " must be greater than zero, got " + value);
    return value;
  };

  //! Moving a wire hands back a TopoDS_Shape, and the sweep builders want a
  //! TopoDS_Wire, so the type has to be put back on.
  function asWire(shape, what) {
    if (!shape || typeof shape.ShapeType !== "function")
      throw new Error("the " + what + " is not a shape");
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) return oc.TopoDS.Wire(shape);
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE)
      return new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(shape)).Wire();
    throw new Error("the " + what + " must be a wire");
  }

  function shapeApi() {
    const api = {
      box(dx, dy, dz, opts) {
        return new oc.BRepPrimAPI_MakeBox(axisSystem(opts),
          positive(dx, "box width"), positive(dy, "box depth"), positive(dz, "box height")).Shape();
      },

      //! A full cylinder, or a pie slice when an angle in degrees is given.
      cylinder(radius, height, opts = {}) {
        const axis = axisSystem(opts);
        const r = positive(radius, "cylinder radius");
        const h = positive(height, "cylinder height");
        return opts.angle === undefined
          ? new oc.BRepPrimAPI_MakeCylinder(axis, r, h).Shape()
          : new oc.BRepPrimAPI_MakeCylinder(axis, r, h,
              positive(opts.angle, "cylinder angle") * Math.PI / 180).Shape();
      },

      sphere(radius, opts) {
        return new oc.BRepPrimAPI_MakeSphere(axisSystem(opts),
          positive(radius, "sphere radius")).Shape();
      },

      //! An annular sector: a pie slice with its middle bored out. A stair
      //! tread, in other words.
      sector(innerRadius, outerRadius, angle, thickness, opts) {
        const outer = api.cylinder(positive(outerRadius, "sector outer radius"),
          positive(thickness, "sector thickness"),
          { ...opts, angle: positive(angle, "sector angle") });
        if (!(innerRadius > CONFUSION)) return outer;
        if (innerRadius >= outerRadius)
          throw new Error("the sector's inner radius must be smaller than its outer radius");
        const bore = api.cylinder(innerRadius, thickness * 3,
          { ...opts, at: [(opts && opts.at ? opts.at[0] : 0), (opts && opts.at ? opts.at[1] : 0),
                          (opts && opts.at ? opts.at[2] : 0) - thickness] });
        return api.cut(outer, bore);
      },

      //! A rectangular bar running from one point to another - a stringer, a
      //! baluster, a beam. The bar's length lies along the axis system's main
      //! direction, because gp_Ax2 projects the X direction onto the plane
      //! normal to it: aim a sloping beam with X and it comes out horizontal.
      beam(from, to, width, depth, opts = {}) {
        const along = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const span = length(along);
        if (span < CONFUSION) throw new Error("a beam needs two different points");
        const w = positive(width, "beam width");
        const d = positive(depth, "beam depth");

        const up = opts.up || [0, 0, 1];
        // Across the run, horizontally; if the run is vertical, any perpendicular will do.
        let across = V.norm(V.cross(up, along)) || V.norm(V.cross([1, 0, 0], along)) || [1, 0, 0];
        const upright = V.norm(V.cross(along, across)) || [0, 0, 1];

        // Centre the section on the line rather than hanging it off one corner.
        const origin = V.add(from, V.add(V.scale(across, -w / 2), V.scale(upright, -d / 2)));
        return new oc.BRepPrimAPI_MakeBox(
          new oc.gp_Ax2(pnt(origin), dir(along), dir(across)), w, d, span).Shape();
      },

      /* --------------------------------------------------------- curves

         A profile is a closed wire; a spine is an open one. Sweeping one along
         the other is how anything with a constant section gets made - a
         handrail, a stringer, a thread.                                    */

      //! A helix, built the way OpenCascade builds one: a straight line in the
      //! (u,v) parameter space of a cylinder, which maps to a helix in space.
      //! It starts at angle zero - at [radius, 0, 0] from the origin given -
      //! and rises by `pitch` every turn.
      helix(radius, pitch, turns, opts = {}) {
        const r = positive(radius, "helix radius");
        const p = asNumber(pitch, "helix pitch");
        const n = positive(turns, "helix turns");

        const surface = new oc.Geom_CylindricalSurface(
          new oc.gp_Ax3(pnt(opts.at || [0, 0, 0]), dir(opts.axis || [0, 0, 1])), r);
        // Advancing 2*pi in u while advancing `pitch` in v is one turn.
        const line = new oc.Geom2d_Line(
          new oc.gp_Ax2d(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, p)));
        const segment = new oc.Geom2d_TrimmedCurve(
          line, 0, n * Math.hypot(2 * Math.PI, p), true, true);

        const edge = new oc.BRepBuilderAPI_MakeEdge(segment, surface).Edge();
        // The edge so far exists only on the surface; give it a 3D curve.
        oc.BRepLib.BuildCurve3d(edge, 1e-5, oc.GeomAbs_Shape.GeomAbs_C1, 14, 0);
        return new oc.BRepBuilderAPI_MakeWire(edge).Wire();
      },

      //! The tangent of that helix where it starts, which is where a profile
      //! has to face to be swept along it.
      helixTangent(radius, pitch) {
        return V.norm([0, radius, pitch / (2 * Math.PI)]) || [0, 1, 0];
      },

      ellipse(major, minor, opts = {}) {
        const a = positive(major, "ellipse major radius");
        const b = positive(minor, "ellipse minor radius");
        if (b > a) throw new Error("an ellipse's minor radius cannot exceed its major radius");
        const edge = new oc.BRepBuilderAPI_MakeEdge(
          new oc.gp_Elips(axisSystem(opts), a, b)).Edge();
        return new oc.BRepBuilderAPI_MakeWire(edge).Wire();
      },

      circle(radius, opts = {}) {
        const edge = new oc.BRepBuilderAPI_MakeEdge(
          new oc.gp_Circ(axisSystem(opts), positive(radius, "circle radius"))).Edge();
        return new oc.BRepBuilderAPI_MakeWire(edge).Wire();
      },

      //! A wire through a run of points, closed or not.
      polyline(points, opts = {}) {
        if (!Array.isArray(points) || points.length < 2)
          throw new Error("a polyline needs at least two points");
        const maker = new oc.BRepBuilderAPI_MakeWire();
        const run = opts.closed ? points.concat([points[0]]) : points;
        for (let i = 0; i < run.length - 1; i++) {
          if (length([run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1],
                      run[i + 1][2] - run[i][2]]) < CONFUSION) continue;
          maker.Add(new oc.BRepBuilderAPI_MakeEdge(pnt(run[i]), pnt(run[i + 1])).Edge());
        }
        if (!maker.IsDone()) throw new Error("those points do not make a wire");
        return maker.Wire();
      },

      //! A rectangle centred on `at`, lying in the plane normal to `axis`. Its
      //! width runs along `xdir` and its height across it, so a stringer's
      //! thickness and depth land on the axes you meant.
      rectangle(width, height, opts = {}) {
        const w = positive(width, "rectangle width") / 2;
        const h = positive(height, "rectangle height") / 2;
        const at = opts.at || [0, 0, 0];
        const normal = V.norm(opts.axis || [0, 0, 1]) || [0, 0, 1];

        const seed = opts.xdir || (Math.abs(normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]);
        // Only the part of xdir that lies in the plane can be the width axis.
        const projected = V.add(seed, V.scale(normal, -(seed[0] * normal[0]
          + seed[1] * normal[1] + seed[2] * normal[2])));
        const x = V.norm(projected)
          || V.norm(V.cross(normal, [1, 0, 0])) || V.norm(V.cross(normal, [0, 1, 0]));
        const y = V.norm(V.cross(normal, x));

        const corner = (sx, sy) => V.add(at, V.add(V.scale(x, sx * w), V.scale(y, sy * h)));
        return api.polyline([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
                            { closed: true });
      },

      face(wire) { return new oc.BRepBuilderAPI_MakeFace(wire, true).Face(); },

      //! Sweeps a profile along a spine. The default keeps the profile upright
      //! the whole way - a handrail does not roll over as it turns - which is
      //! what a constant binormal means; pass frenet: true to let it follow the
      //! curve's own frame instead.
      sweep(profile, spine, opts = {}) {
        const shell = new oc.BRepOffsetAPI_MakePipeShell(asWire(spine, "spine"));
        if (opts.frenet) shell.SetMode(true);
        else shell.SetMode(dir(opts.up || [0, 0, 1]));
        // Correction turns the profile to face along the spine; contact would
        // also slide it onto the spine, which moves the section off centre.
        shell.Add(asWire(profile, "profile"), opts.contact === true, opts.correct !== false);
        shell.Build(new oc.Message_ProgressRange());
        if (!shell.IsDone()) throw new Error("the sweep did not succeed");
        if (opts.solid !== false && !shell.MakeSolid())
          throw new Error("the sweep did not close into a solid");
        return shell.Shape();
      },

      //! Lofts through a run of profiles - the way the neck thread of the
      //! OpenCascade bottle is made.
      loft(profiles, opts = {}) {
        const list = [].concat(profiles).filter(Boolean);
        if (list.length < 2) throw new Error("a loft needs at least two profiles");
        const maker = new oc.BRepOffsetAPI_ThruSections(
          opts.solid !== false, opts.ruled === true, 1e-6);
        for (const wire of list) maker.AddWire(asWire(wire, "loft profile"));
        maker.Build(new oc.Message_ProgressRange());
        if (!maker.IsDone()) throw new Error("the loft did not succeed");
        return maker.Shape();
      },

      prism(face, along) {
        return new oc.BRepPrimAPI_MakePrism(face,
          new oc.gp_Vec(along[0], along[1], along[2]), false, true).Shape();
      },

      //! A round tube through a run of points: a cylinder per segment, a sphere
      //! at every joint so the corners close. For anything smooth, sweep a
      //! circle along a proper spine instead.
      tube(points, radius) {
        const r = positive(radius, "tube radius");
        if (!Array.isArray(points) || points.length < 2)
          throw new Error("a tube needs at least two points");
        const parts = [];
        for (let i = 0; i < points.length - 1; i++) {
          const along = [points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1],
                         points[i + 1][2] - points[i][2]];
          const span = length(along);
          if (span < CONFUSION) continue;
          parts.push(new oc.BRepPrimAPI_MakeCylinder(
            new oc.gp_Ax2(pnt(points[i]), dir(along)), r, span).Shape());
        }
        for (let i = 1; i < points.length - 1; i++) parts.push(api.sphere(r, { at: points[i] }));
        return api.compound(parts);
      },

      move(shape, by) {
        const trsf = new oc.gp_Trsf();
        trsf.SetTranslation(new oc.gp_Vec(asNumber(by[0], "dx"), asNumber(by[1], "dy"),
                                          asNumber(by[2], "dz")));
        return shape.Moved(new oc.TopLoc_Location(trsf));
      },

      rotate(shape, degrees, opts = {}) {
        const trsf = new oc.gp_Trsf();
        trsf.SetRotation(new oc.gp_Ax1(pnt(opts.at || [0, 0, 0]), dir(opts.axis || [0, 0, 1])),
                         asNumber(degrees, "angle") * Math.PI / 180);
        return shape.Moved(new oc.TopLoc_Location(trsf));
      },

      cut(a, b) { return api.boolean(oc.BRepAlgoAPI_Cut, a, b, "cut"); },
      fuse(a, b) { return api.boolean(oc.BRepAlgoAPI_Fuse, a, b, "fuse"); },
      common(a, b) { return api.boolean(oc.BRepAlgoAPI_Common, a, b, "common"); },
      boolean(Operation, a, b, name) {
        const operation = new Operation(a, b, new oc.Message_ProgressRange());
        operation.Build(new oc.Message_ProgressRange());
        if (!operation.IsDone()) throw new Error("the " + name + " did not succeed");
        return operation.Shape();
      },

      fillet(shape, radius) {
        const r = positive(radius, "fillet radius");
        const smallest = smallestSolidExtent(shape);
        if (Number.isFinite(smallest) && r >= smallest / 2)
          throw new Error("a " + trim(r) + " mm fillet does not fit a body "
                        + trim(smallest) + " mm across");
        const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
        const explorer = new oc.TopExp_Explorer(shape, EDGE, ANY);
        while (explorer.More()) { maker.Add(r, oc.TopoDS.Edge(explorer.Current())); explorer.Next(); }
        explorer.delete();
        maker.Build(new oc.Message_ProgressRange());
        if (!maker.IsDone()) throw new Error("the fillet did not converge");
        return maker.Shape();
      },

      compound(shapes) {
        const list = [].concat(shapes).filter(Boolean);
        if (!list.length) throw new Error("nothing to assemble");
        const builder = new oc.TopoDS_Builder();
        const compound = new oc.TopoDS_Compound();
        builder.MakeCompound(compound);
        for (const shape of list) builder.Add(compound, shape);
        return compound;
      },
    };
    return api;
  }

  //! Compiles the source and reads back what it declares. Anything the script
  //! gets wrong - a syntax error, a missing build, a malformed parameter -
  //! surfaces here rather than half-way through modelling.
  function compileScript(source) {
    let module;
    try {
      module = new Function('"use strict"; return (' + source + ");")();
    } catch (err) {
      throw new Error("the code did not compile: " + (err && err.message ? err.message : err));
    }
    if (!module || typeof module !== "object")
      throw new Error("the code must evaluate to an object with params and build");
    if (typeof module.build !== "function")
      throw new Error("the code must define build(params, kernel)");

    const params = [];
    for (const raw of module.params || []) {
      if (!raw || typeof raw.key !== "string" || !raw.key)
        throw new Error("every parameter needs a key");

      // A parameter that names its alternatives is a switch, not a slider. The
      // value stored is still a number - the index - so nothing below here
      // needs to know the difference.
      if (Array.isArray(raw.options)) {
        if (raw.options.length < 2)
          throw new Error("'" + raw.key + "' needs at least two options");
        params.push({
          key: raw.key,
          label: typeof raw.label === "string" ? raw.label : raw.key,
          options: raw.options.map(String),
          def: Number.isFinite(raw.def) ? Math.round(raw.def) : 0,
          min: 0, max: raw.options.length - 1, step: 1, unit: "",
        });
        continue;
      }

      params.push({
        key: raw.key,
        label: typeof raw.label === "string" ? raw.label : raw.key,
        def: Number.isFinite(raw.def) ? raw.def : 0,
        min: Number.isFinite(raw.min) ? raw.min : 0,
        max: Number.isFinite(raw.max) ? raw.max : 100,
        step: Number.isFinite(raw.step) && raw.step > 0 ? raw.step : 1,
        unit: typeof raw.unit === "string" ? raw.unit : "mm",
      });
    }
    if (params.length > 40) throw new Error("a script may declare at most 40 parameters");
    return { module, params };
  }

  builders.Script = {
    //! Compiling is part of the check: a script that will not compile never
    //! reaches the kernel, and the parameters it declares are reconciled with
    //! the ones already stored before anything is built.
    precondition: f => {
      const source = F.code(f, "code", "");
      if (!source.trim()) return "there is no code to run";
      try {
        const { params } = compileScript(source);
        F.syncParams(f, params);
      } catch (err) {
        return err.message;
      }
      return null;
    },
    build: f => {
      const { module, params } = compileScript(F.code(f, "code", ""));
      const stored = F.paramValues(f);
      const values = {};
      for (const spec of params)
        values[spec.key] = clampTo(spec, stored[spec.key] ?? spec.def);

      const shape = module.build(values, shapeApi());
      if (!shape || typeof shape.IsNull !== "function" || shape.IsNull())
        throw new Error("build() must return a shape");
      return shape;
    },
  };

  // The same driver behind both: what differs is only the code it starts with.
  builders.Ribbon = builders.Script;
  builders.Center = builders.Script;

  /* ==========================================================================
     Data.

     Half of what follows builds no geometry at all. A Number, a Series, a bit
     of arithmetic - they compute, and what they compute is wired into the
     sliders of the features that do build. The other half runs the other way:
     a point taken off a curve, a length taken off a solid, back out as numbers.

     Lists travel through the data components. The solid components read the
     first item and say so; making a hundred cubes from a hundred numbers is a
     data tree, and this is not one.
     ========================================================================== */

  //! Grasshopper's longest-list rule: the shortest input repeats its last item
  //! until the longest is exhausted.
  function zip(lists) {
    const n = Math.max(1, ...lists.map(l => l.length));
    const out = [];
    for (let i = 0; i < n; i++)
      out.push(lists.map(l => (l.length ? l[Math.min(i, l.length - 1)] : 0)));
    return out;
  }

  const numbers = values => ({ kind: "number", values });
  const points = list => ({ kind: "point", values: list.flat() });
  const vectors = list => ({ kind: "vector", values: list.flat() });
  const text = lines => ({ kind: "text", values: [], lines });

  //! Every vertex of a shape, in the order OpenCascade walks them.
  //! The vertices a feature put there on purpose: the ones standing free in the
  //! shape, not the two at the ends of every edge. A curve made of two hundred
  //! segments has four hundred vertices and none of them is a point anybody
  //! asked for, so the search does not descend into edges.
  function verticesOf(shape) {
    const out = [];
    if (!shape) return out;
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(shape));
      return [[p.X(), p.Y(), p.Z()]];
    }
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, EDGE);
    const seen = new Set();
    while (explorer.More()) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(explorer.Current()));
      const key = p.X().toFixed(6) + "," + p.Y().toFixed(6) + "," + p.Z().toFixed(6);
      if (!seen.has(key)) { seen.add(key); out.push([p.X(), p.Y(), p.Z()]); }
      explorer.Next();
    }
    explorer.delete();
    return out;
  }

  //! The points arriving on an input: what the source computed if it computed
  //! points, and otherwise the vertices of whatever it built.
  function pointsFrom(source) {
    if (!source) return [];
    const data = F.data(source);
    if (data && data.stride === 3) return F.triples(data);
    return verticesOf(F.shape(source));
  }

  const compoundOf = shapes => {
    const builder = new oc.TopoDS_Builder();
    const compound = new oc.TopoDS_Compound();
    builder.MakeCompound(compound);
    for (const shape of shapes) if (shape) builder.Add(compound, shape);
    return compound;
  };
  const vertexAt = p => new oc.BRepBuilderAPI_MakeVertex(pnt(p)).Shape();
  const segment = (a, b) =>
    length([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) < CONFUSION
      ? null : new oc.BRepBuilderAPI_MakeEdge(pnt(a), pnt(b)).Shape();

  builders.Number = {
    build: f => ({ data: numbers([F.real(f, "value", 100)]) }),
  };

  builders.Series = {
    precondition: f => F.real(f, "count", 10) < 1 ? "a series needs at least one item" : null,
    build: f => {
      const start = F.real(f, "start", 0), step = F.real(f, "step", 10);
      const count = Math.max(1, Math.round(F.real(f, "count", 10)));
      return { data: numbers(Array.from({ length: count }, (_, i) => start + i * step)) };
    },
  };

  builders.Range = {
    build: f => {
      const from = F.real(f, "from", 0), to = F.real(f, "to", 1);
      const steps = Math.max(1, Math.round(F.real(f, "steps", 10)));
      // n steps means n + 1 stations, both bounds included - the way a range of
      // parameters along a curve has to come out.
      return { data: numbers(Array.from({ length: steps + 1 },
        (_, i) => from + (to - from) * (i / steps))) };
    },
  };

  const MATH_OPS = [
    (a, b) => a + b, (a, b) => a - b, (a, b) => a * b, (a, b) => a / b,
    (a, b) => Math.pow(a, b), Math.min, Math.max, (a, b) => a % b,
  ];

  builders.Math = {
    precondition: f => {
      const op = Feature_choice(f, "op");
      if ((op === 3 || op === 7) && F.reals(f, "b", 1).every(b => Math.abs(b) < 1e-12))
        return "B is zero, and this operation divides by it";
      return null;
    },
    build: f => {
      const apply = MATH_OPS[Feature_choice(f, "op")] || MATH_OPS[0];
      const pairs = zip([F.reals(f, "a", 1), F.reals(f, "b", 1)]);
      return { data: numbers(pairs.map(([a, b]) => {
        const v = apply(a, b);
        return Number.isFinite(v) ? v : 0;
      })) };
    },
  };

  builders.Expression = {
    //! Compiled before anything reads it, so a half-written formula reads as a
    //! syntax error rather than as a modelling failure.
    precondition: f => {
      const source = F.code(f, "formula", "").trim();
      if (!source) return "there is no formula";
      try { compileFormula(source); } catch (err) { return err.message; }
      return null;
    },
    build: f => {
      const evaluate = compileFormula(F.code(f, "formula", "").trim());
      const rows = zip([F.reals(f, "a", 1), F.reals(f, "b", 1), F.reals(f, "c", 0)]);
      return { data: numbers(rows.map(([a, b, c], i) => {
        const v = evaluate(a, b, c, i, rows.length);
        if (!Number.isFinite(v))
          throw new Error("the formula gave " + v + " at item " + (i + 1));
        return v;
      })) };
    },
  };

  //! One expression over a, b, c, and the position i in a list of n. Built with
  //! the same Function the written features use; it can read nothing it is not
  //! handed, so it cannot reach the document or the page.
  const formulaCache = new Map();
  function compileFormula(source) {
    if (formulaCache.has(source)) return formulaCache.get(source);
    let fn;
    try {
      fn = new Function("a", "b", "c", "i", "n", "Math",
        '"use strict"; return (' + source + ");");
    } catch (err) {
      throw new Error("the formula will not compile: " + (err.message || err));
    }
    const wrapped = (a, b, c, i, n) => {
      const v = fn(a, b, c, i, n, Math);
      if (typeof v !== "number") throw new Error("the formula gave " + typeof v + ", not a number");
      return v;
    };
    if (formulaCache.size > 60) formulaCache.clear();
    formulaCache.set(source, wrapped);
    return wrapped;
  }

  builders.Panel = {
    precondition: f => F.reference(f, "input") ? null : "nothing is wired into this panel",
    build: f => {
      const source = F.reference(f, "input");
      const data = F.data(source);
      if (data && (data.values.length || data.lines.length))
        return { data: text(dataLines(data)) };
      // Nothing computed: say what was built instead, which is still an answer.
      const shape = F.shape(source);
      if (!shape) return { data: text([F.name(source) + " has not been built"]) };
      const box = extents(shape);
      return { data: text([
        F.name(source) + " · " + shapeKind(shape),
        countSubShapes(shape, SOLID) + " solids · " + countSubShapes(shape, FACE) + " faces · "
          + countSubShapes(shape, EDGE) + " edges",
        box ? "size " + box.size.map(trim).join(" × ") + " mm" : "empty",
      ]) };
    },
  };

  /* ------------------------------------------------------------- curves */

  //! The wire of a curve-producing feature. An edge is promoted; anything else
  //! is refused by name rather than crashing the builder it was handed to.
  function wireOf(source, what) {
    const shape = source && F.shape(source);
    if (!shape) throw new Error("the " + what + " has not been built");
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) return oc.TopoDS.Wire(shape);
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE)
      return new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(shape)).Wire();
    const explorer = new oc.TopExp_Explorer(shape, EDGE, ANY);
    const maker = new oc.BRepBuilderAPI_MakeWire();
    let any = false;
    while (explorer.More()) { maker.Add(oc.TopoDS.Edge(explorer.Current())); any = true; explorer.Next(); }
    explorer.delete();
    if (!any) throw new Error("the " + what + " has no edges");
    return maker.Wire();
  }

  function firstFace(shape, what) {
    if (!shape) throw new Error("the " + what + " has not been built");
    const explorer = new oc.TopExp_Explorer(shape, FACE, ANY);
    if (!explorer.More()) { explorer.delete(); throw new Error("the " + what + " has no faces"); }
    const face = oc.TopoDS.Face(explorer.Current());
    explorer.delete();
    return face;
  }

  const subShapes = (shape, kind, cast) => {
    const explorer = new oc.TopExp_Explorer(shape, kind, ANY);
    const out = [];
    while (explorer.More()) { out.push(cast(explorer.Current())); explorer.Next(); }
    explorer.delete();
    return out;
  };

  //! Every face a profile offers, capping its wires if it offers none. What a
  //! solid is swept from.
  function capped(f, source) {
    const faces = subShapes(source, FACE, oc.TopoDS.Face);
    if (faces.length) return faces;
    const wires = subShapes(source, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopoDS.Wire);
    const out = [];
    for (const wire of wires.length ? wires : [wireOf(F.reference(f, "profile"), "profile")]) {
      try {
        const face = new oc.BRepBuilderAPI_MakeFace(wire, true);
        if (face.IsDone()) out.push(face.Face());
      } catch (e) { /* an open wire will not cap; it is not a solid */ }
    }
    // Nothing capped: sweep it open rather than fail, and say so by shape.
    return out.length ? out : wires;
  }

  //! Every wire a profile offers, taken off its faces when it has them. What a
  //! surface is swept from.
  function outlines(f, source) {
    const wires = subShapes(source, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopoDS.Wire);
    if (wires.length) return wires;
    return [wireOf(F.reference(f, "profile"), "profile")];
  }

  builders.Circle = {
    precondition: f => {
      if (!planeAxis(F.reference(f, "plane"))) return "a plane is needed to put the circle on";
      if (F.real(f, "radius", 60) <= CONFUSION) return "radius must be positive";
      return null;
    },
    build: f => {
      const axis = planeAxis(F.reference(f, "plane"));
      const edge = new oc.BRepBuilderAPI_MakeEdge(
        new oc.gp_Circ(axis, F.real(f, "radius", 60))).Edge();
      return new oc.BRepBuilderAPI_MakeWire(edge).Wire();
    },
  };

  //! Catmull-Rom through the points, parameterised by index so the curve may
  //! double back on itself, then sampled. OpenCascade's B-spline fitter wants a
  //! TColgp array this build does not export, so the smooth curve arrives as a
  //! fine run of segments - which is what it is drawn and lofted as anyway.
  function catmullRom(cps, closed, perSpan) {
    const n = cps.length;
    const at = i => cps[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
    const spans = closed ? n : n - 1;
    const out = [];
    for (let s = 0; s < spans; s++) {
      const [a, b, c, d] = [at(s - 1), at(s), at(s + 1), at(s + 2)];
      for (let j = 0; j < perSpan; j++) {
        const u = j / perSpan;
        out.push([0, 1, 2].map(k => 0.5 * ((2 * b[k]) + (-a[k] + c[k]) * u
          + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u * u
          + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u * u * u)));
      }
    }
    if (!closed) out.push(cps[n - 1]);
    return out;
  }

  builders.Polyline = {
    precondition: f => pointsFrom(F.reference(f, "points")).length < 2
      ? "a polyline needs at least two points" : null,
    build: f => {
      const list = pointsFrom(F.reference(f, "points"));
      return { shape: shapeApi().polyline(list, { closed: Feature_choice(f, "closed") === 1 }),
               data: points(list) };
    },
  };

  /* --------------------------------------------------------------- sketch

     A drawing in two dimensions, put on a plane. Everything in the drawing is
     written in the plane's own u-v coordinates, so this is the only place in
     the program where the sketch meets the world: the plane resolves to a
     gp_Ax2, every point in the drawing goes through it, and the edges are
     built there. Point the sketch at another plane and the whole drawing moves
     with it, because none of it was ever written in world coordinates.

     Edges are built through the points the chain walker hands over rather than
     from each element's own arithmetic. A drawing is full of hundredth-of-a-
     millimetre gaps and a wire will not close over one; welding the ends first
     and building an arc through three points on it means the wire closes
     exactly, and the arc is still a real arc rather than a run of segments. */

  //! The sketch's frame: the plane it is on, moved to the origin point if one
  //! is wired. Without a plane it lies on world XY, so a new sketch draws.
  function sketchFrame(f) {
    const axis = planeAxis(F.reference(f, "plane"))
      || new oc.gp_Ax2(pnt([0, 0, 0]), dir([0, 0, 1]));
    const X = axis.XDirection(), Y = axis.YDirection(), N = axis.Direction();
    const here = axis.Location();
    const origin = readPoint(F.reference(f, "origin")) || [here.X(), here.Y(), here.Z()];
    const x = [X.X(), X.Y(), X.Z()], y = [Y.X(), Y.Y(), Y.Z()], n = [N.X(), N.Y(), N.Z()];
    return {
      normal: n, x, y, origin,
      //! Two numbers on the paper, one point in the world.
      at: uv => V.add(origin, V.add(V.scale(x, uv[0]), V.scale(y, uv[1]))),
      //! A frame for a circle or an ellipse: on the plane, centred there, and
      //! turned in the plane by \p turn so an ellipse knows which way it lies.
      frame(uv, turn = 0) {
        const along = V.add(V.scale(x, Math.cos(turn)), V.scale(y, Math.sin(turn)));
        return new oc.gp_Ax2(pnt(this.at(uv)), dir(n), dir(along));
      },
    };
  }

  //! The drawing as the sketch will be built from it: read off the label, then
  //! relaxed against its own constraints unless that is switched off. The
  //! solved drawing is not written back - the constraints are the truth and
  //! this is what they come to, so nothing drifts by being rebuilt twice.
  function sketchDrawing(f) {
    const drawing = F.sketch(f, "drawing");
    if (Feature_choice(f, "solve") !== 0) return drawing;
    return solveSketch(drawing, Math.max(1, Math.round(F.real(f, "passes", 24)))).drawing;
  }

  const round4 = v => Math.round(v * 1e6) / 1e6;

  const straight = (frame, a, b) =>
    new oc.BRepBuilderAPI_MakeEdge(pnt(frame.at(a)), pnt(frame.at(b))).Edge();

  //! An arc through three of its own points. Its ends are exactly the ones the
  //! chain welded, whatever that did to the radius.
  function arcThrough(frame, a, via, b) {
    const arc = new oc.GC_MakeArcOfCircle(pnt(frame.at(a)), pnt(frame.at(via)), pnt(frame.at(b)));
    if (!arc.IsDone()) throw new Error("the arc is degenerate");
    return new oc.BRepBuilderAPI_MakeEdge(arc.Value()).Edge();
  }

  const runOfEdges = (frame, list) => {
    const out = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i], list[i + 1]];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > CONFUSION) out.push(straight(frame, a, b));
    }
    return out;
  };

  //! One element as edges, in the direction the chain walks it. \p a and \p b
  //! are the welded ends; a closed element has neither and is built from its
  //! own numbers.
  function sketchEdgesOf(el, frame, a, b) {
    switch (el.type) {
      case "point": return [];
      case "line":  return [straight(frame, a, b)];
      case "arc": {
        const via = sketchArcPoint(el, (el.a0 + el.a1) / 2);
        return [arcThrough(frame, a, via, b)];
      }
      case "circle":
        return [new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(frame.frame(el.c), el.r)).Edge()];
      case "ellipse": {
        // gp_Elips insists the major radius is the larger one; a taller
        // ellipse is the same ellipse turned a quarter turn.
        const tall = (el.ry || 0) > (el.rx || 0);
        const major = Math.max(el.rx, el.ry), minor = Math.min(el.rx, el.ry);
        const turn = (el.rot || 0) + (tall ? Math.PI / 2 : 0);
        return [new oc.BRepBuilderAPI_MakeEdge(
          new oc.gp_Elips(frame.frame(el.c, turn), major, minor)).Edge()];
      }
      case "oblong": {
        // Two straights and a half turn at either end - built through points so
        // the four meet exactly.
        const along = V.norm([el.b[0] - el.a[0], el.b[1] - el.a[1], 0]) || [1, 0, 0];
        const side = [-along[1], along[0]];
        const r = el.r;
        const off = (c, k, m) => [c[0] + side[0] * r * k + along[0] * r * m,
                                  c[1] + side[1] * r * k + along[1] * r * m];
        const b1 = off(el.b, -1, 0), b2 = off(el.b, 1, 0);
        const a1 = off(el.a, 1, 0), a2 = off(el.a, -1, 0);
        return [arcThrough(frame, b1, off(el.b, 0, 1), b2),
                straight(frame, b2, a1),
                arcThrough(frame, a1, off(el.a, 0, -1), a2),
                straight(frame, a2, b1)];
      }
      case "spline": {
        const run = splinePoints(el, 12);
        if (run.length < 2) return [];
        const walk = a && b ? [a, ...run.slice(1, -1), b] : run;
        return runOfEdges(frame, walk);
      }
      default: return [];
    }
  }

  //! A chain of elements as one wire. If the exact edges will not join - a
  //! spline doubling back on itself, an arc the weld made degenerate - the
  //! chain is rebuilt as a fine polyline through the same drawing, because a
  //! wire that closes is worth more than a wire that is analytic.
  function sketchWire(drawing, chain, frame, closed) {
    const run = sketchChainEnds(drawing, chain, closed);
    const edges = [];
    for (const step of run) {
      const walked = step.reversed
        ? { ...step.el, ...reverseElement(step.el) } : step.el;
      edges.push(...sketchEdgesOf(walked, frame, step.a, step.b));
    }
    if (!edges.length) return null;
    const maker = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of edges) maker.Add(edge);
    if (maker.IsDone()) return maker.Wire();

    const walk = [];
    for (const step of run) {
      const line = sketchOutlineOf(step.el, step.reversed);
      for (const p of line) if (!walk.length || Math.hypot(p[0] - walk[walk.length - 1][0],
                                                           p[1] - walk[walk.length - 1][1]) > 1e-6)
        walk.push(p);
    }
    if (walk.length < 2) return null;
    const fallback = new oc.BRepBuilderAPI_MakeWire();
    for (const edge of runOfEdges(frame, closed ? [...walk, walk[0]] : walk)) fallback.Add(edge);
    return fallback.IsDone() ? fallback.Wire() : null;
  }

  //! An element walked backwards.
  //!
  //! Only a spline needs one. A line and an arc are built from the welded ends
  //! the walk hands over, and those are already in the order it walks them, so
  //! turning the element round as well turns it back. An arc especially: its
  //! sweep is a pair of angles that only ever increases, so there is no way to
  //! write [a1, a0] at all - the arc's own numbers say which arc it is, and the
  //! ends say which way along it. Writing a0 = a1, a1 = a0 + 2*pi did have a
  //! meaning, and it was a three-quarter turn the other way round.
  function reverseElement(el) {
    if (el.type === "spline") return { pts: (el.pts || []).slice().reverse() };
    return {};
  }

  function sketchOutlineOf(el, reversed) {
    const line = sketchOutline(el, 64);
    return reversed ? line.slice().reverse() : line;
  }

  builders.Sketch = {
    precondition: f => {
      // The frame is written before anything can go wrong with the drawing,
      // because an empty sketch is exactly the one you need it for: without it
      // the viewport cannot turn a click into two numbers, and a sketch you
      // cannot click on is a sketch you can never draw the first line on.
      const frame = sketchFrame(f);
      F.setFrame(f, { origin: frame.origin.map(round4), x: frame.x.map(round4),
                      y: frame.y.map(round4), normal: frame.normal.map(round4) });
      const drawing = F.sketch(f, "drawing");
      const elements = drawing.elements || [];
      if (!elements.length) return "the sketch is empty - draw something on it";
      if (!elements.some(el => sketchEnds(el)))
        return "the sketch has only points in it - draw a line, an arc or a circle";
      return null;
    },
    build: f => {
      const api = shapeApi();
      const drawing = sketchDrawing(f);
      const frame = sketchFrame(f);
      const { loops, open } = sketchLoops(drawing, 0.05);
      const wanted = Feature_choice(f, "faces") === 0;

      // A closed loop becomes a planar face, and that face is what a pad is
      // extruded from - so everything the sketcher closes is pad-ready without
      // anyone asking for a surface. A loop drawn inside another is a hole in
      // it rather than a second plate, and a loop inside a hole is solid again:
      // the nesting is counted, not guessed.
      const wires = loops.map(loop => sketchWire(drawing, loop, frame, true));
      const nesting = sketchNesting(drawing, loops);
      const shapes = [];
      for (let i = 0; i < loops.length; i++) {
        const wire = wires[i];
        if (!wire) continue;
        if (!wanted) { shapes.push(wire); continue; }
        if (nesting[i].hole) continue;              // built into its outline below
        try {
          const maker = new oc.BRepBuilderAPI_MakeFace(wire, true);
          if (!maker.IsDone()) { shapes.push(wire); continue; }
          let face = maker.Face();
          for (let j = 0; j < loops.length; j++) {
            if (!wires[j] || !nesting[j].hole || nesting[j].parent !== i) continue;
            // A hole runs against its outline, or OpenCascade takes it for a
            // second outline and the face comes back bigger, not smaller.
            const cut = new oc.BRepBuilderAPI_MakeFace(face, oc.TopoDS.Wire(wires[j].Reversed()));
            if (cut.IsDone()) face = cut.Face();
          }
          shapes.push(face);
        } catch (e) { shapes.push(wire); }
      }
      for (const chain of open) {
        const wire = sketchWire(drawing, chain, frame, false);
        if (wire) shapes.push(wire);
      }
      if (!shapes.length) throw new Error("nothing in the sketch could be built");

      // The points someone put in the sketch come out as points, so a sketch
      // is also a way of laying out a row of locations on a plane.
      const marks = (drawing.elements || []).filter(el => el.type === "point")
        .map(el => frame.at(el.p));
      const shape = shapes.length === 1 ? shapes[0] : api.compound(shapes);
      return marks.length ? { shape, data: points(marks) } : shape;
    },
  };

  builders.Interpolate = {
    precondition: f => pointsFrom(F.reference(f, "points")).length < 3
      ? "an interpolated curve needs at least three points" : null,
    build: f => {
      const list = pointsFrom(F.reference(f, "points"));
      const closed = Feature_choice(f, "closed") === 1;
      // Degree is what it means here: 1 is the polyline itself, higher degrees
      // ask for a finer sampling of the same spline.
      const perSpan = Math.max(1, Math.round(F.real(f, "degree", 3)) * 6);
      const run = catmullRom(list, closed, perSpan);
      return { shape: shapeApi().polyline(run, { closed }), data: points(list) };
    },
  };

  /* ----------------------------------------------------------- analysis */

  //! A curve sampled densely, with the running length at every sample - enough
  //! to answer both "where is parameter t" and "where is half way along".
  function sampleCurve(wire, samples = 400) {
    const curve = new oc.BRepAdaptor_CompCurve(wire);
    const first = curve.FirstParameter(), last = curve.LastParameter();
    const at = u => {
      const p = curve.Value(first + (last - first) * Math.max(0, Math.min(1, u)));
      return [p.X(), p.Y(), p.Z()];
    };
    const run = [], lengths = [0];
    for (let i = 0; i <= samples; i++) run.push(at(i / samples));
    for (let i = 1; i < run.length; i++)
      lengths.push(lengths[i - 1] + length([run[i][0] - run[i - 1][0],
        run[i][1] - run[i - 1][1], run[i][2] - run[i - 1][2]]));
    const total = lengths[lengths.length - 1];

    //! The parameter at a fraction of the arc length, found in the table.
    const byLength = fraction => {
      const want = total * Math.max(0, Math.min(1, fraction));
      let i = 1;
      while (i < lengths.length && lengths[i] < want) i++;
      const lo = lengths[i - 1], hi = lengths[i] !== undefined ? lengths[i] : lo;
      const span = hi - lo;
      return ((i - 1) + (span > 1e-12 ? (want - lo) / span : 0)) / samples;
    };
    return { at, byLength, total, tangent: u => {
      const step = 1e-4;
      const a = at(Math.max(0, u - step)), b = at(Math.min(1, u + step));
      return V.norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) || [1, 0, 0];
    } };
  }

  builders.EvaluateCurve = {
    precondition: f => F.reference(f, "curve") ? null : "no curve to evaluate",
    build: f => {
      const curve = sampleCurve(wireOf(F.reference(f, "curve"), "curve"));
      const draw = F.real(f, "tangent", 40);
      const hits = F.reals(f, "t", 0.5).map(t => {
        const u = Math.max(0, Math.min(1, t));
        return { point: curve.at(u), tangent: curve.tangent(u) };
      });
      const parts = [];
      for (const hit of hits) {
        parts.push(vertexAt(hit.point));
        if (draw > CONFUSION)
          parts.push(segment(hit.point, V.add(hit.point, V.scale(hit.tangent, draw))));
      }
      return { shape: compoundOf(parts.filter(Boolean)), data: points(hits.map(h => h.point)) };
    },
  };

  builders.DivideCurve = {
    precondition: f => {
      if (!F.reference(f, "curve")) return "no curve to divide";
      if (F.real(f, "count", 10) < 1) return "a curve cannot be divided into less than one";
      return null;
    },
    build: f => {
      const curve = sampleCurve(wireOf(F.reference(f, "curve"), "curve"));
      const count = Math.max(1, Math.round(F.real(f, "count", 10)));
      const inclusive = Feature_choice(f, "ends") === 0;
      const list = [];
      // Divisions, not points: n divisions give n + 1 stations with the ends in.
      const stations = inclusive ? count + 1 : count - 1;
      for (let i = 0; i < Math.max(1, stations); i++)
        list.push(curve.at(curve.byLength(inclusive
          ? (stations > 1 ? i / (stations - 1) : 0)
          : (i + 1) / count)));
      return { shape: compoundOf(list.map(vertexAt)), data: points(list) };
    },
  };

  builders.EvaluateSurface = {
    precondition: f => F.reference(f, "surface") ? null : "no surface to evaluate",
    build: f => {
      const face = firstFace(F.shape(F.reference(f, "surface")), "surface");
      const surface = new oc.BRepAdaptor_Surface(face, true);
      const u0 = surface.FirstUParameter(), u1 = surface.LastUParameter();
      const v0 = surface.FirstVParameter(), v1 = surface.LastVParameter();
      const draw = F.real(f, "normal", 40);
      const at = (su, sv) => {
        const p = surface.Value(u0 + (u1 - u0) * su, v0 + (v1 - v0) * sv);
        return [p.X(), p.Y(), p.Z()];
      };
      const rows = zip([F.reals(f, "u", 0.5), F.reals(f, "v", 0.5)]);
      const parts = [], list = [];
      for (const [su, sv] of rows) {
        const u = Math.max(0, Math.min(1, su)), v = Math.max(0, Math.min(1, sv));
        const here = at(u, v);
        list.push(here);
        parts.push(vertexAt(here));
        if (draw > CONFUSION) {
          // The normal from two steps across the surface: no D1 binding needed,
          // and it degrades to nothing rather than throwing at a seam.
          const step = 1e-3;
          const du = V.add(at(Math.min(1, u + step), v), V.scale(here, -1));
          const dv = V.add(at(u, Math.min(1, v + step)), V.scale(here, -1));
          const normal = V.norm(V.cross(du, dv));
          if (normal) parts.push(segment(here, V.add(here, V.scale(normal, draw))));
        }
      }
      return { shape: compoundOf(parts.filter(Boolean)), data: points(list) };
    },
  };

  builders.Measure = {
    precondition: f => {
      const source = F.reference(f, "shape");
      if (!source) return "nothing to measure";
      const data = F.data(source);
      if (data && data.kind === "mesh") return null;      // a mesh has no B-Rep
      if (!F.shape(source)) return F.name(source) + " has not been built";
      return null;
    },
    build: f => {
      const source = F.reference(f, "shape");
      const meshData = F.data(source);
      if (meshData && meshData.kind === "mesh") return { data: numbers([measureMesh(f, meshData)]) };
      const shape = F.shape(source);
      const quantity = Feature_choice(f, "quantity");
      if (quantity <= 2) {
        const props = new oc.GProp_GProps();
        if (quantity === 0) oc.BRepGProp.LinearProperties(shape, props, false, false);
        else if (quantity === 1) oc.BRepGProp.SurfaceProperties(shape, props, false, false);
        else oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
        const value = props.Mass();
        props.delete();
        return { data: numbers([Number.isFinite(value) ? value : 0]) };
      }
      const box = extents(shape);
      if (!box) return { data: numbers([0]) };
      return { data: numbers([quantity === 6 ? box.diagonal : box.size[quantity - 3]]) };
    },
  };

  /* ==========================================================================
     Polymesh.

     A different kind of geometry from everything above it. A B-Rep has a
     surface under every face and OpenCascade owns it; a polymesh is a list of
     points and a list of faces of any number of sides, and nothing owns it but
     this file. That is what makes it something you can shove a vertex around
     in, and what makes Catmull-Clark possible in the first place.

     A mesh travels as { points: [[x,y,z], …], faces: [[i, j, k, …], …] }, and
     is stored as a flat TDataStd_RealArray beside a TDataStd_IntegerArray
     packed [sides, i, j, …].
     ========================================================================== */

  const packMesh = mesh => ({
    kind: "mesh",
    values: mesh.points.flat(),
    faces: mesh.faces.flatMap(face => [face.length, ...face]),
  });

  //! The mesh arriving on an input, unpacked. Anything that is not a mesh -
  //! a list of points, say - is refused by name rather than half-read.
  function meshFrom(source, what) {
    if (!source) throw new Error("no " + what + " is wired in");
    const data = F.data(source);
    if (!data || data.kind !== "mesh")
      throw new Error(F.name(source) + " is not a mesh");
    const points = F.triples(data);
    return { points, faces: meshFaces(data) };
  }

  const meshCounts = mesh => mesh.points.length + " vertices, " + mesh.faces.length + " faces";

  //! A guard every mesh driver runs before it hands anything on. A mesh with a
  //! face pointing at a vertex that is not there will take the renderer down
  //! two features later, where nothing explains it.
  function checkMesh(mesh, what) {
    if (!mesh.points.length) throw new Error("the " + what + " has no vertices");
    for (const face of mesh.faces)
      for (const index of face)
        if (!Number.isInteger(index) || index < 0 || index >= mesh.points.length)
          throw new Error("the " + what + " has a face pointing at vertex " + index
            + ", and there are only " + mesh.points.length);
    if (mesh.points.length > 400000)
      throw new Error(mesh.points.length + " vertices is more than this kernel will carry");
    return mesh;
  }

  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vmul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const centroid = list => vmul(list.reduce(vadd, [0, 0, 0]), 1 / Math.max(1, list.length));

  //! Newell's normal: right for an n-gon, and right for one that is not quite
  //! flat, which after a few hand edits none of them are.
  function faceNormal(points, face) {
    let n = [0, 0, 0];
    for (let i = 0; i < face.length; i++) {
      const a = points[face[i]], b = points[face[(i + 1) % face.length]];
      n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]),
           n[1] + (a[2] - b[2]) * (a[0] + b[0]),
           n[2] + (a[0] - b[0]) * (a[1] + b[1])];
    }
    return V.norm(n) || [0, 0, 1];
  }

  const faceArea = (points, face) => {
    let n = [0, 0, 0];
    for (let i = 0; i < face.length; i++) {
      const a = points[face[i]], b = points[face[(i + 1) % face.length]];
      n = [n[0] + (a[1] * b[2] - a[2] * b[1]),
           n[1] + (a[2] * b[0] - a[0] * b[2]),
           n[2] + (a[0] * b[1] - a[1] * b[0])];
    }
    return 0.5 * Math.hypot(n[0], n[1], n[2]);
  };

  //! Signed volume by the divergence theorem, fanning each face from its first
  //! vertex. Only means anything on a mesh that is actually closed.
  const meshVolume = mesh => {
    let total = 0;
    for (const face of mesh.faces)
      for (let i = 1; i + 1 < face.length; i++) {
        const [a, b, c] = [mesh.points[face[0]], mesh.points[face[i]], mesh.points[face[i + 1]]];
        total += (a[0] * (b[1] * c[2] - b[2] * c[1])
                - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
    return Math.abs(total);
  };

  //! Averaged face normals, weighted by nothing - the mesh is a cage, and a
  //! cage's normals only have to be good enough to light it.
  function vertexNormals(mesh) {
    const normals = mesh.points.map(() => [0, 0, 0]);
    for (const face of mesh.faces) {
      const n = faceNormal(mesh.points, face);
      for (const index of face) normals[index] = vadd(normals[index], n);
    }
    return normals.map(n => V.norm(n) || [0, 0, 1]);
  }

  /* ------------------------------------------------------- the half-edges */

  //! Every directed edge in the mesh, and the face it belongs to. An edge whose
  //! reverse is missing is an open edge: the boundary of a hole, or of a sheet.
  function edgeMap(mesh) {
    const used = new Map();                 // "a,b" -> face index
    const key = (a, b) => a + "," + b;
    mesh.faces.forEach((face, at) => {
      for (let i = 0; i < face.length; i++)
        used.set(key(face[i], face[(i + 1) % face.length]), at);
    });
    const open = [];
    for (const [pair] of used) {
      const [a, b] = pair.split(",").map(Number);
      if (!used.has(key(b, a))) open.push([a, b]);
    }
    return { used, open, isOpen: (a, b) => !used.has(key(b, a)) || !used.has(key(a, b)) };
  }

  /* --------------------------------------------------------- Catmull-Clark */

  //! One level of Catmull-Clark, for faces of any number of sides.
  //!
  //!   face point    the average of the face's vertices
  //!   edge point    the average of its two ends and the two face points
  //!                 beside it - or, on an open edge, the midpoint
  //!   vertex point  (F + 2R + (n-3)V) / n, where F is the average of the
  //!                 touching face points, R of the touching edge midpoints
  //!                 and n the valence - or, on the boundary, (E1 + 6V + E2)/8
  //!
  //! Every face then becomes one quad per corner. \p sharpBoundary keeps an
  //! open edge where it is instead of letting it creep inwards.
  function catmullClark(mesh, sharpBoundary) {
    const { points, faces } = mesh;
    const facePoints = faces.map(face => centroid(face.map(i => points[i])));

    // Every undirected edge once, with the faces on either side of it.
    const edges = new Map();
    const key = (a, b) => (a < b ? a + "," + b : b + "," + a);
    faces.forEach((face, at) => {
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        const k = key(a, b);
        if (!edges.has(k)) edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
        edges.get(k).faces.push(at);
      }
    });

    const out = [];
    const facePointIndex = facePoints.map(p => (out.push(p), out.length - 1));
    const edgePointIndex = new Map();
    for (const [k, edge] of edges) {
      const mid = vmul(vadd(points[edge.a], points[edge.b]), 0.5);
      const open = edge.faces.length < 2;
      const p = open ? mid
        : vmul(vadd(vadd(points[edge.a], points[edge.b]),
                    vadd(facePoints[edge.faces[0]], facePoints[edge.faces[1]])), 0.25);
      out.push(p);
      edgePointIndex.set(k, out.length - 1);
    }

    // What each original vertex touches, and whether it sits on an open edge.
    const touchingFaces = points.map(() => []);
    const touchingEdges = points.map(() => []);
    faces.forEach((face, at) => { for (const i of face) touchingFaces[i].push(at); });
    for (const [, edge] of edges) {
      touchingEdges[edge.a].push(edge);
      touchingEdges[edge.b].push(edge);
    }

    const movedIndex = points.map((v, i) => {
      const boundary = touchingEdges[i].filter(e => e.faces.length < 2);
      let moved;
      if (boundary.length >= 2) {
        // On the boundary the surface is a curve, and it is subdivided as one.
        if (sharpBoundary) moved = v;
        else {
          const ends = boundary.slice(0, 2).map(e =>
            vmul(vadd(points[e.a], points[e.b]), 0.5));
          moved = vmul(vadd(vadd(ends[0], ends[1]), vmul(v, 6)), 1 / 8);
        }
      } else {
        const n = touchingEdges[i].length;
        if (n < 3) moved = v;
        else {
          const Fp = centroid(touchingFaces[i].map(at => facePoints[at]));
          const R = centroid(touchingEdges[i].map(e =>
            vmul(vadd(points[e.a], points[e.b]), 0.5)));
          moved = vmul(vadd(vadd(Fp, vmul(R, 2)), vmul(v, n - 3)), 1 / n);
        }
      }
      out.push(moved);
      return out.length - 1;
    });

    const newFaces = [];
    faces.forEach((face, at) => {
      for (let i = 0; i < face.length; i++) {
        const prev = face[(i - 1 + face.length) % face.length];
        const here = face[i];
        const next = face[(i + 1) % face.length];
        newFaces.push([
          movedIndex[here],
          edgePointIndex.get(key(here, next)),
          facePointIndex[at],
          edgePointIndex.get(key(prev, here)),
        ]);
      }
    });
    return { points: out, faces: newFaces };
  }

  /* ----------------------------------------------------------------- weld */

  //! Merges vertices that sit within \p tolerance of each other by rounding them
  //! into a grid and keeping the first of each cell. The neighbouring cells are
  //! checked too, so two points either side of a cell wall still meet.
  function weldMesh(mesh, tolerance, dropDegenerate) {
    const size = Math.max(1e-9, tolerance);
    const cells = new Map();
    const remap = new Array(mesh.points.length);
    const points = [];

    mesh.points.forEach((p, i) => {
      const c = p.map(v => Math.floor(v / size));
      let found = -1;
      for (let dx = -1; dx <= 1 && found < 0; dx++)
        for (let dy = -1; dy <= 1 && found < 0; dy++)
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            const bucket = cells.get((c[0] + dx) + "," + (c[1] + dy) + "," + (c[2] + dz));
            if (!bucket) continue;
            for (const candidate of bucket)
              if (length(vsub(points[candidate], p)) <= tolerance) { found = candidate; break; }
          }
      if (found < 0) {
        points.push(p);
        found = points.length - 1;
        const k = c.join(",");
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(found);
      }
      remap[i] = found;
    });

    const faces = [];
    for (const face of mesh.faces) {
      // A run of the same vertex is one vertex now; a face left with fewer than
      // three has collapsed.
      const walked = [];
      for (const i of face) {
        const to = remap[i];
        if (!walked.length || walked[walked.length - 1] !== to) walked.push(to);
      }
      while (walked.length > 1 && walked[0] === walked[walked.length - 1]) walked.pop();
      if (walked.length >= 3 || !dropDegenerate) faces.push(walked);
    }
    return { points, faces: faces.filter(face => face.length >= 3),
             merged: mesh.points.length - points.length,
             dropped: mesh.faces.length - faces.filter(face => face.length >= 3).length };
  }

  /* ------------------------------------------------------------ hole fill */

  //! Chains the open edges into loops and closes each one. A loop is walked by
  //! following the open edge that leaves the vertex the last one arrived at, so
  //! a hole with a pinch in it comes out as two loops rather than one bad face.
  //! Every closed run of open edges. A hole with a pinch in it comes out as two
  //! loops rather than one bad face, because the walk follows the open edge
  //! leaving the vertex it just arrived at and never uses one twice.
  function boundaryLoops(mesh, maxEdges = 100000) {
    const { open } = edgeMap(mesh);
    const leaving = new Map();
    for (const [a, b] of open) {
      if (!leaving.has(a)) leaving.set(a, []);
      leaving.get(a).push(b);
    }
    const walked = new Set();
    const loops = [], abandoned = [];
    for (const [start] of leaving) {
      let here = start;
      const loop = [];
      while (leaving.has(here)) {
        const next = (leaving.get(here) || []).find(to => !walked.has(here + "," + to));
        if (next === undefined) break;
        walked.add(here + "," + next);
        loop.push(here);
        here = next;
        if (here === start || loop.length > maxEdges) break;
      }
      if (loop.length >= 3 && here === start && loop.length <= maxEdges) loops.push(loop);
      else if (loop.length) abandoned.push(loop);
    }
    return { loops, abandoned };
  }

  function fillHoles(mesh, maxEdges, fan) {
    const points = mesh.points.slice();
    const faces = mesh.faces.slice();
    const { loops, abandoned } = boundaryLoops(mesh, maxEdges);

    for (const loop of loops) {
      // The loop runs the way the open edges do, so the patch faces the other
      // way - reversed, it agrees with the faces around it.
      const ring = loop.slice().reverse();
      if (fan && ring.length > 4) {
        points.push(centroid(ring.map(i => points[i])));
        const middle = points.length - 1;
        for (let i = 0; i < ring.length; i++)
          faces.push([middle, ring[i], ring[(i + 1) % ring.length]]);
      } else {
        faces.push(ring);
      }
    }
    return { points, faces, filled: loops.length, skipped: abandoned.length };
  }

  /* --------------------------------------------------------- mesh sources */

  //! A box as a cage of quads. Each face is a grid, and the grids share their
  //! edges, so the box welds to itself without being welded.
  function boxMesh(dx, dy, dz, segX, segY, segZ, place) {
    const points = [];
    const index = new Map();
    const at = (i, j, k) => {
      const key = i + "," + j + "," + k;
      if (!index.has(key)) {
        points.push(place([dx * i / segX, dy * j / segY, dz * k / segZ]));
        index.set(key, points.length - 1);
      }
      return index.get(key);
    };
    const faces = [];
    const quad = (a, b, c, d) => faces.push([a, b, c, d]);
    for (let i = 0; i < segX; i++) for (let j = 0; j < segY; j++) {
      quad(at(i, j, 0), at(i, j + 1, 0), at(i + 1, j + 1, 0), at(i + 1, j, 0));
      quad(at(i, j, segZ), at(i + 1, j, segZ), at(i + 1, j + 1, segZ), at(i, j + 1, segZ));
    }
    for (let i = 0; i < segX; i++) for (let k = 0; k < segZ; k++) {
      quad(at(i, 0, k), at(i + 1, 0, k), at(i + 1, 0, k + 1), at(i, 0, k + 1));
      quad(at(i, segY, k), at(i, segY, k + 1), at(i + 1, segY, k + 1), at(i + 1, segY, k));
    }
    for (let j = 0; j < segY; j++) for (let k = 0; k < segZ; k++) {
      quad(at(0, j, k), at(0, j, k + 1), at(0, j + 1, k + 1), at(0, j + 1, k));
      quad(at(segX, j, k), at(segX, j + 1, k), at(segX, j + 1, k + 1), at(segX, j, k + 1));
    }
    return { points, faces };
  }

  //! The axis system a mesh source is laid out on: the plane gives the
  //! orientation, the point the position, and the same fallback as everywhere
  //! else when either is missing.
  function meshFrame(originFeature, planeFeature) {
    const at = readPoint(originFeature) || [0, 0, 0];
    const axis = planeAxis(planeFeature);
    if (!axis) return p => vadd(at, p);
    const o = axis.Location(), z = axis.Direction(), x = axis.XDirection(), y = axis.YDirection();
    const O = [o.X(), o.Y(), o.Z()], X = [x.X(), x.Y(), x.Z()];
    const Y = [y.X(), y.Y(), y.Z()], Z = [z.X(), z.Y(), z.Z()];
    // The plane orients; the point positions, measured from the plane's origin.
    const shift = originFeature ? vsub(at, O) : [0, 0, 0];
    return p => vadd(vadd(O, shift),
      vadd(vadd(vmul(X, p[0]), vmul(Y, p[1])), vmul(Z, p[2])));
  }

  builders.MeshBox = {
    precondition: f => {
      for (const key of ["dx", "dy", "dz"])
        if (F.real(f, key, 120) <= CONFUSION) return "every side must be longer than nothing";
      return null;
    },
    build: f => {
      const seg = key => Math.max(1, Math.round(F.real(f, key, 1)));
      const place = meshFrame(F.reference(f, "origin"), F.reference(f, "plane"));
      const mesh = boxMesh(F.real(f, "dx", 120), F.real(f, "dy", 120), F.real(f, "dz", 120),
                           seg("segX"), seg("segY"), seg("segZ"), place);
      return { data: packMesh(checkMesh(mesh, "box")) };
    },
  };

  builders.MeshGrid = {
    precondition: f => {
      if (F.real(f, "width", 400) <= CONFUSION || F.real(f, "depth", 400) <= CONFUSION)
        return "the grid must have a size";
      return null;
    },
    build: f => {
      const cols = Math.max(1, Math.round(F.real(f, "cols", 6)));
      const rows = Math.max(1, Math.round(F.real(f, "rows", 6)));
      const w = F.real(f, "width", 400), d = F.real(f, "depth", 400);
      const place = meshFrame(null, F.reference(f, "plane"));
      const points = [], faces = [];
      for (let j = 0; j <= rows; j++)
        for (let i = 0; i <= cols; i++)
          points.push(place([-w / 2 + w * i / cols, -d / 2 + d * j / rows, 0]));
      const at = (i, j) => j * (cols + 1) + i;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++)
          faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
      return { data: packMesh(checkMesh({ points, faces }, "grid")) };
    },
  };

  builders.MeshFromShape = {
    precondition: f => {
      const source = F.reference(f, "shape");
      if (!source) return "nothing is wired in to tessellate";
      if (!F.shape(source)) return F.name(source) + " has not been built";
      if (countSubShapes(F.shape(source), FACE) === 0)
        return F.name(source) + " has no faces to tessellate";
      return null;
    },
    //! OpenCascade tessellates per face and gives every face its own copy of
    //! the shared vertices, so the result is a pile of triangles rather than a
    //! mesh. Welding is what turns it into one, and is on by default.
    build: f => {
      const shape = F.shape(F.reference(f, "shape"));
      const quality = Math.max(0.05, F.real(f, "quality", 1));
      const stream = tessellate(shape, deflectionFor(shape) / quality);
      if (!stream.positions || !stream.index || !stream.index.length)
        throw new Error("the tessellation came back empty");
      const points = [];
      for (let i = 0; i + 2 < stream.positions.length; i += 3)
        points.push([stream.positions[i], stream.positions[i + 1], stream.positions[i + 2]]);
      const faces = [];
      for (let i = 0; i + 2 < stream.index.length; i += 3)
        faces.push([stream.index[i], stream.index[i + 1], stream.index[i + 2]]);
      let mesh = { points, faces };
      if (Feature_choice(f, "weld") === 0) {
        const box = extents(shape);
        mesh = weldMesh(mesh, Math.max(1e-4, (box ? box.diagonal : 100) * 1e-5), true);
      }
      return { data: packMesh(checkMesh(mesh, "tessellation")) };
    },
  };

  /* ----------------------------------------------------- mesh operations */

  builders.EditMesh = {
    precondition: f => F.reference(f, "mesh") ? null : "no mesh to edit",
    //! The hand edits, applied. An offset for a vertex that is no longer there -
    //! because something upstream changed the topology - is left alone rather
    //! than thrown away, so putting the upstream back puts the edit back.
    build: f => {
      const mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      const moves = F.edits(f, "moves");
      const scale = F.real(f, "scale", 1);
      const points = mesh.points.map(p => p.slice());
      let applied = 0, stale = 0;
      for (const [index, offset] of Object.entries(moves)) {
        const at = Number(index);
        if (!(at >= 0 && at < points.length)) { stale++; continue; }
        points[at] = vadd(points[at], vmul(offset, scale));
        applied++;
      }
      if (stale && !applied)
        throw new Error(stale + " moved vertices are no longer in this mesh - "
          + "the mesh upstream has " + points.length);
      return { data: packMesh(checkMesh({ points, faces: mesh.faces }, "mesh")) };
    },
  };

  builders.Subdivide = {
    precondition: f => {
      const source = F.reference(f, "mesh");
      if (!source) return "no mesh to subdivide";
      if (Feature_choice(f, "on") === 1) return null;
      const data = F.data(source);
      const faces = data ? meshFaces(data).length : 0;
      const levels = Math.max(1, Math.round(F.real(f, "levels", 2)));
      // Every level multiplies the face count by the number of corners. Four
      // levels of a thousand quads is a quarter of a million faces, and the
      // level after that is where the tab stops responding.
      const after = faces * Math.pow(4, levels);
      if (after > 150000)
        return "level " + levels + " of this mesh would be about "
          + Math.round(after / 1000) + "k faces; use fewer levels or a coarser cage";
      return null;
    },
    build: f => {
      let mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      if (Feature_choice(f, "on") === 0) {
        const levels = Math.max(1, Math.round(F.real(f, "levels", 2)));
        const sharp = Feature_choice(f, "boundary") === 0;
        for (let i = 0; i < levels; i++) mesh = catmullClark(mesh, sharp);
      }
      const data = packMesh(checkMesh(mesh, "mesh"));
      data.smooth = Feature_choice(f, "shading") === 0;
      return { data };
    },
  };

  builders.Weld = {
    //! The same rule the fillet radius follows: judge it against the geometry
    //! before the operation runs, not by whether the result looks empty
    //! afterwards. A tolerance past a quarter of the mesh is never a weld.
    precondition: f => {
      const source = F.reference(f, "mesh");
      if (!source) return "no mesh to weld";
      const data = F.data(source);
      if (!data || data.kind !== "mesh") return F.name(source) + " is not a mesh";
      const points = F.triples(data);
      if (!points.length) return F.name(source) + " has no vertices";
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of points)
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
      const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const tolerance = F.real(f, "tolerance", 0.05);
      if (diagonal > CONFUSION && tolerance >= diagonal / 4)
        return "welding at " + trim(tolerance) + " mm would take most of a mesh only "
          + trim(diagonal) + " mm across; the limit here is " + trim(diagonal / 4) + " mm";
      return null;
    },
    build: f => {
      const mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      const welded = weldMesh(mesh, Math.max(1e-6, F.real(f, "tolerance", 0.05)),
                              Feature_choice(f, "degenerate") === 0);
      if (!welded.faces.length && mesh.faces.length)
        throw new Error("that distance welds the whole mesh into nothing");
      return { data: packMesh(checkMesh(welded, "mesh")) };
    },
  };

  builders.FillHoles = {
    precondition: f => F.reference(f, "mesh") ? null : "no mesh to fill",
    build: f => {
      const mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      const filled = fillHoles(mesh, Math.max(3, Math.round(F.real(f, "maxEdges", 64))),
                               Feature_choice(f, "fill") === 1);
      return { data: packMesh(checkMesh(filled, "mesh")) };
    },
  };

  /* ----------------------------------------------------------- amalgamate

     What a subdivision workflow actually wants when two cages meet. A CSG
     boolean would cut them against each other exactly and hand back a seam of
     triangles, which is right for a solid and useless as a cage: Catmull-Clark
     wants quads, and a triangle fan round the join pinches under it. So this
     does what a modeller does by hand - throws away the faces where the two
     run into each other, and bridges the openings left behind.

     For an exact boolean, do it on the B-Rep side and come back: Boolean, then
     MeshFromShape. That gives the right solid and a tessellation of it.
     ------------------------------------------------------------------------ */

  //! Every triangle of a mesh, for ray casting. Faces are fanned, which is
  //! exact for a convex n-gon and close enough for a cage's slightly bent ones.
  function trianglesOf(mesh) {
    const out = [];
    for (const face of mesh.faces)
      for (let i = 1; i + 1 < face.length; i++)
        out.push([mesh.points[face[0]], mesh.points[face[i]], mesh.points[face[i + 1]]]);
    return out;
  }

  //! Moller-Trumbore. Returns the distance along the ray, or null.
  function rayHitsTriangle(from, dir, [a, b, c]) {
    const e1 = vsub(b, a), e2 = vsub(c, a);
    const h = V.cross(dir, e2);
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) return null;                 // parallel
    const inv = 1 / det;
    const s = vsub(from, a);
    const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
    if (u < 0 || u > 1) return null;
    const q = V.cross(s, e1);
    const v = inv * (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]);
    if (v < 0 || u + v > 1) return null;
    const t = inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
    return t > 1e-9 ? t : null;
  }

  // A direction chosen to line up with nothing: an axis-aligned ray through an
  // axis-aligned cage hits edges, and an edge hit is counted twice or not at all.
  const ODD_RAY = V.norm([0.5773502692, 0.3313007813, 0.7457221543]);

  //! Odd number of crossings, so it is inside. Only worth using on a mesh that
  //! is closed; on an open one it answers something, but not this question.
  function insideMesh(point, triangles) {
    let crossings = 0;
    for (const triangle of triangles)
      if (rayHitsTriangle(point, ODD_RAY, triangle) !== null) crossings++;
    return (crossings & 1) === 1;
  }

  //! The distance from a point to the nearest triangle of a mesh, and the
  //! direction to it. Brute force over the triangles: a cage is a few hundred.
  function nearestOn(point, triangles) {
    let best = Infinity, at = null;
    for (const [a, b, c] of triangles) {
      const n = V.norm(V.cross(vsub(b, a), vsub(c, a)));
      if (!n) continue;
      const away = vsub(point, a);
      const off = away[0] * n[0] + away[1] * n[1] + away[2] * n[2];
      // The foot of the perpendicular, clamped back into the triangle by
      // falling to the nearest corner when it lands outside.
      const foot = vsub(point, vmul(n, off));
      const inside = [[a, b], [b, c], [c, a]].every(([p, q]) => {
        const edge = vsub(q, p), to = vsub(foot, p);
        const cross = V.cross(edge, to);
        return cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] >= -1e-9;
      });
      const candidates = inside ? [foot] : [a, b, c];
      for (const candidate of candidates) {
        const d = length(vsub(point, candidate));
        if (d < best) { best = d; at = candidate; }
      }
    }
    return { distance: best, at };
  }

  //! Two open loops, sewn together. Equal lengths give quads all the way round;
  //! unequal ones walk both loops in step and drop in a triangle wherever one
  //! side has to catch up, which is what a bridge between mismatched loops is.
  function bridgeLoops(A, B) {
    const n = A.length, m = B.length;
    const faces = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      const ta = i < n ? (i + 1) / n : Infinity;
      const tb = j < m ? (j + 1) / m : Infinity;
      // Wound against the loops, not with them. A boundary loop follows the
      // free directed edges of the faces around it, so a bridge that runs the
      // same way leaves the edge free a second time and the rim stays open.
      if (i < n && j < m && Math.abs(ta - tb) < 1e-9) {
        faces.push([A[(i + 1) % n], A[i], B[j], B[(j + 1) % m]]);
        i++; j++;
      } else if (ta < tb) {
        faces.push([A[(i + 1) % n], A[i], B[j % m]]);
        i++;
      } else {
        faces.push([A[i % n], B[j], B[(j + 1) % m]]);
        j++;
      }
    }
    return faces;
  }

  //! Which vertex of B to start at so the bridge does not come out twisted:
  //! the rotation that puts the two loops closest to each other overall.
  function alignLoops(points, A, B) {
    let best = 0, shortest = Infinity;
    for (let k = 0; k < B.length; k++) {
      let total = 0;
      for (let i = 0; i < A.length; i++) {
        const b = B[(k + Math.round(i * B.length / A.length)) % B.length];
        total += length(vsub(points[A[i]], points[b]));
        if (total >= shortest) break;
      }
      if (total < shortest) { shortest = total; best = k; }
    }
    return best;
  }

  const rotated = (loop, by) =>
    loop.map((_, i) => loop[(((i + by) % loop.length) + loop.length) % loop.length]);

  builders.MeshMerge = {
    precondition: f => {
      for (const key of ["a", "b"]) {
        const source = F.reference(f, key);
        if (!source) return "both meshes are needed - " + key.toUpperCase() + " is empty";
        const data = F.data(source);
        if (!data || data.kind !== "mesh") return F.name(source) + " is not a mesh";
        if (!data.values.length) return F.name(source) + " has no vertices";
      }
      const size = ["a", "b"].reduce((n, key) =>
        n + meshFaces(F.data(F.reference(f, key))).length, 0);
      // Both tests are brute force over the other mesh's triangles. Two cages
      // are a few hundred faces; two tessellations are a hundred thousand, and
      // that is a different algorithm, not a slower one.
      if (size > 6000)
        return size + " faces is more than this merge will walk - it compares every "
          + "face against the whole of the other mesh. Merge the cages, then subdivide.";
      return null;
    },

    build: f => {
      const A = meshFrom(F.reference(f, "a"), "mesh A");
      const B = meshFrom(F.reference(f, "b"), "mesh B");
      const mode = Feature_choice(f, "mode");

      // One mesh, B's indices moved up behind A's.
      const shift = A.points.length;
      const points = A.points.concat(B.points);
      const faces = A.faces.concat(B.faces.map(face => face.map(i => i + shift)));
      const fromA = faces.map((_, at) => at < A.faces.length);

      const trianglesA = trianglesOf(A), trianglesB = trianglesOf(B);
      const distance = F.real(f, "distance", 40);
      const squareOn = F.real(f, "facing", 0.35);

      //! Whether a face is in the way of the other mesh: either its middle is
      //! inside it, or it is close to it and pointing at it.
      const inTheWay = (face, mine, theirs, triangles) => {
        const middle = centroid(face.map(i => points[i]));
        if (mode === 0) return insideMesh(middle, triangles);
        const near = nearestOn(middle, triangles);
        if (!(near.distance <= distance) || !near.at) return false;
        const towards = V.norm(vsub(near.at, middle));
        if (!towards) return true;
        const n = faceNormal(points, face);
        return n[0] * towards[0] + n[1] * towards[1] + n[2] * towards[2] >= squareOn;
      };

      const doomed = faces.map((face, at) =>
        inTheWay(face, at, null, fromA[at] ? trianglesB : trianglesA));
      const removed = doomed.filter(Boolean).length;
      if (!removed)
        throw new Error(mode === 0
          ? "neither cage reaches inside the other, so nothing was removed - move them "
            + "together, or switch to facing within a distance"
          : "no face is within " + trim(distance) + " mm of the other cage and pointing at it");
      if (removed === faces.length)
        throw new Error("that would remove every face of both cages");

      // The vertices the removed faces touched: only the loops around those are
      // the ones this operation made, and only those get bridged.
      const touched = new Set();
      faces.forEach((face, at) => { if (doomed[at]) for (const i of face) touched.add(i); });

      const kept = faces.filter((_, at) => !doomed[at]);
      const keptFromA = faces.map((_, at) => at).filter(at => !doomed[at]).map(at => fromA[at]);
      let merged = { points, faces: kept };

      if (Feature_choice(f, "bridge") === 0) {
        const { loops } = boundaryLoops(merged, 4000);
        // A loop belongs to whichever cage its vertices came from, and it is one
        // of ours only if the faces we removed were the ones that opened it.
        const ours = loops.filter(loop => loop.every(i => touched.has(i)));
        const sideA = ours.filter(loop => loop[0] < shift);
        const sideB = ours.filter(loop => loop[0] >= shift);
        if (!sideA.length || !sideB.length)
          throw new Error("removing those faces left " + sideA.length + " opening"
            + (sideA.length === 1 ? "" : "s") + " on A and " + sideB.length + " on B, "
            + "so there is nothing to bridge across - try the other way of choosing faces");

        const flip = Feature_choice(f, "flip") === 1;
        const twist = Math.round(F.real(f, "twist", 0));
        const spare = sideB.slice();
        const bridged = [];
        for (const loop of sideA) {
          // Each opening on A joins the nearest one left on B.
          const middle = centroid(loop.map(i => points[i]));
          let best = 0, shortest = Infinity;
          spare.forEach((other, at) => {
            const d = length(vsub(middle, centroid(other.map(i => points[i]))));
            if (d < shortest) { shortest = d; best = at; }
          });
          if (!spare.length) break;
          const partner = spare.splice(best, 1)[0];
          // The two loops run the way their own faces wind, which is opposite
          // across the join; one is turned round so the bridge does not knot.
          const facing = flip ? partner.slice() : partner.slice().reverse();
          const aligned = rotated(facing, alignLoops(points, loop, facing) + twist);
          bridged.push(...bridgeLoops(loop, aligned));
        }
        if (!bridged.length)
          throw new Error("the openings could not be bridged");
        merged = { points, faces: kept.concat(bridged) };
      }

      const weld = F.real(f, "weld", 0.05);
      if (weld > 1e-9) merged = weldMesh(merged, weld, true);
      // A merge that leaves nothing standing is a mistake, not a result.
      if (!merged.faces.length) throw new Error("nothing was left of either cage");
      return { data: packMesh(checkMesh(merged, "merged mesh")) };
    },
  };

  builders.MeshTransform = {
    precondition: f => {
      if (!F.reference(f, "mesh")) return "no mesh to move";
      if (Math.abs(F.real(f, "scale", 1)) < 1e-6) return "a scale of zero leaves nothing";
      return null;
    },
    build: f => {
      const mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      const scale = F.real(f, "scale", 1);
      const move = [F.real(f, "mx", 0), F.real(f, "my", 0), F.real(f, "mz", 0)];
      const [rx, ry, rz] = ["rx", "ry", "rz"].map(k => F.real(f, k, 0) * Math.PI / 180);
      const turn = (p, angle, i, j) => {
        const c = Math.cos(angle), s = Math.sin(angle);
        const out = p.slice();
        out[i] = p[i] * c - p[j] * s;
        out[j] = p[i] * s + p[j] * c;
        return out;
      };
      // About the mesh's own middle, so turning it does not fling it away.
      const middle = centroid(mesh.points);
      const points = mesh.points.map(p => {
        let q = vmul(vsub(p, middle), scale);
        q = turn(q, rx, 1, 2);
        q = turn(q, ry, 2, 0);
        q = turn(q, rz, 0, 1);
        return vadd(vadd(q, middle), move);
      });
      return { data: packMesh(checkMesh({ points, faces: mesh.faces }, "mesh")) };
    },
  };

  builders.MeshDisplace = {
    precondition: f => {
      if (!F.reference(f, "mesh")) return "no mesh to displace";
      const source = F.code(f, "formula", "").trim();
      if (!source) return "there is no formula";
      try { compileDisplacement(source); } catch (err) { return err.message; }
      return null;
    },
    build: f => {
      const mesh = meshFrom(F.reference(f, "mesh"), "mesh");
      const evaluate = compileDisplacement(F.code(f, "formula", "").trim());
      const amount = F.real(f, "amount", 20);
      const along = Feature_choice(f, "along");
      const normals = along === 0 ? vertexNormals(mesh) : null;
      const axis = [null, [1, 0, 0], [0, 1, 0], [0, 0, 1]][along] || [0, 0, 1];
      const n = mesh.points.length;
      const points = mesh.points.map((p, i) => {
        const k = evaluate(p[0], p[1], p[2], i, n);
        if (!Number.isFinite(k))
          throw new Error("the formula gave " + k + " at vertex " + i);
        return vadd(p, vmul(normals ? normals[i] : axis, k * amount));
      });
      return { data: packMesh(checkMesh({ points, faces: mesh.faces }, "mesh")) };
    },
  };

  //! One expression over a vertex's own position, and where it sits in the list.
  //! Compiled the same guarded way the written features are.
  const displacementCache = new Map();
  function compileDisplacement(source) {
    if (displacementCache.has(source)) return displacementCache.get(source);
    let fn;
    try {
      fn = new Function("x", "y", "z", "i", "n", "Math",
        '"use strict"; return (' + source + ");");
    } catch (err) {
      throw new Error("the formula will not compile: " + (err.message || err));
    }
    const wrapped = (x, y, z, i, n) => {
      const v = fn(x, y, z, i, n, Math);
      if (typeof v !== "number") throw new Error("the formula gave " + typeof v + ", not a number");
      return v;
    };
    if (displacementCache.size > 60) displacementCache.clear();
    displacementCache.set(source, wrapped);
    return wrapped;
  }

  //! The same seven quantities off a polymesh. Length is the total length of
  //! its edges, area the sum of its polygons, volume the divergence-theorem
  //! answer - which only means something on a mesh that is closed.
  function measureMesh(f, data) {
    const mesh = { points: F.triples(data), faces: meshFaces(data) };
    const quantity = Feature_choice(f, "quantity");
    if (quantity === 0) {
      let total = 0;
      const seen = new Set();
      for (const face of mesh.faces)
        for (let i = 0; i < face.length; i++) {
          const a = face[i], b = face[(i + 1) % face.length];
          const key = a < b ? a + "," + b : b + "," + a;
          if (seen.has(key)) continue;
          seen.add(key);
          total += length(vsub(mesh.points[a], mesh.points[b]));
        }
      return total;
    }
    if (quantity === 1) return mesh.faces.reduce((n, face) => n + faceArea(mesh.points, face), 0);
    if (quantity === 2) return meshVolume(mesh);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.points)
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    const size = [0, 1, 2].map(i => (Number.isFinite(hi[i] - lo[i]) ? hi[i] - lo[i] : 0));
    return quantity === 6 ? Math.hypot(...size) : size[quantity - 3];
  }

  /* ================================================================ lists

     The four primitives a graph needs before it can compose anything: a list
     you type, a group, a projection onto terrain, and a way to put one shape
     at many places. Without them a definition of any size falls back to a
     written feature, and a written feature takes no inputs - so it stops being
     part of the graph at all.
     ================================================================== */

  builders.Numbers = {
    precondition: f => parseNumbers(F.text(f, "values", "")).length
      ? null : "type some numbers, separated by commas or spaces",
    build: f => {
      const scale = F.real(f, "scale", 1);
      return { data: numbers(parseNumbers(F.text(f, "values", "")).map(v => v * scale)) };
    },
  };

  builders.Join = {
    precondition: f => {
      const parts = F.references(f, "parts");
      if (!parts.length) return "nothing is wired in to join";
      for (const part of parts)
        if (!F.shape(part)) return F.name(part) + " has not been built";
      return null;
    },
    //! A compound, not a fuse. The parts keep their own faces and nothing is
    //! recomputed - which is what a group is for.
    build: f => compoundOf(F.references(f, "parts").map(F.shape)),
  };

  //! Triangles to cast against, whether the target is a mesh or a solid. A
  //! solid is tessellated once, here, at the resolution the viewer would use.
  function targetTriangles(source, what) {
    const data = F.data(source);
    if (data && data.kind === "mesh")
      return trianglesOf({ points: F.triples(data), faces: meshFaces(data) });
    const shape = F.shape(source);
    if (!shape) throw new Error(F.name(source) + " has not been built");
    const stream = tessellate(shape, 0);
    if (!stream.positions || !stream.index || !stream.index.length)
      throw new Error("there is no surface on " + F.name(source) + " to land on");
    const out = [];
    const at = i => [stream.positions[i * 3], stream.positions[i * 3 + 1], stream.positions[i * 3 + 2]];
    for (let i = 0; i + 2 < stream.index.length; i += 3)
      out.push([at(stream.index[i]), at(stream.index[i + 1]), at(stream.index[i + 2])]);
    return out;
  }

  builders.Drape = {
    precondition: f => {
      if (!F.reference(f, "points")) return "no points to drape";
      if (!F.reference(f, "onto")) return "nothing to drape them onto";
      return null;
    },
    //! Straight down, and the highest thing hit wins - so a point over an
    //! overhang lands on the top of it, the way a building sits on a hill
    //! rather than inside it.
    build: f => {
      const plan = pointsFrom(F.reference(f, "points"));
      if (!plan.length) throw new Error("that input carries no points");
      const triangles = targetTriangles(F.reference(f, "onto"), "target");
      if (!triangles.length) throw new Error("the target has no surface to land on");

      let high = -Infinity;
      for (const [a, b, c] of triangles) high = Math.max(high, a[2], b[2], c[2]);
      const start = high + 1;
      const down = [0, 0, -1];
      const lift = F.real(f, "lift", 0);
      const keep = Feature_choice(f, "miss") === 1;

      const landed = [];
      let missed = 0;
      for (const point of plan) {
        const from = [point[0], point[1], start];
        let best = null;
        for (const triangle of triangles) {
          const t = rayHitsTriangle(from, down, triangle);
          if (t === null) continue;
          const z = start - t;
          if (best === null || z > best) best = z;
        }
        if (best === null) { missed++; if (keep) landed.push([point[0], point[1], point[2] + lift]); continue; }
        landed.push([point[0], point[1], best + lift]);
      }
      if (!landed.length)
        throw new Error("not one of those " + plan.length + " points is over the target");
      if (missed && !keep && landed.length < plan.length)
        F.setError(f, "");                       // a partial drape is still a drape
      return { shape: compoundOf(landed.map(vertexAt)), data: points(landed) };
    },
  };

  builders.PlaceAt = {
    precondition: f => {
      const shape = F.reference(f, "shape");
      if (!shape) return "no shape to place";
      if (!F.shape(shape)) return F.name(shape) + " has not been built";
      const at = F.reference(f, "points");
      if (!at) return "no points to place it at";
      if (!pointsFrom(at).length) return F.name(at) + " carries no points";
      return null;
    },
    //! One shape, many locations. Each copy is the same TopoDS_Shape with a
    //! different TopLoc_Location on it - the instancing the Array feature uses,
    //! so the cost of the hundredth copy is a matrix, not a rebuild.
    build: f => {
      const shape = F.shape(F.reference(f, "shape"));
      const at = pointsFrom(F.reference(f, "points"));
      const angles = F.reference(f, "angles");
      const turns = angles ? (F.data(angles) || { values: [] }).values : [];
      const base = F.real(f, "turn", 0);
      const lift = F.real(f, "lift", 0);
      if (at.length > 2000)
        throw new Error(at.length + " places is more than this will build at once");

      const api = shapeApi();
      const copies = at.map((point, i) => {
        // The angle list is read the way every other list is: the shortest
        // repeats its last value, so one angle turns them all.
        const turn = base + (turns.length ? turns[Math.min(i, turns.length - 1)] : 0);
        const turned = Math.abs(turn) > 1e-9
          ? api.rotate(shape, turn, { at: [0, 0, 0], axis: [0, 0, 1] })
          : shape;
        return api.move(turned, [point[0], point[1], point[2] + lift]);
      });
      return compoundOf(copies);
    },
  };

  /* --------------------------------------------------------- operations */

  builders.Extrude = {
    precondition: f => {
      const profile = F.reference(f, "profile");
      if (!profile) return "no profile to extrude";
      if (!F.shape(profile)) return F.name(profile) + " has not been built";
      if (!readVector(F.reference(f, "direction"))) return "a direction vector is needed";
      if (Math.abs(F.real(f, "distance", 120)) <= CONFUSION) return "distance must not be zero";
      return null;
    },
    build: f => {
      const api = shapeApi();
      const source = F.shape(F.reference(f, "profile"));
      const solid = Feature_choice(f, "cap") === 0;
      const v = V.norm(readVector(F.reference(f, "direction")));
      const along = V.scale(v, F.real(f, "distance", 120));

      // Solid or surface is a real choice, not a hint. A pad is swept from the
      // faces of the profile - every one of them, so a sketch of six closed
      // loops pads into six bodies rather than the first. A surface is swept
      // from the wires, so the same sketch on "Surface" gives six tubes; a
      // profile that arrived as a face has its own outlines taken back off it.
      const bases = solid ? capped(f, source) : outlines(f, source);
      if (!bases.length) throw new Error("the profile has nothing to extrude");
      const swept = bases.map(base => api.prism(base, along));
      return swept.length === 1 ? swept[0] : api.compound(swept);
    },
  };

  builders.Loft = {
    precondition: f => {
      const sections = F.references(f, "sections");
      if (sections.length < 2) return "a loft needs at least two sections";
      for (const section of sections)
        if (!F.shape(section)) return F.name(section) + " has not been built";
      return null;
    },
    build: f => shapeApi().loft(
      F.references(f, "sections").map(s => wireOf(s, "section")),
      { solid: Feature_choice(f, "cap") === 0, ruled: Feature_choice(f, "ruled") === 1 }),
  };

  builders.Boolean = {
    precondition: f => {
      for (const key of ["a", "b"]) {
        const source = F.reference(f, key);
        if (!source) return "both bodies are needed - " + key.toUpperCase() + " is empty";
        if (!F.shape(source)) return F.name(source) + " has not been built";
        if (countSubShapes(F.shape(source), FACE) === 0)
          return F.name(source) + " has no faces to work with";
      }
      return null;
    },
    build: f => {
      const api = shapeApi();
      const a = F.shape(F.reference(f, "a")), b = F.shape(F.reference(f, "b"));
      const op = Feature_choice(f, "op");
      const shape = op === 0 ? api.fuse(a, b) : op === 1 ? api.cut(a, b) : api.common(a, b);
      if (countSubShapes(shape, FACE) === 0)
        throw new Error("the two bodies do not meet, so the result is empty");
      return shape;
    },
  };

  builders.Project = {
    precondition: f => {
      if (!F.reference(f, "curve")) return "no curve to project";
      const onto = F.reference(f, "onto");
      if (!onto) return "nothing to project onto";
      if (!F.shape(onto)) return F.name(onto) + " has not been built";
      if (countSubShapes(F.shape(onto), FACE) === 0)
        return F.name(onto) + " has no faces to land on";
      return null;
    },
    //! Sampled, pulled to the target, and re-fitted. An exact projected curve
    //! needs BRepProj_Projection, which this kernel does not carry; the nearest
    //! point on the target is exact at every sample, and the samples are yours.
    build: f => {
      const curve = sampleCurve(wireOf(F.reference(f, "curve"), "curve"));
      const target = F.shape(F.reference(f, "onto"));
      const count = Math.max(4, Math.round(F.real(f, "samples", 40)));
      const surfaces = [];
      const explorer = new oc.TopExp_Explorer(target, FACE, ANY);
      while (explorer.More()) {
        surfaces.push(oc.BRep_Tool.Surface(oc.TopoDS.Face(explorer.Current())));
        explorer.Next();
      }
      explorer.delete();
      if (!surfaces.length) throw new Error("the target has no surface to land on");

      const list = [];
      for (let i = 0; i <= count; i++) {
        const here = curve.at(i / count);
        let best = null, nearest = Infinity;
        for (const surface of surfaces) {
          const onto = new oc.GeomAPI_ProjectPointOnSurf(pnt(here), surface);
          if (onto.NbPoints() > 0 && onto.LowerDistance() < nearest) {
            const p = onto.NearestPoint();
            nearest = onto.LowerDistance();
            best = [p.X(), p.Y(), p.Z()];
          }
          onto.delete();
        }
        if (best) list.push(best);
      }
      if (list.length < 2) throw new Error("nothing of that curve lands on the target");
      const smooth = Feature_choice(f, "fit") === 0;
      const run = smooth && list.length > 3 ? catmullRom(list, false, 3) : list;
      return { shape: shapeApi().polyline(run, { closed: false }), data: points(list) };
    },
  };

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

  //! Polymesh in, the same vertex stream out. Faces of any number of sides are
  //! fanned into triangles for drawing only - the mesh itself keeps its n-gons,
  //! and every edge of every polygon is sent as a line so the cage reads as the
  //! cage rather than as the triangles it was drawn with.
  //!
  //! The unsplit vertices go too, under `vertices`: those are the ones a handle
  //! can be put on, and their positions in that list are the indices a hand edit
  //! is written against.
  function streamMesh(data) {
    const points = F.triples(data);
    const faces = meshFaces(data);
    const out = { shape: "mesh", vertices: points.flat(), faceCount: faces.length };

    const smooth = data.smooth === true;
    const normals = smooth ? vertexNormals({ points, faces }) : null;
    const positions = [], normalOut = [], index = [];
    for (const face of faces) {
      const n = smooth ? null : faceNormal(points, face);
      // Flat shading needs its own copy of each corner; smooth shading could
      // share them, but a fan is written the same way either way.
      const base = positions.length / 3;
      for (const at of face) {
        positions.push(points[at][0], points[at][1], points[at][2]);
        const vn = smooth ? normals[at] : n;
        normalOut.push(vn[0], vn[1], vn[2]);
      }
      for (let i = 1; i + 1 < face.length; i++) index.push(base, base + i, base + i + 1);
    }
    out.positions = positions;
    out.normals = normalOut;
    out.index = index;
    out.triangles = index.length / 3;

    const seen = new Set();
    const edges = [];
    for (const face of faces)
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        const key = a < b ? a + "," + b : b + "," + a;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(points[a][0], points[a][1], points[a][2],
                   points[b][0], points[b][1], points[b][2]);
      }
    out.edges = edges;
    return out;
  }

  //! B-Rep in, vertex stream out - the whole contract with the viewer.
  //! The enum arrives as "TopAbs_SOLID" and the native kernel reports "solid",
  //! so a client reads one vocabulary whichever kernel answered.
  const shapeKind = shape => String(shape.ShapeType()).replace(/^TopAbs_/, "").toLowerCase();

  function tessellate(shape, deflection) {
    const out = {};
    if (!shape || shape.IsNull()) return out;

    out.shape = shapeKind(shape);
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

    // A point feature may hold one vertex or two hundred; a vertex carries no
    // triangles, so each one is sent as a location for the viewer to mark.
    const marks = verticesOf(shape);
    if (marks.length) {
      out.points = marks.flat();
      out.point = marks[0];
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

    //! Editing a script is an edit of the document, undone and redone and saved
    //! like any other.
    //! One vertex, moved. The offset lands on whichever argument of the feature
    //! holds hand edits, so a feature that has none refuses it by name.
    async moveVertex(id, index, offset) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      const arg = F.spec(f).args.find(a => a.kind === "edits");
      if (!arg) throw new Error(F.name(f) + " does not hold hand edits - put an "
        + "EditMesh after it and move the vertex there");
      const zero = !offset || offset.every(v => Math.abs(v) < 1e-9);
      F.moveVertex(f, arg.key, index, zero ? null : offset);
      doc.log.touch(F.argLabel(f, arg.key, true));
      return state(doc.recompute(false));
    },

    async setCode(id, key, text) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.setCode(f, key, text);
      return state(doc.recompute(false));
    },

    //! The drawing on a sketch. One string in, the whole sketch and everything
    //! downstream of it rebuilt - which is the same road the tree, the node
    //! editor and someone typing into the model file all take.
    async setSketch(id, key, drawing) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      const arg = key || (F.spec(f).args.find(a => a.kind === "sketch") || {}).key;
      if (!arg) throw new Error(F.name(f) + " has nothing to draw on");
      doc.setSketch(f, arg, drawing);
      return state(doc.recompute(false));
    },

    //! Wiring. An input that takes one wire is set; an input that takes several
    //! gets another. Passing no target clears - all of them, or the one named.
    async setReference(id, key, target, remove = false) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      if (remove || !target) doc.clearReference(f, key, target ? doc.find(target) : null);
      else doc.setReference(f, key, doc.find(target));
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

    //! What a feature should look like. No rebuild follows - appearance is not
    //! geometry - so the tree comes back with no regeneration report.
    async setAppearance(id, appearance) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.setAppearance(f, appearance);
      return { ok: true, tree: doc.treeJson(), report: null };
    },

    //! The scene as STEP, for taking into any other CAD system. Every visible
    //! solid is transferred as its own root, so the parts stay separate rather
    //! than arriving as one lump.
    async exportStep() {
      const parts = [];
      for (const f of doc.features()) {
        if (!F.visible(f)) continue;
        const shape = F.shape(f);
        // Datums are construction geometry and have no business in a solid
        // exchange file.
        if (shape && countSubShapes(shape, SOLID) > 0) parts.push({ f, shape });
      }
      if (!parts.length) {
        // A polymesh is not a solid and STEP does not carry one. Say which
        // rather than "nothing to export" when the scene is plainly full.
        const meshes = doc.features().filter(f => {
          const data = F.data(f);
          return F.visible(f) && data && data.kind === "mesh";
        });
        if (meshes.length)
          throw new Error("STEP carries solids, and everything visible here is a polymesh - "
            + meshes.map(F.name).join(", ") + ". Put a MeshFromShape the other way round, or "
            + "export the mesh from the showroom instead.");
        throw new Error("there is nothing solid in the scene to export");
      }

      const writer = new oc.STEPControl_Writer();
      if (oc.Interface_Static)
        oc.Interface_Static.SetCVal("write.step.unit", doc.units === "m" ? "M" : "MM");

      for (const part of parts) {
        const status = writer.Transfer(part.shape,
          oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange());
        if (String(status) !== "IFSelect_RetDone")
          throw new Error("OpenCascade could not transfer " + F.name(part.f) + " to STEP");
      }

      const path = "/export.step";
      if (String(writer.Write(path)) !== "IFSelect_RetDone")
        throw new Error("OpenCascade could not write the STEP file");
      const text = oc.FS.readFile(path, { encoding: "utf8" });
      try { oc.FS.unlink(path); } catch (err) { /* the scratch file is not important */ }

      return { ok: true, text, solids: parts.length, name: doc.title, units: doc.units };
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
        const data = F.data(f);
        let mesh = {};
        try {
          // A polymesh is drawn from its own polygons; there is no B-Rep under
          // it to tessellate.
          mesh = data && data.kind === "mesh" ? streamMesh(data) : tessellate(shape, 0);
        } catch (err) {
          mesh = { meshError: describeError(err) };
        }
        features.push({
          id, type: spec.type, name: F.name(f), revision: F.revision(f),
          built: !!shape || !!(data && data.kind === "mesh"), visible: F.visible(f), ...mesh,
        });
      }
      return { ok: true, features };
    },
  };
}
