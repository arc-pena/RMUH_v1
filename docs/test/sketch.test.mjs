// The sketcher: a drawing in two dimensions, on a plane.
//
// What is being checked is the thing that makes a sketch a sketch: the drawing
// is written in the plane's coordinates and nowhere else, so moving the plane
// moves the drawing and nothing in the JSON changes. After that, that the
// loops it closes really are faces - measured, not assumed - and that a pad
// off a sketch is a solid with a volume you can predict on paper.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { EMPTY_SKETCH, SKETCH_CLICKS, SKETCH_TYPES, readSketch, sketchElement,
         sketchLoops, sketchRelation, sketchSummary, solveSketch } from "../src/sketch.js";
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

console.log("\n10. the sample the sketcher ships with");
{
  const { SAMPLES } = await import("../src/ocaf.js");
  const sample = SAMPLES.find(s => s.key === "sketched-bracket");
  const built = await kernel.loadModel(sample.model);
  check("the sketched bracket builds", built.report.failed.length === 0,
    JSON.stringify(built.report.failed.map(f => f.id + ": " + f.message)));
  const bad = (await tree()).features.filter(f => f.error);
  check("with nothing in error", bad.length === 0,
    bad.map(f => f.id + ": " + f.error).join("; "));
  const plate = (await kernel.mesh(["FI1"])).features[0];
  check("and the plate is real geometry", plate.triangles > 2000, String(plate.triangles));
}

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
