// The polymesh half: n-gon meshes, Catmull-Clark, and the operations that keep
// a mesh a mesh - welding, filling and pushing vertices about.
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
const streamOf = async id => (await kernel.mesh([id])).features[0];

await mdl.run({ op: "model", model: { format: "ocaf-parametric-model", version: 1,
  name: "Mesh", units: "mm", features: [] } });

console.log("1. a box is a cage of quads");
const box = await mdl.run({ op: "add", type: "MeshBox", name: "Cage" });
let entry = await at(box.id);
check("it produces a mesh", entry.produces === "mesh" && entry.data.kind === "mesh");
check("eight vertices, six quads", entry.data.count === 8 && entry.data.faces === 6,
      entry.data.preview);
check("and it counts as built, with no B-Rep behind it", entry.built);
check("the faces are quads", /6 quads/.test(entry.data.preview), entry.data.preview);

await mdl.run({ op: "set", id: box.id, key: "segX", value: 3 });
await mdl.run({ op: "set", id: box.id, key: "segY", value: 3 });
await mdl.run({ op: "set", id: box.id, key: "segZ", value: 3 });
entry = await at(box.id);
check("dividing it shares the vertices between faces",
      entry.data.count === 56 && entry.data.faces === 54, entry.data.preview);

console.log("2. the viewer gets triangles and the cage both");
let stream = await streamOf(box.id);
check("n-gons are fanned for drawing", stream.triangles === 54 * 2, String(stream.triangles));
check("but every polygon edge is sent", stream.edges.length / 6 === 108,
      String(stream.edges.length / 6));
check("and the unsplit vertices go too, for the handles",
      stream.vertices.length / 3 === 56, String(stream.vertices.length / 3));

console.log("3. Catmull-Clark");
await mdl.run({ op: "set", id: box.id, key: "segX", value: 1 });
await mdl.run({ op: "set", id: box.id, key: "segY", value: 1 });
await mdl.run({ op: "set", id: box.id, key: "segZ", value: 1 });
const sub = await mdl.run({ op: "add", type: "Subdivide", name: "Smooth" });
await mdl.run({ op: "connect", id: sub.id, key: "mesh", from: box.id });
await mdl.run({ op: "set", id: sub.id, key: "levels", value: 1 });
entry = await at(sub.id);
check("one level of a cube is 24 quads", entry.data.faces === 24, entry.data.preview);
check("with 26 vertices", entry.data.count === 26, entry.data.preview);
await mdl.run({ op: "set", id: sub.id, key: "levels", value: 2 });
check("two levels is 96", (await at(sub.id)).data.faces === 96, (await at(sub.id)).data.preview);

const size = await mdl.run({ op: "add", type: "Measure", name: "Size" });
await mdl.run({ op: "connect", id: size.id, key: "shape", from: sub.id });
await mdl.run({ op: "set", id: size.id, key: "quantity", value: 3 });   // Size X
const smoothed = Number((await at(size.id)).data.preview);
check("and it has pulled in from the 120 mm cage", smoothed > 80 && smoothed < 119,
      String(smoothed));

await mdl.run({ op: "set", id: sub.id, key: "on", value: 1 });          // Off
entry = await at(sub.id);
check("switched off it is the cage again", entry.data.faces === 6 && entry.data.count === 8,
      entry.data.preview);
check("and the measurement goes back to the cage",
      Number((await at(size.id)).data.preview) === 120, (await at(size.id)).data.preview);
await mdl.run({ op: "set", id: sub.id, key: "on", value: 0 });

console.log("4. a boundary is subdivided as a curve, or held");
const grid = await mdl.run({ op: "add", type: "MeshGrid", name: "Sheet" });
const gsub = await mdl.run({ op: "add", type: "Subdivide", name: "SheetSmooth" });
await mdl.run({ op: "connect", id: gsub.id, key: "mesh", from: grid.id });
await mdl.run({ op: "set", id: gsub.id, key: "levels", value: 1 });
const corner = async id => {
  const s = await streamOf(id);
  let far = 0;
  for (let i = 0; i < s.vertices.length; i += 3)
    far = Math.max(far, Math.hypot(s.vertices[i], s.vertices[i + 1]));
  return far;
};
await mdl.run({ op: "set", id: gsub.id, key: "boundary", value: 0 });   // Keep sharp
const sharp = await corner(gsub.id);
await mdl.run({ op: "set", id: gsub.id, key: "boundary", value: 1 });   // Smooth
const soft = await corner(gsub.id);
check("kept sharp, the sheet still reaches its corners", Math.abs(sharp - Math.hypot(200, 200)) < 1e-6,
      String(sharp));
