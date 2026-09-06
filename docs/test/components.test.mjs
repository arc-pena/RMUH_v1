// The Grasshopper-shaped half of the catalogue: numbers flowing into sliders,
// geometry flowing back out as numbers, and the components between.
import { createWasmKernel } from "../src/wasm-kernel.js";
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
const mdl = new Mdl({
  kernel, setNode: () => {}, readLayout: () => ({}), select: () => {}, selected: () => null,
});

const tree = async () => (await kernel.tree()).tree;
const at = async id => (await tree()).features.find(f => f.id === id);
const errors = async () => (await tree()).features.filter(f => f.error)
  .map(f => f.id + ": " + f.error);

console.log("1. a number is a feature");
await mdl.run({ op: "model", model: { format: "ocaf-parametric-model", version: 1,
  name: "Data", units: "mm", features: [] } });
const num = await mdl.run({ op: "add", type: "Number", name: "Width" });
await mdl.run({ op: "set", id: num.id, key: "value", value: 250 });
let entry = await at(num.id);
check("it computes rather than builds", !entry.built && !!entry.data);
check("and the answer is the number", entry.data.preview === "250", entry.data.preview);
check("it produces numbers", entry.produces === "number");

console.log("2. a wire replaces a literal");
const pt = await mdl.run({ op: "add", type: "Point", name: "P" });
const cube = await mdl.run({ op: "add", type: "Cube", name: "Block" });
await mdl.run({ op: "connect", id: cube.id, key: "dx", from: num.id });
entry = await at(cube.id);
check("the slider reports what arrives", entry.values.dx === 250, String(entry.values.dx));
check("and says who is driving it", entry.driven.dx === num.id, JSON.stringify(entry.driven));
check("the cube still built", entry.built && !entry.error, entry.error);

await mdl.run({ op: "set", id: num.id, key: "value", value: 90 });
entry = await at(cube.id);
check("changing the number rebuilds downstream", entry.values.dx === 90, String(entry.values.dx));

await mdl.run({ op: "disconnect", id: cube.id, key: "dx" });
entry = await at(cube.id);
check("pulling the wire off restores the literal", entry.values.dx === 80, String(entry.values.dx));
check("and nothing is driving it", !entry.driven.dx);

console.log("3. a cycle is still impossible");
let refused = "";
const measure = await mdl.run({ op: "add", type: "Measure", name: "Size" });
await mdl.run({ op: "connect", id: measure.id, key: "shape", from: cube.id });
try { await mdl.run({ op: "connect", id: cube.id, key: "dx", from: measure.id }); }
catch (e) { refused = e.message; }
check("a measurement cannot drive what it measures", refused.length > 0, refused);

console.log("4. geometry back into numbers");
for (const key of ["dx", "dy", "dz"]) await mdl.run({ op: "set", id: cube.id, key, value: 100 });
const QUANTITIES = ["Length", "Area", "Volume", "Size X", "Size Y", "Size Z", "Diagonal"];
for (const [name, want] of Object.entries(
    { Area: 60000, Volume: 1000000, "Size X": 100, Diagonal: Math.sqrt(3) * 100 })) {
  await mdl.run({ op: "set", id: measure.id, key: "quantity", value: QUANTITIES.indexOf(name) });
  const got = Number((await at(measure.id)).data.preview);
  check("a 100 mm cube measures " + name.toLowerCase(), Math.abs(got - want) < want * 1e-6,
        got + " vs " + want);
}

console.log("5. a list of numbers becomes a row of points");
const series = await mdl.run({ op: "add", type: "Series", name: "Stations" });
await mdl.run({ op: "set", id: series.id, key: "start", value: 0 });
await mdl.run({ op: "set", id: series.id, key: "step", value: 50 });
await mdl.run({ op: "set", id: series.id, key: "count", value: 8 });
check("the series is eight long", (await at(series.id)).data.count === 8);

await mdl.run({ op: "connect", id: pt.id, key: "x", from: series.id });
entry = await at(pt.id);
check("one point becomes eight", entry.data.count === 8, JSON.stringify(entry.data));
check("and they are points", entry.data.kind === "point");
check("the list length is reported", entry.lists.x === 8, JSON.stringify(entry.lists));

