// Undo/redo over the one channel: does a stack of whole model files really put
// the document back, and does a stream of slider ticks collapse into one step?
import { createWasmKernel } from "../src/wasm-kernel.js";
import { Mdl } from "../src/mdl.js";
import { readFileSync } from "fs";

const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const init = (await import(DIR + "/replicad_single.js")).default;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};

const kernel = await createWasmKernel({ initModule: init, wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });
let layout = {};
const mdl = new Mdl({
  kernel,
  apply: () => {},
  setNode: () => {},
  readLayout: block => (block === undefined ? layout : (layout = block)),
  select: () => {},
  selected: () => null,
});
const tree = async () => (await kernel.tree()).tree;
const names = async () => (await tree()).features.map(f => f.name).join(",");
const at = async id => (await tree()).features.find(f => f.id === id);

await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "U", units: "mm", features: [] });

console.log("1. an edit can be taken back");
const cube = await mdl.run({ op: "add", type: "Cube", name: "Block" });
check("adding put something on the stack", mdl.undoable === "add", String(mdl.undoable));
await mdl.run({ op: "undo" });
check("undo removes it", (await names()) === "", await names());
check("and offers itself back", mdl.redoable === "add", String(mdl.redoable));
await mdl.run({ op: "redo" });
check("redo puts it back", (await names()) === "Block", await names());

console.log("\n2. a slider drag is one step, not a hundred");
const id = (await tree()).features[0].id;
const start = (await at(id)).values.dx;
for (let v = 100; v <= 160; v += 2) await mdl.run({ op: "set", id, key: "dx", value: v });
check("the drag moved it", (await at(id)).values.dx === 160, String((await at(id)).values.dx));
check("but left one step behind it", mdl.past.length === 2,
  mdl.past.map(p => p.label).join(","));
await mdl.run({ op: "undo" });
check("one undo returns the whole drag", (await at(id)).values.dx === start,
  (await at(id)).values.dx + " vs " + start);

console.log("\n3. doing something new forgets the redo branch");
await mdl.run({ op: "rename", id, name: "Base" });
check("the branch is gone", mdl.redoable === null, String(mdl.redoable));
check("and the new edit is on the stack", mdl.undoable === "rename");

console.log("\n4. view edits are not on it");
const depth = mdl.past.length;
await mdl.run({ op: "move", id, x: 40, y: 40 });
await mdl.run({ op: "select", id });
check("moving a node and selecting change nothing to undo", mdl.past.length === depth,
  mdl.past.length + " vs " + depth);

console.log("\n5. a refused edit has nothing to undo");
const before = mdl.past.length;
try { await mdl.run({ op: "set", id, key: "nonesuch", value: 1 }); } catch (e) { /* expected */ }
check("it did not push a step", mdl.past.length === before, mdl.past.length + " vs " + before);

console.log("\n6. the whole document, wires and all");
const point = await mdl.run({ op: "add", type: "Point", name: "Corner" });
await mdl.run({ op: "connect", id, key: "origin", from: point.id });
check("the wire is on", (await at(id)).refs.origin === point.id);
await mdl.run({ op: "undo" });
check("undo pulls the wire", !(await at(id)).refs.origin, String((await at(id)).refs.origin));
await mdl.run({ op: "undo" });
check("and again removes the point", !(await tree()).features.some(f => f.name === "Corner"));

console.log("\n7. it carries the graph's layout too");
layout = { [id]: { x: 11, y: 22 } };
await mdl.run({ op: "add", type: "Sphere", name: "Ball" });
layout = { [id]: { x: 99, y: 99 } };
await mdl.run({ op: "undo" });
check("the canvas goes back with the model", layout[id].x === 11, JSON.stringify(layout));

console.log("\n8. undo at the bottom says so rather than throwing nonsense");
while (mdl.past.length) await mdl.run({ op: "undo" });
let said = "";
try { await mdl.run({ op: "undo" }); } catch (e) { said = e.message; }
check("it refuses in words", said === "nothing to undo", said);

console.log("\n9. a sketch handle drags, and one drag is one step");
await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "U", units: "mm", features: [] });
mdl.past.length = mdl.future.length = 0;
const sk = (await mdl.run({ op: "add", type: "Sketch", name: "Face" })).id;
await mdl.run({ op: "draw", id: sk, type: "line", at: [[0, 0], [100, 0]] });
const line = () => at(sk).then(e => e.sketch.drawing.elements[0]);
check("the line is where it was drawn", (await line()).b[0] === 100);
for (let x = 100; x <= 140; x += 4) await mdl.run({ op: "drag", id: sk, handle: "e1.b", to: [x, 20] });
check("dragging moved the end", (await line()).b[0] === 140, JSON.stringify((await line()).b));
const steps = mdl.past.length;
await mdl.run({ op: "undo" });
check("and one undo puts the whole drag back", (await line()).b[0] === 100 && (await line()).b[1] === 0,
  JSON.stringify((await line()).b) + " after " + steps + " steps");

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
