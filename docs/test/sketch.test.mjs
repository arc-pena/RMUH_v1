// The sketcher: a drawing in two dimensions, on a plane.
//
// What is being checked is the thing that makes a sketch a sketch: the drawing
// is written in the plane's coordinates and nowhere else, so moving the plane
// moves the drawing and nothing in the JSON changes. After that, that the
// loops it closes really are faces - measured, not assumed - and that a pad
// off a sketch is a solid with a volume you can predict on paper.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { EMPTY_SKETCH, SKETCH_CLICKS, SKETCH_TYPES, readSketch, sketchDirectionAt,
         sketchCrossings, sketchElement, sketchEnds, sketchLoops, sketchRelation,
         sketchRelationMarks, sketchSummary,
         sketchTangentArc, solveSketch } from "../src/sketch.js";
import { Mdl } from "../src/mdl.js";
import { readFileSync } from "fs";

const WASM_DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(WASM_DIR + "/replicad_single.js")).default;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};

const kernel = await createWasmKernel({
  initModule, wasmBinary: readFileSync(WASM_DIR + "/replicad_single.wasm"),
});
const tree = async () => (await kernel.tree()).tree;
const at = async id => (await tree()).features.find(f => f.id === id);

const square = side => ({
  elements: [
    { id: "e1", type: "line", a: [0, 0], b: [side, 0] },
    { id: "e2", type: "line", a: [side, 0], b: [side, side] },
    { id: "e3", type: "line", a: [side, side], b: [0, side] },
    { id: "e4", type: "line", a: [0, side], b: [0, 0] },
  ],
  constraints: [],
});

console.log("1. the drawing on its own");
{
  const drawn = SKETCH_TYPES.map(type =>
    sketchElement(type, "x", [[0, 0], [40, 0], [40, 30], [10, 50]]
      .slice(0, Math.max(1, SKETCH_CLICKS[type] || 4))));
  check("every kind of element draws from clicks", drawn.length === SKETCH_TYPES.length);
  check("a square is one loop", sketchLoops(square(100)).loops.length === 1);
  const gappy = square(100);
  gappy.elements[1].a = [100, 0.02];
  check("a hand-drawn gap still reads as a loop", sketchLoops(gappy).loops.length === 1);
  check("nonsense in the file is dropped, not fatal",
    readSketch('{"elements":[{"id":"a","type":"line","a":[0,0],"b":[1,1]},{"type":"kite"}]}')
      .elements.length === 1);
  check("the summary says what is there", sketchSummary(square(100)) === "4 elements · 1 loop",
    sketchSummary(square(100)));
}

console.log("\n2. constraints");
{
  const slanted = {
    elements: [{ id: "e1", type: "line", a: [0, 0], b: [100, 7] }],
    constraints: [sketchRelation("horizontal", ["e1"])],
  };
  const solved = solveSketch(slanted, 24);
  const line = solved.drawing.elements[0];
  check("horizontal levels a line", Math.abs(line.a[1] - line.b[1]) < 1e-6,
    JSON.stringify([line.a, line.b]));
  check("and says how far off it finished", solved.residual < 1e-6, String(solved.residual));

  const corner = {
    elements: [{ id: "e1", type: "line", a: [0, 0], b: [100, 0] },
               { id: "e2", type: "line", a: [90, 20], b: [90, 90] }],
    constraints: [sketchRelation("coincident", ["e1.b", "e2.a"])],
  };
  const met = solveSketch(corner, 40).drawing;
  const gap = Math.hypot(met.elements[0].b[0] - met.elements[1].a[0],
                         met.elements[0].b[1] - met.elements[1].a[1]);
  check("coincident brings two ends together", gap < 1e-6, String(gap));
}

console.log("\n3. the sketch is a feature");
await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "Sketching",
                         units: "mm", features: [] });
let out = await kernel.addFeature("Sketch", {});
const sketchId = out.id;
check("an empty sketch says so rather than crashing",
  /empty/.test((await at(sketchId)).error || ""), (await at(sketchId)).error || "no error");

