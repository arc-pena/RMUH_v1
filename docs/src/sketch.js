// The sketch: two dimensions, on a plane.
//
// A sketch is a drawing in its own coordinates - u across, v up - and a plane
// it lives on. Nothing in the drawing knows where that plane is. Move the
// plane, or point the sketch at a different one, and every line, arc and
// spline in it goes with it, because none of them was ever written in world
// coordinates. That is the whole idea, and it is why the plane and the origin
// are references rather than numbers.
//
// This file is the drawing's semantics and nothing else: no OpenCascade, no
// DOM. The kernel reads it to build edges on the plane; the viewport reads the
// same functions to draw the sketch you are still drawing and to decide what
// your cursor is snapping to. One definition, two readers.

/* ------------------------------------------------------------- the format */

//! What a drawing is:
//!
//!   { elements:    [ { id, type, … } ],
//!     constraints: [ { type, … } ] }
//!
//! Every element carries its own geometry in 2D. Nothing is implicit and
//! nothing is derived at rest, so the JSON is the drawing.
export const SKETCH_TYPES = ["point", "line", "arc", "circle", "ellipse", "oblong", "spline"];

//! The relations the solver knows. Each one is a projection: it moves the
//! handles it governs the shortest way to satisfy itself, and the solver runs
//! them all in turn until they stop moving.
export const SKETCH_RELATIONS = [
  { key: "coincident",    label: "Coincident",    takes: 2, of: "handle",
    hint: "two ends meet" },
  { key: "horizontal",    label: "Horizontal",    takes: 1, of: "line",
    hint: "a line lies along u" },
  { key: "vertical",      label: "Vertical",      takes: 1, of: "line",
    hint: "a line lies along v" },
  { key: "parallel",      label: "Parallel",      takes: 2, of: "line",
    hint: "two lines run the same way" },
  { key: "perpendicular", label: "Perpendicular", takes: 2, of: "line",
    hint: "two lines meet at a right angle" },
  { key: "tangent",       label: "Tangent",       takes: 2, of: "any",
    hint: "a line touches a circle, or two circles touch" },
];

export const EMPTY_SKETCH = { elements: [], constraints: [] };

/* ------------------------------------------------------------------ maths */

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = a => Math.hypot(a[0], a[1]);
const norm = a => { const l = len(a); return l < 1e-12 ? null : [a[0] / l, a[1] / l]; };
const perp = a => [-a[1], a[0]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const sketchRound = p => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];

/* --------------------------------------------------------------- elements */

//! A fresh element of each kind, given the clicks that made it. The viewport
//! collects the points; this decides what they mean.
export function sketchElement(type, id, clicks) {
  const p = i => clicks[i] || [0, 0];
  switch (type) {
    case "point":  return { id, type, p: sketchRound(p(0)) };
    case "line":   return { id, type, a: sketchRound(p(0)), b: sketchRound(p(1)) };
    case "circle": return { id, type, c: sketchRound(p(0)), r: round1(len(sub(p(1), p(0)))) };
    case "arc": {
      // Centre, then start, then a point that says how far round to go.
      const c = p(0), r = len(sub(p(1), c));
      const a0 = Math.atan2(p(1)[1] - c[1], p(1)[0] - c[0]);
      let a1 = Math.atan2(p(2)[1] - c[1], p(2)[0] - c[0]);
      // Always the short way round unless the third click says otherwise.
      while (a1 < a0) a1 += Math.PI * 2;
      return { id, type, c: sketchRound(c), r: round1(r), a0: round4(a0), a1: round4(a1) };
    }
    case "ellipse": {
      const c = p(0);
      const major = sub(p(1), c);
      const rx = len(major) || 1;
      const ry = Math.max(0.1, Math.abs(dot(sub(p(2), c), perp(norm(major) || [0, 1]))));
      return { id, type, c: sketchRound(c), rx: round1(rx), ry: round1(Math.min(ry, rx * 0.999)),
               rot: round4(Math.atan2(major[1], major[0])) };
    }
    case "oblong": {
      const a = p(0), b = p(1);
      const along = norm(sub(b, a)) || [1, 0];
      const r = Math.max(0.1, Math.abs(dot(sub(p(2), b), perp(along))));
      return { id, type, a: sketchRound(a), b: sketchRound(b), r: round1(r) };
    }
    case "spline": return { id, type, pts: clicks.map(sketchRound), closed: false };
    default: throw new Error('there is no sketch element called "' + type + '"');
  }
}