check("smoothed, the edge creeps in", soft < sharp - 1, soft + " vs " + sharp);

console.log("5. moving a vertex by hand");
const edit = await mdl.run({ op: "add", type: "EditMesh", name: "Edited" });
await mdl.run({ op: "connect", id: edit.id, key: "mesh", from: box.id });
const before = (await streamOf(edit.id)).vertices.slice(0, 3);
await mdl.run({ op: "vertex", id: edit.id, index: 0, x: 40, y: 0, z: -25 });
let after = (await streamOf(edit.id)).vertices.slice(0, 3);
check("the vertex moved by the offset",
      Math.abs(after[0] - before[0] - 40) < 1e-6 && Math.abs(after[2] - before[2] + 25) < 1e-6,
      after.join(","));
check("and the move is in the tree as JSON",
      JSON.stringify((await at(edit.id)).lists.moves) === '{"0":[40,0,-25]}',
      JSON.stringify((await at(edit.id)).lists.moves));

await mdl.run({ op: "set", id: edit.id, key: "scale", value: 0.5 });
after = (await streamOf(edit.id)).vertices.slice(0, 3);
check("the move scale halves it", Math.abs(after[0] - before[0] - 20) < 1e-6, after.join(","));
await mdl.run({ op: "set", id: edit.id, key: "scale", value: 1 });

await mdl.run({ op: "vertex", id: edit.id, index: 0, x: 0, y: 0, z: 0 });
check("an offset of zero forgets the edit",
      JSON.stringify((await at(edit.id)).lists.moves) === "{}",
      JSON.stringify((await at(edit.id)).lists.moves));

let refused = "";
try { await mdl.run({ op: "vertex", id: box.id, index: 0, x: 1, y: 0, z: 0 }); }
catch (e) { refused = e.message; }
check("a feature that holds no hand edits says so", /EditMesh/.test(refused), refused);

console.log("6. a hand edit survives the file, and the subdivision follows it");
await mdl.run({ op: "vertex", id: edit.id, index: 0, x: 0, y: 0, z: 90 });
const chain = await mdl.run({ op: "add", type: "Subdivide", name: "Final" });
await mdl.run({ op: "connect", id: chain.id, key: "mesh", from: edit.id });
const peak = async () => {
  const s = await streamOf(chain.id);
  let top = -Infinity;
  for (let i = 2; i < s.vertices.length; i += 3) top = Math.max(top, s.vertices[i]);
  return top;
};
const lifted = await peak();
check("the smoothed mesh follows the moved vertex", lifted > 100, String(lifted));

const text = JSON.stringify(await kernel.model());
check("the file carries the move", /"moves"/.test(text) && /90/.test(text));
await mdl.run({ op: "model", model: text });
check("and it rebuilds to the same place", Math.abs((await peak()) - lifted) < 1e-6);
check("nothing failed on the way back",
      (await tree()).features.every(f => !f.error),
      (await tree()).features.filter(f => f.error).map(f => f.id + ": " + f.error).join(" | "));

console.log("7. welding a tessellation into a mesh");
const pt = await mdl.run({ op: "add", type: "Point", name: "O" });
const vz = await mdl.run({ op: "add", type: "Vector", name: "Up" });
const pl = await mdl.run({ op: "add", type: "Plane", name: "XY" });
await mdl.run({ op: "connect", id: pl.id, key: "origin", from: pt.id });
await mdl.run({ op: "connect", id: pl.id, key: "normal", from: vz.id });
const solid = await mdl.run({ op: "add", type: "Cube", name: "Block" });
const from = await mdl.run({ op: "add", type: "MeshFromShape", name: "Tessellated" });
await mdl.run({ op: "connect", id: from.id, key: "shape", from: solid.id });
await mdl.run({ op: "set", id: from.id, key: "weld", value: 1 });        // leave as tessellated
const loose = (await at(from.id)).data.count;
await mdl.run({ op: "set", id: from.id, key: "weld", value: 0 });        // weld
const tight = (await at(from.id)).data.count;
check("tessellation splits the corners", loose > tight, loose + " → " + tight);
check("welding brings a box back to eight", tight === 8, String(tight));
check("and it consumed the solid", !(await at(solid.id)).visible);