out = await kernel.setSketch(sketchId, "drawing", square(100));
check("drawing on it builds", !(await at(sketchId)).error, (await at(sketchId)).error);
{
  const entry = await at(sketchId);
  check("the tree publishes the drawing whole", entry.sketch.drawing.elements.length === 4);
  check("with a summary a node can print", entry.sketch.summary === "4 elements · 1 loop",
    entry.sketch.summary);
}
{
  const model = (await kernel.model());
  const stored = model.features.find(f => f.id === sketchId);
  check("the model file carries the drawing as JSON", stored.args.drawing.elements.length === 4);
  check("and only the drawing - no world coordinates",
    JSON.stringify(stored.args.drawing).indexOf("null") < 0);
}

console.log("\n4. closed loops become faces");
const up = (await kernel.addFeature("Vector", {})).id;
await kernel.setParameter(up, "dx", 0);
await kernel.setParameter(up, "dz", 1);
const pad = (await kernel.addFeature("Extrude", { profile: sketchId, direction: up })).id;
await kernel.setParameter(pad, "distance", 40);
check("a pad off the sketch builds", !(await at(pad)).error, (await at(pad)).error);
const gauge = (await kernel.addFeature("Measure", { shape: pad })).id;
await kernel.setParameter(gauge, "quantity", 2);
const volumeOf = async () => {
  const entry = await at(gauge);
  return entry && entry.data ? Number(entry.data.preview) : NaN;
};
check("and it is a solid of the volume the drawing says", Math.abs(await volumeOf() - 100 * 100 * 40) < 1,
  String(await volumeOf()));

// Solid or surface is the difference between a body and a skin, and the way
// to tell them apart is to measure them: a capped pad has its two ends, a
// swept wire has only the four walls.
const areaOf = async () => {
  await kernel.setParameter(gauge, "quantity", 1);
  const entry = await at(gauge);
  const area = entry && entry.data ? Number(entry.data.preview) : NaN;
  await kernel.setParameter(gauge, "quantity", 2);
  return area;
};
check("as a solid it has its two ends on it", Math.abs(await areaOf() - 36000) < 1,
  String(await areaOf()));
await kernel.setParameter(pad, "cap", 1);
check("on Surface it is the four walls and nothing else",
  Math.abs(await areaOf() - 16000) < 1, String(await areaOf()));
await kernel.setParameter(pad, "cap", 0);

console.log("\n5. two loops pad into two bodies");
{
  const twice = square(60);
  twice.elements.push({ id: "c1", type: "circle", c: [200, 30], r: 25 });
  await kernel.setSketch(sketchId, "drawing", twice);
  const both = await volumeOf();
  check("a circle and a square pad into both",
    Math.abs(both - (60 * 60 * 40 + Math.PI * 25 * 25 * 40)) < 200, String(both));
}

console.log("\n6. a loop inside a loop is a hole");
{
  const plate = square(200);
  plate.elements.push({ id: "h1", type: "circle", c: [50, 100], r: 18 },
                      { id: "h2", type: "circle", c: [150, 100], r: 18 });
  await kernel.setSketch(sketchId, "drawing", plate);
  const want = (200 * 200 - 2 * Math.PI * 18 * 18) * 40;
  check("two circles drawn inside a square are drilled, not padded",
    Math.abs(await volumeOf() - want) < 400, (await volumeOf()) + " vs " + want.toFixed(0));

  // Draw a third circle inside one of the holes: an island, solid again.
  plate.elements.push({ id: "i1", type: "circle", c: [50, 100], r: 8 });
  await kernel.setSketch(sketchId, "drawing", plate);
  const island = (200 * 200 - 2 * Math.PI * 18 * 18 + Math.PI * 8 * 8) * 40;
  check("and a loop inside a hole is solid again",
    Math.abs(await volumeOf() - island) < 400, (await volumeOf()) + " vs " + island.toFixed(0));
}

