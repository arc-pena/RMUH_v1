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

import { CATALOGUE, Doc, Driver, F, clampTo, dataLines, kernelMessage, schemaJson,
         typeSpec } from "./ocaf.js";

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
      if (!F.shape(source)) return F.name(source) + " has not been built";
      return null;
    },
    build: f => {
      const shape = F.shape(F.reference(f, "shape"));
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

      // A face extrudes to a solid; a wire has to be capped first, and if it
      // will not cap it is swept open and comes out as a surface.
      let base = null;
      if (countSubShapes(source, FACE) > 0) base = firstFace(source, "profile");
      else {
        const wire = wireOf(F.reference(f, "profile"), "profile");
        if (solid) { try { base = api.face(wire); } catch (e) { base = null; } }
        if (!base) base = wire;
      }
      return api.prism(base, along);
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
    async setCode(id, key, text) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      doc.setCode(f, key, text);
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
      if (!parts.length) throw new Error("there is nothing solid in the scene to export");

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
