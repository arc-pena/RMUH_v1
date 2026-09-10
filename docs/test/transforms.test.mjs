// Where a shape is, as a feature.
//
// Every check here is a measurement of the result, not of the arguments: a
// transform that "ran" and a transform that put the box where it was asked for
// are different statements, and a sign error passes the first one every time.
// So each one builds the shape, meshes it, and reads the box back out.
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

const point = async (id, x, y, z) => {
  await mdl.run({ op: "add", type: "Point", id, name: id });
  for (const [key, value] of [["x", x], ["y", y], ["z", z]])
    await mdl.run({ op: "set", id, key, value });
  return id;
};
const vector = async (id, dx, dy, dz) => {
  await mdl.run({ op: "add", type: "Vector", id, name: id });
  for (const [key, value] of [["dx", dx], ["dy", dy], ["dz", dz]])
    await mdl.run({ op: "set", id, key, value });
  return id;
};
//! The box a feature's triangles fit in, rounded to the millimetre. What every
//! check below is written against.
const box = async id => {
  const mesh = (await kernel.mesh([id])).features[0];
  if (!mesh || !mesh.positions || !mesh.positions.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], mesh.positions[i + k]);
      hi[k] = Math.max(hi[k], mesh.positions[i + k]);
    }
  return lo.concat(hi).map(v => Math.round(v));
};
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
const trouble = async id => ((await kernel.tree()).tree.features.find(f => f.id === id) || {}).error;

await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "T",
                         units: "mm", features: [] });
await point("O", 0, 0, 0);
await point("FAR", 1000, 500, 200);
await point("ONX", 1000, 0, 0);
await vector("VX", 1, 0, 0);
await vector("VY", 0, 1, 0);
await vector("VZ", 0, 0, 1);
await mdl.run({ op: "add", type: "Cube", id: "BOX", name: "Box", refs: { origin: "O" } });
for (const [k, v] of [["dx", 100], ["dy", 100], ["dz", 100]])
  await mdl.run({ op: "set", id: "BOX", key: k, value: v });

console.log("1. moving something");
{
  await mdl.run({ op: "add", type: "Move", id: "MV", name: "Point to point",
                  refs: { shape: "BOX", from: "O", to: "FAR" } });
  await mdl.run({ op: "set", id: "MV", key: "kind", value: 1 });
  check("point to point moves by the difference of the two points",
        same(await box("MV"), [1000, 500, 200, 1100, 600, 300]), JSON.stringify(await box("MV")));

  await mdl.run({ op: "add", type: "Move", id: "DIR", name: "Along a direction",
                  refs: { shape: "BOX", direction: "VY" } });
  await mdl.run({ op: "set", id: "DIR", key: "distance", value: 750 });
  check("along a direction goes that far along it, and no further",
        same(await box("DIR"), [0, 750, 0, 100, 850, 100]), JSON.stringify(await box("DIR")));

  // The tween. What a slider is wired into.
  await mdl.run({ op: "add", type: "Move", id: "TW", name: "Between",
                  refs: { shape: "BOX", start: "O", end: "ONX" } });
  await mdl.run({ op: "set", id: "TW", key: "kind", value: 2 });
  for (const [at, want] of [[0, 0], [0.25, 250], [1, 1000], [1.5, 1500], [-0.5, -500]]) {
    await mdl.run({ op: "set", id: "TW", key: "at", value: at });
    const got = await box("TW");
    check("between two points at " + at + " is " + want + " mm along",
          got && got[0] === want, JSON.stringify(got));
  }
}

console.log("\n2. turning it");
{
  await mdl.run({ op: "add", type: "Rotate", id: "RT", name: "Rotate",
                  refs: { shape: "BOX", axis: "VZ", through: "O" } });
  await mdl.run({ op: "set", id: "RT", key: "end", value: 90 });
  check("90 degrees about Z takes the +x quadrant to the +y one",
        same(await box("RT"), [-100, 0, 0, 0, 100, 100]), JSON.stringify(await box("RT")));

  // Two angles, not one: the turn is the difference, so a start angle is a
  // datum and not decoration.
  await mdl.run({ op: "set", id: "RT", key: "start", value: 90 });
  await mdl.run({ op: "set", id: "RT", key: "end", value: 180 });
  check("start 90 to end 180 turns 90, not 180",
        same(await box("RT"), [-100, 0, 0, 0, 100, 100]), JSON.stringify(await box("RT")));
  await mdl.run({ op: "set", id: "RT", key: "start", value: 0 });
  await mdl.run({ op: "set", id: "RT", key: "end", value: 0 });
  check("and a turn of nothing is refused rather than silently done",
        !!(await trouble("RT")), String(await trouble("RT")));
  await mdl.run({ op: "set", id: "RT", key: "end", value: 90 });
}

