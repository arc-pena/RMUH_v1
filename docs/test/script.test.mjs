import { createWasmKernel } from "../src/wasm-kernel.js";
import { readFileSync } from "fs";
const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(DIR + "/replicad_single.js")).default;
const kernel = await createWasmKernel({ initModule, wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });

let failures = 0;
const check = (n, ok, d = "") => { if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + n + (d ? "  — " + d : "")); };
const ids = l => l.map(e => e.id);

console.log("1. a new Script feature is a spiral stair");
let out = await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "Stair",
  units: "mm", features: [] });
out = await kernel.addFeature("Script", {});
const id = out.id;
check("it built", out.report.failed.length === 0, JSON.stringify(out.report.failed.map(f => f.message)));
const entry = out.tree.features.find(f => f.id === id);
check("the script declared its parameters", entry.params.length === 13, String(entry.params.length));
check("every part is a slider",
  ["steps","rise","sweep","innerRadius","outerRadius","treadThickness","riserThickness",
   "poleRadius","stringerDepth","railHeight","railRadius"].every(k => entry.params.some(p => p.key === k)));
check("the source is on the feature", entry.code.includes("build(p, k)"));

let mesh = (await kernel.mesh([id])).features[0];
check("it is a solid assembly", mesh.triangles > 2000, mesh.triangles + " triangles");
const at13 = mesh.triangles;

console.log("2. the sliders drive the geometry");
out = await kernel.setParameter(id, "steps", 20);
check("only the script re-ran", ids(out.report.executed).join(",") === id);
mesh = (await kernel.mesh([id])).features[0];
check("more steps, more geometry", mesh.triangles > at13, mesh.triangles + " triangles");

out = await kernel.setParameter(id, "riserThickness", 0);
check("risers can be switched off", out.report.failed.length === 0);
const noRisers = (await kernel.mesh([id])).features[0].triangles;
out = await kernel.setParameter(id, "riserThickness", 18);
check("and back on", (await kernel.mesh([id])).features[0].triangles > noRisers);

out = await kernel.setParameter(id, "sweep", 540);
check("a longer sweep still builds", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));

console.log("3. a stair is a body like any other");
out = await kernel.addFeature("Array", { source: id });
check("it can be arrayed", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
await kernel.deleteFeature(out.id);

console.log("4. editing the code replaces the feature");
out = await kernel.setCode(id, "code", `({
  params: [{ key: "size", label: "Size", def: 60, min: 10, max: 200, step: 1 }],
  build(p, k) { return k.fillet(k.box(p.size, p.size, p.size), p.size / 8); }
})`);
check("the new code ran", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
const swapped = out.tree.features.find(f => f.id === id);
check("the parameters follow the code", swapped.params.length === 1 && swapped.params[0].key === "size",
  JSON.stringify(swapped.params.map(p => p.key)));

console.log("5. bad code is reported, not thrown");
for (const [name, source] of [
  ["a syntax error", "({ params: [], build(p, k) { return k.box(1 } })"],
  ["no build function", "({ params: [] })"],
  ["returning nothing", "({ params: [], build() { return null; } })"],
  ["a kernel misuse", "({ params: [], build(p, k) { return k.box(-5, 10, 10); } })"],
]) {
  out = await kernel.setCode(id, "code", source);
  check(name + " is reported", out.report.failed.length === 1,
    JSON.stringify(out.report.failed.map(f => f.message)));
}
out = await kernel.setCode(id, "code", '({ params: [], build(p, k) { return k.box(40, 40, 40); } })');
check("the feature recovers", out.report.failed.length === 0);

console.log("6. the model file carries the code and the values");
await kernel.setCode(id, "code", `({
  params: [{ key: "size", label: "Size", def: 60, min: 10, max: 200, step: 1 }],
  build(p, k) { return k.box(p.size, p.size, p.size); }
})`);
await kernel.setParameter(id, "size", 137);
const model = await kernel.model();
const saved = model.features.find(f => f.id === id);
check("the source is in the file", saved.args.code.includes("build(p, k)"));
check("so is the value", saved.args.params.size === 137, JSON.stringify(saved.args.params));
const reloaded = await kernel.loadModel(model);
check("and it rebuilds", reloaded.report.failed.length === 0);
check("with the value it was saved with",
  reloaded.tree.features.find(f => f.id === id).params[0].value === 137);

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