console.log("\n7. the plane moves the whole drawing");
{
  await kernel.setSketch(sketchId, "drawing", square(100));
  const before = (await kernel.mesh([pad])).features[0].positions;
  const json = JSON.stringify((await at(sketchId)).sketch.drawing);

  const origin = (await kernel.addFeature("Point", {})).id;
  const normal = (await kernel.addFeature("Vector", {})).id;
  await kernel.setParameter(normal, "dz", 0);
  await kernel.setParameter(normal, "dx", 1);
  const plane = (await kernel.addFeature("Plane", { origin, normal })).id;
  await kernel.setReference(sketchId, "plane", plane);

  const after = (await kernel.mesh([pad])).features[0].positions;
  check("the drawing does not change when the plane does",
    JSON.stringify((await at(sketchId)).sketch.drawing) === json);
  check("but the geometry does", before.length === after.length &&
    JSON.stringify(before) !== JSON.stringify(after));

  const moved = (await kernel.addFeature("Point", {})).id;
  await kernel.setParameter(moved, "x", 300);
  await kernel.setReference(sketchId, "origin", moved);
  const shifted = (await kernel.mesh([pad])).features[0].positions;
  check("and moving the origin moves the drawing with it",
    JSON.stringify(shifted) !== JSON.stringify(after));
}

console.log("\n8. arcs, ellipses, oblongs and splines all build");
{
  const menagerie = {
    elements: [
      { id: "a1", type: "arc", c: [0, 0], r: 50, a0: 0, a1: Math.PI },
      { id: "l1", type: "line", a: [-50, 0], b: [0, -50] },
      { id: "l2", type: "line", a: [0, -50], b: [50, 0] },
      { id: "el", type: "ellipse", c: [200, 0], rx: 60, ry: 30, rot: 0.4 },
      { id: "ob", type: "oblong", a: [400, 0], b: [500, 0], r: 25 },
      { id: "sp", type: "spline", pts: [[0, 200], [60, 260], [140, 180], [220, 240]], closed: false },
      { id: "pt", type: "point", p: [0, 400] },
    ],
    constraints: [],
  };
  await kernel.setSketch(sketchId, "drawing", menagerie);
  check("all seven kinds build together", !(await at(sketchId)).error,
    (await at(sketchId)).error);
  const entry = await at(sketchId);
  check("the point in it comes out as a point", entry.data && entry.data.kind === "point",
    JSON.stringify(entry.data || null));
}

console.log("\n9. a sketch is a node like any other");
{
  const file = (await kernel.model());
  const back = await kernel.loadModel(file);
  check("the model file reloads", back.report.failed.length === 0,
    JSON.stringify(back.report.failed.map(f => f.message)));
  const reloaded = (await tree()).features.find(f => f.type === "Sketch");
  check("with its drawing intact", reloaded.sketch.drawing.elements.length === 7,
    String(reloaded.sketch.drawing.elements.length));
}

console.log("\n10. an element the chain walks backwards is still itself");
{
  // The walker chains elements end to end whichever way round they were drawn,
  // so half of them get built in reverse. A line does not care. An arc very
  // much does: its sweep is a pair of angles that only ever increases, so
  // "reversed" cannot be written down as angles at all - and an attempt to
  // write it turned a quarter turn into a three-quarter turn the other way,
  // silently, in geometry that still looked plausible. Measure it.
  const backwards = {
    elements: [
      // Drawn so that the walk has to take the arc from its end to its start.
      { id: "run", type: "line", a: [-100, 10], b: [0, 10] },
      { id: "turn", type: "arc", c: [0, -30], r: 40, a0: 0, a1: Math.PI / 2 },
    ],
    constraints: [],
  };
  const walk = sketchLoops(backwards);
  check("the chain is one open run of two", walk.open.length === 1 && walk.open[0].length === 2);
  check("with the arc walked backwards", walk.open[0].some(step => step.reversed));

  await kernel.setSketch(sketchId, "drawing", backwards);
  // Measured on the sketch itself, not on what was padded from it: the length
  // of the drawing is the thing the reversal got wrong.
  const rule = (await kernel.addFeature("Measure", { shape: sketchId })).id;
  await kernel.setParameter(rule, "quantity", 0);
  const length = Number((await at(rule)).data.preview);
  const want = 100 + Math.PI * 40 / 2;
  check("and it measures the length it was drawn", Math.abs(length - want) < 0.01,
    length + " vs " + want.toFixed(2));
  await kernel.deleteFeature(rule);
}

