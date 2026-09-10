// The four primitives a graph needs to compose on its own - a typed list, a
// group, a projection onto terrain, and one shape at many places - and the
// worked example built out of them.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { Mdl } from "../src/mdl.js";
import { SAMPLES, HILLSIDE_TOWN, parseNumbers } from "../src/ocaf.js";
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
const mdl = new Mdl({
  kernel, setNode: () => {}, readLayout: () => ({}), select: () => {}, selected: () => null,
});
const tree = async () => (await kernel.tree()).tree;
const at = async id => (await tree()).features.find(f => f.id === id);
const errors = async () => (await tree()).features.filter(f => f.error)
  .map(f => f.id + " " + f.name + ": " + f.error);

console.log("1. numbers, typed");
check("commas", parseNumbers("1, 2, 3").join() === "1,2,3");
check("spaces and newlines", parseNumbers("1 2\n-3.5").join() === "1,2,-3.5");
check("rubbish is skipped, not fatal", parseNumbers("1, banana, 3").join() === "1,3");
check("and nothing is nothing, not zero", parseNumbers("   ").length === 0,
      JSON.stringify(parseNumbers("   ")));

await mdl.run({ op: "model", model: { format: "ocaf-parametric-model", version: 1,
  name: "Nodes", units: "mm", features: [] } });
const nums = await mdl.run({ op: "add", type: "Numbers", name: "Bays" });
await mdl.run({ op: "code", id: nums.id, key: "values", text: "-1400, 0, 1400" });
let entry = await at(nums.id);
check("the node carries the list", entry.data.count === 3, entry.data.preview);
check("and publishes the text it was typed as",
      entry.texts.values === "-1400, 0, 1400", JSON.stringify(entry.texts));
await mdl.run({ op: "set", id: nums.id, key: "scale", value: 0.5 });
check("scale multiplies it", (await at(nums.id)).data.preview === "-700, 0, 700",
      (await at(nums.id)).data.preview);
await mdl.run({ op: "set", id: nums.id, key: "scale", value: 1 });
await mdl.run({ op: "code", id: nums.id, key: "values", text: "  " });
check("an empty list says so rather than building nothing",
      /type some numbers/.test((await at(nums.id)).error || ""), (await at(nums.id)).error);
await mdl.run({ op: "code", id: nums.id, key: "values", text: "-1400, 0, 1400" });

console.log("2. a plan, and the hill it lands on");
const pt = await mdl.run({ op: "add", type: "Point", name: "O" });
const vz = await mdl.run({ op: "add", type: "Vector", name: "Up" });
const pl = await mdl.run({ op: "add", type: "Plane", name: "Site" });
await mdl.run({ op: "connect", id: pl.id, key: "origin", from: pt.id });
await mdl.run({ op: "connect", id: pl.id, key: "normal", from: vz.id });

const grid = await mdl.run({ op: "add", type: "MeshGrid", name: "Grid" });
await mdl.run({ op: "connect", id: grid.id, key: "plane", from: pl.id });
for (const [key, value] of [["width", 4000], ["depth", 3000], ["cols", 12], ["rows", 10]])
  await mdl.run({ op: "set", id: grid.id, key, value });
const hill = await mdl.run({ op: "add", type: "MeshDisplace", name: "Landform" });
await mdl.run({ op: "connect", id: hill.id, key: "mesh", from: grid.id });
await mdl.run({ op: "set", id: hill.id, key: "along", value: 3 });     // Z
await mdl.run({ op: "set", id: hill.id, key: "amount", value: 800 });
await mdl.run({ op: "code", id: hill.id, key: "formula", text: "Math.exp(-((x / 1400) ** 2))" });
check("the hill built", !(await at(hill.id)).error, (await at(hill.id)).error);

const plan = await mdl.run({ op: "add", type: "Point", name: "Plan" });
await mdl.run({ op: "connect", id: plan.id, key: "x", from: nums.id });
await mdl.run({ op: "set", id: plan.id, key: "y", value: -600 });
check("three plan points, all flat", (await at(plan.id)).data.count === 3 &&
      /, 0\) \(0, -600, 0\)/.test((await at(plan.id)).data.preview),
      (await at(plan.id)).data.preview);

const drape = await mdl.run({ op: "add", type: "Drape", name: "Sites" });
await mdl.run({ op: "connect", id: drape.id, key: "points", from: plan.id, mode: "only" });
await mdl.run({ op: "connect", id: drape.id, key: "onto", from: hill.id });
entry = await at(drape.id);
const landed = entry.data.preview.match(/-?\d+(\.\d+)?(?=\))/g).map(Number);
check("the plan came back with heights on it", entry.data.count === 3, entry.data.preview);
check("the middle one is on the crest and the ends are lower",
      landed[1] > landed[0] && landed[1] > landed[2], landed.join(" / "));
check("and it kept its x and y", /^\(-1400, -600,/.test(entry.data.preview), entry.data.preview);
await mdl.run({ op: "set", id: drape.id, key: "lift", value: 50 });
const lifted = (await at(drape.id)).data.preview.match(/-?\d+(\.\d+)?(?=\))/g).map(Number);
check("lift raises every landing", Math.abs(lifted[1] - landed[1] - 50) < 1e-6,
      lifted[1] + " vs " + landed[1]);
await mdl.run({ op: "set", id: drape.id, key: "lift", value: 0 });

