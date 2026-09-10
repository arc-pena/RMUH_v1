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
import { CONFUSION, V, factorySchema, makeFactories, turnAbout } from "./factory.js";
import { FORMATS, fromBase64, isAssembly, parseObj, parseStl, realNames,
         utf8, writeObj, writeStl } from "./exchange.js";

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

  const length = V.length;
  //! The point a feature stands for, read from what it computed rather than
  //! from its arguments. An input that says it accepts "point" then really does
  //! accept any of them - a Point of any kind, a point off a curve, a draped
  //! site - instead of only the one feature type that happened to spell its
  //! coordinates x, y and z.
  const readPoint = f => {
    const data = f && F.data(f);
    return data && data.kind === "point" && data.values.length >= 3
      ? [data.values[0], data.values[1], data.values[2]] : null;
  };
  const readVector = f => {
    const data = f && F.data(f);
    return data && data.kind === "vector" && data.values.length >= 3
      ? [data.values[0], data.values[1], data.values[2]] : null;
  };

  //! A plane datum resolved, whichever way it was asked for. One answer, not
  //! two: either the frame or the sentence saying why there isn't one. A flag
  //! that switched between them could not survive being called recursively -
  //! "fine" and "broken" both came back as null - so it does not exist.
  function resolvePlane(f) {
    const no = why => ({ ax: null, why });
    if (!f || F.spec(f).type !== "Plane") return no("that is not a plane");
    //! Every branch ends here, and here means one HybridShapeFactory call.
    //! The factory raises; a datum answers with a sentence instead, because a
    //! plane that cannot be worked out is something to say, not to throw.
    const made = build => {
      try {
        const ax = build();
        return ax ? { ax, why: null } : no("that plane cannot be worked out");
      } catch (e) { return no(describeError(e)); }
    };
    const frame = (at, normal, xdir) => {
      if (!at || !normal) return no("that plane cannot be worked out");
      return made(() => HSF.planeNormal(at, normal, xdir));
    };

    switch (Feature_choice(f, "kind")) {
      case 1: {                                   // square across a curve
        const curve = F.reference(f, "curve");
        if (!F.shape(curve)) return no("no curve to stand across");
        const on = alongCurve(curve, F.real(f, "at", 0.5));
        if (!on || !on.tangent) return no("that curve cannot be walked along");
        return frame(on.at, on.tangent);
      }
      case 2: {                                   // offset from another plane
        const parent = resolvePlane(F.reference(f, "from"));
        if (!parent.ax) return no(parent.why || "no plane to offset from");
        return made(() => HSF.planeOffset(parent.ax, F.real(f, "offset", 100)));
      }
      case 3: {                                   // halfway between two planes
        const a = resolvePlane(F.reference(f, "a"));
        const b = resolvePlane(F.reference(f, "b"));
        if (!a.ax || !b.ax) return no(a.why || b.why || "two planes are needed");
        return made(() => HSF.planeMean(a.ax, b.ax));
      }
      case 4: {                                   // turned about an axis
        const parent = resolvePlane(F.reference(f, "turn"));
        if (!parent.ax) return no(parent.why || "no plane to turn");
        const spin = axisOf(F.reference(f, "axis"));
        if (!spin) return no("an axis is needed to turn about");
        return made(() => HSF.planeRotate(parent.ax, spin.along, F.real(f, "angle", 45)));
      }
      default: {                                  // an origin and a normal
        const origin = readPoint(F.reference(f, "origin"));
        const normal = readVector(F.reference(f, "normal"));
        if (!origin) return no("origin point is missing");
        if (!normal || length(normal) < CONFUSION) return no("normal vector is missing or null");
        return frame(origin, normal);
      }
    }
  }

  //! The frame, or null - what every driver that stands something on a plane
  //! has always asked for.
  const planeAxis = f => resolvePlane(f).ax;
  //! And why there isn't one, for the precondition to say out loud.
  const planeTrouble = f => resolvePlane(f).why;

  //! A direction, from a vector or from whatever a curve happens to run along.
  //! Turning a plane wants one and so does an axis of revolution, and neither
  //! cares which of the two it was given.
  function axisOf(f) {
    const found = HSF.axisOf(f && F.shape(f), readVector(f));
    if (found) return found;
    const on = alongCurve(f, 0.5);
    return on && on.tangent ? { at: on.at, along: on.tangent } : null;
  }

  //! Where a line starts and which way it goes, whichever way it was asked
  //! for. Same shape of answer as the plane, for the same reason.
  function resolveLine(f) {
    const no = why => ({ ray: null, why });
    const ray = (at, along) => {
      const unit = V.norm(along);
      if (!at || !unit) return no("that line has no direction");
      return { ray: { at, along: unit }, why: null };
    };
    switch (Feature_choice(f, "kind")) {
      case 1: {
        const a = readPoint(F.reference(f, "from")), b = readPoint(F.reference(f, "to"));
        if (!a || !b) return no("two points are needed");
        const along = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        if (length(along) < CONFUSION) return no("those two points are the same point");
        return ray(a, along);
      }
      case 2: {
        const plane = resolvePlane(F.reference(f, "plane"));
        if (!plane.ax) return no(plane.why || "no plane to stand on");
        const n = plane.ax.Direction(), at = plane.ax.Location();
        const through = readPoint(F.reference(f, "at"));
        return ray(through || [at.X(), at.Y(), at.Z()], [n.X(), n.Y(), n.Z()]);
      }
      case 3: {
        const curve = F.reference(f, "curve");
        if (!F.shape(curve)) return no("no curve to be tangent to");
        const on = alongCurve(curve, F.real(f, "along", 0.5));
        if (!on || !on.tangent) return no("that curve cannot be walked along");
        return ray(on.at, on.tangent);
      }
      case 4: {
        const spin = axisOf(F.reference(f, "shape"));
        if (!spin) return no("nothing there has an axis");
        return ray(spin.at, spin.along);
      }
      default: {
        const at = readPoint(F.reference(f, "origin"));
        const along = readVector(F.reference(f, "direction"));
        if (!at) return no("start point is missing");
        if (!along || length(along) < CONFUSION) return no("direction vector is missing or null");
        return ray(at, along);
      }
    }
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

  /* ---------------------------------------------------------- the API

     Every driver below builds its shape by calling one of these two and
     nothing else. That is the whole point of them: a driver's job is to read
     its arguments off the document and hand them over, so "point on a curve"
     and "point at the centre" cannot end up with two different ideas of what a
     curve is. The handful of things a factory needs that only the document
     side knows how to do - reading a wire off a shape, meshing one - are
     handed in rather than reached for, so the factories stay geometry.        */

  const kit = {
    wireOf: shape => wireFrom(shape),
    verticesOf: shape => verticesOf(shape),
    compoundOf: shapes => compoundOf(shapes),
    tessellationOf: (shape, deflection) => tessellationOf(shape, deflection),
    deflectionFor: shape => deflectionFor(shape),
    smallestSolidExtent: shape => smallestSolidExtent(shape),
  };
  const { hybrid: HSF, shape: SF } = makeFactories(oc, kit);

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

  //! Where a curve is, a fraction of the way along it. The whole wire, not one
  //! edge, so a chained profile reads as one curve the way it looks.
  function alongCurve(f, t) {
    const shape = f && F.shape(f);
    if (!shape) return null;
    try { return HSF.pointOnCurve(shape, t); } catch (e) { return null; }
  }

  //! The centre of a circular or elliptical edge, taken from the curve itself
  //! rather than from a bounding box - so half an arc still says where its
  //! centre is, which a box cannot.
  function centreOf(shape) {
    try { return HSF.pointCenter(shape); } catch (e) { return null; }
  }

  //! Every point OpenCascade meshed a shape down to - the same tessellation the
  //! viewport draws. Asking the drawn shape where its far end is beats asking
  //! its vertices, because a cylinder's side is not a vertex.
  function tessellationOf(shape, deflection) {
    const out = [];
    const push = run => {
      for (let i = 0; i + 2 < run.length; i += 3) out.push([run[i], run[i + 1], run[i + 2]]);
    };
    try {
      if (countSubShapes(shape, FACE) > 0) {
        const faces = oc.ReplicadMeshExtractor.extract(shape, deflection, 0.3, false);
        push(readFloats(faces.getVerticesPtr(), faces.getVerticesSize()));
        faces.delete();
      }
      if (countSubShapes(shape, EDGE) > 0) {
        const edges = oc.ReplicadEdgeMeshExtractor.extract(shape, deflection, 0.3);
        push(readFloats(edges.getLinesPtr(), edges.getLinesSize()));
        edges.delete();
      }
    } catch (e) { /* the vertices alone, then */ }
    return out;
  }

  //! The point of a shape that reaches furthest along a direction - vertices
  //! and tessellation both, so the far end of a curved face is found and not
  //! just its corners.
  function extremeOf(shape, along, furthest = true) {
    try { return HSF.pointExtreme(shape, along, furthest); } catch (e) { return null; }
  }

  //! Where two shapes come closest, and how far apart they are there. Zero
  //! means they cross, so this answers "the intersection" and "the near point"
  //! with one call - which is as well, because this build carries no curve-to-
  //! curve intersector.
  function nearestBetween(a, b) {
    try { return HSF.pointBetween(a, b); } catch (e) { return null; }
  }

  const builders = {
    //! Wire a list of numbers into a coordinate and one point becomes a row of
    //! them: the shortest list repeats its last value, which is the rule
    //! everything downstream of here follows.
    //! One node, five ways of finding a point. Whichever it is, the answer goes
    //! out as a point and nothing downstream knows the difference - which is
    //! the reason for having one node rather than five.
    Point: {
      precondition: f => {
        const kind = Feature_choice(f, "kind");
        if (kind === 1 && !F.shape(F.reference(f, "curve"))) return "no curve to sit on";
        if (kind === 2 && !F.shape(F.reference(f, "of"))) return "nothing to find the centre of";
        if (kind === 3) {
          if (!F.shape(F.reference(f, "shape"))) return "nothing to measure";
          if (!readVector(F.reference(f, "along"))) return "a direction is needed to be extreme along";
        }
        if (kind === 4 && !(F.shape(F.reference(f, "first")) && F.shape(F.reference(f, "second"))))
          return "two curves are needed";
        return null;
      },
      build: f => {
        const kind = Feature_choice(f, "kind");
        let rows = null;
        if (kind === 1) {
          const on = alongCurve(F.reference(f, "curve"), F.real(f, "at", 0.5));
          if (!on) throw new Error("that curve cannot be walked along");
          rows = [on.at];
        } else if (kind === 2) {
          const at = centreOf(F.shape(F.reference(f, "of")));
          if (!at) throw new Error("nothing round to take the centre of");
          rows = [at];
        } else if (kind === 3) {
          const at = extremeOf(F.shape(F.reference(f, "shape")),
                               readVector(F.reference(f, "along")),
                               Feature_choice(f, "end") === 0);
          if (!at) throw new Error("nothing to be extreme");
          rows = [at];
        } else if (kind === 4) {
          const meet = nearestBetween(F.shape(F.reference(f, "first")),
                                      F.shape(F.reference(f, "second")));
          if (!meet) throw new Error("those two never come near each other");
          rows = [meet.at];
        } else {
          // Coordinates. Wire a list of numbers into one and a point becomes a
          // row of them: the shortest list repeats its last value, the rule
          // everything downstream of here follows.
          rows = zip([F.reals(f, "x", 0), F.reals(f, "y", 0), F.reals(f, "z", 0)]);
        }
        const shape = rows.length === 1
          ? HSF.pointVertex(rows[0])
          : HSF.join(rows.map(row => HSF.pointVertex(row)));
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
        return { shape: HSF.lineFrom([0, 0, 0], v, 0, 100), data: vectors([v]) };
      },
    },

    //! Where the line runs is one question; how far it runs is another, and the
    //! second one has an answer a number cannot give - stop on that plane. So
    //! the two are separate settings and every combination of them works.
    Line: {
      precondition: f => resolveLine(f).why,
      build: f => {
        const answer = resolveLine(f);
        if (!answer.ray) throw new Error(answer.why);
        const { at, along } = answer.ray;
        // Between two points means between them: the ends are the points, so
        // the lengths are read off rather than typed in.
        let from = F.real(f, "start", 0), to = F.real(f, "length", 100);
        if (Feature_choice(f, "kind") === 1 && Feature_choice(f, "limit") === 0) {
          const a = readPoint(F.reference(f, "from")), b = readPoint(F.reference(f, "to"));
          from = 0;
          to = length([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        }
        if (Feature_choice(f, "limit") === 1) {
          // Run into the plane instead of to a length: how far along the
          // direction the plane is, which is the only sensible reading of
          // "until", and says so when the two never meet.
          const stop = planeAxis(F.reference(f, "until"));
          if (!stop) throw new Error("no plane to run into");
          to = HSF.lineDistanceToPlane(at, along, stop);
          from = 0;
        }
        return HSF.lineFrom(at, along, from, to);
      },
    },

    Plane: {
      precondition: f => {
        if (F.real(f, "size", 160) <= CONFUSION) return "display size must be positive";
        return planeTrouble(f);
      },
      build: f => {
        const axis = planeAxis(f);
        if (!axis) throw new Error("that plane cannot be worked out");
        return HSF.planeFace(axis, F.real(f, "size", 160));
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
        return SF.box(placement, F.real(f, "dx", 80), F.real(f, "dy", 80), F.real(f, "dz", 80));
      },
    },

    Sphere: {
      precondition: f => {
        if (!readPoint(F.reference(f, "center"))) return "centre point is missing";
        if (F.real(f, "radius", 50) <= CONFUSION) return "radius must be positive";
        return null;
      },
      build: f => SF.sphere(HSF.planeNormal(readPoint(F.reference(f, "center")), [0, 0, 1]),
                            F.real(f, "radius", 50)),
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
        // A fillet needs something with a thickness. Handed a pile of loose
        // surfaces - which is what half the STEP files in the world are -
        // OpenCascade does not refuse, it faults, and a fault is a number with
        // no explanation in it. So the shape is asked what it is first.
        if (countSubShapes(body, SOLID) === 0
            && countSubShapes(body, oc.TopAbs_ShapeEnum.TopAbs_SHELL) === 0)
          return F.name(source) + " has no solid to round - it is " + describeShape(body)
            + ", and a fillet needs a body";

        const smallest = smallestSolidExtent(body);
        if (Number.isFinite(smallest) && radius >= smallest / 2)
          return "radius " + trim(radius) + " mm does not fit: the body is only "
               + trim(smallest) + " mm across, so the limit is " + trim(smallest / 2) + " mm";
        return null;
      },
      build: f => SF.fillet(F.shape(F.reference(f, "body")), F.real(f, "radius", 10)),
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

  //! The script API. A script is written by hand, so this reads the way a
  //! person writes - `cylinder(r, h, { at, axis })` rather than a placement
  //! built first - but every one of these that a factory already does is that
  //! factory call with the arguments unpacked. The ergonomics are here; the
  //! geometry is not.
  function shapeApi() {
    const api = {
      box(dx, dy, dz, opts) { return SF.box(axisSystem(opts), dx, dy, dz); },

      //! A full cylinder, or a pie slice when an angle in degrees is given.
      cylinder(radius, height, opts = {}) {
        return SF.cylinder(axisSystem(opts), radius, height, opts.angle);
      },

      sphere(radius, opts) { return SF.sphere(axisSystem(opts), radius); },

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
        return HSF.ellipse(axisSystem(opts), major, minor);
      },

      circle(radius, opts = {}) { return HSF.circle(axisSystem(opts), radius); },

      //! A wire through a run of points, closed or not.
      polyline(points, opts = {}) {
        if (!Array.isArray(points)) throw new Error("a polyline needs a list of points");
        return HSF.polyline(points, opts.closed === true);
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

      face(wire) { return HSF.fill(wire); },

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
        const list = [].concat(profiles).filter(Boolean).map(w => asWire(w, "loft profile"));
        return opts.solid !== false ? SF.loft(list, opts.ruled === true)
                                    : HSF.loft(list, opts.ruled === true);
      },

      //! Sweeps a face or a wire straight along a vector. A face gives a body,
      //! a wire gives a skin, which is the difference between the two factories
      //! stated as an argument rather than as a choice.
      prism(base, along) {
        return base.ShapeType() === FACE ? SF.pad(base, along) : HSF.extrude(base, along);
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
        return SF.move(shape, [asNumber(by[0], "dx"), asNumber(by[1], "dy"),
                               asNumber(by[2], "dz")]);
      },

      rotate(shape, degrees, opts = {}) {
        return SF.rotate(shape, opts.at || [0, 0, 0], opts.axis || [0, 0, 1],
                         asNumber(degrees, "angle"));
      },

      cut(a, b) { return SF.remove(a, b); },
      fuse(a, b) { return SF.add(a, b); },
      common(a, b) { return SF.intersect(a, b); },

      fillet(shape, radius) { return SF.fillet(shape, radius); },

      compound(shapes) {
        const list = [].concat(shapes).filter(Boolean);
        if (!list.length) throw new Error("nothing to assemble");
        return SF.assemble(list);
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

  //! Every point arriving on an input, from every wire on it, in the order they
  //! were wired. One source or five reads the same to whatever consumes it,
  //! which is what lets three separate points make a polyline.
  const pointsOf = (f, key) => F.references(f, key).flatMap(pointsFrom);

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
  //! Whatever a shape offers, as one wire. The factories take shapes, so this
  //! is the form they are handed; the feature form below is the same thing with
  //! the label read off first.
  function wireFrom(shape, what = "curve") {
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

  const wireOf = (source, what) => wireFrom(source && F.shape(source), what);

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
    build: f => HSF.circle(planeAxis(F.reference(f, "plane")), F.real(f, "radius", 60)),
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
    precondition: f => pointsOf(f, "points").length < 2
      ? "a polyline needs at least two points" : null,
    build: f => {
      const list = pointsOf(f, "points");
      return { shape: HSF.polyline(list, Feature_choice(f, "closed") === 1),
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
    precondition: f => pointsOf(f, "points").length < 3
      ? "an interpolated curve needs at least three points" : null,
    build: f => {
      const list = pointsOf(f, "points");
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
      if (!F.references(f, "points").length) return "no points to drape";
      if (!F.reference(f, "onto")) return "nothing to drape them onto";
      return null;
    },
    //! Straight down, and the highest thing hit wins - so a point over an
    //! overhang lands on the top of it, the way a building sits on a hill
    //! rather than inside it.
    build: f => {
      const plan = pointsOf(f, "points");
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
      if (!F.references(f, "points").length) return "no points to place it at";
      if (!pointsOf(f, "points").length) return "nothing wired into Points carries any";
      return null;
    },
    //! One shape, many locations. Each copy is the same TopoDS_Shape with a
    //! different TopLoc_Location on it - the instancing the Array feature uses,
    //! so the cost of the hundredth copy is a matrix, not a rebuild.
    build: f => {
      const shape = F.shape(F.reference(f, "shape"));
      const at = pointsOf(f, "points");
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
      if (Feature_choice(f, "limit") === 1) {
        if (!F.reference(f, "until")) return "no plane to extrude up to";
        return planeTrouble(F.reference(f, "until"));
      }
      if (Math.abs(F.real(f, "distance", 120)) <= CONFUSION) return "distance must not be zero";
      return null;
    },
    build: f => {
      const source = F.shape(F.reference(f, "profile"));
      const v = V.norm(readVector(F.reference(f, "direction")));
      // How far is either a number or a plane. "Up to that face" is the
      // measurement a person actually has, and it keeps being true when the
      // plane moves - which a number typed once does not.
      const reach = Feature_choice(f, "limit") === 1
        ? HSF.lineDistanceToPlane(HSF.pointCenter(source), v,
                                  planeAxis(F.reference(f, "until")))
        : F.real(f, "distance", 120);
      if (Math.abs(reach) < CONFUSION)
        throw new Error("the profile is already on that plane, so there is nothing to extrude");
      const along = V.scale(v, reach);

      // Solid or surface is a real choice, not a hint, and the two factories
      // are where it is made. A pad is swept from the faces of the profile -
      // every one of them, so a sketch of six closed loops pads into six bodies
      // rather than the first. A surface is swept from the wires, so the same
      // sketch on "Surface" gives six tubes; a profile that arrived as a face
      // has its own outlines taken back off it.
      if (Feature_choice(f, "cap") === 0) {
        const faces = capped(f, source);
        if (!faces.length) throw new Error("the profile has nothing to extrude");
        return SF.pad(HSF.join(faces), along);
      }
      const wires = outlines(f, source);
      if (!wires.length) throw new Error("the profile has nothing to extrude");
      return HSF.extrude(HSF.join(wires), along);
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
    build: f => {
      const sections = F.references(f, "sections").map(s => wireOf(s, "section"));
      const ruled = Feature_choice(f, "ruled") === 1;
      return Feature_choice(f, "cap") === 0 ? SF.loft(sections, ruled)
                                            : HSF.loft(sections, ruled);
    },
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
      const a = F.shape(F.reference(f, "a")), b = F.shape(F.reference(f, "b"));
      const op = Feature_choice(f, "op");
      const shape = op === 0 ? SF.add(a, b) : op === 1 ? SF.remove(a, b) : SF.intersect(a, b);
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
      return { shape: HSF.polyline(run, false), data: points(list) };
    },
  };

  //! Sweeping along a rail rather than along a direction. The profile is
  //! capped for a body and left open for a skin, which is the same choice
  //! Extrude offers and made in the same place.
  builders.Sweep = {
    precondition: f => {
      for (const [key, what] of [["profile", "profile"], ["spine", "rail"]]) {
        const source = F.reference(f, key);
        if (!source) return "no " + what + " to sweep" + (key === "spine" ? " along" : "");
        if (!F.shape(source)) return F.name(source) + " has not been built";
      }
      return null;
    },
    //! Solid or skin, the same rail. The factory works out what the profile
    //! offers - one loop, several, or a loop with a hole in it - so there is
    //! nothing to cap or take apart first.
    build: f => {
      const source = F.shape(F.reference(f, "profile"));
      const spine = F.shape(F.reference(f, "spine"));
      return Feature_choice(f, "cap") === 0 ? SF.rib(source, spine)
                                            : HSF.sweep1(source, spine);
    },
  };

  builders.ParallelCurve = {
    precondition: f => {
      const curve = F.reference(f, "curve");
      if (!curve) return "no curve to offset";
      if (!F.shape(curve)) return F.name(curve) + " has not been built";
      const support = F.reference(f, "support");
      if (support && !F.shape(support)) return F.name(support) + " has not been built";
      return null;
    },
    //! The support is asked for only when it is needed, the way CATIA asks: a
    //! curve that is already flat carries its own plane, and one that lies on
    //! a surface has to be told which surface or the offset leaves it.
    build: f => {
      const source = F.reference(f, "curve");
      const support = F.reference(f, "support");
      const face = support ? firstFace(F.shape(support), "support") : null;
      // A sketch writes down the plane it was drawn on, so a spine drawn as one
      // straight segment still knows which way is sideways. Without that it is
      // a question with no answer, and the factory says so rather than picking.
      const frame = !face && F.frame(source);
      return HSF.parallelCurve(F.shape(source), F.real(f, "distance", 100), face,
                               frame ? frame.normal : null);
    },
  };

  builders.ThickSurface = {
    precondition: f => {
      const source = F.reference(f, "surface");
      if (!source) return "no surface to thicken";
      if (!F.shape(source)) return F.name(source) + " has not been built";
      if (countSubShapes(F.shape(source), FACE) === 0)
        return F.name(source) + " is a curve, not a surface - fill it or extrude it first";
      if (Math.abs(F.real(f, "thickness", 200)) <= CONFUSION) return "thickness must not be zero";
      return null;
    },
    build: f => SF.thickness(F.shape(F.reference(f, "surface")),
                             F.real(f, "thickness", 200),
                             Feature_choice(f, "sides") === 1),
  };

  builders.Intersect = {
    precondition: f => {
      for (const key of ["a", "b"]) {
        const source = F.reference(f, key);
        if (!source) return "both are needed - " + key.toUpperCase() + " is empty";
        if (!F.shape(source)) return F.name(source) + " has not been built";
      }
      return null;
    },
    build: f => {
      const shape = HSF.intersect(F.shape(F.reference(f, "a")), F.shape(F.reference(f, "b")));
      const marks = verticesOf(shape);
      // A section that came out as points is a point: say so in the data as
      // well as in the shape, so it can drive anything that wants one.
      return marks.length && countSubShapes(shape, EDGE) === 0
        ? { shape, data: points(marks) } : shape;
    },
  };

  builders.Draft = {
    precondition: f => {
      const body = F.reference(f, "body");
      if (!body) return "no body to draft";
      if (!F.shape(body)) return F.name(body) + " has not been built";
      if (countSubShapes(F.shape(body), FACE) === 0) return F.name(body) + " has no faces";
      const neutral = F.reference(f, "neutral");
      if (!neutral) return "a neutral plane is needed - it is the height the draft turns about";
      const trouble = planeTrouble(neutral);
      if (trouble) return trouble;
      if (Math.abs(F.real(f, "angle", 5)) <= CONFUSION) return "an angle of zero drafts nothing";
      return null;
    },
    //! Which faces to lean over is the driver's question, not the factory's:
    //! it is read off the document, the way every other argument is. "Sides"
    //! means the faces that run along the pull rather than across it - the
    //! walls of a pad, not its top and bottom.
    build: f => {
      const body = F.shape(F.reference(f, "body"));
      const neutral = planeAxis(F.reference(f, "neutral"));
      const pull = readVector(F.reference(f, "direction"))
        || [neutral.Direction().X(), neutral.Direction().Y(), neutral.Direction().Z()];
      const sidesOnly = Feature_choice(f, "faces") === 0;
      const along = V.norm(pull);

      const chosen = [];
      for (const face of subShapes(body, FACE, oc.TopoDS.Face)) {
        if (!sidesOnly) { chosen.push(face); continue; }
        const surface = new oc.BRepAdaptor_Surface(face);
        if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
        const n = surface.Plane().Axis().Direction();
        if (Math.abs(V.dot([n.X(), n.Y(), n.Z()], along)) < 0.5) chosen.push(face);
      }
      if (!chosen.length)
        throw new Error("no face of that body runs along the pull direction - "
                      + "check the direction, or draft all faces");
      return SF.draft(body, chosen, neutral, along, F.real(f, "angle", 5));
    },
  };

  //! A container builds nothing, and that is the point of it. It holds no
  //! geometry, consumes nothing and hides nothing: what is filed in a set stays
  //! exactly as visible and as wired as it was, so putting a node away can
  //! never change the part. What it computes is a sentence about itself - what
  //! it holds and what crosses its boundary - which is what the tree and the
  //! panel show when you ask.
  builders.GeometricalSet = {
    build: f => {
      const inside = doc.within(f), feeds = doc.inputsOf(f), out = doc.outputsOf(f);
      const count = (n, one, many) => n + " " + (n === 1 ? one : many);
      return { data: text([
        count(inside.length, "item", "items"),
        feeds.length ? "in: " + feeds.map(F.name).join(", ") : "nothing comes in",
        out.length ? "out: " + out.map(F.name).join(", ") : "nothing reads out of it",
      ]) };
    },
  };
  builders.Body = builders.GeometricalSet;

  /* ---------------------------------------------------------- imported

     Two drivers, and neither builds anything. What they hold IS the geometry -
     a B-Rep string, or OBJ text - so rebuilding is reading it back. Held that
     way rather than as the file it arrived in so that one reader rebuilds
     every import, whichever reader first read it. */

  builders.Imported = {
    precondition: f => F.code(f, "brep", "") ? null
      : "this import holds no geometry - it was read from a file that had none",
    //! A shape and a readout of what it is, which is what every other node
    //! hands back. The readout matters more here than anywhere else: an import
    //! is the one node whose contents nobody chose, so "3 solids, 18 faces" is
    //! the difference between a body you can fillet and a pile of surfaces that
    //! will refuse - and it says which before you wire anything to it.
    build: f => {
      const shape = oc.BRepToolsWrapper.Read(F.code(f, "brep", ""));
      if (!shape || shape.IsNull())
        throw new Error("the stored geometry will not read back - the model file may be truncated");
      const from = F.code(f, "source", "");
      return { shape, data: text([describeShape(shape), from ? "from " + from : "read from a file"]) };
    },
  };

  builders.MeshImported = {
    precondition: f => F.code(f, "obj", "") ? null
      : "this import holds no geometry - it was read from a file that had none",
    build: f => {
      const parts = parseObj(F.code(f, "obj", ""));
      if (!parts.length) throw new Error("the stored geometry has no faces in it");
      // A part is written per feature, so there is normally one. Several are
      // merged rather than refused: an OBJ typed in by hand may have any number.
      const points = [], faces = [];
      for (const part of parts) {
        const base = points.length;
        for (const p of part.points) points.push(p);
        for (const face of part.faces) faces.push(face.map(i => i + base));
      }
      return { data: { ...packMesh(checkMesh({ points, faces }, "imported mesh")),
                       smooth: Feature_choice(f, "smooth") === 1 } };
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

  /* ------------------------------------------------------------ exchange

     Everything the readers and writers need that is not arithmetic. The
     arithmetic - OBJ and STL, both ways - is in exchange.js and knows nothing
     about OpenCascade; what is here is the part that does.                  */

  //! OpenCascade's own shape format, read back. It is what every import is
  //! stored as, so this is the road every rebuild of an import takes.
  const readBrep = text => {
    const shape = oc.BRepToolsWrapper.Read(text);
    if (!shape || shape.IsNull())
      throw new Error("that BREP file will not read - it may not be a BREP file");
    return { shape };
  };

  //! A STEP file, transferred. Every root separately: an assembly written as
  //! several products comes back as several shapes, and that is the structure
  //! the file itself carries. What it does NOT carry through these bindings is
  //! the nesting below that - the compound of a sub-assembly arrives whole -
  //! so a part is a solid, and the import says so rather than implying a tree
  //! it cannot see.
  const readStep = text => {
    const path = "/import.step";
    if (oc.Interface_Static)
      oc.Interface_Static.SetCVal("xstep.cascade.unit", doc.units === "m" ? "M" : "MM");
    oc.FS.writeFile(path, text);
    const reader = new oc.STEPControl_Reader();
    let status;
    try {
      status = String(reader.ReadFile(path));
    } finally {
      try { oc.FS.unlink(path); } catch (err) { /* the scratch file is not important */ }
    }
    if (status !== "IFSelect_RetDone")
      throw new Error("OpenCascade refused that STEP file (" + status + ")");
    if (!reader.NbRootsForTransfer())
      throw new Error("that STEP file holds nothing that transfers to a shape");
    reader.TransferRoots(new oc.Message_ProgressRange());
    const parts = [];
    for (let i = 1; i <= reader.NbShapes(); i++) {
      const shape = reader.Shape(i);
      if (shape && !shape.IsNull()) parts.push({ shape });
    }
    return parts;
  };

  //! A transferred root broken into the parts a person would call parts:
  //! solids if there are any, shells if there are not, faces if there are
  //! neither. A root that is one of those already comes back as itself.
  const explode = parts => {
    const SHELL = oc.TopAbs_ShapeEnum.TopAbs_SHELL;
    const out = [];
    for (const part of parts) {
      const solids = subShapes(part.shape, SOLID, oc.TopoDS.Solid);
      const shells = solids.length ? [] : subShapes(part.shape, SHELL, oc.TopoDS.Shell);
      const faces = solids.length || shells.length ? [] : subShapes(part.shape, FACE, oc.TopoDS.Face);
      const pieces = solids.length ? solids : shells.length ? shells : faces;
      if (!pieces.length) { out.push(part); continue; }
      for (const piece of pieces) out.push({ shape: piece, name: part.name });
    }
    return out;
  };

  //! A compound that holds one solid and nothing else IS that solid, and a STEP
  //! reader hands back plenty of them. Unwrapped here so what lands in the tree
  //! is a body like any other body - the counts have to match exactly, because
  //! a compound of one solid and three loose edges is not the solid.
  const unwrap = shape => {
    if (!shape || shape.IsNull()) return shape;
    if (String(shape.ShapeType()) !== "TopAbs_COMPOUND") return shape;
    const solids = subShapes(shape, SOLID, oc.TopoDS.Solid);
    if (solids.length !== 1) return shape;
    const one = solids[0];
    if (countSubShapes(one, FACE) !== countSubShapes(shape, FACE)
        || countSubShapes(one, EDGE) !== countSubShapes(shape, EDGE)) return shape;
    return one;
  };

  const describeShape = shape => {
    const solids = countSubShapes(shape, SOLID), faces = countSubShapes(shape, FACE);
    const count = (n, one) => n + " " + one + (n === 1 ? "" : "s");
    return solids ? count(solids, "solid") + ", " + count(faces, "face")
      : faces ? count(faces, "face") : "no surfaces - wireframe only";
  };

  //! STL gives every triangle its own three vertices, so a cube arrives as 36
  //! points that are really 8. Welding is what makes it a mesh rather than a
  //! pile, and it is done against the size of the thing rather than against a
  //! fixed number, because a file in metres and a file in millimetres are the
  //! same model.
  const weldTriangles = mesh => {
    if (!mesh.points.length) return mesh;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.points)
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return weldMesh(mesh, Math.max(1e-7, diagonal * 1e-6), true);
  };

  //! Several parts as one mesh, vertices renumbered. Faces are copied across
  //! exactly as they are: a quad stays a quad.
  const mergeParts = (parts, name) => {
    const points = [], faces = [];
    for (const part of parts) {
      const base = points.length;
      for (const p of part.points) points.push(p);
      for (const face of part.faces) faces.push(face.map(i => i + base));
    }
    return { name, points, faces };
  };

  //! An OBJ group name may not carry a space and survive every reader.
  const objName = name => String(name || "part").replace(/\s+/g, "_");

  //! Everything visible, as polygons. A polymesh gives up its own faces
  //! untouched - which is the whole point: a quad cage exported here opens as
  //! a quad cage in Blender, and comes back as one. A B-Rep has no faces to
  //! keep, so it is tessellated and welded, and those are triangles because
  //! that is what a tessellation is.
  const exportParts = () => {
    const parts = [];
    for (const f of doc.features()) {
      if (!F.visible(f)) continue;
      const data = F.data(f);
      if (data && data.kind === "mesh") {
        parts.push({ name: objName(F.name(f)), points: F.triples(data), faces: meshFaces(data) });
        continue;
      }
      // A datum plane has a face on it so it can be seen; it is not geometry
      // anybody wants in a mesh file.
      if (F.spec(f).category === "datum") continue;
      const shape = F.shape(f);
      if (!shape || countSubShapes(shape, FACE) === 0) continue;   // nothing to tessellate
      const stream = tessellate(shape, deflectionFor(shape));
      if (!stream.positions || !stream.index || !stream.index.length) continue;
      const points = [], faces = [];
      for (let i = 0; i + 2 < stream.positions.length; i += 3)
        points.push([stream.positions[i], stream.positions[i + 1], stream.positions[i + 2]]);
      for (let i = 0; i + 2 < stream.index.length; i += 3)
        faces.push([stream.index[i], stream.index[i + 1], stream.index[i + 2]]);
      const box = extents(shape);
      parts.push({ name: objName(F.name(f)),
                   ...weldMesh({ points, faces }, Math.max(1e-4, (box ? box.diagonal : 100) * 1e-5), true) });
    }
    return parts;
  };

  return {
    kind: "wasm",
    description: "OpenCascade (WebAssembly), in this page",

    //! What this kernel is: its catalogue of nodes, and the API those nodes are
    //! built out of. Two halves of one answer - a node is a driver and a driver
    //! is one factory call - so they are published together and anything
    //! reading the kernel, the node editor or the assistant, gets both.
    async schema() {
      return { ...schemaJson(), api: factorySchema({ hybrid: HSF, shape: SF }),
               exchange: FORMATS };
    },

    /* ------------------------------------------------------- packages

       What a package is handed, and how its nodes get in. A package's driver
       is a driver like any other - it reads its arguments off the labels and
       calls the factories - so what it needs is what every driver here needs,
       and it is handed the same things rather than a smaller copy of them. */

    //! Everything a package's drivers build with. The factories first, because
    //! a driver that reaches past them into OpenCascade is a driver doing two
    //! jobs - that rule does not stop applying because the driver arrived in a
    //! package.
    toolkit() {
      return {
        oc, F, hybrid: HSF, shape: SF,
        readPoint, readVector, planeAxis, planeTrouble, axisOf, alongCurve,
        wireFrom, firstFace, verticesOf, compoundOf, subShapes, extents,
        deflectionFor, tessellationOf, countSubShapes, describeError,
        points, numbers, vectors, text, pointsOf, zip,
        tessellate, sampleCurve, capped, outlines,
        FACE, EDGE, SOLID, ANY,
      };
    },

    //! A package's nodes, given drivers. The catalogue already has the specs by
    //! the time this is called - the package system put them there - so all
    //! that is left is to say which function builds each one.
    installDrivers(specs, builders) {
      const missing = specs.filter(spec => !builders[spec.type]).map(spec => spec.type);
      if (missing.length)
        throw new Error("no driver for " + missing.join(", ")
          + " - a node without one is a node that cannot build");
      for (const spec of specs)
        drivers.set(spec.guid, new Driver(spec, { ...builders[spec.type], release, describeError }));
    },

    removeDrivers(specs) { for (const spec of specs) drivers.delete(spec.guid); },

    //! Which of these types the document is actually using, by feature name.
    //! Asked before a package is put away, because taking a type out from under
    //! a feature leaves something nothing can rebuild.
    typesInUse(types) {
      const wanted = new Set(types);
      return doc.features().filter(f => wanted.has(F.spec(f).type)).map(F.name);
    },
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
    async setReference(id, key, target, remove = false, only = false) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      if (remove || !target) doc.clearReference(f, key, target ? doc.find(target) : null);
      else doc.setReference(f, key, doc.find(target), only);
      return state(doc.recompute(false));
    },

    async addFeature(type, refs = {}, id = null) {
      const spec = typeSpec(type);
      if (!spec) throw new Error('unknown feature type "' + type + '"');
      const f = doc.addFeature(type, id);
      try {
        for (const [key, id] of Object.entries(refs)) {
          if (!id) continue;
          // An input that gathers takes a list: several things picked by hand
          // are wired in the order they were picked.
          for (const one of Array.isArray(id) ? id : [id]) {
            const target = doc.find(one);
            if (!target) throw new Error("cannot point " + key + " at unknown feature '" + one + "'");
            doc.setReference(f, key, target);
          }
        }
      } catch (err) {
        doc.deleteFeature(f);
        throw err;
      }
      return { ...state(doc.recompute(false)), id: F.id(f) };
    },

    //! File a feature under a set, or at the top level when `into` is null.
    //! One feature at a time, the way every other edit here works, so an undo
    //! step is one move and the report says which.
    async setParent(id, into) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      const holder = into ? doc.find(into) : null;
      if (into && !holder) throw new Error("no set '" + into + "'");
      doc.setParent(f, holder);
      return state(doc.recompute(false));
    },

    //! Everything feeding a set's contents from outside it. Published rather
    //! than worked out by the interface, because the answer depends on the
    //! wiring and the wiring lives here.
    async inputsOf(id) {
      const f = doc.find(id);
      if (!f) throw new Error("no feature '" + id + "'");
      if (!doc.isContainer(f)) throw new Error(F.name(f) + " is not a set");
      return { ok: true, inputs: doc.inputsOf(f).map(x => ({ id: F.id(x), name: F.name(x) })),
               outputs: doc.outputsOf(f).map(x => ({ id: F.id(x), name: F.name(x) })),
               contents: doc.within(f).map(x => ({ id: F.id(x), name: F.name(x) })) };
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

      return { ok: true, text, solids: parts.length, name: doc.title, units: doc.units,
               parts: parts.length,
               note: parts.length + (parts.length === 1 ? " solid" : " solids")
                 + ", each its own root, in " + doc.units };
    },

    /* ------------------------------------------------------ exchange

       Files in and files out. Two rules hold this end of it together.

       A mesh keeps its faces. A quad stays a quad, an n-gon stays an n-gon,
       through the import, through the document and back out again - because a
       low-poly model from Blender or Max is a CAGE, and a cage triangulated on
       the way in is a cage you can no longer subdivide. Triangles appear in
       exactly two places and both are forced: STL, which has nothing else, and
       the tessellation of a B-Rep, which never had faces to keep.

       Whatever arrives is converted once, here, to the one form the document
       stores - a B-Rep string for solids, OBJ text for meshes. So every import
       rebuilds through one reader rather than through whichever reader first
       read it, and the model file says what it holds in a form a person can
       still read. */

    //! What can be read and written, published so the interface builds its
    //! menus from the kernel's own answer rather than from a list of its own
    //! that can drift.
    formats: FORMATS,

    //! One file in. Returns the document, and a note saying what was found -
    //! which is the part worth reading, because "14 solids in 3 assemblies"
    //! and "one solid" are both successes and only one of them is what was
    //! expected.
    async importFile({ format, name = "", data = "", encoding = "text", as = "single" }) {
      const spec = FORMATS.find(f => f.key === format);
      if (!spec || !spec.read) throw new Error('this kernel cannot read "' + format + '"');
      const bytes = encoding === "base64" ? fromBase64(data) : null;
      const stem = String(name).replace(/\.[^.]*$/, "") || "Imported";

      const made = [];
      const hold = (type, key, geometry, partName, source) => {
        const f = doc.addFeature(type, null, partName);
        F.setCode(f, key, geometry);
        F.setCode(f, "source", source);
        made.push(f);
        return f;
      };

      let note = "", folder = "Body";
      if (format === "step" || format === "brep") {
        const text = bytes ? utf8(bytes) : String(data);
        const parts = format === "brep" ? [readBrep(text)] : readStep(text);
        if (!parts.length) throw new Error("nothing in that file transferred into a shape");

        // One object, or one per part. Exploding is only offered for a format
        // that carries several - everything else has one thing in it, and
        // pretending otherwise would make a set of one.
        // One thing stays one thing. Wrapping a single shape in a compound of
        // one would make an import the only node in the document whose result
        // is a container, and every operation downstream would meet a shape of
        // a kind nothing else here produces.
        const pieces = as === "parts" ? explode(parts)
          : parts.length === 1 ? [{ shape: unwrap(parts[0].shape) }]
          : [{ shape: compoundOf(parts.map(p => p.shape)) }];
        const names = format === "step" ? realNames(text) : [];
        const named = names.length === pieces.length ? names : null;
        pieces.forEach((piece, i) => {
          const label = pieces.length === 1 ? stem
            : (piece.name || (named ? named[i] : "") || stem + " " + (i + 1));
          hold("Imported", "brep", oc.BRepToolsWrapper.Write(piece.shape), label, name);
        });
        note = pieces.length === 1
          ? "one object, " + describeShape(pieces[0].shape)
          : pieces.length + " parts"
            + (named ? ", named from the file" : ", numbered - the file gave no usable names");
        if (format === "step" && as !== "parts" && isAssembly(text))
          note += " (this file is an assembly - import it again as sub-components to break it up)";
        // Freed in the order they were made: a piece is a sub-shape of a part,
        // and a part is only its own if nothing exploded it.
        for (const piece of pieces)
          if (!parts.some(part => part.shape === piece.shape)) release(piece.shape);
        for (const part of parts) release(part.shape);
      } else if (format === "obj" || format === "stl") {
        folder = "GeometricalSet";
        const parts = format === "obj"
          ? parseObj(bytes ? utf8(bytes) : String(data))
          : [{ name: stem, ...weldTriangles(parseStl(bytes || String(data))) }];
        if (!parts.length) throw new Error("no faces in that file");
        const kept = parts.reduce((n, part) => n + part.faces.length, 0);
        const quads = parts.reduce((n, part) => n + part.faces.filter(f => f.length > 3).length, 0);

        const pieces = as === "parts" ? parts : [mergeParts(parts, stem)];
        for (const piece of pieces)
          hold("MeshImported", "obj", writeObj([piece], "from " + name), piece.name || stem, name);
        note = pieces.length + (pieces.length === 1 ? " mesh, " : " meshes, ") + kept + " faces"
          + (quads ? " - " + quads + " of them with more than three sides, kept as they are"
                   : " - all triangles");
      } else {
        throw new Error('"' + format + '" is not read here - a model file is opened, not imported');
      }

      // Several parts are a set, the way anything several is a set here: they
      // are filed under one, so the tree shows the file as one thing that can
      // be opened rather than as fourteen loose features.
      let holder = null;
      if (made.length > 1) {
        holder = doc.addFeature(folder, null, stem);
        for (const f of made) doc.setParent(f, holder);
      }

      return { ...state(doc.recompute(false)), note,
               created: made.map(F.id), set: holder ? F.id(holder) : null };
    },

    //! Everything visible, out. STEP is a separate road because it is the only
    //! one OpenCascade writes for us; the rest are written here, from what the
    //! features already hold.
    async exportShapes(format) {
      if (format === "step") return await this.exportStep();
      const spec = FORMATS.find(f => f.key === format);
      if (!spec || !spec.write) throw new Error('this kernel cannot write "' + format + '"');
      const stem = (doc.title || "part").replace(/[^\w.-]+/g, "-");

      if (format === "brep") {
        const shapes = doc.features().filter(f => F.visible(f) && F.shape(f)).map(F.shape);
        if (!shapes.length) throw new Error("there is no B-Rep geometry visible to write");
        return { ok: true, text: oc.BRepToolsWrapper.Write(compoundOf(shapes)),
                 parts: shapes.length, name: doc.title, units: doc.units,
                 note: shapes.length + " shapes, exactly as the kernel holds them" };
      }

      const parts = exportParts();
      if (!parts.length) throw new Error("there is nothing visible to write");
      const polygons = parts.reduce((n, p) => n + p.faces.filter(f => f.length > 3).length, 0);
      const note = "from " + doc.title + ", " + doc.units;
      const text = format === "obj" ? writeObj(parts, note) : writeStl(parts, stem);
      return { ok: true, text, parts: parts.length, name: doc.title, units: doc.units,
               note: format === "obj"
                 ? parts.length + " objects" + (polygons
                     ? ", " + polygons + " faces of more than three sides kept as they are"
                     : "")
                 : parts.length + " objects, fanned into triangles - which is all STL has" };
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