console.log("\n11. drawing that carries on from what was drawn");
{
  const mdl = new Mdl({ kernel, apply: () => {}, setNode: () => {},
                        readLayout: () => ({}), select: () => {}, selected: () => null });
  await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "S",
                           units: "mm", features: [] });
  const sk = (await mdl.run({ op: "add", type: "Sketch", name: "Chain" })).id;
  const drawing = async () => (await at(sk)).sketch.drawing;

  // A polyline is the line tool used again and again, so what it writes is the
  // same edit again and again.
  for (const [a, b] of [[[0, 0], [100, 0]], [[100, 0], [100, 60]], [[100, 60], [0, 60]]])
    await mdl.run({ op: "draw", id: sk, type: "line", at: [a, b] });
  check("three segments make a run", (await drawing()).elements.length === 3);

  // An arc off the end of the last line: it starts there, leaves the way the
  // line was going, and only needs where it ends.
  await mdl.run({ op: "draw", id: sk, type: "arc", at: [[-60, 0]], from: "e3.b" });
  const arc = (await drawing()).elements[3];
  check("the arc is an arc", arc.type === "arc", JSON.stringify(arc));

  // Tangency, measured: at the join, the arc's direction and the line's must
  // be the same, and both ends must sit on the circle.
  const line = (await drawing()).elements[2];
  const join = line.b;
  const ends = sketchEnds(arc);
  const onCircle = p => Math.abs(Math.hypot(p[0] - arc.c[0], p[1] - arc.c[1]) - arc.r);
  check("it starts where the line stopped",
    Math.min(Math.hypot(ends.a[0] - join[0], ends.a[1] - join[1]),
             Math.hypot(ends.b[0] - join[0], ends.b[1] - join[1])) < 1e-3);
  check("and reaches where it was told", Math.min(onCircle(ends.a), onCircle(ends.b)) < 1e-3);
  // sketchDirectionAt answers "which way was it going when it got here", so the
  // way out of a handle and back along the element is the opposite of it. The
  // line arrives at the corner going one way; the arc must leave going the same.
  const heading = sketchDirectionAt(line, "b");
  const near = Math.hypot(ends.a[0] - join[0], ends.a[1] - join[1]) < 1e-3 ? "start" : "end";
  const inward = sketchDirectionAt(arc, near);
  const along = [-inward[0], -inward[1]];
  check("leaving exactly the way the line came in",
    Math.abs(along[0] - heading[0]) < 1e-4 && Math.abs(along[1] - heading[1]) < 1e-4,
    JSON.stringify([along, heading]));

  // Straight on has no arc through it - the "circle" is infinite. That is a
  // line, and drawing one beats refusing the click. e3 runs to [0,60] from
  // [100,60], so carrying on out of its far end means going back east.
  await mdl.run({ op: "draw", id: sk, type: "arc", at: [[240, 60]], from: "e3.a" });
  check("a straight tangent comes out as a line",
    (await drawing()).elements[4].type === "line", (await drawing()).elements[4].type);

  // And a handle moves without tearing the element it belongs to.
  await mdl.run({ op: "drag", id: sk, handle: "e1.b", to: [140, -20] });
  check("dragging an end moves it",
    JSON.stringify((await drawing()).elements[0].b) === "[140,-20]",
    JSON.stringify((await drawing()).elements[0].b));
  let refused = "";
  try { await mdl.run({ op: "drag", id: sk, handle: "nope.b", to: [0, 0] }); }
  catch (e) { refused = e.message; }
  check("dragging nothing is refused in words", /no handle/.test(refused), refused);
}