//! A relation over what is selected. \p of is the elements or the handles,
//! in the order they were picked, and how many there must be is in
//! SKETCH_RELATIONS - so a panel offering relations and a solver running them
//! never disagree about what one is.
export function sketchRelation(type, of) {
  const spec = SKETCH_RELATIONS.find(r => r.key === type);
  if (!spec) throw new Error('there is no sketch relation called "' + type + '"');
  const list = (of || []).slice(0, spec.takes);
  if (list.length !== spec.takes)
    throw new Error(spec.label + " takes " + spec.takes
      + (spec.of === "handle" ? " ends" : " " + spec.of === "any" ? " elements" : " lines"));
  return { type, of: list };
}

const round1 = v => Math.round(v * 1e4) / 1e4;
const round4 = v => Math.round(v * 1e6) / 1e6;

//! How many clicks each kind wants before it is a thing. A spline is however
//! many you give it.
export const SKETCH_CLICKS = { point: 1, line: 2, circle: 2, arc: 3, ellipse: 3, oblong: 3, spline: 0 };

//! The points on an element that can be taken hold of - by the solver, by a
//! coincidence, or by a cursor. Named, because a constraint says "e1.b".
export function sketchHandles(el) {
  switch (el.type) {
    case "point":   return [["p", el.p]];
    case "line":    return [["a", el.a], ["b", el.b]];
    case "circle":  return [["c", el.c]];
    case "arc":     return [["c", el.c], ["start", arcEnd(el, el.a0)], ["end", arcEnd(el, el.a1)]];
    case "ellipse": return [["c", el.c]];
    case "oblong":  return [["a", el.a], ["b", el.b]];
    case "spline":  return el.pts.map((p, i) => ["p" + i, p]);
    default: return [];
  }
}

const arcEnd = (el, angle) =>
  [el.c[0] + el.r * Math.cos(angle), el.c[1] + el.r * Math.sin(angle)];

//! Moving a handle. An arc's endpoint is not a free point - it is an angle and
//! a radius - so moving it turns and resizes the arc instead of tearing it.
export function sketchMoveHandle(el, key, to) {
  const p = sketchRound(to);
  switch (el.type) {
    case "point":   el.p = p; return;
    case "line":    if (key === "a") el.a = p; else el.b = p; return;
    case "circle":
    case "ellipse": el.c = p; return;
    case "oblong":  if (key === "a") el.a = p; else el.b = p; return;
    case "arc":
      if (key === "c") { el.c = p; return; }
      {
        const away = sub(to, el.c);
        const r = len(away);
        if (r > 1e-9) {
          el.r = round1(r);
          const angle = Math.atan2(away[1], away[0]);
          if (key === "start") el.a0 = round4(angle);
          else { let a1 = angle; while (a1 < el.a0) a1 += Math.PI * 2; el.a1 = round4(a1); }
        }
      }
      return;
    case "spline": {
      const at = Number(key.slice(1));
      if (Number.isInteger(at) && el.pts[at]) el.pts[at] = p;
      return;
    }
  }
}

const byId = drawing => new Map((drawing.elements || []).map(el => [el.id, el]));

//! "e3.b" - the element and the handle on it.
export function sketchHandleAt(drawing, reference) {
  const [id, key] = String(reference || "").split(".");
  const el = byId(drawing).get(id);
  if (!el) return null;
  const found = sketchHandles(el).find(([k]) => k === key);
  return found ? { el, key, p: found[1] } : null;
}

/* ----------------------------------------------------------- the outlines */

