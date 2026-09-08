// Geometrical sets and bodies: the folder that is also a node.
//
// A set has one job that no slider can do - it has a BOUNDARY, so you can ask
// what crosses it. Everything here is that question asked from a different
// side: what feeds the contents from outside, what reads out of them, and what
// survives the set being deleted. And the thing a folder must never do is
// change the part, so that is measured too.
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
const kernel = await createWasmKernel({ initModule: init,
                                        wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });
const mdl = new Mdl({ kernel, apply: () => {}, setNode: () => {}, readLayout: () => ({}),
                      select: () => {}, selected: () => null, picked: () => [] });
const tree = async () => (await kernel.tree()).tree.features;
const at = async id => (await tree()).find(f => f.id === id);
const names = list => list.map(id => id).sort().join(",");

console.log("1. a part, then a folder put round half of it");
await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "S", units: "mm",
  features: [
    { id: "PT", type: "Point", name: "Origin", args: { x: 0, y: 0, z: 0 } },
    { id: "VZ", type: "Vector", name: "Up", args: { dz: 1, dx: 0, dy: 0 } },
    { id: "PL", type: "Plane", name: "Ground", args: { origin: { ref: "PT" }, normal: { ref: "VZ" } } },
    { id: "CI", type: "Circle", name: "Ring", args: { plane: { ref: "PL" }, radius: 500 } },
    { id: "EX", type: "Extrude", name: "Tower",
      args: { profile: { ref: "CI" }, direction: { ref: "VZ" }, distance: 3000 } },
  ] });
const volume = async id => {
  const gauge = (await kernel.addFeature("Measure", { shape: id })).id;
  await kernel.setParameter(gauge, "quantity", 2);
  const entry = await at(gauge);
  const value = entry && entry.data ? Number(entry.data.preview) : NaN;
  await kernel.deleteFeature(gauge);
  return value;
};
const before = await volume("EX");
check("the tower builds", Number.isFinite(before) && before > 0, before.toFixed(0));
//! Consumed, built and visible for every feature, so filing things away can be
//! compared against how they were rather than against an assumption.
const standing = async () => Object.fromEntries((await tree()).map(f =>
  [f.id, (f.consumedBy || "-") + "/" + (f.built ? "built" : "no") + "/" + f.visible]));
const wasStanding = await standing();

await mdl.run({ op: "add", type: "GeometricalSet", id: "GS", name: "Layout" });
check("a set is a feature like any other", !!(await at("GS")), (await at("GS")) && (await at("GS")).type);
for (const id of ["CI", "PL"]) await mdl.run({ op: "group", id, into: "GS" });
check("two things are filed in it", names((await at("GS")).contents) === "CI,PL",
  JSON.stringify((await at("GS")).contents));
check("and each one says where it lives", (await at("CI")).parent === "GS"
  && (await at("PL")).parent === "GS");
check("filing them away changed nothing about the part",
  Math.abs((await volume("EX")) - before) < 1, (await volume("EX")).toFixed(0));
{
  const now = await standing();
  const moved = Object.keys(wasStanding).filter(id => now[id] !== wasStanding[id]);
  check("and nothing about them changed - not consumed, not hidden, not unbuilt",
    moved.length === 0, moved.map(id => id + ": " + wasStanding[id] + " -> " + now[id]).join("; "));
}

console.log("\n2. what crosses the boundary");
{
  const set = await at("GS");
  // Ground stands on Origin and Up; the ring stands on Ground, which is inside.
  check("its inputs are what feeds it from outside, and only that",
    names(set.inputs) === "PT,VZ", JSON.stringify(set.inputs));
  check("and its outputs are what reads out of it",
    names(set.outputs) === "EX", JSON.stringify(set.outputs));

  const answer = await kernel.inputsOf("GS");
  check("the kernel answers the same question directly",
    names(answer.inputs.map(i => i.id)) === "PT,VZ",
    answer.inputs.map(i => i.name).join(", "));

  // Move the point in as well and it stops being an input: it is no longer
  // outside.
  await mdl.run({ op: "group", id: "PT", into: "GS" });
  check("moving a feeder inside takes it off the list",
    names((await at("GS")).inputs) === "VZ", JSON.stringify((await at("GS")).inputs));
  await mdl.run({ op: "group", id: "PT" });
  check("and taking it back out puts it back",
    names((await at("GS")).inputs) === "PT,VZ", JSON.stringify((await at("GS")).inputs));
  check("out means out - it is at the top level again", !(await at("PT")).parent);
}