console.log("8. filling holes");
const holed = await mdl.run({ op: "add", type: "MeshGrid", name: "Open" });
await mdl.run({ op: "set", id: holed.id, key: "cols", value: 2 });
await mdl.run({ op: "set", id: holed.id, key: "rows", value: 2 });
const fill = await mdl.run({ op: "add", type: "FillHoles", name: "Closed" });
await mdl.run({ op: "connect", id: fill.id, key: "mesh", from: holed.id });
entry = await at(fill.id);
check("a sheet's own outline is one loop, and it gets a lid",
      entry.data.faces === 5, entry.data.preview);
check("the lid is an eight-sided polygon", /1 8-gons/.test(entry.data.preview), entry.data.preview);
await mdl.run({ op: "set", id: fill.id, key: "fill", value: 1 });        // fan
check("or a fan from the middle", (await at(fill.id)).data.faces === 12,
      (await at(fill.id)).data.preview);

console.log("9. measuring a mesh");
const mm = await mdl.run({ op: "add", type: "Measure", name: "Volume" });
await mdl.run({ op: "connect", id: mm.id, key: "shape", from: box.id });
for (const [name, index, want] of [["area", 1, 6 * 120 * 120], ["volume", 2, 120 ** 3]]) {
  await mdl.run({ op: "set", id: mm.id, key: "quantity", value: index });
  const got = Number((await at(mm.id)).data.preview);
  check("a 120 mm cage measures " + name, Math.abs(got - want) < want * 1e-9, got + " vs " + want);
}

console.log("10. moving and displacing by arithmetic");
const move = await mdl.run({ op: "add", type: "MeshTransform", name: "Placed" });
await mdl.run({ op: "connect", id: move.id, key: "mesh", from: box.id });
await mdl.run({ op: "set", id: move.id, key: "mz", value: 300 });
const raised = (await streamOf(move.id)).vertices;
check("it moved up", Math.min(...raised.filter((_, i) => i % 3 === 2)) === 300,
      String(Math.min(...raised.filter((_, i) => i % 3 === 2))));
await mdl.run({ op: "set", id: move.id, key: "scale", value: 2 });
await mdl.run({ op: "set", id: move.id, key: "mz", value: 0 });
await mdl.run({ op: "connect", id: mm.id, key: "shape", from: move.id });
await mdl.run({ op: "set", id: mm.id, key: "quantity", value: 3 });
check("and scaling doubles it", Number((await at(mm.id)).data.preview) === 240,
      (await at(mm.id)).data.preview);

const disp = await mdl.run({ op: "add", type: "MeshDisplace", name: "Wave" });
await mdl.run({ op: "connect", id: disp.id, key: "mesh", from: grid.id });
await mdl.run({ op: "code", id: disp.id, key: "formula", text: "Math.sin(x * 0.02)" });
check("displacement built", !(await at(disp.id)).error, (await at(disp.id)).error);
await mdl.run({ op: "code", id: disp.id, key: "formula", text: "Math.sin(" });
check("a broken formula is a syntax error",
      /will not compile/.test((await at(disp.id)).error || ""), (await at(disp.id)).error);
await mdl.run({ op: "code", id: disp.id, key: "formula", text: "1" });
await mdl.run({ op: "set", id: disp.id, key: "along", value: 3 });       // Z
await mdl.run({ op: "set", id: disp.id, key: "amount", value: 50 });
const flat = (await streamOf(disp.id)).vertices;
check("along an axis it moves every vertex the same way",
      flat.filter((_, i) => i % 3 === 2).every(z => Math.abs(z - 50) < 1e-9));

console.log("11. the guards");
await mdl.run({ op: "set", id: box.id, key: "segX", value: 12 });
await mdl.run({ op: "set", id: box.id, key: "segY", value: 12 });
await mdl.run({ op: "set", id: box.id, key: "segZ", value: 12 });
await mdl.run({ op: "set", id: sub.id, key: "levels", value: 4 });
check("a subdivision that would not finish is refused before it starts",
      /would be about/.test((await at(sub.id)).error || ""), (await at(sub.id)).error);
await mdl.run({ op: "set", id: sub.id, key: "levels", value: 1 });
check("and one level of the same cage is fine", !(await at(sub.id)).error, (await at(sub.id)).error);

const weld = await mdl.run({ op: "add", type: "Weld", name: "Fused" });
await mdl.run({ op: "connect", id: weld.id, key: "mesh", from: box.id });
await mdl.run({ op: "set", id: weld.id, key: "tolerance", value: 100 });
check("welding everything into nothing is refused, not shipped",
      !!(await at(weld.id)).error, "(none)");