//! An element as a run of 2D points - what the viewport draws, and what the
//! chain walker measures. \p quality is points per full turn on anything round.
export function sketchOutline(el, quality = 64) {
  const round = (from, to, radius, centre) => {
    const steps = Math.max(2, Math.ceil(Math.abs(to - from) / (Math.PI * 2) * quality));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = from + (to - from) * (i / steps);
      out.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
    }
    return out;
  };
  switch (el.type) {
    case "point":  return [el.p];
    case "line":   return [el.a, el.b];
    case "circle": return round(0, Math.PI * 2, el.r, el.c);
    case "arc":    return round(el.a0, el.a1, el.r, el.c);
    case "ellipse": {
      const out = [];
      const cos = Math.cos(el.rot || 0), sin = Math.sin(el.rot || 0);
      for (let i = 0; i <= quality; i++) {
        const t = (i / quality) * Math.PI * 2;
        const x = el.rx * Math.cos(t), y = el.ry * Math.sin(t);
        out.push([el.c[0] + x * cos - y * sin, el.c[1] + x * sin + y * cos]);
      }
      return out;
    }
    case "oblong": {
      const along = norm(sub(el.b, el.a)) || [1, 0];
      const across = perp(along);
      const angle = Math.atan2(along[1], along[0]);
      return [
        ...round(angle - Math.PI / 2, angle + Math.PI / 2, el.r, el.b),
        ...round(angle + Math.PI / 2, angle + Math.PI * 1.5, el.r, el.a),
        add(el.b, mul(across, -el.r)),
      ];
    }
    case "spline": return splinePoints(el, Math.max(8, quality / 4));
    default: return [];
  }
}

