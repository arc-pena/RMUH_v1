import { createWasmKernel } from "../src/wasm-kernel.js";
import { Mdl } from "../src/mdl.js";
import { coincidentGroup, solveSketch } from "../src/sketch.js";
import { readFileSync } from "fs";
const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const init = (await import(DIR + "/replicad_single.js")).default;
let failures = 0;
const check = (n, ok, d = "") => { if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + n + (d ? "  — " + d : "")); };
const kernel = await createWasmKernel({ initModule: init, wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });
const mdl = new Mdl({ kernel, apply: () => {}, setNode: () => {}, readLayout: () => ({}), select: () => {}, selected: () => null });
const at = async id => ((await kernel.tree()).tree.features).find(f => f.id === id);

console.log("1. three points, one input");
await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "M", units: "mm", features: [] });
const pts = [];
for (const [x, y] of [[0, 0], [200, 0], [200, 160]]) {
  const p = (await mdl.run({ op: "add", type: "Point", name: "P" + pts.length })).id;
  await mdl.run({ op: "set", id: p, key: "x", value: x });
  await mdl.run({ op: "set", id: p, key: "y", value: y });
  pts.push(p);
}
const poly = (await mdl.run({ op: "add", type: "Polyline", name: "Run" })).id;
// The first drop replaces whatever the button guessed; the rest add to it.
await mdl.run({ op: "connect", id: poly, key: "points", from: pts[0], mode: "only" });
await mdl.run({ op: "connect", id: poly, key: "points", from: pts[1] });
await mdl.run({ op: "connect", id: poly, key: "points", from: pts[2] });
check("all three wires landed on one input", (await at(poly)).lists.points.length === 3,
  JSON.stringify((await at(poly)).lists.points));
check("and it built", !(await at(poly)).error, (await at(poly)).error);
const ruler = (await mdl.run({ op: "add", type: "Measure", name: "Len" })).id;
await mdl.run({ op: "connect", id: ruler, key: "shape", from: poly, mode: "only" });
const length = Number((await at(ruler)).data.preview);
check("through the points, in the order they were wired", Math.abs(length - 360) < 0.01,
  length + " vs 360");

console.log("\n2. and one wire replaces them all");
await mdl.run({ op: "connect", id: poly, key: "points", from: pts[0], mode: "only" });
check("only leaves one", (await at(poly)).lists.points.length === 1,
  JSON.stringify((await at(poly)).lists.points));

console.log("\n3. the model file carries the list, and reads a single one back");
const model = await kernel.model();
check("written as a list", Array.isArray(model.features.find(f => f.id === poly).args.points));
model.features.find(f => f.id === poly).args.points = { ref: pts[1] };
await kernel.loadModel(model);
check("a single reference, the way the old format wrote it, still lands on it",
  JSON.stringify((await at(poly)).lists.points) === JSON.stringify([pts[1]]),
  JSON.stringify((await at(poly)).lists.points));

console.log("\n4. a relation can be taken off again");
await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "M", units: "mm", features: [] });
const sk = (await mdl.run({ op: "add", type: "Sketch", name: "S" })).id;
await mdl.run({ op: "draw", id: sk, type: "line", at: [[0, 0], [100, 0]] });
await mdl.run({ op: "draw", id: sk, type: "line", at: [[100, 0], [100, 60]] });
await mdl.run({ op: "relate", id: sk, type: "coincident", of: ["e1.b", "e2.a"] });
const drawing = async () => (await at(sk)).sketch.drawing;
check("the relation is on", (await drawing()).constraints.length === 1);
check("and the group knows both ends",
  JSON.stringify(coincidentGroup(await drawing(), "e1.b")) === '["e2.a"]',
  JSON.stringify(coincidentGroup(await drawing(), "e1.b")));

console.log("\n5. dragging a held corner takes the other end with it");
await mdl.run({ op: "drag", id: sk, handle: "e1.b", to: [140, -30] });
const d = await drawing();
check("the dragged end went exactly where it was put",
  JSON.stringify(d.elements[0].b) === "[140,-30]", JSON.stringify(d.elements[0].b));
check("and the other end came with it, all the way",
  JSON.stringify(d.elements[1].a) === "[140,-30]", JSON.stringify(d.elements[1].a));
check("while the far ends stayed put",
  JSON.stringify(d.elements[0].a) === "[0,0]" && JSON.stringify(d.elements[1].b) === "[100,60]",
  JSON.stringify([d.elements[0].a, d.elements[1].b]));

console.log("\n6. take the relation off and they come apart again");
await mdl.run({ op: "unrelate", id: sk, at: 0 });
check("it is gone", (await drawing()).constraints.length === 0);
await mdl.run({ op: "drag", id: sk, handle: "e1.b", to: [40, 40] });
const apart = await drawing();
check("now only the dragged end moves",
  JSON.stringify(apart.elements[0].b) === "[40,40]" &&
  JSON.stringify(apart.elements[1].a) === "[140,-30]",
  JSON.stringify([apart.elements[0].b, apart.elements[1].a]));
let said = "";
try { await mdl.run({ op: "unrelate", id: sk, at: 0 }); } catch (e) { said = e.message; }
check("removing one that is not there is refused in words", /no relation/.test(said), said);

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
