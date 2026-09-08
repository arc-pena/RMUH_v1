// The two factories.
//
// CATIA splits its geometry API in two, and the split is the right one: a
// HybridShapeFactory that makes wireframe and surfaces, and a ShapeFactory that
// makes and cuts solids. Everything that is not a solid is hybrid; everything
// that is, is not. Nothing else needs saying to know which half a thing lives
// in, and a person who knows CATIA already knows where to look.
//
// The point of naming them is that they become a surface with a shape, rather
// than a pile of calls. Every operation here is DECLARED - a name, what it
// takes, what it gives back, one sentence - and the declaration and the
// implementation are the same object, so they cannot drift. That declaration is
// what the kernel publishes, what the node editor's catalogue is built on top
// of, and what the assistant is handed when it is asked to build something. One
// definition, three readers.
//
// The layering it buys:
//
//     factory (HSF / SF)   the geometry, and only the geometry
//            |             knows nothing about documents, labels or features
//     OCAF driver          reads the arguments off the labels, calls one
//            |             factory operation, hands back the shape
//     node element         the catalogue entry: what it is called, what it
//                          takes, and which driver runs it
//
// A driver that reaches past the factory into OpenCascade is a driver doing two
// jobs, and the reason a "point on curve" and a "point at the centre" ended up
// with two different ideas of what a curve is.

/* ------------------------------------------------------------------ maths */

export const CONFUSION = 1e-7;

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0]],
  length: a => Math.hypot(a[0], a[1], a[2]),
  norm(a) { const l = V.length(a); return l < 1e-9 ? null : V.scale(a, 1 / l); },
};

//! Rodrigues: \p v turned \p angle about \p axis.
export function turnAbout(v, axis, angle) {
  const k = V.norm(axis);
  if (!k) return v;
  const c = Math.cos(angle), s = Math.sin(angle);
  const along = V.dot(v, k);
  const cross = V.cross(k, v);
  return [v[0] * c + cross[0] * s + k[0] * along * (1 - c),
          v[1] * c + cross[1] * s + k[1] * along * (1 - c),
          v[2] * c + cross[2] * s + k[2] * along * (1 - c)];
}

/* ------------------------------------------------------------- the tables

   Each entry is the operation AND its declaration. `run` is what gets called;
   the rest is what gets published. They are the same object, so a signature
   cannot describe an operation that is not there and an operation cannot exist
   without saying what it is.                                                */

//! One factory, built from its table. The result is callable as
//! `hsf.pointCoord(...)` and readable as `hsf.$manifest`.
function assemble(table, kind) {
  const api = { $kind: kind, $manifest: [] };
  for (const entry of table) {
    api[entry.name] = entry.run;
    api.$manifest.push({ name: entry.name, takes: entry.takes,
                         gives: entry.gives, summary: entry.summary });
  }
  Object.freeze(api.$manifest);
  return api;
}