console.log("3. one shape, many places");
const cube = await mdl.run({ op: "add", type: "Cube", name: "Hut" });
await mdl.run({ op: "connect", id: cube.id, key: "origin", from: pt.id });
const turns = await mdl.run({ op: "add", type: "Numbers", name: "Turns" });
await mdl.run({ op: "code", id: turns.id, key: "values", text: "0, 30, -30" });
const place = await mdl.run({ op: "add", type: "PlaceAt", name: "Huts" });
await mdl.run({ op: "connect", id: place.id, key: "shape", from: cube.id });
await mdl.run({ op: "connect", id: place.id, key: "points", from: drape.id });
await mdl.run({ op: "connect", id: place.id, key: "angles", from: turns.id });
entry = await at(place.id);
check("it built", entry.built && !entry.error, entry.error);
check("and it consumed the shape", !(await at(cube.id)).visible);
const spread = async id => {
  const s = (await kernel.mesh([id])).features[0];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < s.positions.length; i += 3) { lo = Math.min(lo, s.positions[i]); hi = Math.max(hi, s.positions[i]); }
  return hi - lo;
};
check("the copies are spread across the whole plan", (await spread(place.id)) > 2800,
      String(Math.round(await spread(place.id))));
const before = await spread(place.id);
await mdl.run({ op: "set", id: place.id, key: "turn", value: 45 });
check("turning them all changes the footprint", Math.abs((await spread(place.id)) - before) > 1,
      before + " → " + (await spread(place.id)));
await mdl.run({ op: "set", id: place.id, key: "turn", value: 0 });

let refused = "";
try { await mdl.run({ op: "connect", id: place.id, key: "points", from: nums.id }); }
catch (e) { refused = e.message; }
check("it will not take numbers where it wants points", /point/i.test(refused), refused);

console.log("4. a group is not a fuse");
const other = await mdl.run({ op: "add", type: "Sphere", name: "Ball" });
await mdl.run({ op: "connect", id: other.id, key: "center", from: pt.id });
const join = await mdl.run({ op: "add", type: "Join", name: "Both" });
await mdl.run({ op: "connect", id: join.id, key: "parts", from: place.id });
await mdl.run({ op: "connect", id: join.id, key: "parts", from: other.id });
entry = await at(join.id);
check("both parts went in, in order",
      JSON.stringify(entry.lists.parts) === JSON.stringify([place.id, other.id]),
      JSON.stringify(entry.lists.parts));
check("it built", entry.built && !entry.error, entry.error);
check("and both left the 3D view",
      !(await at(place.id)).visible && !(await at(other.id)).visible);
const area = await mdl.run({ op: "add", type: "Measure", name: "Area" });
await mdl.run({ op: "connect", id: area.id, key: "shape", from: join.id });
await mdl.run({ op: "set", id: area.id, key: "quantity", value: 1 });
check("nothing was fused away - the faces of both are still there",
      Number((await at(area.id)).data.preview) > 0, (await at(area.id)).data.preview);

console.log("5. the worked example");
check("there is a sample to load", SAMPLES.length >= 1 && SAMPLES[0].model === HILLSIDE_TOWN);
check("and not one of its features is a written one",
      HILLSIDE_TOWN.features.every(f => !["Script", "Ribbon", "Center"].includes(f.type)),
      HILLSIDE_TOWN.features.filter(f => f.type === "Script").map(f => f.id).join(","));
check("it carries a layout for every feature",
      HILLSIDE_TOWN.features.every(f => Array.isArray(HILLSIDE_TOWN.layout[f.id])));

const started = Date.now();
const out = await mdl.run({ op: "model", model: HILLSIDE_TOWN });
const ms = Date.now() - started;
check("it loads", out.tree.features.length === HILLSIDE_TOWN.features.length,
      out.tree.features.length + " of " + HILLSIDE_TOWN.features.length);
check("every node builds", (await errors()).length === 0, (await errors()).join(" | "));
check("in well under a second", ms < 1500, ms + " ms");
check("the town is there", (await at("JT")).built);
check("and the readout read the site", Number((await at("EX")).data.preview) === 42,
      (await at("EX")).data.preview);

console.log("6. it is parametric where it says it is");
const townSize = async () => {
  const s = (await kernel.mesh(["JT"])).features[0];
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < s.positions.length; i += 3) { lo = Math.min(lo, s.positions[i]); hi = Math.max(hi, s.positions[i]); }
  return hi - lo;
};
const flat = await townSize();
await mdl.run({ op: "set", id: "NH", key: "value", value: 1800 });
check("raising the hill lifts the town with it", (await townSize()) > flat + 400,
      flat + " → " + (await townSize()));
check("nothing broke on the way", (await errors()).length === 0, (await errors()).join(" | "));

const report = (await mdl.run({ op: "code", id: "NT1", key: "values", text: "40, -35, 25" })).report;
check("retyping one villa's turn rebuilds three nodes, not forty-seven",
      report.executed.length === 3, report.executed.map(e => e.id).join(","));
check("and they are the list, the placement and the town",
      report.executed.map(e => e.id).sort().join(",") === "JT,NT1,PA1",
      report.executed.map(e => e.id).join(","));

await mdl.run({ op: "set", id: "NW", key: "value", value: 6000 });
check("widening the site is clean", (await errors()).length === 0, (await errors()).join(" | "));
check("and the readout followed", Number((await at("EX")).data.preview) === 60,
      (await at("EX")).data.preview);

console.log("7. the file survives itself");
const text = JSON.stringify(await kernel.model());
await mdl.run({ op: "model", model: text });
check("round trip keeps every feature",
      (await tree()).features.length === HILLSIDE_TOWN.features.length);
check("and every one still builds", (await errors()).length === 0, (await errors()).join(" | "));
check("the typed lists came back",
      (await at("NB")).texts.values === "-1450, 0, 1450", (await at("NB")).texts.values);
check("so did the wire onto the grid's width",
      (await at("MG")).driven.width === "NW", JSON.stringify((await at("MG")).driven));

console.log(failures ? "\n" + failures + " FAILED" : "\nall good");
process.exit(failures ? 1 : 0);
