// Exercises the in-page kernel headlessly: build, edit, regenerate, and every
// way an over-sized fillet can go wrong.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { readFileSync } from "fs";

const WASM_DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(WASM_DIR + "/replicad_single.js")).default;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};

const MODEL = {
  format: "ocaf-parametric-model", version: 1, name: "Cube and Fillet", units: "mm",
  features: [
    { id: "PT1", type: "Point", name: "Origin", args: { x: 0, y: 0, z: 0 } },
    { id: "VZ", type: "Vector", name: "Z Direction", args: { dx: 0, dy: 0, dz: 1 } },
    { id: "PL1", type: "Plane", name: "XY Plane",
      args: { origin: { ref: "PT1" }, normal: { ref: "VZ" }, size: 200 } },
    { id: "CB1", type: "Cube", name: "Cube.1",
      args: { origin: { ref: "PT1" }, plane: { ref: "PL1" }, dx: 80, dy: 80, dz: 80 } },
    { id: "FL1", type: "Fillet", name: "Fillet.1", args: { body: { ref: "CB1" }, radius: 12 } },
  ],
};

const ids = list => list.map(e => e.id);
const kernel = await createWasmKernel({
  initModule, wasmBinary: readFileSync(WASM_DIR + "/replicad_single.wasm"),
});

console.log("1. build the model");
let out = await kernel.loadModel(MODEL);
check("all five functions executed", out.report.executed.length === 5, ids(out.report.executed).join(","));
check("nothing failed", out.report.failed.length === 0, JSON.stringify(out.report.failed));
check("datums come before what reads them",
  ids(out.report.executed).join(",") === "PT1,VZ,PL1,CB1,FL1", ids(out.report.executed).join(","));

const tree = out.tree;
const byId = id => tree.features.find(f => f.id === id);
check("the consumed cube leaves the 3D view", byId("CB1").visible === false);
check("the consumed cube stays in the tree", !!byId("CB1") && byId("CB1").consumedBy === "FL1");
check("the fillet is shown", byId("FL1").visible === true);
check("OCAF entries are addressed", byId("FL1").labels.radius === "0:1:1:5:2", byId("FL1").labels.radius);

console.log("2. real geometry, not an approximation");
let mesh = (await kernel.mesh(["CB1", "FL1"])).features;
const cube = mesh.find(m => m.id === "CB1"), fillet = mesh.find(m => m.id === "FL1");
check("the cube meshes to 12 triangles", cube.triangles === 12, String(cube.triangles));
check("the fillet is a rounded solid", fillet.triangles > 500, fillet.triangles + " triangles");
check("normals accompany every vertex", fillet.normals.length === fillet.positions.length);
check("edge polylines came through", fillet.edges.length > 0, fillet.edges.length / 3 + " points");

console.log("3. editing re-runs only what depends on the edit");
out = await kernel.setParameter("FL1", "radius", 20);
check("the fillet alone rebuilt", ids(out.report.executed).join(",") === "FL1", ids(out.report.executed).join(","));
check("four functions were left alone", out.report.skipped.length === 4);

out = await kernel.setParameter("CB1", "dz", 140);
check("the cube edit cascades into the fillet",
  ids(out.report.executed).join(",") === "CB1,FL1", ids(out.report.executed).join(","));
check("the datums did not move", out.report.skipped.length === 3);

console.log("4. revisions say what to re-stream");
const before = byId2(out.tree, "PL1").revision;
out = await kernel.setParameter("FL1", "radius", 9);
check("an untouched datum keeps its revision", byId2(out.tree, "PL1").revision === before);
check("the rebuilt fillet advances", byId2(out.tree, "FL1").revision > 1);
function byId2(t, id) { return t.features.find(f => f.id === id); }

console.log("5. the failures OpenCascade will not report honestly");
out = await kernel.setParameter("FL1", "radius", 40.6);   // OCCT answers IsDone() = true here
check("an over-sized radius is refused before the kernel runs", out.report.failed.length === 1,
  JSON.stringify(out.report.failed.map(f => f.message)));
check("the message says what the limit is",
  /limit is 40/.test((out.report.failed[0] || {}).message || ""), (out.report.failed[0] || {}).message);
check("the last good shape survives the failure", byId2(out.tree, "FL1").built === true);

out = await kernel.setParameter("FL1", "radius", 14);
check("the model recovers on the next valid value", out.report.failed.length === 0);

console.log("6. a fillet on a sphere");
out = await kernel.addFeature("Sphere", { center: "PT1" });
const sphereId = out.id;
out = await kernel.addFeature("Fillet", { body: sphereId });
check("refused, with a reason", out.report.failed.length === 1,
  JSON.stringify(out.report.failed.map(f => f.message)));
await kernel.deleteFeature(out.report.failed[0].id);

console.log("7. the model file round-trips");
const model = await kernel.model();
check("features survive the round trip", model.features.length === 6, String(model.features.length));
const reloaded = await kernel.loadModel(model);
check("the reloaded model builds", reloaded.report.failed.length === 0);

console.log("8. deleting");
let threw = null;
try { await kernel.deleteFeature("CB1"); } catch (e) { threw = e.message; }
check("a consumed body cannot be deleted", /still reads from/.test(threw || ""), threw || "no error");
await kernel.deleteFeature("FL1");
out = await kernel.tree();
check("the cube reappears in 3D once its fillet is gone",
  out.tree.features.find(f => f.id === "CB1").visible === true);

console.log("9. the kernel is still healthy after all of that");
out = await kernel.setParameter("CB1", "dx", 60);
check("it still builds", out.report.failed.length === 0);
mesh = (await kernel.mesh(["CB1"])).features[0];
check("and still meshes", mesh.triangles === 12, String(mesh.triangles));

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
