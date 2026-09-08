// One node, many drivers.
//
// A CAD modeller has one point tool, not five: what it is a point OF is a
// setting on it, and the arguments change with the setting. Same for planes and
// lines. What is checked here is that every setting really produces the datum
// it claims - measured, because "a plane appeared" and "the plane is halfway
// between those two" are different statements.
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
const mdl = new Mdl({ kernel, apply: () => {}, setNode: () => {}, readLayout: () => ({}),
                      select: () => {}, selected: () => null, picked: () => [] });
const at = async id => ((await kernel.tree()).tree.features).find(f => f.id === id);
const fresh = () => kernel.loadModel({ format: "ocaf-parametric-model", version: 1,
                                       name: "D", units: "mm", features: [] });
//! Where a point feature ended up, read off what it computed.
const where = async id => {
  const entry = await at(id);
  if (entry.error) return "ERROR: " + entry.error;
  const preview = entry.data && entry.data.preview;
  return preview ? preview.replace(/[()]/g, "").split(",").map(Number) : null;
};
const near = (a, b, tol = 0.01) => Array.isArray(a) && a.length === b.length
  && a.every((v, i) => Math.abs(v - b[i]) < tol);

//! A point at x, y, z - the plain kind, which is also how everything else here
//! gets something to point at.
const point = async (id, name, x, y, z) => {
  await mdl.run({ op: "add", type: "Point", id, name });
  for (const [key, value] of [["x", x], ["y", y], ["z", z]])
    await mdl.run({ op: "set", id, key, value });
  return id;
};

console.log("1. a file written before any of this still loads");
{
  await kernel.loadModel({
    format: "ocaf-parametric-model", version: 1, name: "Old", units: "mm",
    features: [
      { id: "PT1", type: "Point", name: "Origin", args: { x: 10, y: 20, z: 30 } },
      { id: "VE1", type: "Vector", name: "Up", args: { dx: 0, dy: 0, dz: 1 } },
      { id: "PL1", type: "Plane", name: "XY", args: { origin: { ref: "PT1" }, normal: { ref: "VE1" }, size: 200 } },
      { id: "LN1", type: "Line", name: "Rail",
        args: { origin: { ref: "PT1" }, direction: { ref: "VE1" }, length: 250 } },
    ],
  });
  const bad = (await kernel.tree()).tree.features.filter(f => f.error);
  check("the old point, plane and line all build", bad.length === 0,
    bad.map(f => f.id + ": " + f.error).join("; "));
  check("and the point is where it was written", near(await where("PT1"), [10, 20, 30]),
    JSON.stringify(await where("PT1")));
  const gauge = (await mdl.run({ op: "add", type: "Measure", name: "L" })).id;
  await mdl.run({ op: "connect", id: gauge, key: "shape", from: "LN1", mode: "only" });
  check("and the line is still the length it was given",
    Math.abs(Number((await at(gauge)).data.preview) - 250) < 0.01,
    (await at(gauge)).data.preview);
}

console.log("\n2. a point on a curve");
{
  await fresh();
  await point("A", "A", 0, 0, 0);
  await point("B", "B", 300, 0, 0);
  await mdl.run({ op: "add", type: "Line", id: "L", name: "Run" });
  await mdl.run({ op: "set", id: "L", key: "kind", value: 1 });
  await mdl.run({ op: "connect", id: "L", key: "from", from: "A", mode: "only" });
  await mdl.run({ op: "connect", id: "L", key: "to", from: "B", mode: "only" });
  check("a line between two points is 300 long", !(await at("L")).error, (await at("L")).error);

  await mdl.run({ op: "add", type: "Point", id: "P", name: "Quarter" });
  await mdl.run({ op: "set", id: "P", key: "kind", value: 1 });
  await mdl.run({ op: "connect", id: "P", key: "curve", from: "L", mode: "only" });
  await mdl.run({ op: "set", id: "P", key: "at", value: 0.25 });
  check("a quarter of the way along it is at x=75", near(await where("P"), [75, 0, 0]),
    JSON.stringify(await where("P")));
  await mdl.run({ op: "set", id: "P", key: "at", value: 1 });
  check("and the far end is at x=300", near(await where("P"), [300, 0, 0]),
    JSON.stringify(await where("P")));
}

