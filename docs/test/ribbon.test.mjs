import { createWasmKernel } from "../src/wasm-kernel.js";
import { readFileSync } from "fs";
const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(DIR + "/replicad_single.js")).default;
const kernel = await createWasmKernel({ initModule, wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });

let failures = 0;
const check = (n, ok, d = "") => { if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + n + (d ? "  — " + d : "")); };

await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "Heydar", units: "mm", features: [] });
console.log("building the ribbon shell…");
const t0 = Date.now();
let out = await kernel.addFeature("Ribbon", {});
const id = out.id;
console.log("  built in", Date.now() - t0, "ms");
check("it built", out.report.failed.length === 0, JSON.stringify(out.report.failed.map(f => f.message)));

const entry = out.tree.features.find(f => f.id === id);
check("it is its own feature type", entry.type === "Ribbon");
check("ten parameters", entry.params.length === 10, String(entry.params.length));
check("the ribbon count is a parameter", entry.params.some(p => p.key === "ribbons"));
check("the direction is a switch, not a slider",
  (entry.params.find(p => p.key === "direction") || {}).options?.join("/") === "U/V",
  JSON.stringify((entry.params.find(p => p.key === "direction") || {}).options));
check("the switch sits beside the count",
  entry.params[0].key === "direction" && entry.params[1].key === "ribbons",
  entry.params.slice(0, 2).map(p => p.key).join(","));

const t1 = Date.now();
let mesh = (await kernel.mesh([id])).features[0];
console.log("  meshed in", Date.now() - t1, "ms");
check("it is solid geometry", mesh.triangles > 1000, mesh.triangles + " triangles");
const at22 = mesh.triangles;

console.log("changing the band count");
const t2 = Date.now();
out = await kernel.setParameter(id, "ribbons", 12);
console.log("  rebuilt in", Date.now() - t2, "ms");
check("fewer bands rebuilds cleanly", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
mesh = (await kernel.mesh([id])).features[0];
check("and makes less geometry", mesh.triangles < at22, at22 + " -> " + mesh.triangles);

console.log("flipping the ribbons from U to V");
const t3 = Date.now();
out = await kernel.setParameter(id, "direction", 1);
console.log("  flipped in", Date.now() - t3, "ms");
check("V runs cleanly too", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
const flipped = (await kernel.mesh([id])).features[0];
check("and gives different geometry", flipped.triangles !== mesh.triangles,
  mesh.triangles + " -> " + flipped.triangles);
check("the switch remembers where it is",
  out.tree.features.find(f => f.id === id).params.find(p => p.key === "direction").value === 1);
out = await kernel.setParameter(id, "direction", 0);
check("and flips back", out.report.failed.length === 0);

out = await kernel.setParameter(id, "solidRatio", 0.9);
check("a wider band still builds", out.report.failed.length === 0);
out = await kernel.setParameter(id, "height", 1800);
check("a taller peak still builds", out.report.failed.length === 0);

console.log("it is a body like any other");
out = await kernel.addFeature("Array", { source: id });
check("it can be arrayed", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
await kernel.deleteFeature(out.id);

const step = await kernel.exportStep();
check("and exports as STEP", step.text.startsWith("ISO-10303-21;") && step.solids >= 1,
  step.solids + " solids, " + Math.round(step.text.length / 1024) + " KB");

console.log("the spiral stair is still its own button");
out = await kernel.addFeature("Script", {});
check("Script still starts as the stair", out.report.failed.length === 0
  && out.tree.features.find(f => f.id === out.id).params.some(p => p.key === "steps"));

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