//! Catmull-Rom through the points, parameterised by index so the curve may
//! double back - the same spline the written features use.
export function splinePoints(el, perSpan = 12) {
  const pts = el.pts || [];
  if (pts.length < 2) return pts.slice();
  if (pts.length === 2) return pts.slice();
  const closed = !!el.closed;
  const n = pts.length;
  const at = i => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  const spans = closed ? n : n - 1;
  const out = [];
  for (let s = 0; s < spans; s++) {
    const [a, b, c, d] = [at(s - 1), at(s), at(s + 1), at(s + 2)];
    for (let j = 0; j < perSpan; j++) {
      const u = j / perSpan;
      out.push([0, 1].map(k => 0.5 * ((2 * b[k]) + (-a[k] + c[k]) * u
        + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u * u
        + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * u * u * u)));
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

//! Where an element starts and ends, and whether it closes on itself. A point
//! is neither, so it never joins a loop.
export function sketchEnds(el) {
  switch (el.type) {
    case "point":  return null;
    case "line":   return { a: el.a, b: el.b, closed: false };
    case "arc":    return { a: arcEnd(el, el.a0), b: arcEnd(el, el.a1), closed: false };
    case "circle":
    case "ellipse":
    case "oblong": return { a: null, b: null, closed: true };
    case "spline": {
      const pts = el.pts || [];
      if (pts.length < 2) return null;
      return el.closed ? { a: null, b: null, closed: true }
                       : { a: pts[0], b: pts[pts.length - 1], closed: false };
    }
    default: return null;
  }
}

/* ---------------------------------------------------------------- the loops

   A face needs a closed run of edges. Circles, ellipses and slots are already
   one; the rest have to be walked, end to end, until the walk comes back to
   where it started. Anything left over stays a wire.                        */

export function sketchLoops(drawing, tolerance = 0.05) {
  const elements = (drawing.elements || []).filter(el => sketchEnds(el));
  const loops = [], open = [];
  const spare = [];

  for (const el of elements) {
    const ends = sketchEnds(el);
    if (ends.closed) loops.push([{ id: el.id, reversed: false }]);
    else spare.push(el);
  }

  const near = (p, q) => p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;
  const used = new Set();

  for (const seed of spare) {
    if (used.has(seed.id)) continue;
    const chain = [{ id: seed.id, reversed: false }];
    used.add(seed.id);
    let head = sketchEnds(seed).a, tail = sketchEnds(seed).b;

    let grew = true;
    while (grew) {
      grew = false;
      for (const el of spare) {
        if (used.has(el.id)) continue;
        const ends = sketchEnds(el);
        if (near(tail, ends.a))      { chain.push({ id: el.id, reversed: false }); tail = ends.b; }
        else if (near(tail, ends.b)) { chain.push({ id: el.id, reversed: true });  tail = ends.a; }
        else if (near(head, ends.b)) { chain.unshift({ id: el.id, reversed: false }); head = ends.a; }
        else if (near(head, ends.a)) { chain.unshift({ id: el.id, reversed: true });  head = ends.b; }
        else continue;
        used.add(el.id);
        grew = true;
      }
    }
    if (chain.length >= 2 && near(head, tail)) loops.push(chain);
    else open.push(chain);
  }
  return { loops, open };
}

//! Which way an element is heading when it arrives at one of its ends. What a
//! CAD sketcher continues when you carry on drawing: the next arc leaves the
//! corner going the same way the last line came in, so the two meet smoothly
//! instead of at a kink.
export function sketchDirectionAt(el, key) {
  if (!el) return null;
  if (el.type === "line") return key === "a" ? norm(sub(el.a, el.b)) : norm(sub(el.b, el.a));
  if (el.type === "arc") {
    // An arc drawn from a0 to a1 runs anticlockwise, so the way it is going at
    // any angle is the radius turned a quarter turn the same way.
    const at = key === "start" ? el.a0 : el.a1;
    const out = [-Math.sin(at), Math.cos(at)];
    return key === "start" ? [-out[0], -out[1]] : out;
  }
  if (el.type === "spline") {
    const pts = el.pts || [];
    if (pts.length < 2) return null;
    const at = Number(String(key).slice(1));
    if (at === 0) return norm(sub(pts[0], pts[1]));
    if (at === pts.length - 1) return norm(sub(pts[at], pts[at - 1]));
    return norm(sub(pts[at + 1], pts[at - 1]));
  }
  return null;
}

//! The arc that leaves \p from in the direction \p tangent and arrives at
//! \p to. There is exactly one, and this is the whole of what a tangent-arc
//! tool does: the centre is somewhere on the line through \p from at right
//! angles to the tangent, and the radius is whatever puts \p to on the circle.
//!
//!   |from + r*N - to| = |r|,  N perpendicular to the tangent
//!     =>  r = -(D.D) / (2 N.D)   with D = from - to
//!
//! Returns null when the three are in a line and no arc exists - draw the line
//! instead, which is what that degenerate case actually is.
export function sketchTangentArc(from, tangent, to, id) {
  const t = norm(tangent);
  if (!t) return null;
  const N = perp(t);
  const D = sub(from, to);
  const below = 2 * dot(N, D);
  if (Math.abs(below) < 1e-9 || dot(D, D) < 1e-12) return null;
  const r = -dot(D, D) / below;
  const c = add(from, mul(N, r));
  const radius = Math.abs(r);
  if (!(radius > 1e-9) || !Number.isFinite(radius)) return null;

  const angleOf = p => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a = angleOf(from), b = angleOf(to);
  const turn = x => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // An arc is stored as a sweep that only ever increases, so if the tangent
  // says it leaves `from` clockwise it is written the other way round - the
  // same arc, walked from `to`. Which end is which never mattered to a chain.
  const anticlockwise = dot([-Math.sin(a), Math.cos(a)], t) > 0;
  const a0 = anticlockwise ? a : b;
  const a1 = a0 + turn(anticlockwise ? b - a : a - b);
  return { id, type: "arc", c: sketchRound(c), r: round1(radius),
           a0: round4(a0), a1: round4(a1) };
}

//! One chain's elements with their ends welded shut. Two elements that a
//! chain says meet are, in a drawing, a hundredth of a millimetre apart; a
//! wire will not close over that. So the meeting point is taken as the middle
//! of the two ends and both sides are given that exact point, and whoever
//! builds the edges builds them through the points given here rather than
//! through the element's own arithmetic.
//!
//! \p chain is a run out of sketchLoops(). Elements it names in reverse are
//! reported the way the chain walks them, not the way they were drawn.
export function sketchChainEnds(drawing, chain, closed = false) {
  const map = byId(drawing);
  const run = [];
  for (const step of chain || []) {
    const el = map.get(step.id);
    const ends = el && sketchEnds(el);
    if (!ends) continue;
    run.push({ el, reversed: !!step.reversed, closed: ends.closed,
               a: step.reversed ? ends.b : ends.a,
               b: step.reversed ? ends.a : ends.b });
  }
  const middle = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let i = 0; i + 1 < run.length; i++) {
    if (!run[i].b || !run[i + 1].a) continue;
    const joint = middle(run[i].b, run[i + 1].a);
    run[i].b = joint;
    run[i + 1].a = joint;
  }
  if (closed && run.length > 1) {
    const last = run[run.length - 1];
    if (last.b && run[0].a) {
      const joint = middle(last.b, run[0].a);
      last.b = joint;
      run[0].a = joint;
    }
  }
  return run;
}

//! Where an arc is at an angle. Exported because the kernel builds its arcs
//! through three points on them rather than from a centre and two angles.
export function sketchArcPoint(el, angle) { return arcEnd(el, angle); }

//! A whole loop as one 2D polygon, walked the way the chain walks it. What
//! decides whether one loop is inside another - and so whether it is a hole.
export function sketchLoopOutline(drawing, chain, quality = 48) {
  const map = byId(drawing);
  const out = [];
  for (const step of chain || []) {
    const el = map.get(step.id);
    if (!el) continue;
    const line = sketchOutline(el, quality);
    for (const p of step.reversed ? line.slice().reverse() : line) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
    }
  }
  return out;
}

//! Is this point inside that polygon? A ray cast east, counting crossings -
//! enough for loops that do not cross themselves, which is what a sketch draws.
export function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

//! Which loops are holes in which. A loop with an odd number of loops around it
//! is a hole in the innermost of them; a loop with an even number is an outline
//! in its own right. So a plate with two bolt holes is one face with two holes,
//! and an island drawn inside a hole is solid again - which is how every CAD
//! sketcher reads a drawing, and it falls straight out of counting.
export function sketchNesting(drawing, loops, quality = 48) {
  const rings = loops.map(chain => sketchLoopOutline(drawing, chain, quality));
  const inside = (a, b) => a !== b && rings[a].length && rings[b].length
    && pointInPolygon(rings[a][0], rings[b]);
  return loops.map((chain, i) => {
    const around = loops.map((_, j) => j).filter(j => inside(i, j));
    // The innermost thing around it is the one it is a hole in.
    const parent = around.length
      ? around.reduce((best, j) => (inside(j, best) ? j : best), around[0]) : -1;
    return { chain, ring: rings[i], depth: around.length,
             hole: around.length % 2 === 1, parent };
  });
}

/* --------------------------------------------------------------- the solver

   Not a degree-of-freedom solver: a relaxation. Every relation knows how to
   move the handles it governs the shortest way to satisfy itself, and they are
   run in turn until nothing moves. That converges on the sketches people draw,
   fights itself when a sketch is over-constrained, and says how far off it
   finished rather than pretending.                                          */

export function solveSketch(drawing, passes = 24) {
  const work = JSON.parse(JSON.stringify(drawing || EMPTY_SKETCH));
  const relations = work.constraints || [];
  if (!relations.length) return { drawing: work, passes: 0, residual: 0 };

  const index = byId(work);
  const handle = reference => {
    const [id, key] = String(reference || "").split(".");
    const el = index.get(id);
    if (!el) return null;
    const found = sketchHandles(el).find(([k]) => k === key);
    return found ? { el, key, p: found[1] } : null;
  };
  const moveTo = (h, p) => { sketchMoveHandle(h.el, h.key, p); };

  let residual = 0, ran = 0;
  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    residual = 0;
    ran = pass + 1;
    for (const relation of relations) {
      residual += applyRelation(relation, index, handle, moveTo);
    }
    if (residual < 1e-7) break;
  }
  return { drawing: work, passes: ran, residual: Math.sqrt(Math.max(0, residual)) };
}