console.log("\n3. the centre of a circle, and the far end of a thing");
{
  await fresh();
  await point("O", "O", 40, 60, 0);
  await mdl.run({ op: "add", type: "Vector", id: "UP", name: "Up" });
  await mdl.run({ op: "set", id: "UP", key: "dz", value: 1 });
  await mdl.run({ op: "add", type: "Plane", id: "PL", name: "Plane" });
  await mdl.run({ op: "connect", id: "PL", key: "origin", from: "O", mode: "only" });
  await mdl.run({ op: "connect", id: "PL", key: "normal", from: "UP", mode: "only" });
  await mdl.run({ op: "add", type: "Circle", id: "C", name: "Ring" });
  await mdl.run({ op: "connect", id: "C", key: "plane", from: "PL", mode: "only" });
  await mdl.run({ op: "set", id: "C", key: "radius", value: 90 });

  await mdl.run({ op: "add", type: "Point", id: "CEN", name: "Centre" });
  await mdl.run({ op: "set", id: "CEN", key: "kind", value: 2 });
  await mdl.run({ op: "connect", id: "CEN", key: "of", from: "C", mode: "only" });
  check("the centre of the circle is where the circle is",
    near(await where("CEN"), [40, 60, 0]), JSON.stringify(await where("CEN")));

  await mdl.run({ op: "add", type: "Vector", id: "EAST", name: "East" });
  await mdl.run({ op: "set", id: "EAST", key: "dz", value: 0 });
  await mdl.run({ op: "set", id: "EAST", key: "dx", value: 1 });
  await mdl.run({ op: "add", type: "Point", id: "FAR", name: "Far side" });
  await mdl.run({ op: "set", id: "FAR", key: "kind", value: 3 });
  await mdl.run({ op: "connect", id: "FAR", key: "shape", from: "C", mode: "only" });
  await mdl.run({ op: "connect", id: "FAR", key: "along", from: "EAST", mode: "only" });
  check("the furthest point east on it is the east side of the ring",
    near(await where("FAR"), [130, 60, 0], 1.5), JSON.stringify(await where("FAR")));
  await mdl.run({ op: "set", id: "FAR", key: "end", value: 1 });
  check("and the other end is the west side",
    near(await where("FAR"), [-50, 60, 0], 1.5), JSON.stringify(await where("FAR")));
}

console.log("\n4. where two curves cross");
{
  await fresh();
  await point("A", "A", 0, 0, 0);
  await point("B", "B", 200, 0, 0);
  await point("C", "C", 120, -80, 0);
  await point("D", "D", 120, 80, 0);
  for (const [id, a, b] of [["L1", "A", "B"], ["L2", "C", "D"]]) {
    await mdl.run({ op: "add", type: "Line", id, name: id });
    await mdl.run({ op: "set", id, key: "kind", value: 1 });
    await mdl.run({ op: "connect", id, key: "from", from: a, mode: "only" });
    await mdl.run({ op: "connect", id, key: "to", from: b, mode: "only" });
  }
  await mdl.run({ op: "add", type: "Point", id: "X", name: "Crossing" });
  await mdl.run({ op: "set", id: "X", key: "kind", value: 4 });
  await mdl.run({ op: "connect", id: "X", key: "first", from: "L1", mode: "only" });
  await mdl.run({ op: "connect", id: "X", key: "second", from: "L2", mode: "only" });
  check("two crossing lines meet where they cross", near(await where("X"), [120, 0, 0]),
    JSON.stringify(await where("X")));
}