console.log("\n3. a set inside a set");
{
  await mdl.run({ op: "add", type: "Body", id: "BD", name: "Solids" });
  await mdl.run({ op: "group", id: "EX", into: "BD" });
  await mdl.run({ op: "group", id: "GS", into: "BD" });
  check("a body holds the tower and the set both",
    names((await at("BD")).contents) === "EX,GS", JSON.stringify((await at("BD")).contents));
  check("its inputs are what feeds everything inside, however deep",
    names((await at("BD")).inputs) === "PT,VZ", JSON.stringify((await at("BD")).inputs));
  check("and nothing reads out of it now", (await at("BD")).outputs.length === 0,
    JSON.stringify((await at("BD")).outputs));

  let refused = "";
  try { await mdl.run({ op: "group", id: "BD", into: "GS" }); }
  catch (e) { refused = e.message; }
  check("a set cannot be put inside something it already holds", !!refused, refused);
}

console.log("\n4. the file carries it, and brings it back");
{
  const model = await kernel.model();
  const stored = model.features.find(f => f.id === "CI");
  check("a member says which set it is in, by name", stored.parent === "GS",
    JSON.stringify(stored.parent));
  await kernel.loadModel(model);
  check("it round-trips", names((await at("GS")).contents) === "CI,PL",
    JSON.stringify((await at("GS")).contents));
  check("nesting round-trips too", (await at("GS")).parent === "BD");
  check("and the part is the part it was",
    Math.abs((await volume("EX")) - before) < 1, (await volume("EX")).toFixed(0));

  // The order features are written in must not matter: a set may be written
  // after the things it holds.
  const shuffled = { ...model, features: [...model.features].reverse() };
  await kernel.loadModel(shuffled);
  check("written back to front it still comes back whole",
    names((await at("GS")).contents) === "CI,PL", JSON.stringify((await at("GS")).contents));
}

console.log("\n5. deleting a set keeps what is in it");
{
  await mdl.run({ op: "delete", id: "GS" });
  check("the set is gone", !(await at("GS")));
  check("but the ring and the plane are not",
    !!(await at("CI")) && !!(await at("PL")));
  check("and they were handed to whatever the set was in - not to the top",
    (await at("CI")).parent === "BD" && (await at("PL")).parent === "BD",
    (await at("CI")).parent);
  check("the tower is untouched", Math.abs((await volume("EX")) - before) < 1,
    (await volume("EX")).toFixed(0));

  await mdl.run({ op: "delete", id: "BD" });
  check("dissolving the outer one puts everything back at the top level",
    !(await at("CI")).parent && !(await at("EX")).parent);
  check("and the whole part still builds",
    (await tree()).every(f => !f.error), (await tree()).filter(f => f.error).map(f => f.id).join(","));
}

console.log("\n6. one undo puts a set back where it was");
{
  await mdl.run({ op: "add", type: "GeometricalSet", id: "G2", name: "Second" });
  await mdl.run({ op: "group", id: "CI", into: "G2" });
  check("filed away", (await at("CI")).parent === "G2");
  await mdl.run({ op: "undo" });
  check("undo takes it out again", !(await at("CI")).parent, (await at("CI")).parent);
  await mdl.run({ op: "redo" });
  check("redo puts it back", (await at("CI")).parent === "G2", (await at("CI")).parent);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall checks passed");
process.exit(failures ? 1 : 0);