function applyRelation(relation, index, handle, moveTo) {
  // A relation names what it governs in one place, however many things that
  // is: {"type":"parallel","of":["e1","e2"]}. SKETCH_RELATIONS says how many
  // each takes, so the panel that offers them and the solver that runs them
  // read one description.
  const of = Array.isArray(relation.of) ? relation.of : [relation.of];
  const line = id => {
    const el = index.get(id);
    return el && el.type === "line" ? el : null;
  };
  switch (relation.type) {
    case "coincident": {
      const a = handle(of[0]), b = handle(of[1]);
      if (!a || !b) return 0;
      const gap = sub(b.p, a.p);
      const target = mid(a.p, b.p);
      moveTo(a, target);
      moveTo(b, target);
      return dot(gap, gap);
    }
    case "horizontal":
    case "vertical": {
      const el = line(of[0]);
      if (!el) return 0;
      const axis = relation.type === "horizontal" ? 1 : 0;
      const centre = (el.a[axis] + el.b[axis]) / 2;
      const off = el.a[axis] - el.b[axis];
      el.a = el.a.slice(); el.b = el.b.slice();
      el.a[axis] = centre; el.b[axis] = centre;
      return off * off;
    }
    case "parallel":
    case "perpendicular": {
      const first = line(of[0]), second = line(of[1]);
      if (!first || !second) return 0;
      const want = norm(sub(first.b, first.a));
      if (!want) return 0;
      const aim = relation.type === "parallel" ? want : perp(want);
      const have = sub(second.b, second.a);
      const half = len(have) / 2;
      const centre = mid(second.a, second.b);
      // Turn the second line about its own middle rather than dragging an end,
      // so a relation never walks the sketch across the plane.
      const sign = dot(have, aim) < 0 ? -1 : 1;
      const wanted = mul(aim, half * sign);
      const before = sub(have, mul(wanted, 2));
      second.a = sketchRound(sub(centre, wanted));
      second.b = sketchRound(add(centre, wanted));
      return dot(before, before);
    }
    case "tangent": {
      const a = index.get(of[0]), b = index.get(of[1]);
      if (!a || !b) return 0;
      const round = a.type === "circle" ? a : b.type === "circle" ? b : null;
      const other = round === a ? b : a;
      if (!round) return 0;
      if (other.type === "line") {
        const along = norm(sub(other.b, other.a));
        if (!along) return 0;
        const away = sub(round.c, other.a);
        const across = dot(away, perp(along));
        const off = Math.abs(across) - round.r;
        // Slide the circle along the line's normal until it just touches.
        round.c = sketchRound(sub(round.c, mul(perp(along), Math.sign(across) * off)));
        return off * off;
      }
      if (other.type === "circle") {
        const between = sub(other.c, round.c);
        const distance = len(between);
        const want = round.r + other.r;
        if (distance < 1e-9) return 0;
        const off = distance - want;
        const shift = mul(norm(between), off / 2);
        round.c = sketchRound(add(round.c, shift));
        other.c = sketchRound(sub(other.c, shift));
        return off * off;
      }
      return 0;
    }
    default: return 0;
  }
}