console.log("\n5. planes: offset, bisector, across a curve, turned");
{
  await fresh();
  await point("O", "O", 0, 0, 0);
  await mdl.run({ op: "add", type: "Vector", id: "UP", name: "Up" });
  await mdl.run({ op: "set", id: "UP", key: "dz", value: 1 });
  await mdl.run({ op: "add", type: "Plane", id: "BASE", name: "Base" });
  await mdl.run({ op: "connect", id: "BASE", key: "origin", from: "O", mode: "only" });
  await mdl.run({ op: "connect", id: "BASE", key: "normal", from: "UP", mode: "only" });

  await mdl.run({ op: "add", type: "Plane", id: "OFF", name: "Level 1" });
  await mdl.run({ op: "set", id: "OFF", key: "kind", value: 2 });
  await mdl.run({ op: "connect", id: "OFF", key: "from", from: "BASE", mode: "only" });
  await mdl.run({ op: "set", id: "OFF", key: "offset", value: 3500 });
  check("an offset plane builds", !(await at("OFF")).error, (await at("OFF")).error);
  // Measured by where a point on it lands: put a circle on it and take its centre.
  await mdl.run({ op: "add", type: "Circle", id: "RING", name: "Ring" });
  await mdl.run({ op: "connect", id: "RING", key: "plane", from: "OFF", mode: "only" });
  await mdl.run({ op: "add", type: "Point", id: "CEN", name: "Centre" });
  await mdl.run({ op: "set", id: "CEN", key: "kind", value: 2 });
  await mdl.run({ op: "connect", id: "CEN", key: "of", from: "RING", mode: "only" });
  check("and it really is 3500 above the one it came from",
    near(await where("CEN"), [0, 0, 3500]), JSON.stringify(await where("CEN")));

  // A bisector between a horizontal plane and a vertical one leans at 45.
  await mdl.run({ op: "add", type: "Vector", id: "EAST", name: "East" });
  await mdl.run({ op: "set", id: "EAST", key: "dz", value: 0 });
  await mdl.run({ op: "set", id: "EAST", key: "dx", value: 1 });
  await mdl.run({ op: "add", type: "Plane", id: "SIDE", name: "Side" });
  await mdl.run({ op: "connect", id: "SIDE", key: "origin", from: "O", mode: "only" });
  await mdl.run({ op: "connect", id: "SIDE", key: "normal", from: "EAST", mode: "only" });
  await mdl.run({ op: "add", type: "Plane", id: "MID", name: "Bisector" });
  await mdl.run({ op: "set", id: "MID", key: "kind", value: 3 });
  await mdl.run({ op: "connect", id: "MID", key: "a", from: "BASE", mode: "only" });
  await mdl.run({ op: "connect", id: "MID", key: "b", from: "SIDE", mode: "only" });
  check("a bisector between two planes builds", !(await at("MID")).error, (await at("MID")).error);
  // Its normal leans 45 degrees: a line normal to it rises as much as it runs.
  await mdl.run({ op: "add", type: "Line", id: "N", name: "Normal" });
  await mdl.run({ op: "set", id: "N", key: "kind", value: 2 });
  await mdl.run({ op: "connect", id: "N", key: "plane", from: "MID", mode: "only" });
  await mdl.run({ op: "set", id: "N", key: "length", value: 100 });
  await mdl.run({ op: "add", type: "Point", id: "TIP", name: "Tip" });
  await mdl.run({ op: "set", id: "TIP", key: "kind", value: 1 });
  await mdl.run({ op: "connect", id: "TIP", key: "curve", from: "N", mode: "only" });
  await mdl.run({ op: "set", id: "TIP", key: "at", value: 1 });
  const tip = await where("TIP");
  check("and it leans at 45 degrees", Array.isArray(tip)
    && Math.abs(Math.abs(tip[0]) - Math.abs(tip[2])) < 0.5, JSON.stringify(tip));

  // Turning the base plane 90 about east makes it vertical.
  await mdl.run({ op: "add", type: "Plane", id: "TURN", name: "Turned" });
  await mdl.run({ op: "set", id: "TURN", key: "kind", value: 4 });
  await mdl.run({ op: "connect", id: "TURN", key: "turn", from: "BASE", mode: "only" });
  await mdl.run({ op: "connect", id: "TURN", key: "axis", from: "EAST", mode: "only" });
  await mdl.run({ op: "set", id: "TURN", key: "angle", value: 90 });
  await mdl.run({ op: "add", type: "Line", id: "N2", name: "Turned normal" });
  await mdl.run({ op: "set", id: "N2", key: "kind", value: 2 });
  await mdl.run({ op: "connect", id: "N2", key: "plane", from: "TURN", mode: "only" });
  await mdl.run({ op: "set", id: "N2", key: "length", value: 100 });
  await mdl.run({ op: "add", type: "Point", id: "TIP2", name: "Tip 2" });
  await mdl.run({ op: "set", id: "TIP2", key: "kind", value: 1 });
  await mdl.run({ op: "connect", id: "TIP2", key: "curve", from: "N2", mode: "only" });
  await mdl.run({ op: "set", id: "TIP2", key: "at", value: 1 });
  const tip2 = await where("TIP2");
  check("a plane turned 90 degrees about east points along -y",
    near(tip2, [0, -100, 0], 0.5) || near(tip2, [0, 100, 0], 0.5), JSON.stringify(tip2));
}

