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

console.log("10. arraying a feature");
await kernel.loadModel(MODEL);
out = await kernel.addFeature("Array", { source: "FL1" });
const arrayId = out.id;
check("the array built", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
check("one feature in the tree, not many",
  out.tree.features.filter(f => f.type === "Array").length === 1);
check("the source leaves the 3D view but stays in the tree",
  byId2(out.tree, "FL1").visible === false && byId2(out.tree, "FL1").consumedBy === arrayId);

let arrayMesh = (await kernel.mesh([arrayId])).features[0];
const oneBody = 1380;
check("three copies by default", arrayMesh.triangles === oneBody * 3,
  arrayMesh.triangles + " triangles");

console.log("11. an instance is a relocation, not a rebuild");
out = await kernel.setParameter(arrayId, "countX", 8);
check("only the array re-ran - the fillet was not rebuilt",
  ids(out.report.executed).join(",") === arrayId, ids(out.report.executed).join(","));
check("the fillet is reported unchanged",
  out.report.skipped.some(e => e.id === "FL1"));
const filletRevision = byId2(out.tree, "FL1").revision;
arrayMesh = (await kernel.mesh([arrayId])).features[0];
check("eight copies now", arrayMesh.triangles === oneBody * 8, arrayMesh.triangles + " triangles");

out = await kernel.setParameter(arrayId, "countY", 3);
check("a grid multiplies both ways", (await kernel.mesh([arrayId])).features[0].triangles
  === oneBody * 24);
check("the fillet still has not been touched",
  byId2(out.tree, "FL1").revision === filletRevision);

console.log("12. the same feature switches to polar");
out = await kernel.setParameter(arrayId, "mode", 1);
check("the mode is stored as a choice", byId2(out.tree, arrayId).values.mode === 1);
check("it rebuilt without complaint", out.report.failed.length === 0,
  JSON.stringify(out.report.failed.map(f => f.message)));
check("six copies around the axis",
  (await kernel.mesh([arrayId])).features[0].triangles === oneBody * 6);

out = await kernel.setParameter(arrayId, "count", 12);
check("twelve now", (await kernel.mesh([arrayId])).features[0].triangles === oneBody * 12);
out = await kernel.setParameter(arrayId, "angle", 180);
check("a half sweep still builds", out.report.failed.length === 0);
check("the rectangular counts survived the switch",
  byId2(out.tree, arrayId).values.countY === 3);

out = await kernel.setParameter(arrayId, "mode", 0);
check("switching back restores the grid",
  (await kernel.mesh([arrayId])).features[0].triangles === oneBody * 24);

console.log("13. an array is a body like any other");
{
  // A box that is already fully rounded has no sharp edges left, so the array
  // to fillet here is an array of plain cubes.
  const plain = { ...MODEL, features: MODEL.features.filter(f => f.id !== "FL1") };
  const built = await kernel.loadModel(plain);
  check("the plain model built", built.report.failed.length === 0);
  const grid = await kernel.addFeature("Array", { source: "CB1" });
  const rounded = await kernel.addFeature("Fillet", { body: grid.id });
  check("an array can be filleted", rounded.report.failed.length === 0,
    JSON.stringify(rounded.report.failed.map(f => f.message)));
  check("the fillet radius is judged per body, not per array",
    /limit is 40/.test(((await kernel.setParameter(rounded.id, "radius", 50))
      .report.failed[0] || {}).message || ""));
}

await kernel.loadModel(MODEL);
out = await kernel.addFeature("Array", { source: "FL1" });
const bigId = out.id;
out = await kernel.setParameter(bigId, "countX", 40);
out = await kernel.setParameter(bigId, "countY", 40);
check("an unreasonable pattern is refused, not attempted",
  out.report.failed.length === 1 && /more than this kernel will build/.test(out.report.failed[0].message),
  JSON.stringify(out.report.failed.map(f => f.message)));

console.log("14. the model file carries the pattern by name");
const arrayModel = await kernel.model();
const arrayEntry = arrayModel.features.find(f => f.id === bigId);
check("the mode reads as a word, not an index", arrayEntry.args.mode === "Rectangular",
  JSON.stringify(arrayEntry.args.mode));
await kernel.setParameter(bigId, "countX", 3);
await kernel.setParameter(bigId, "countY", 2);
const roundTrip = await kernel.loadModel(await kernel.model());
check("and rebuilds from the file", roundTrip.report.failed.length === 0,
  JSON.stringify(roundTrip.report.failed.map(f => f.message)));

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
