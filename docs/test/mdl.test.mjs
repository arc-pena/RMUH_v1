// The command language, headlessly: every op against a real kernel, the
// refusals it must make, and the round trip through the model file.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { Mdl, MDL_OPS, parseEdits, mdlSchema, mdlOp } from "../src/mdl.js";
import { graphRanks } from "../src/graph.js";
import { readFileSync } from "fs";

const WASM_DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(WASM_DIR + "/replicad_single.js")).default;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};

const MODEL = {
  format: "ocaf-parametric-model", version: 1, name: "Part1", units: "mm",
  features: [
    { id: "PT1", type: "Point", name: "Origin", args: { x: 0, y: 0, z: 0 } },
    { id: "VZ", type: "Vector", name: "Z Direction", args: { dx: 0, dy: 0, dz: 1 } },
    { id: "PL1", type: "Plane", name: "XY Plane",
      args: { origin: { ref: "PT1" }, normal: { ref: "VZ" }, size: 200 } },
    { id: "CB1", type: "Cube", name: "Cube.1",
      args: { origin: { ref: "PT1" }, plane: { ref: "PL1" }, dx: 80, dy: 80, dz: 80 } },
  ],
};

const kernel = await createWasmKernel({
  initModule, wasmBinary: readFileSync(WASM_DIR + "/replicad_single.wasm"),
});

// The channel, with the graph's two view hooks stubbed by a plain map.
const layout = new Map();
let selected = null;
const mdl = new Mdl({
  kernel,
  setNode: (id, x, y) => layout.set(id, { x, y }),
  readLayout: block => {
    if (block === undefined)
      return Object.fromEntries([...layout].map(([id, at]) => [id, [at.x, at.y]]));
    layout.clear();
    for (const [id, at] of Object.entries(block || {})) layout.set(id, { x: at[0], y: at[1] });
  },
  select: id => { selected = id; },
  selected: () => selected,
});

console.log("1. the language describes itself");
const schema = mdlSchema();
check("every op is published", schema.ops.length === MDL_OPS.length, String(schema.ops.length));
check("every op carries an example",
  schema.ops.every(op => op.example && op.example.op === op.op));
check("view ops are marked", schema.ops.find(o => o.op === "move").rebuilds === false);
check("model ops are marked", schema.ops.find(o => o.op === "set").rebuilds === true);
check("mdlOp finds one", mdlOp("connect") !== null && mdlOp("nope") === null);

console.log("2. text in, edits out");
check("a bare object needs no brackets", parseEdits('{"op":"select","id":"CB1"}').length === 1);
check("a list works", parseEdits('[{"op":"select"},{"op":"select"}]').length === 2);
check("a trailing comma is forgiven", parseEdits('{"op":"select","id":"A"},').length === 1);
check("blank is nothing", parseEdits("   ").length === 0);
let threw = "";
try { parseEdits('{"op":"explode"}'); } catch (e) { threw = e.message; }
check("an unknown op is refused", threw.includes("explode"), threw);

console.log("3. every op against a real kernel");
await mdl.run({ op: "model", model: MODEL });
check("the document loaded", (await kernel.tree()).tree.features.length === 4);

await mdl.run({ op: "set", id: "CB1", key: "dx", value: 130 });
let tree = (await kernel.tree()).tree;
check("set moved a parameter", tree.features.find(f => f.id === "CB1").values.dx === 130);

const born = await mdl.run({ op: "add", type: "Sphere", name: "Ball" });
tree = (await kernel.tree()).tree;
check("add returns the new id", !!born.id, born.id);
check("add named it", tree.features.find(f => f.id === born.id).name === "Ball");

await mdl.run({ op: "add", type: "Fillet", name: "Round" });
tree = (await kernel.tree()).tree;
const fillet = tree.features.find(f => f.name === "Round");
check("the operation wired itself to a body", !!fillet.refs.body, JSON.stringify(fillet.refs));

await mdl.run({ op: "disconnect", id: fillet.id, key: "body" });
tree = (await kernel.tree()).tree;
check("disconnect cleared the wire", !tree.features.find(f => f.id === fillet.id).refs.body);
check("and the feature says why it cannot build",
  /body|missing|no /i.test(tree.features.find(f => f.id === fillet.id).error || ""),
  tree.features.find(f => f.id === fillet.id).error);