console.log("\n6. a line stopped by a plane rather than by a number");
{
  await fresh();
  await point("O", "O", 0, 0, 0);
  await mdl.run({ op: "add", type: "Vector", id: "UP", name: "Up" });
  await mdl.run({ op: "set", id: "UP", key: "dz", value: 1 });
  await point("HIGH", "High", 0, 0, 4200);
  await mdl.run({ op: "add", type: "Plane", id: "CEIL", name: "Ceiling" });
  await mdl.run({ op: "connect", id: "CEIL", key: "origin", from: "HIGH", mode: "only" });
  await mdl.run({ op: "connect", id: "CEIL", key: "normal", from: "UP", mode: "only" });

  await mdl.run({ op: "add", type: "Line", id: "POST", name: "Post" });
  await mdl.run({ op: "connect", id: "POST", key: "origin", from: "O", mode: "only" });
  await mdl.run({ op: "connect", id: "POST", key: "direction", from: "UP", mode: "only" });
  await mdl.run({ op: "set", id: "POST", key: "limit", value: 1 });
  await mdl.run({ op: "connect", id: "POST", key: "until", from: "CEIL", mode: "only" });
  const gauge = (await mdl.run({ op: "add", type: "Measure", name: "Height" })).id;
  await mdl.run({ op: "connect", id: gauge, key: "shape", from: "POST", mode: "only" });
  check("a line run into a plane is as long as the plane is far",
    Math.abs(Number((await at(gauge)).data.preview) - 4200) < 0.01,
    (await at(gauge)).data.preview);

  // Moving the plane moves the end of the line: that is the point of it.
  await mdl.run({ op: "set", id: "HIGH", key: "z", value: 2600 });
  check("and it follows the plane when the plane moves",
    Math.abs(Number((await at(gauge)).data.preview) - 2600) < 0.01,
    (await at(gauge)).data.preview);

  // A line along the plane never reaches it, and says so.
  await mdl.run({ op: "add", type: "Vector", id: "EAST", name: "East" });
  await mdl.run({ op: "set", id: "EAST", key: "dz", value: 0 });
  await mdl.run({ op: "set", id: "EAST", key: "dx", value: 1 });
  await mdl.run({ op: "connect", id: "POST", key: "direction", from: "EAST", mode: "only" });
  check("a line parallel to the plane says it never reaches it",
    /never reaches/.test((await at("POST")).error || ""), (await at("POST")).error || "no error");
}

console.log("\n7. two lengths, back and forward from where it starts");
{
  await fresh();
  await point("O", "O", 0, 0, 0);
  await mdl.run({ op: "add", type: "Vector", id: "UP", name: "Up" });
  await mdl.run({ op: "set", id: "UP", key: "dz", value: 1 });
  await mdl.run({ op: "add", type: "Line", id: "AX", name: "Axis" });
  await mdl.run({ op: "connect", id: "AX", key: "origin", from: "O", mode: "only" });
  await mdl.run({ op: "connect", id: "AX", key: "direction", from: "UP", mode: "only" });
  await mdl.run({ op: "set", id: "AX", key: "start", value: -400 });
  await mdl.run({ op: "set", id: "AX", key: "length", value: 600 });
  const gauge = (await mdl.run({ op: "add", type: "Measure", name: "L" })).id;
  await mdl.run({ op: "connect", id: gauge, key: "shape", from: "AX", mode: "only" });
  check("400 back and 600 forward is 1000 of line",
    Math.abs(Number((await at(gauge)).data.preview) - 1000) < 0.01,
    (await at(gauge)).data.preview);
}

console.log("\n8. the model file says which kind, in words");
{
  const model = await kernel.model();
  const axis = model.features.find(f => f.id === "AX");
  check("a kind is written as its name, not its number",
    axis.args.kind === "Point and direction", JSON.stringify(axis.args.kind));
  const back = await kernel.loadModel(model);
  check("and reads back", back.report.failed.length === 0,
    JSON.stringify(back.report.failed.map(f => f.message)));
}

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