console.log("6. an expression shapes the list");
const expr = await mdl.run({ op: "add", type: "Expression", name: "Wave" });
await mdl.run({ op: "connect", id: expr.id, key: "a", from: series.id });
await mdl.run({ op: "code", id: expr.id, key: "formula", text: "a * 0.5" });
check("it ran over the whole list", (await at(expr.id)).data.count === 8);
check("and it did the arithmetic", (await at(expr.id)).data.preview.startsWith("0, 25, 50"),
      (await at(expr.id)).data.preview);
await mdl.run({ op: "code", id: expr.id, key: "formula", text: "a * (" });
check("a broken formula is a syntax error, not a crash",
      /will not compile/.test((await at(expr.id)).error || ""), (await at(expr.id)).error);
await mdl.run({ op: "code", id: expr.id, key: "formula", text: "Math.sin(i / n * 6.28) * 120" });
await mdl.run({ op: "connect", id: pt.id, key: "z", from: expr.id });
check("and it drives a coordinate", !(await at(pt.id)).error, (await at(pt.id)).error);

console.log("7. points into curves, curves back into points");
const poly = await mdl.run({ op: "add", type: "Interpolate", name: "Spline" });
await mdl.run({ op: "connect", id: poly.id, key: "points", from: pt.id });
entry = await at(poly.id);
check("the curve built", entry.built && !entry.error, entry.error);
check("and it produces a curve", entry.produces === "curve");

const divide = await mdl.run({ op: "add", type: "DivideCurve", name: "Divisions" });
await mdl.run({ op: "connect", id: divide.id, key: "curve", from: poly.id });
await mdl.run({ op: "set", id: divide.id, key: "count", value: 12 });
check("dividing gives thirteen stations for twelve divisions",
      (await at(divide.id)).data.count === 13, String((await at(divide.id)).data.count));

const evaluate = await mdl.run({ op: "add", type: "EvaluateCurve", name: "Mid" });
await mdl.run({ op: "connect", id: evaluate.id, key: "curve", from: poly.id });
check("evaluating at one parameter gives one point",
      (await at(evaluate.id)).data.count === 1, (await at(evaluate.id)).data.preview);
const range = await mdl.run({ op: "add", type: "Range", name: "T" });
await mdl.run({ op: "set", id: range.id, key: "steps", value: 5 });
await mdl.run({ op: "connect", id: evaluate.id, key: "t", from: range.id });
check("evaluating at a list gives a list", (await at(evaluate.id)).data.count === 6,
      String((await at(evaluate.id)).data.count));

console.log("8. surfaces, and the point on one");
const evalSurf = await mdl.run({ op: "add", type: "EvaluateSurface", name: "OnFace" });
await mdl.run({ op: "connect", id: evalSurf.id, key: "surface", from: cube.id });
check("a point comes off the face", !(await at(evalSurf.id)).error, (await at(evalSurf.id)).error);

console.log("9. extrude, loft, boolean, project");
const circle = await mdl.run({ op: "add", type: "Circle", name: "Ring" });
check("the circle says it needs a plane", !!(await at(circle.id)).error, "(none)");
const origin = await mdl.run({ op: "add", type: "Point", name: "O" });
const up = await mdl.run({ op: "add", type: "Vector", name: "Up" });
const pl = await mdl.run({ op: "add", type: "Plane", name: "Base" });
await mdl.run({ op: "connect", id: pl.id, key: "origin", from: origin.id });
await mdl.run({ op: "connect", id: pl.id, key: "normal", from: up.id });
await mdl.run({ op: "connect", id: circle.id, key: "plane", from: pl.id });
check("now the circle builds", !(await at(circle.id)).error, (await at(circle.id)).error);

const extrude = await mdl.run({ op: "add", type: "Extrude", name: "Post" });
await mdl.run({ op: "connect", id: extrude.id, key: "profile", from: circle.id });
await mdl.run({ op: "connect", id: extrude.id, key: "direction", from: up.id });
entry = await at(extrude.id);
check("the extrusion built", entry.built && !entry.error, entry.error);
check("and it consumed the profile", !(await at(circle.id)).visible);

const p2 = await mdl.run({ op: "add", type: "Point", name: "O2" });
await mdl.run({ op: "set", id: p2.id, key: "z", value: 200 });
const pl2 = await mdl.run({ op: "add", type: "Plane", name: "Top" });
await mdl.run({ op: "connect", id: pl2.id, key: "origin", from: p2.id });
await mdl.run({ op: "connect", id: pl2.id, key: "normal", from: up.id });
const c2 = await mdl.run({ op: "add", type: "Circle", name: "Ring2" });
await mdl.run({ op: "connect", id: c2.id, key: "plane", from: pl2.id });
await mdl.run({ op: "set", id: c2.id, key: "radius", value: 20 });
const c3 = await mdl.run({ op: "add", type: "Circle", name: "Ring3" });
await mdl.run({ op: "connect", id: c3.id, key: "plane", from: pl.id });
await mdl.run({ op: "set", id: c3.id, key: "radius", value: 90 });