console.log("\n3. mirroring it");
{
  await mdl.run({ op: "add", type: "Mirror", id: "MI", name: "Mirror",
                  refs: { shape: "BOX", at: "O", normal: "VX" } });
  await mdl.run({ op: "set", id: "MI", key: "by", value: 1 });
  check("a mirror in the plane through the origin normal to X flips x",
        same(await box("MI"), [-100, 0, 0, 0, 100, 100]), JSON.stringify(await box("MI")));
  await mdl.run({ op: "set", id: "MI", key: "keep", value: 1 });
  check("and both halves is both of them",
        same(await box("MI"), [-100, 0, 0, 100, 100, 100]), JSON.stringify(await box("MI")));
}

console.log("\n4. scaling it");
{
  await mdl.run({ op: "add", type: "Scale", id: "SC", name: "Scale",
                  refs: { shape: "BOX", centre: "O" } });
  await mdl.run({ op: "set", id: "SC", key: "factor", value: 3 });
  check("three times the size about the origin",
        same(await box("SC"), [0, 0, 0, 300, 300, 300]), JSON.stringify(await box("SC")));

  // A squash along one direction is not a gp_Trsf, and this build has no
  // BRepBuilderAPI_GTransform - so it is a mesh operation, and Mesh Transform
  // takes a factor per axis. This is the check that it really does.
  await mdl.run({ op: "add", type: "MeshFromShape", id: "ME", name: "Mesh",
                  refs: { shape: "BOX" } });
  await mdl.run({ op: "add", type: "MeshTransform", id: "SQ", name: "Squash",
                  refs: { mesh: "ME" } });
  await mdl.run({ op: "set", id: "SQ", key: "sz", value: 0.25 });
  const squashed = await box("SQ");
  check("a mesh scaled in Z only is squashed in Z only",
        squashed && squashed[3] - squashed[0] === 100 && squashed[5] - squashed[2] === 25,
        JSON.stringify(squashed));
  check("and about its own middle, so it does not fly off",
        squashed && squashed[2] === 38 && squashed[5] === 63, JSON.stringify(squashed));
}

console.log("\n5. an axis system, and going from one to another");
{
  await mdl.run({ op: "add", type: "AxisSystem", id: "AX1", name: "Here",
                  refs: { origin: "O", xdir: "VX", ydir: "VY" } });
  await mdl.run({ op: "add", type: "AxisSystem", id: "AX2", name: "There",
                  refs: { origin: "FAR", xdir: "VY", ydir: "VZ" } });
  const frame = async id => ((await kernel.tree()).tree.features.find(f => f.id === id) || {}).data;
  check("an axis system publishes an origin and three directions",
        (await frame("AX2")).count === 4, JSON.stringify((await frame("AX2")).preview));
  check("right handed: Z is X cross Y",
        (await frame("AX2")).preview.endsWith("(1, 0, 0)"),
        (await frame("AX2")).preview);

  // Two directions that are not square to each other still make a frame: X is
  // believed and Y is squared up against it.
  await vector("SKEW", 1, 1, 0);
  await mdl.run({ op: "add", type: "AxisSystem", id: "AX3", name: "Skew",
                  refs: { origin: "O", xdir: "VX", ydir: "SKEW" } });
  check("a Y that is not square to X is squared up rather than refused",
        (await frame("AX3")).preview === "(0, 0, 0) (1, 0, 0) (0, 1, 0) (0, 0, 1)",
        (await frame("AX3")).preview);

  await mdl.run({ op: "add", type: "AxisSystem", id: "AX4", name: "Three points",
                  refs: { at: "O", alongX: "ONX", inPlane: "FAR" } });
  await mdl.run({ op: "set", id: "AX4", key: "kind", value: 1 });
  check("three points make one too", !(await trouble("AX4")), String(await trouble("AX4")));

  await mdl.run({ op: "add", type: "AxisToAxis", id: "A2A", name: "Axis to axis",
                  refs: { shape: "BOX", from: "AX1", to: "AX2" } });
  // The box was drawn about AX1. In AX2 its own x runs along world y, its y
  // along world z and its z along world x, from the origin of AX2.
  check("axis to axis puts the shape where the second frame is",
        same(await box("A2A"), [1000, 500, 200, 1100, 600, 300]), JSON.stringify(await box("A2A")));

  // And it follows: move the target frame and the part goes with it, which is
  // the whole reason for placing anything this way.
  await mdl.run({ op: "set", id: "FAR", key: "z", value: 2200 });
  check("and moving the target frame moves the part",
        same(await box("A2A"), [1000, 500, 2200, 1100, 600, 2300]), JSON.stringify(await box("A2A")));
  await mdl.run({ op: "set", id: "FAR", key: "z", value: 200 });
}

console.log("\n6. it survives being written down");
{
  const model = await kernel.model();
  const moved = model.features.find(f => f.id === "TW");
  check("a kind is written as its name, not its number",
        moved.args.kind === "Between two points", JSON.stringify(moved.args.kind));
  const back = await kernel.loadModel(model);
  check("and the whole file reads back with nothing failed",
        back.report.failed.length === 0,
        JSON.stringify(back.report.failed.map(f => f.message)));
  check("with the transforms still where they were",
        same(await box("A2A"), [1000, 500, 200, 1100, 600, 300]), JSON.stringify(await box("A2A")));
}

console.log(failures ? "\n" + failures + " failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