console.log("12. amalgamating two cages");
const cageA = await mdl.run({ op: "add", type: "MeshBox", name: "A" });
const cageB = await mdl.run({ op: "add", type: "MeshBox", name: "B" });
for (const id of [cageA.id, cageB.id])
  for (const key of ["segX", "segY", "segZ"]) await mdl.run({ op: "set", id, key, value: 2 });
const placed = await mdl.run({ op: "add", type: "MeshTransform", name: "Placed" });
await mdl.run({ op: "connect", id: placed.id, key: "mesh", from: cageB.id });
await mdl.run({ op: "set", id: placed.id, key: "mx", value: 100 });

const join = await mdl.run({ op: "add", type: "MeshMerge", name: "Joined" });
await mdl.run({ op: "connect", id: join.id, key: "a", from: cageA.id });
await mdl.run({ op: "connect", id: join.id, key: "b", from: placed.id });
entry = await at(join.id);
check("the two cages became one", !entry.error && entry.data.count === 52, entry.error);
check("and it is still all quads", /^52 vertices . 48 quads$/.test(entry.data.preview),
      entry.data.preview);

// The test that matters: a bridge wound the same way as the loops it joins
// leaves the rim open, and nothing downstream says so until the subdivision
// tears. Filling the holes of a closed mesh must add nothing at all.
const closed = await mdl.run({ op: "add", type: "FillHoles", name: "Check" });
await mdl.run({ op: "connect", id: closed.id, key: "mesh", from: join.id });
check("the openings really were sewn shut",
      (await at(closed.id)).data.faces === entry.data.faces,
      (await at(closed.id)).data.preview);

const joinVolume = await mdl.run({ op: "add", type: "Measure", name: "Union" });
await mdl.run({ op: "connect", id: joinVolume.id, key: "shape", from: join.id });
await mdl.run({ op: "set", id: joinVolume.id, key: "quantity", value: 2 });
check("and it encloses the union of the two boxes",
      Number((await at(joinVolume.id)).data.preview) === 2 * 120 ** 3 - 20 * 120 * 120,
      (await at(joinVolume.id)).data.preview);

const joinSub = await mdl.run({ op: "add", type: "Subdivide", name: "Both" });
await mdl.run({ op: "connect", id: joinSub.id, key: "mesh", from: join.id });
await mdl.run({ op: "set", id: joinSub.id, key: "levels", value: 2 });
check("and it subdivides as one piece", !(await at(joinSub.id)).error,
      (await at(joinSub.id)).error);

console.log("13. openings that do not match");
await mdl.run({ op: "set", id: cageB.id, key: "segY", value: 1 });
await mdl.run({ op: "set", id: cageB.id, key: "segZ", value: 1 });
await mdl.run({ op: "set", id: placed.id, key: "mx", value: 110 });
entry = await at(join.id);
check("eight against four bridges with quads and triangles",
      /4 tris/.test(entry.data.preview) && /quads/.test(entry.data.preview),
      entry.error || entry.data.preview);
check("and the result is still closed",
      (await at(closed.id)).data.faces === entry.data.faces,
      (await at(closed.id)).data.preview);
check("and still subdivides to quads",
      /^\d+ vertices . \d+ quads$/.test((await at(joinSub.id)).data.preview),
      (await at(joinSub.id)).error || (await at(joinSub.id)).data.preview);

console.log("14. what it refuses");
await mdl.run({ op: "set", id: placed.id, key: "mx", value: 400 });
check("cages that never meet are refused with the reason",
      /nothing was removed/.test((await at(join.id)).error || ""), (await at(join.id)).error);
await mdl.run({ op: "set", id: join.id, key: "mode", value: 1 });         // facing
await mdl.run({ op: "set", id: join.id, key: "distance", value: 400 });
check("facing within a distance reaches them", !(await at(join.id)).error,
      (await at(join.id)).error);
await mdl.run({ op: "set", id: join.id, key: "mode", value: 0 });
await mdl.run({ op: "set", id: placed.id, key: "mx", value: 100 });

for (const key of ["segX", "segY", "segZ"])
  await mdl.run({ op: "set", id: cageA.id, key, value: 40 });
check("a cage too dense to walk face-against-face is refused before it starts",
      /more than this merge will walk/.test((await at(join.id)).error || ""),
      (await at(join.id)).error);

console.log(failures ? "\n" + failures + " FAILED" : "\nall good");
process.exit(failures ? 1 : 0);