console.log("\n12. the sample the sketcher ships with");
{
  const { SAMPLES } = await import("../src/ocaf.js");
  const sample = SAMPLES.find(s => s.key === "sketcher");
  check("it sits after the hillside", SAMPLES.map(s => s.key).join(",")
    === "hillside-town,sketcher", SAMPLES.map(s => s.key).join(","));
  const built = await kernel.loadModel(sample.model);
  check("the Sketcher sample builds", built.report.failed.length === 0,
    JSON.stringify(built.report.failed.map(f => f.id + ": " + f.message)));
  const bad = (await tree()).features.filter(f => f.error);
  check("with nothing in error", bad.length === 0,
    bad.map(f => f.id + ": " + f.error).join("; "));

  const measure = async (shape, quantity) => {
    const id = (await kernel.addFeature("Measure", { shape })).id;
    await kernel.setParameter(id, "quantity", quantity);
    return Number((await at(id)).data.preview);
  };
  // Every number in the sample can be read off the drawing, so read them off.
  const outline = 210 + Math.PI * 50 + 210 + 100          // the four outer elements
                + 2 * Math.PI * 16 + 2 * Math.PI * 22     // two bolt circles
                + 2 * 70 + 2 * Math.PI * 14;              // and the slot
  check("the plate outline is as long as it is drawn",
    Math.abs(await measure("SK1", 0) - outline) < 0.05, String(await measure("SK1", 0)));

  const plate = await measure("EX1", 2), rib = await measure("EX2", 2);
  const union = await measure("BO1", 2);
  // A Boolean that appears to do nothing is the failure mode that looks right,
  // so the fuse is measured rather than believed: what it removed is the
  // trapezoid of rib standing in the plate's 14 mm, 14 mm thick.
  const overlap = (210 + 196) / 2 * 14 * 14;
  check("fusing the rib to the plate removes exactly where they overlap",
    Math.abs(plate + rib - union - overlap) < 1,
    (plate + rib - union) + " vs " + overlap);

  // The fin is the other half of the solid/surface toggle: an open chain,
  // swept, and nothing but the sweep.
  const chain = await measure("SK3", 0);
  check("the open chain sweeps into its own area, and no ends",
    Math.abs(await measure("EX3", 1) - chain * 40) < 0.05,
    (await measure("EX3", 1)) + " vs " + (chain * 40).toFixed(2));
  check("and the part is real geometry",
    (await kernel.mesh(["FI1"])).features[0].triangles > 2000);
}

console.log("\n13. a point held where two curves cross");
{
  // A line straight through a circle crosses it twice, so which crossing is
  // meant matters: it is the one the point is already nearest, and it stays
  // that one as the curves move.
  const drawing = {
    elements: [
      { id: "L1", type: "line", a: [-200, 0], b: [200, 0] },
      { id: "C1", type: "circle", c: [0, 0], r: 60 },
      { id: "P1", type: "point", p: [40, 8] },
    ],
    constraints: [sketchRelation("intersect", ["P1.p", "L1", "C1"])],
  };
  const at = d => solveSketch(d, 12).drawing.elements.find(e => e.id === "P1").p;
  const near = (p, want) => Math.abs(p[0] - want[0]) < 0.01 && Math.abs(p[1] - want[1]) < 0.01;
  check("the point goes to the crossing it is nearest", near(at(drawing), [60, 0]),
    JSON.stringify(at(drawing)));

  const other = JSON.parse(JSON.stringify(drawing));
  other.elements[2].p = [-40, 8];
  check("started on the other side it takes the other crossing",
    near(at(other), [-60, 0]), JSON.stringify(at(other)));

  // The crossing is a fact about the two curves, so growing one moves the
  // point and nothing else.
  const bigger = JSON.parse(JSON.stringify(drawing));
  bigger.elements[1].r = 150;
  const moved = solveSketch(bigger, 12).drawing;
  check("growing the circle takes the point with it",
    near(moved.elements.find(e => e.id === "P1").p, [150, 0]),
    JSON.stringify(moved.elements.find(e => e.id === "P1").p));
  check("and neither curve was moved to suit it",
    moved.elements[0].a[0] === -200 && moved.elements[1].c[0] === 0);

  // Curves that never meet leave it alone rather than throwing it somewhere.
  const apart = JSON.parse(JSON.stringify(drawing));
  apart.elements[0].a = [-200, 500];
  apart.elements[0].b = [200, 500];
  const still = solveSketch(apart, 12).drawing.elements.find(e => e.id === "P1").p;
  check("two that never meet leave the point where it was", near(still, [40, 8]),
    JSON.stringify(still));

  check("the mark sits on the point, not between the three things it names",
    near(sketchRelationMarks(drawing)[0].p, [40, 8]),
    JSON.stringify(sketchRelationMarks(drawing)[0].p));

  check("a file that carries one reads it back",
    readSketch(JSON.stringify(drawing)).constraints.length === 1);
  check("and one written with too few names is dropped rather than half-read",
    readSketch({ elements: drawing.elements,
                 constraints: [{ type: "intersect", of: ["P1.p", "L1"] }] }).constraints.length === 0);

  check("the crossings are found by id as well",
    sketchCrossings(drawing, "L1", "C1").length === 2,
    JSON.stringify(sketchCrossings(drawing, "L1", "C1")));
}

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