/* ------------------------------------------------------------- housekeeping */

//! Reads a drawing out of whatever was stored, dropping anything malformed
//! rather than failing the feature. A sketch half-typed into the model file is
//! still most of a sketch.
export function readSketch(source) {
  const raw = typeof source === "string"
    ? (() => { try { return JSON.parse(source); } catch (e) { return null; } })()
    : source;
  if (!raw || typeof raw !== "object") return { elements: [], constraints: [] };
  const seen = new Set();
  const elements = (Array.isArray(raw.elements) ? raw.elements : []).filter(el => {
    if (!el || !SKETCH_TYPES.includes(el.type) || typeof el.id !== "string") return false;
    if (seen.has(el.id)) return false;
    seen.add(el.id);
    return sketchHandles(el).every(([, p]) => Array.isArray(p) && p.every(Number.isFinite));
  });
  const known = new Set(SKETCH_RELATIONS.map(r => r.key));
  const constraints = (Array.isArray(raw.constraints) ? raw.constraints : [])
    .filter(c => {
      if (!c || !known.has(c.type)) return false;
      const takes = SKETCH_RELATIONS.find(r => r.key === c.type).takes;
      return Array.isArray(c.of) && c.of.length === takes
        && c.of.every(name => typeof name === "string" && name);
    })
    .map(c => ({ type: c.type, of: c.of.slice() }));
  return { elements, constraints };
}

//! The next free id, so two elements never collide however the drawing was
//! edited - by clicking, or by typing into the model file.
export function nextSketchId(drawing, prefix = "e") {
  const used = new Set((drawing.elements || []).map(el => el.id));
  for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i;
}

//! One line describing a drawing, for the tree and the node.
export function sketchSummary(drawing) {
  const n = (drawing.elements || []).length;
  const c = (drawing.constraints || []).length;
  if (!n) return "empty";
  const { loops } = sketchLoops(drawing);
  return n + (n === 1 ? " element" : " elements")
       + (c ? " · " + c + (c === 1 ? " relation" : " relations") : "")
       + (loops.length ? " · " + loops.length + (loops.length === 1 ? " loop" : " loops") : "");
}