await mdl.run({ op: "connect", id: fillet.id, key: "body", from: "CB1" });
tree = (await kernel.tree()).tree;
check("connect wired it back", tree.features.find(f => f.id === fillet.id).refs.body === "CB1");
check("and it built", tree.features.find(f => f.id === fillet.id).built);

await mdl.run({ op: "rename", id: "CB1", name: "Base block" });
check("rename took", (await kernel.tree()).tree.features.find(f => f.id === "CB1").name === "Base block");

await mdl.run({ op: "appearance", id: "CB1", appearance: { finish: "brass" } });
check("appearance took",
  (await kernel.tree()).tree.features.find(f => f.id === "CB1").appearance.finish === "brass");

await mdl.run({ op: "select", id: "CB1" });
check("select is a view op that still runs", selected === "CB1");
await mdl.run({ op: "move", id: "CB1", x: 420, y: 160 });
check("move is recorded in the layout", layout.get("CB1").x === 420);

console.log("4. refusals are recorded, not swallowed");
const before = mdl.history.length;
let refused = "";
try { await mdl.run({ op: "delete", id: "CB1" }); } catch (e) { refused = e.message; }
check("a body something reads from cannot be deleted", refused.includes("still reads"), refused);
check("the refusal is in the history", mdl.history.length === before + 1);
check("and it is marked failed", mdl.history[mdl.history.length - 1].ok === false);

refused = "";
try { await mdl.run({ op: "set", id: "CB1", key: "dx", value: "big" }); } catch (e) { refused = e.message; }
check("a value must be a number", refused.includes("number"), refused);

refused = "";
try { await mdl.run({ op: "connect", id: "CB1", key: "plane", from: "PT1" }); } catch (e) { refused = e.message; }
check("a wire must respect the type", refused.includes("Plane"), refused);

refused = "";
try { await mdl.run({ op: "connect", id: "PL1", key: "origin", from: fillet.id }); } catch (e) { refused = e.message; }
check("a cycle is refused", refused.length > 0, refused);

console.log("5. the file is the model");
const text = await mdl.modelText();
const parsed = JSON.parse(text);
check("the layout travels in the file", parsed.layout.CB1[0] === 420, JSON.stringify(parsed.layout));
check("so does the appearance", parsed.features.find(f => f.id === "CB1").appearance.finish === "brass");
check("and the edited parameter", parsed.features.find(f => f.id === "CB1").args.dx === 130);

layout.clear();
await mdl.run({ op: "model", model: text });
tree = (await kernel.tree()).tree;
check("the file rebuilds the part", tree.features.length === parsed.features.length);
check("the file restores the layout", layout.get("CB1").x === 420);
check("nothing failed on the way back", tree.features.every(f => !f.error),
  tree.features.filter(f => f.error).map(f => f.id + ": " + f.error).join(" | "));

console.log("6. the two views agree");
const ranks = graphRanks(tree.features);
const order = tree.features.map(f => f.id);
check("a reference always ranks after what it reads",
  tree.features.every(f => Object.values(f.refs).every(target =>
    !target || ranks.get(target) < ranks.get(f.id))));
check("the datums are the roots",
  tree.features.filter(f => ranks.get(f.id) === 0).every(f => f.category === "datum"),
  tree.features.filter(f => ranks.get(f.id) === 0).map(f => f.id).join(","));
check("the tree lists every node the graph draws", order.length === ranks.size);

console.log("7. a batch is one session");
const n = mdl.history.length;
await mdl.runAll([
  { op: "move", id: "PT1", x: 30, y: 30 },
  { op: "move", id: "VZ", x: 30, y: 140 },
]);
check("both edits ran", mdl.history.length === n + 2);
check("in order", mdl.history[n].edit.id === "PT1" && mdl.history[n + 1].edit.id === "VZ");

console.log(failures ? "\n" + failures + " FAILED" : "\nall good");
process.exit(failures ? 1 : 0);