const loft = await mdl.run({ op: "add", type: "Loft", name: "Skin" });
check("a loft with nothing wired says so", /at least two/.test((await at(loft.id)).error || ""),
      (await at(loft.id)).error);
await mdl.run({ op: "connect", id: loft.id, key: "sections", from: c3.id });
await mdl.run({ op: "connect", id: loft.id, key: "sections", from: c2.id });
entry = await at(loft.id);
check("two sections make a skin", entry.built && !entry.error, entry.error);
check("both sections are listed in order",
      JSON.stringify(entry.lists.sections) === JSON.stringify([c3.id, c2.id]),
      JSON.stringify(entry.lists.sections));
check("and both left the 3D view", !(await at(c2.id)).visible && !(await at(c3.id)).visible);

const bool = await mdl.run({ op: "add", type: "Boolean", name: "Cut" });
await mdl.run({ op: "connect", id: bool.id, key: "a", from: cube.id });
await mdl.run({ op: "connect", id: bool.id, key: "b", from: loft.id });
await mdl.run({ op: "set", id: bool.id, key: "op", value: 1 });
check("difference built", (await at(bool.id)).built && !(await at(bool.id)).error,
      (await at(bool.id)).error);

const project = await mdl.run({ op: "add", type: "Project", name: "Onto" });
await mdl.run({ op: "connect", id: project.id, key: "curve", from: poly.id });
await mdl.run({ op: "connect", id: project.id, key: "onto", from: pl.id });
entry = await at(project.id);
check("the projection built", entry.built && !entry.error, entry.error);
check("and every sample landed on the plane",
      entry.data.count > 4 && /, 0\)/.test(entry.data.preview), entry.data.preview);

console.log("10. a panel shows what is flowing");
const panel = await mdl.run({ op: "add", type: "Panel", name: "Watch" });
await mdl.run({ op: "connect", id: panel.id, key: "input", from: series.id });
check("it prints the numbers", (await at(panel.id)).data.preview.startsWith("0 · 50 · 100"),
      (await at(panel.id)).data.preview);
await mdl.run({ op: "disconnect", id: panel.id, key: "input" });
await mdl.run({ op: "connect", id: panel.id, key: "input", from: bool.id });
check("and describes a solid when there is no data",
      /solids/.test((await at(panel.id)).data.preview), (await at(panel.id)).data.preview);

console.log("11. the whole graph survives the file");
const text = JSON.stringify(await kernel.model());
const before = (await tree()).features.length;
await mdl.run({ op: "model", model: text });
const after = await tree();
check("every feature came back", after.features.length === before,
      after.features.length + " of " + before);
check("nothing failed on the way back", (await errors()).length === 0, (await errors()).join(" | "));
check("the wire onto a slider survived", (await at(pt.id)).driven.x === series.id,
      JSON.stringify((await at(pt.id)).driven));
check("the loft's section order survived",
      JSON.stringify((await at(loft.id)).lists.sections) === JSON.stringify([c3.id, c2.id]),
      JSON.stringify((await at(loft.id)).lists.sections));

console.log("12. only what had to rebuild did");
const report = (await mdl.run({ op: "set", id: num.id, key: "value", value: 123 })).report;
check("editing a number nobody reads runs one function",
      report.executed.length === 1 && report.executed[0].id === num.id,
      report.executed.map(e => e.id).join(","));
const ran = (await mdl.run({ op: "set", id: series.id, key: "step", value: 60 }))
  .report.executed.map(e => e.id);
check("editing the series runs the series and its readers",
      ran.includes(series.id) && ran.includes(pt.id) && ran.includes(poly.id), ran.join(","));
check("and not the circle, which reads none of it", !ran.includes(circle.id), ran.join(","));
check("but the cube does rebuild, because its corner is one of those points",
      ran.includes(cube.id), ran.join(","));

console.log(failures ? "\n" + failures + " FAILED" : "\nall good");
process.exit(failures ? 1 : 0);