//! Both factories, over one OpenCascade. \p kit carries the handful of things
//! that need the shape utilities living in the kernel - reading a wire off a
//! shape, listing its vertices - so the factory never has to know how a
//! document stores anything.
export function makeFactories(oc, kit) {
  const { wireOf, verticesOf, compoundOf, tessellationOf, deflectionFor,
          smallestSolidExtent } = kit;
  const pnt = p => new oc.gp_Pnt(p[0], p[1], p[2]);
  const dir = d => new oc.gp_Dir(d[0], d[1], d[2]);
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const WIRE = oc.TopAbs_ShapeEnum.TopAbs_WIRE;
  const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;

  const count = (shape, of) => {
    const walk = new oc.TopExp_Explorer(shape, of, ANY);
    let n = 0;
    while (walk.More()) { n++; walk.Next(); }
    walk.delete();
    return n;
  };
  const each = (shape, of, cast) => {
    const walk = new oc.TopExp_Explorer(shape, of, ANY);
    const out = [];
    while (walk.More()) { out.push(cast(walk.Current())); walk.Next(); }
    walk.delete();
    return out;
  };
  const positive = (value, what) => {
    if (!(value > CONFUSION)) throw new Error(what + " must be greater than zero");
    return value;
  };
  //! An axis system from a location and a normal, with an X direction that is
  //! a suggestion rather than a demand: gp_Ax2 projects it onto the plane, so
  //! a rough one will do as long as it is not along the normal.
  //! Straight segments through a list of points. Declared here rather than
  //! only in the table because two other operations end in one, and reaching
  //! back into the assembled factory to build a wire would make the table
  //! depend on its own result.
  const polylineOf = (points, closed) => {
    if (points.length < 2) throw new Error("a polyline needs at least two points");
    const maker = new oc.BRepBuilderAPI_MakeWire();
    const run = closed ? [...points, points[0]] : points;
    let any = false;
    for (let i = 0; i + 1 < run.length; i++) {
      if (V.length(V.sub(run[i + 1], run[i])) < CONFUSION) continue;
      maker.Add(new oc.BRepBuilderAPI_MakeEdge(pnt(run[i]), pnt(run[i + 1])).Edge());
      any = true;
    }
    if (!any) throw new Error("all of those points are in the same place");
    return maker.Wire();
  };

  const faceOf = wire => {
    const face = new oc.BRepBuilderAPI_MakeFace(wire, true);
    if (!face.IsDone()) throw new Error("that wire does not bound a flat face");
    return face.Face();
  };

  //! A solid whose faces face out. A shell thickened from a surface whose
  //! normals happen to point inwards comes back inside out - it measures a
  //! NEGATIVE volume, and every boolean after it is then working with a void
  //! rather than a body. Cheap to detect and cheap to put right.
  const rightWayOut = shape => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
    return props.Mass() < 0 ? shape.Reversed() : shape;
  };

  //! A surface moved along its own normal. Both factories reach for it - the
  //! hybrid one to publish it, the solid one on its way to a thickness - so it
  //! is declared once, here, rather than in either table.
  const offsetSurfaceOf = (surface, distance) => {
    if (Math.abs(distance) < CONFUSION) return surface;
    const made = new oc.BRepOffsetAPI_MakeOffsetShape();
    made.PerformByJoin(surface, distance, CONFUSION * 10,
      oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
      oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!made.IsDone()) throw new Error("that surface will not offset by that much");
    return made.Shape();
  };

  //! The one loft, used by both factories: a skin here, a body there.
  const thruSections = (sections, ruled, solid) => {
    if (sections.length < 2) throw new Error("a loft needs at least two sections");
    const maker = new oc.BRepOffsetAPI_ThruSections(solid, ruled, CONFUSION);
    for (const section of sections) maker.AddWire(section);
    maker.Build();
    if (!maker.IsDone()) throw new Error("those sections will not loft");
    return maker.Shape();
  };

  const frame = (at, normal, xdir) => {
    const n = V.norm(normal);
    if (!n) throw new Error("that direction has no length");
    const across = xdir && V.norm(xdir);
    return across && Math.abs(V.dot(across, n)) < 0.999
      ? new oc.gp_Ax2(pnt(at), dir(n), dir(across))
      : new oc.gp_Ax2(pnt(at), dir(n));
  };

  /* ================================================== HybridShapeFactory */

  const hybridTable = [

    /* ----------------------------------------------------------- points */
    { name: "pointCoord", takes: "x, y, z", gives: "point",
      summary: "A point at three coordinates.",
      run: (x, y, z) => [x, y, z] },

    { name: "pointOnCurve", takes: "curve, ratio", gives: "{ at, tangent }",
      summary: "A point a fraction of the way along a curve, with the direction "
             + "the curve is going there. The whole wire, not one edge, so a "
             + "chained profile reads as one curve the way it looks.",
      run: (curve, ratio) => {
        const adaptor = new oc.BRepAdaptor_CompCurve(wireOf(curve));
        const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
        const u = first + (last - first) * Math.max(0, Math.min(1, ratio));
        const p = adaptor.Value(u);
        const d = new oc.gp_Vec();
        adaptor.D1(u, new oc.gp_Pnt(), d);
        return { at: [p.X(), p.Y(), p.Z()], tangent: V.norm([d.X(), d.Y(), d.Z()]) };
      } },

    { name: "pointCenter", takes: "shape", gives: "point",
      summary: "The centre of a circular or elliptical edge, taken from the curve "
             + "itself rather than from a bounding box - so half an arc still says "
             + "where its centre is, which a box cannot. Anything else answers with "
             + "the middle of its extents.",
      run: shape => {
        for (const edge of each(shape, EDGE, oc.TopoDS.Edge)) {
          try {
            const curve = new oc.BRepAdaptor_Curve(edge);
            const type = curve.GetType();
            const at = type === oc.GeomAbs_CurveType.GeomAbs_Circle ? curve.Circle().Location()
                     : type === oc.GeomAbs_CurveType.GeomAbs_Ellipse ? curve.Ellipse().Location()
                     : null;
            if (at) return [at.X(), at.Y(), at.Z()];
          } catch (e) { /* not a conic; try the next edge */ }
        }
        const box = new oc.Bnd_Box();
        oc.BRepBndLib.Add(shape, box, true);
        if (box.IsVoid()) throw new Error("there is nothing there to take the centre of");
        const lo = box.CornerMin(), hi = box.CornerMax();
        return [(lo.X() + hi.X()) / 2, (lo.Y() + hi.Y()) / 2, (lo.Z() + hi.Z()) / 2];
      } },

    { name: "pointExtreme", takes: "shape, direction, furthest", gives: "point",
      summary: "The point on a shape that reaches furthest along a direction, or "
             + "furthest back against it. Read off the same tessellation the "
             + "viewport draws, so the far end found is the far end you can see - "
             + "a cylinder's side counts, not only its rims.",
      run: (shape, direction, furthest = true) => {
        const along = V.norm(direction);
        if (!along) throw new Error("a direction is needed to be extreme along");
        let best = null, score = furthest ? -Infinity : Infinity;
        const consider = p => {
          const d = V.dot(p, along);
          if (furthest ? d > score : d < score) { score = d; best = p; }
        };
        for (const p of verticesOf(shape)) consider(p);
        for (const p of tessellationOf(shape, deflectionFor(shape))) consider(p);
        if (!best) throw new Error("there is nothing there to be extreme");
        return best;
      } },

    { name: "pointBetween", takes: "a, b", gives: "{ at, gap }",
      summary: "Where two shapes come closest, and how far apart they are there. A "
             + "gap of zero means they cross, so this answers \"the intersection\" "
             + "and \"the nearest point\" with one call - as well, because this "
             + "build carries no curve-to-curve intersector.",
      run: (a, b) => {
        const gap = new oc.BRepExtrema_DistShapeShape();
        gap.LoadS1(a);
        gap.LoadS2(b);
        gap.Perform();
        if (!gap.IsDone() || gap.NbSolution() < 1)
          throw new Error("those two never come near each other");
        const p = gap.PointOnShape1(1), q = gap.PointOnShape2(1);
        return { at: [(p.X() + q.X()) / 2, (p.Y() + q.Y()) / 2, (p.Z() + q.Z()) / 2],
                 gap: gap.Value() };
      } },

    { name: "pointVertex", takes: "point", gives: "shape",
      summary: "One point as a shape, so it can be drawn and picked.",
      run: at => new oc.BRepBuilderAPI_MakeVertex(pnt(at)).Shape() },

    /* ------------------------------------------------------------ lines */
    { name: "lineFrom", takes: "at, along, from, to", gives: "shape",
      summary: "A straight edge along a direction, cut by two lengths measured from "
             + "where it starts - so it may run backwards as well as forwards.",
      run: (at, along, from, to) => {
        const unit = V.norm(along);
        if (!unit) throw new Error("that line has no direction");
        if (Math.abs(to - from) < CONFUSION) throw new Error("the line has no length");
        return new oc.BRepBuilderAPI_MakeEdge(
          pnt(V.add(at, V.scale(unit, from))), pnt(V.add(at, V.scale(unit, to)))).Shape();
      } },

    { name: "lineDistanceToPlane", takes: "at, along, plane", gives: "number",
      summary: "How far along a direction a plane is - what turns \"until that "
             + "plane\" into a length, and says so when the two never meet.",
      run: (at, along, plane) => {
        const unit = V.norm(along);
        if (!unit) throw new Error("that line has no direction");
        const origin = plane.Location(), normal = plane.Direction();
        const n = [normal.X(), normal.Y(), normal.Z()];
        const facing = V.dot(n, unit);
        if (Math.abs(facing) < CONFUSION)
          throw new Error("the line runs along that plane, so it never reaches it");
        return V.dot(V.sub([origin.X(), origin.Y(), origin.Z()], at), n) / facing;
      } },

    { name: "axisOf", takes: "shape or direction", gives: "{ at, along }",
      summary: "A direction, from a vector or from whatever a shape runs along - the "
             + "axis of a cylinder, the run of a line. Turning a plane wants one and "
             + "so does a revolution, and neither cares which it was given.",
      run: (shape, straight) => {
        if (straight && V.length(straight) > CONFUSION)
          return { at: [0, 0, 0], along: V.norm(straight) };
        if (!shape) return null;
        const ends = verticesOf(shape);
        if (ends.length >= 2) {
          const along = V.norm(V.sub(ends[ends.length - 1], ends[0]));
          if (along) return { at: ends[0], along };
        }
        return null;
      } },

    /* ----------------------------------------------------------- planes */
    { name: "planeNormal", takes: "at, normal, xdir", gives: "axis system",
      summary: "The plane through a point with a normal. Every other plane here "
             + "comes back as one of these, so nothing downstream has to know which "
             + "way it was asked for.",
      run: (at, normal, xdir) => frame(at, normal, xdir) },

    { name: "planeOffset", takes: "plane, distance", gives: "axis system",
      summary: "A plane parallel to another, a distance along its normal. It keeps "
             + "the parent's X direction, so the two share a coordinate system.",
      run: (plane, distance) => {
        const n = plane.Direction(), at = plane.Location(), x = plane.XDirection();
        return frame([at.X() + n.X() * distance, at.Y() + n.Y() * distance,
                      at.Z() + n.Z() * distance],
                     [n.X(), n.Y(), n.Z()], [x.X(), x.Y(), x.Z()]);
      } },

    { name: "planeMean", takes: "a, b", gives: "axis system",
      summary: "The plane halfway between two. Facing each other and facing the same "
             + "way both make sense, so the nearer reading is taken and the bisector "
             + "never flips as one of them turns.",
      run: (a, b) => {
        const na = a.Direction(), nb = b.Direction();
        const pa = a.Location(), pb = b.Location();
        const sign = na.X() * nb.X() + na.Y() * nb.Y() + na.Z() * nb.Z() < 0 ? -1 : 1;
        const between = [na.X() + nb.X() * sign, na.Y() + nb.Y() * sign,
                         na.Z() + nb.Z() * sign];
        if (V.length(between) < CONFUSION)
          throw new Error("those two planes are back to back");
        return frame([(pa.X() + pb.X()) / 2, (pa.Y() + pb.Y()) / 2, (pa.Z() + pb.Z()) / 2],
                     between);
      } },

    { name: "planeRotate", takes: "plane, axis, degrees", gives: "axis system",
      summary: "A plane turned about an axis, staying where it is.",
      run: (plane, axis, degrees) => {
        const at = plane.Location(), n = plane.Direction();
        return frame([at.X(), at.Y(), at.Z()],
                     turnAbout([n.X(), n.Y(), n.Z()], axis, degrees * Math.PI / 180));
      } },

    { name: "planeFace", takes: "plane, size", gives: "shape",
      summary: "A plane as something you can see: a square of it, centred on its "
             + "origin. The size is display only and drives no geometry.",
      run: (plane, size) => {
        const half = positive(size, "display size") / 2;
        return new oc.BRepBuilderAPI_MakeFace(
          new oc.gp_Pln(new oc.gp_Ax3(plane)), -half, half, -half, half).Shape();
      } },

    /* ----------------------------------------------------------- curves */
    { name: "circle", takes: "plane, radius", gives: "shape",
      summary: "A circle on a plane, as a closed wire.",
      run: (plane, radius) => new oc.BRepBuilderAPI_MakeWire(
        new oc.BRepBuilderAPI_MakeEdge(
          new oc.gp_Circ(plane, positive(radius, "circle radius"))).Edge()).Wire() },

    { name: "ellipse", takes: "plane, major, minor", gives: "shape",
      summary: "An ellipse on a plane, as a closed wire. Its major radius runs along "
             + "the plane's X direction.",
      run: (plane, major, minor) => {
        const a = positive(major, "major radius"), b = positive(minor, "minor radius");
        if (b > a) throw new Error("an ellipse's minor radius cannot exceed its major radius");
        return new oc.BRepBuilderAPI_MakeWire(
          new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Elips(plane, a, b)).Edge()).Wire();
      } },

    { name: "polyline", takes: "points, closed", gives: "shape",
      summary: "Straight segments through a list of points, open or closed.",
      run: (points, closed) => polylineOf(points, closed) },

    { name: "spline", takes: "points, closed, perSpan", gives: "shape",
      summary: "A smooth curve through a list of points - Catmull-Rom, parameterised "
             + "by index so it may double back on itself, then sampled. This build "
             + "has no B-spline fitter, so the curve arrives as a fine run of "
             + "segments, which is what it is drawn and lofted as anyway.",
      run: (points, closed, perSpan = 12) => {
        const n = points.length;
        if (n < 3) throw new Error("a spline needs at least three points");
        const at = i => points[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
        const out = [];
        for (let s = 0; s < (closed ? n : n - 1); s++) {
          const [a, b, c, d] = [at(s - 1), at(s), at(s + 1), at(s + 2)];
          for (let j = 0; j < perSpan; j++) {
            const u = j / perSpan;
            out.push([0, 1, 2].map(k => 0.5 * ((2 * b[k]) + (-a[k] + c[k]) * u
              + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u * u
              + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u * u * u)));
          }
        }
        if (!closed) out.push(points[n - 1]);
        return polylineOf(out, closed);
      } },

    { name: "fill", takes: "wire", gives: "shape",
      summary: "The planar face a closed wire bounds. What makes a drawing something "
             + "a pad can be swept from.",
      run: wire => faceOf(wire) },

    { name: "fillWithHoles", takes: "outer, holes", gives: "shape",
      summary: "A planar face with holes in it. A hole runs AGAINST its outline, or "
             + "OpenCascade reads it as a second outline and the face comes back "
             + "bigger rather than smaller.",
      run: (outer, holes) => {
        let face = faceOf(outer);
        for (const hole of holes) {
          const cut = new oc.BRepBuilderAPI_MakeFace(face, oc.TopoDS.Wire(hole.Reversed()));
          if (cut.IsDone()) face = cut.Face();
        }
        return face;
      } },

    { name: "parallelCurve", takes: "curve, distance, support", gives: "shape",
      summary: "A curve offset from another. A flat curve needs nothing else and is "
             + "offset in its own plane; a curve lying on a surface is offset in that "
             + "surface, so it stays on it - which is exactly when CATIA asks for a "
             + "support and when it does not.",
      run: (curve, distance, support) => {
        if (Math.abs(distance) < CONFUSION) return curve;
        const join = oc.GeomAbs_JoinType.GeomAbs_Arc;
        let maker;
        if (support) {
          // Offsetting IN a face, not beside it: OpenCascade works in the
          // face's own parameter space, so the result hugs a curved wall
          // instead of leaving it.
          maker = new oc.BRepOffsetAPI_MakeOffset(support, join, false);
          maker.AddWire(wireOf(curve));
        } else {
          maker = new oc.BRepOffsetAPI_MakeOffset(wireOf(curve), join, false);
        }
        maker.Perform(distance, 0);
        if (!maker.IsDone()) throw new Error("that curve cannot be offset by that much");
        const shape = maker.Shape();
        if (!shape || shape.IsNull() || count(shape, EDGE) === 0)
          throw new Error("offsetting by " + distance + " leaves nothing of that curve");
        return shape;
      } },

    { name: "offsetSurface", takes: "surface, distance", gives: "shape",
      summary: "A surface moved a distance along its own normal - still a skin, not a "
             + "body. What a thickness is measured from when it grows both ways.",
      run: (surface, distance) => offsetSurfaceOf(surface, distance) },

    { name: "project", takes: "points, onto", gives: "points",
      summary: "Points pulled onto the nearest place on a shape. Sampling, not an "
             + "exact projection - this build carries no BRepProj_Projection - but "
             + "the nearest point is exact at every sample.",
      run: (points, onto) => points.map(p => {
        const gap = new oc.BRepExtrema_DistShapeShape();
        gap.LoadS1(new oc.BRepBuilderAPI_MakeVertex(pnt(p)).Shape());
        gap.LoadS2(onto);
        gap.Perform();
        if (!gap.IsDone() || gap.NbSolution() < 1) return p;
        const q = gap.PointOnShape2(1);
        return [q.X(), q.Y(), q.Z()];
      }) },

    { name: "intersect", takes: "a, b", gives: "shape",
      summary: "Where two shapes cross, as wireframe: the section curve of two "
             + "surfaces, the point where two curves meet.",
      run: (a, b) => {
        const section = new oc.BRepAlgoAPI_Section(a, b, false);
        section.ComputePCurveOn1(false);
        section.Approximation(true);
        section.Build();
        if (!section.IsDone()) throw new Error("those two will not intersect");
        const shape = section.Shape();
        if (count(shape, EDGE) === 0 && verticesOf(shape).length === 0)
          throw new Error("those two do not cross anywhere");
        return shape;
      } },

    /* --------------------------------------------------------- surfaces */
    { name: "extrude", takes: "profile, along", gives: "shape",
      summary: "A surface swept from a wire along a direction. The hybrid half of "
             + "extruding: a skin, not a body. For a body, pad it.",
      run: (profile, along) => {
        if (V.length(along) < CONFUSION) throw new Error("the sweep has no length");
        return new oc.BRepPrimAPI_MakePrism(profile,
          new oc.gp_Vec(along[0], along[1], along[2])).Shape();
      } },

    { name: "sweep1", takes: "profile, spine", gives: "shape",
      summary: "A profile swept along one rail. The profile is carried along the "
             + "spine keeping its angle to it, which is what a handrail, a gutter or "
             + "a moulding is.",
      run: (profile, spine) => {
        const maker = new oc.BRepOffsetAPI_MakePipe(wireOf(spine), profile);
        if (!maker.IsDone()) throw new Error("that profile will not sweep along that path");
        return maker.Shape();
      } },

    { name: "loft", takes: "sections, ruled", gives: "shape",
      summary: "A skin through section curves, in the order they are given. Ruled "
             + "runs straight between them; smooth passes through. For a body rather "
             + "than a skin, the solid factory lofts too.",
      run: (sections, ruled = false) => thruSections(sections, ruled, false) },

    /* ------------------------------------------------------- assembling */
    { name: "join", takes: "shapes", gives: "shape",
      summary: "Several shapes gathered as one, compounded rather than fused. The "
             + "group of a node editor: what goes downstream as a single thing.",
      run: shapes => compoundOf(shapes) },
  ];

  /* ========================================================= ShapeFactory */

  const shapeTable = [
    { name: "box", takes: "plane, dx, dy, dz", gives: "solid",
      summary: "A box from a corner, oriented by a plane.",
      run: (plane, dx, dy, dz) => new oc.BRepPrimAPI_MakeBox(plane,
        positive(dx, "box width"), positive(dy, "box depth"),
        positive(dz, "box height")).Shape() },

    { name: "cylinder", takes: "plane, radius, height, degrees", gives: "solid",
      summary: "A full cylinder, or a pie slice when an angle is given.",
      run: (plane, radius, height, degrees) => {
        const r = positive(radius, "cylinder radius");
        const h = positive(height, "cylinder height");
        return degrees === undefined
          ? new oc.BRepPrimAPI_MakeCylinder(plane, r, h).Shape()
          : new oc.BRepPrimAPI_MakeCylinder(plane, r, h,
              positive(degrees, "angle") * Math.PI / 180).Shape();
      } },

    { name: "sphere", takes: "plane, radius", gives: "solid",
      summary: "A sphere at a point.",
      run: (plane, radius) => new oc.BRepPrimAPI_MakeSphere(plane,
        positive(radius, "sphere radius")).Shape() },

    { name: "pad", takes: "profile, along", gives: "solid",
      summary: "A body swept from a face along a direction - the solid half of "
             + "extruding. Every face the profile offers is padded, so a sketch of "
             + "six closed loops pads into six bodies rather than the first.",
      run: (profile, along) => {
        if (V.length(along) < CONFUSION) throw new Error("the pad has no depth");
        const vector = new oc.gp_Vec(along[0], along[1], along[2]);
        const faces = each(profile, FACE, oc.TopoDS.Face);
        if (!faces.length) throw new Error("there is no face to pad");
        const swept = faces.map(face => new oc.BRepPrimAPI_MakePrism(face, vector).Shape());
        return swept.length === 1 ? swept[0] : compoundOf(swept);
      } },

    { name: "add", takes: "a, b", gives: "solid",
      summary: "Two bodies fused into one. CATIA calls it Add; it is the union.",
      run: (a, b) => {
        const made = new oc.BRepAlgoAPI_Fuse(a, b, new oc.Message_ProgressRange());
        made.Build(new oc.Message_ProgressRange());
        if (!made.IsDone()) throw new Error("those two will not add together");
        return made.Shape();
      } },

    { name: "remove", takes: "a, b", gives: "solid",
      summary: "The second body taken out of the first. CATIA calls it Remove. If it "
             + "ever appears to do nothing, measure it: a self-intersecting argument "
             + "is answered by handing back what it was given, with no error.",
      run: (a, b) => {
        const made = new oc.BRepAlgoAPI_Cut(a, b, new oc.Message_ProgressRange());
        made.Build(new oc.Message_ProgressRange());
        if (!made.IsDone()) throw new Error("that will not cut");
        return made.Shape();
      } },

    { name: "intersect", takes: "a, b", gives: "solid",
      summary: "What two bodies have in common.",
      run: (a, b) => {
        const made = new oc.BRepAlgoAPI_Common(a, b, new oc.Message_ProgressRange());
        made.Build(new oc.Message_ProgressRange());
        if (!made.IsDone()) throw new Error("those two do not overlap");
        return made.Shape();
      } },

    { name: "thickness", takes: "surface, thickness, both", gives: "solid",
      summary: "A surface given a thickness, so a skin becomes a body. Thickening is "
             + "not offsetting: an offset surface is another skin, and it is "
             + "MakeThickSolid that closes the two skins into something with a volume. "
             + "Both sides moves the surface back half the thickness first, so the "
             + "surface ends up down the middle of what it made. Which side a "
             + "one-sided thickness grows towards is the surface's own normal; the "
             + "sign of the thickness is how you say the other one.",
      run: (surface, thickness, both = false) => {
        const t = Math.abs(thickness);
        if (t < CONFUSION) throw new Error("the thickness must not be zero");
        const from = both ? offsetSurfaceOf(surface, -t / 2 * Math.sign(thickness || 1))
                          : surface;
        const made = new oc.BRepOffsetAPI_MakeThickSolid();
        made.MakeThickSolidBySimple(from, thickness < 0 ? -t : t);
        if (!made.IsDone()) throw new Error("that surface will not thicken");
        const shape = made.Shape();
        if (!shape || shape.IsNull() || count(shape, SOLID) === 0)
          throw new Error("thickening that surface by " + thickness + " leaves no body");
        return rightWayOut(shape);
      } },

    { name: "draft", takes: "solid, faces, neutral, direction, degrees", gives: "solid",
      summary: "Faces leaned over by an angle about where they meet a neutral face - "
             + "what makes a moulded part come out of its mould.",
      run: (solid, faces, neutral, direction, degrees) => {
        const made = new oc.BRepOffsetAPI_DraftAngle(solid);
        const pull = V.norm(direction);
        if (!pull) throw new Error("a direction is needed to draft along");
        let any = false;
        for (const face of faces) {
          made.Add(face, dir(pull), degrees * Math.PI / 180,
                   new oc.gp_Pln(new oc.gp_Ax3(neutral)));
          if (!made.AddDone()) { made.Remove(face); continue; }
          any = true;
        }
        if (!any) throw new Error("none of those faces can take that draft");
        made.Build();
        if (!made.IsDone()) throw new Error("that draft will not build");
        return made.Shape();
      } },

    { name: "loft", takes: "sections, ruled", gives: "solid",
      summary: "A body through section curves - the closed loft. The sections are "
             + "capped, so it comes out solid rather than as a tube.",
      run: (sections, ruled = false) => thruSections(sections, ruled, true) },

    { name: "fillet", takes: "solid, radius", gives: "solid",
      summary: "Every edge of a body rounded to a radius. The radius is checked "
             + "against the body first: on an 80 mm cube OpenCascade answers r = 39.9 "
             + "with IsDone() true, r = 40 with false and r = 60 with true again, so "
             + "asking it whether the radius fits is not a way of finding out.",
      run: (solid, radius) => {
        const r = positive(radius, "fillet radius");
        const smallest = smallestSolidExtent(solid);
        if (Number.isFinite(smallest) && r >= smallest / 2)
          throw new Error("a " + r + " mm fillet does not fit a body only "
                        + Math.round(smallest * 10) / 10 + " mm across");
        const made = new oc.BRepFilletAPI_MakeFillet(solid,
          oc.ChFi3d_FilletShape.ChFi3d_Rational);
        let any = false;
        for (const edge of each(solid, EDGE, oc.TopoDS.Edge)) { made.Add(r, edge); any = true; }
        if (!any) throw new Error("that body has no edges to round");
        made.Build(new oc.Message_ProgressRange());
        if (!made.IsDone()) throw new Error("the fillet did not converge at " + r + " mm");
        const shape = made.Shape();
        if (!shape || shape.IsNull() || count(shape, FACE) === 0)
          throw new Error("the fillet produced an empty shape at " + r + " mm");
        return shape;
      } },

    { name: "move", takes: "shape, by", gives: "shape",
      summary: "A shape somewhere else. The same shape under a different location, "
             + "so a hundred copies cost a matrix each rather than a rebuild.",
      run: (shape, by) => {
        const move = new oc.gp_Trsf();
        move.SetTranslation(new oc.gp_Vec(by[0], by[1], by[2]));
        return shape.Moved(new oc.TopLoc_Location(move));
      } },

    { name: "rotate", takes: "shape, at, axis, degrees", gives: "shape",
      summary: "A shape turned about an axis through a point.",
      run: (shape, at, axis, degrees) => {
        const turn = new oc.gp_Trsf();
        turn.SetRotation(new oc.gp_Ax1(pnt(at), dir(V.norm(axis) || [0, 0, 1])),
                         degrees * Math.PI / 180);
        return shape.Moved(new oc.TopLoc_Location(turn));
      } },

    { name: "assemble", takes: "shapes", gives: "shape",
      summary: "Bodies gathered without being fused - a part with several bodies in "
             + "it, which is what a Part is.",
      run: shapes => compoundOf(shapes) },
  ];

  const hybrid = assemble(hybridTable, "HybridShapeFactory");
  const shape = assemble(shapeTable, "ShapeFactory");
  return { hybrid, shape };
}

//! What the kernel publishes about itself, beside its catalogue of nodes: the
//! two factories and what each of them can do. A node's driver is one call into
//! one of these, so knowing the factories is knowing what a node could be built
//! from - which is why the assistant is shown both.
export function factorySchema(factories) {
  return {
    format: "ocaf-geometry-api", version: 1,
    summary: "Two factories, split the way CATIA splits them: everything that is not "
           + "a solid is hybrid, everything that is, is not. A node's driver reads its "
           + "arguments off the document and makes one call into one of these.",
    factories: [
      { name: factories.hybrid.$kind, makes: "wireframe and surfaces",
        operations: factories.hybrid.$manifest },
      { name: factories.shape.$kind, makes: "solids, and operations between bodies",
        operations: factories.shape.$manifest },
    ],
  };
}
