// Files in, files out.
//
// The thing worth testing here is not that a file appears. It is that what
// goes round the loop comes back the same: a quad cage stays a quad cage, a
// solid keeps its volume, an assembly stays several parts, and an import
// survives being written into the model file and read back out - because an
// import that cannot be reopened is worse than no import at all.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { Mdl } from "../src/mdl.js";
import { FORMATS, formatFor, isBinaryStl, parseObj, parseStl, productNames,
         toBase64, whyNot, writeObj, writeStl } from "../src/exchange.js";
import { isElided, lightenModel } from "../src/ocaf.js";
import { readFileSync } from "fs";

const WASM_DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const initModule = (await import(WASM_DIR + "/replicad_single.js")).default;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

console.log("1. the formats, declared");
{
  check("a step file is a STEP file", (formatFor("bracket.STP") || {}).key === "step");
  check("and so is one with a long name", (formatFor("/a/b/c.d.step") || {}).key === "step");
  check("an unknown extension is not guessed at", formatFor("part.zip") === null);
  check("IGES says why not, rather than nothing",
        /not compiled/.test((whyNot("part.igs") || {}).reason || ""));
  check("so does a Rhino file", /Rhino/.test((whyNot("house.3dm") || {}).name || ""));
  // Only a format that carries several parts may be broken into several.
  const structured = FORMATS.filter(f => f.structure).map(f => f.key).sort().join(",");
  check("only STEP and OBJ carry more than one part", structured === "obj,step", structured);
}

console.log("2. OBJ keeps the faces it was given");
{
  // A cube as six quads, the way Blender writes one.
  const blender = [
    "# Blender v3.6", "o Cube",
    "v -1 -1 -1", "v -1 -1 1", "v -1 1 -1", "v -1 1 1",
    "v 1 -1 -1", "v 1 -1 1", "v 1 1 -1", "v 1 1 1",
    "vt 0.5 0.5", "vn 0 0 1",
    "s off",
    "f 1/1/1 2/1/1 4/1/1 3/1/1", "f 3/1/1 4/1/1 8/1/1 7/1/1",
    "f 7/1/1 8/1/1 6/1/1 5/1/1", "f 5/1/1 6/1/1 2/1/1 1/1/1",
    "f 3/1/1 7/1/1 5/1/1 1/1/1", "f 8/1/1 4/1/1 2/1/1 6/1/1",
  ].join("\n");
  const parts = parseObj(blender);
  check("one object", parts.length === 1 && parts[0].name === "Cube");
  check("eight vertices, six faces", parts[0].points.length === 8 && parts[0].faces.length === 6);
  check("and every face still has four sides - NOT triangulated",
        parts[0].faces.every(f => f.length === 4),
        parts[0].faces.map(f => f.length).join(","));

  // Out and back in again. This is the round trip that matters: a cage that
  // loses its quads cannot be subdivided, so the loop has to preserve them.
  const back = parseObj(writeObj(parts, "round trip"));
  check("written out and read back, still six quads",
        back.length === 1 && back[0].faces.length === 6
        && back[0].faces.every(f => f.length === 4));
  check("and the vertices are where they were",
        back[0].points.every((p, i) => p.every((v, k) => near(v, parts[0].points[i][k], 1e-9))));

  const grouped = parseObj([
    "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
    "g floor", "f 1 2 3 4",
    "g wall", "v 0 0 1", "v 1 0 1", "f 1 2 6 5",
  ].join("\n"));
  check("groups come in as separate parts", grouped.length === 2
        && grouped[0].name === "floor" && grouped[1].name === "wall");
  check("and each carries only the vertices it uses",
        grouped[0].points.length === 4 && grouped[1].points.length === 4,
        grouped.map(g => g.points.length).join(","));

  const relative = parseObj(["v 0 0 0", "v 1 0 0", "v 1 1 0", "f -3 -2 -1"].join("\n"));
  check("a negative index counts back from the vertices so far",
        relative.length === 1 && relative[0].faces[0].length === 3
        && relative[0].points.length === 3);

  const named = parseObj(["v 0 0 0", "v 1 0 0", "v 1 1 0", "g empty", "g real", "f 1 2 3"].join("\n"));
  check("a group with nothing in it is not a part", named.length === 1 && named[0].name === "real");
}

console.log("3. STL, both encodings");
{
  const quad = [{ name: "q", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
                  faces: [[0, 1, 2, 3]] }];
  const ascii = writeStl(quad);
  check("a quad is fanned into two triangles, because STL has nothing else",
        (ascii.match(/facet normal/g) || []).length === 2);
  check("with a normal that points somewhere", /facet normal 0 0 1/.test(ascii), ascii.split("\n")[1]);
  const read = parseStl(ascii);
  check("read back as six loose vertices in two triangles",
        read.points.length === 6 && read.faces.length === 2);

  // A binary STL of one triangle, built by hand: 80 bytes of header, a count,
  // then 50 bytes a triangle.
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  const corners = [[0, 0, 0], [5, 0, 0], [0, 5, 0]];
  corners.forEach((p, i) => p.forEach((v, k) => view.setFloat32(84 + 12 + i * 12 + k * 4, v, true)));
  check("a binary file is recognised by its size, not its first word", isBinaryStl(bytes));
  const binary = parseStl(bytes);
  check("and reads as one triangle", binary.faces.length === 1 && binary.points.length === 3);
  check("with the corners it was written with",
        near(binary.points[1][0], 5, 1e-6) && near(binary.points[2][1], 5, 1e-6));
  // The word "solid" at the start proves nothing: this is what the guard is for.
  const liar = new Uint8Array(84 + 50);
  new Uint8Array(liar.buffer, 0, 5).set([115, 111, 108, 105, 100]);
  new DataView(liar.buffer).setUint32(80, 1, true);
  check("a binary file that begins with the word solid is still binary", isBinaryStl(liar));
}

console.log("4. round trips through the kernel");
const kernel = await createWasmKernel({
  initModule, wasmBinary: readFileSync(WASM_DIR + "/replicad_single.wasm"),
});
const mdl = new Mdl({
  kernel, setNode: () => {}, readLayout: () => ({}), select: () => {}, selected: () => null,
});
const tree = async () => (await kernel.tree()).tree;
const at = async id => (await tree()).features.find(f => f.id === id);
const blank = async () => await mdl.run({ op: "model", model: {
  format: "ocaf-parametric-model", version: 1, name: "Exchange", units: "mm", features: [] } });
const volumeOf = async id => {
  const measure = await mdl.run({ op: "add", type: "Measure" });
  await mdl.run({ op: "connect", id: measure.id, key: "shape", from: id });
  await mdl.run({ op: "set", id: measure.id, key: "quantity", value: 2 });   // volume
  const entry = await at(measure.id);
  await mdl.run({ op: "delete", id: measure.id });
  return entry.data ? Number(entry.data.preview.replace(/[^0-9.eE+-]/g, "")) : NaN;
};

await blank();
const point = await mdl.run({ op: "add", type: "Point" });
const cube = await mdl.run({ op: "add", type: "Cube", refs: { origin: point.id } });
for (const [key, value] of [["dx", 40], ["dy", 30], ["dz", 20]])
  await mdl.run({ op: "set", id: cube.id, key, value });
const wanted = 40 * 30 * 20;
check("a cube to start from", near(await volumeOf(cube.id), wanted, 1));

{
  const step = await kernel.exportShapes("step");
  check("STEP comes out as ISO-10303 text", /ISO-10303-21/.test(step.text), step.text.slice(0, 20));

  await blank();
  const back = await mdl.run({ op: "import", format: "step", name: "block.step", data: step.text });
  check("and reads back as one feature", back.created.length === 1, JSON.stringify(back.created));
  const entry = await at(back.created[0]);
  check("of type Imported, built, with no error",
        entry.type === "Imported" && entry.built && !entry.error, entry.error || "");
  check("named after the file", entry.name === "block", entry.name);
  check("the note says what came in", /one object, 1 solid, 6 faces/.test(back.note), back.note);
  check("and the volume survived the trip", near(await volumeOf(back.created[0]), wanted, 1),
        String(await volumeOf(back.created[0])));
}

console.log("5. an assembly comes in as parts, or as one object");
{
  // Two products in one file - which is what a STEP assembly is.
  await blank();
  const p1 = await mdl.run({ op: "add", type: "Point" });
  const a = await mdl.run({ op: "add", type: "Cube", refs: { origin: p1.id } });
  const p2 = await mdl.run({ op: "add", type: "Point" });
  await mdl.run({ op: "set", id: p2.id, key: "x", value: 300 });
  const b = await mdl.run({ op: "add", type: "Cube", refs: { origin: p2.id } });
  await mdl.run({ op: "set", id: b.id, key: "dx", value: 20 });
  const step = await kernel.exportShapes("step");
  check("two solids went out", step.solids === 2, String(step.solids));
  check("and the file names two products", productNames(step.text).length === 2,
        productNames(step.text).join(" | "));

  await blank();
  const parts = await mdl.run({ op: "import", format: "step", name: "asm.step",
                                data: step.text, as: "parts" });
  check("as sub-components: two features", parts.created.length === 2, parts.note);
  check("filed under one set", !!parts.set);
  const set = await at(parts.set);
  const inside = (await tree()).features.filter(f => f.parent === parts.set);
  check("which is a Body holding both", set.type === "Body" && inside.length === 2,
        set.type + " " + inside.length);
  // OpenCascade's own writer numbers its products after itself, and that is not
  // a name anybody gave: those are numbered here instead, and the note says so.
  check("a translator's own product names are not used as part names",
        /numbered - the file gave no usable names/.test(parts.note), parts.note);

  // The same file with names a person would have given it.
  // The writer numbers its products from a counter that has been running all
  // through this file, so they are replaced in the order they appear.
  const give = ["Bracket", "Spacer"];
  let nth = 0;
  // A STEP PRODUCT carries the same name twice - as its id and as its name - so
  // the replacements come in pairs.
  const named = step.text.replace(/'Open CASCADE STEP translator [^']*'/g,
                                  () => "'" + (give[Math.floor(nth++ / 2)] || "Extra") + "'");
  await blank();
  const real = await mdl.run({ op: "import", format: "step", name: "asm.step",
                               data: named, as: "parts" });
  check("but names from the file are", /named from the file/.test(real.note), real.note);
  const rows = (await tree()).features.filter(f => f.type === "Imported").map(f => f.name);
  check("and they are the names the file gave", rows.join(", ") === "Bracket, Spacer",
        rows.join(", "));

  await blank();
  const single = await mdl.run({ op: "import", format: "step", name: "asm.step",
                                 data: step.text, as: "single" });
  check("as one object: one feature, no set", single.created.length === 1 && !single.set);
  check("holding both solids", /2 solids/.test(single.note), single.note);
}

console.log("6. BREP, the kernel's own");
{
  await blank();
  const p = await mdl.run({ op: "add", type: "Point" });
  const c = await mdl.run({ op: "add", type: "Cube", refs: { origin: p.id } });
  for (const [key, value] of [["dx", 10], ["dy", 10], ["dz", 10]])
    await mdl.run({ op: "set", id: c.id, key, value });
  const brep = await kernel.exportShapes("brep");
  check("it says what it is", /CASCADE Topology/.test(brep.text), brep.text.slice(1, 30));
  await blank();
  const back = await mdl.run({ op: "import", format: "brep", name: "cube.brep", data: brep.text });
  check("read back as one shape", back.created.length === 1);
  check("with the volume it had", near(await volumeOf(back.created[0]), 1000, 0.5));
}

console.log("7. a quad cage, out to OBJ and back - the trip that matters");
{
  await blank();
  const grid = await mdl.run({ op: "add", type: "MeshBox", name: "Cage" });
  for (const key of ["segX", "segY", "segZ"])
    await mdl.run({ op: "set", id: grid.id, key, value: 2 });
  const before = await at(grid.id);
  const faces = before.data.faces;
  check("a cage of quads to start", faces === 24, String(faces));

  const obj = await kernel.exportShapes("obj");
  const parsed = parseObj(obj.text);
  check("the OBJ has the same faces, not triangles",
        parsed.length === 1 && parsed[0].faces.length === faces
        && parsed[0].faces.every(f => f.length === 4), obj.note);
  check("and the export says so", /faces of more than three sides kept/.test(obj.note), obj.note);

  await blank();
  const back = await mdl.run({ op: "import", format: "obj", name: "cage.obj", data: obj.text });
  const entry = await at(back.created[0]);
  check("imported as a mesh", entry.type === "MeshImported" && entry.data.kind === "mesh");
  check("with every quad intact", entry.data.faces === faces && /24 quads/.test(entry.data.preview),
        entry.data.preview);
  check("the note counts them", /24 of them with more than three sides/.test(back.note), back.note);

  // And it is still a cage: Catmull-Clark needs the quads to be there.
  const sub = await mdl.run({ op: "add", type: "Subdivide" });
  await mdl.run({ op: "connect", id: sub.id, key: "mesh", from: back.created[0] });
  await mdl.run({ op: "set", id: sub.id, key: "levels", value: 1 });
  const smoothed = await at(sub.id);
  check("so it subdivides, which is what a cage is for - one quad becomes four",
        smoothed.built && smoothed.data.faces === faces * 4,
        smoothed.error || smoothed.data.preview);
}

console.log("8. an import survives the model file");
{
  await blank();
  const p = await mdl.run({ op: "add", type: "Point" });
  const c = await mdl.run({ op: "add", type: "Cube", refs: { origin: p.id } });
  for (const [key, value] of [["dx", 12], ["dy", 12], ["dz", 12]])
    await mdl.run({ op: "set", id: c.id, key, value });
  const step = (await kernel.exportShapes("step")).text;
  await blank();
  const first = await mdl.run({ op: "import", format: "step", name: "keep.step", data: step });
  const model = await kernel.model();
  const entry = model.features.find(f => f.type === "Imported");
  check("the model file carries the geometry itself", typeof entry.args.brep === "string"
        && entry.args.brep.length > 100, String((entry.args.brep || "").length));
  check("and says where it came from", entry.args.source === "keep.step");

  // Undo has to reach back past the import, which means the whole document -
  // geometry and all - went on the stack.
  await mdl.run({ op: "undo" });
  check("undo takes the import away",
        !(await tree()).features.some(f => f.type === "Imported"));
  await mdl.run({ op: "redo" });
  check("and redo brings it back, still built",
        ((await tree()).features.find(f => f.type === "Imported") || {}).built);

  // Reopened from its own file, with nothing else in memory.
  await mdl.run({ op: "model", model });
  const again = (await tree()).features.find(f => f.type === "Imported");
  check("reopening the file rebuilds it", again.built && !again.error, again.error || "");
  check("with the same volume", near(await volumeOf(again.id), 1728, 0.5));

  check("the log does not keep the file", (() => {
    const record = mdl.history.find(r => r.edit && r.edit.op === "import");
    return record && /characters of file/.test(record.edit.data);
  })(), "the whole file would be kept twice over");
  void first;
}

console.log("9. STL out and in, and base64 in");
{
  await blank();
  const p = await mdl.run({ op: "add", type: "Point" });
  const c = await mdl.run({ op: "add", type: "Cube", refs: { origin: p.id } });
  for (const [key, value] of [["dx", 10], ["dy", 10], ["dz", 10]])
    await mdl.run({ op: "set", id: c.id, key, value });
  const stl = await kernel.exportShapes("stl");
  check("a box tessellates to twelve triangles",
        (stl.text.match(/facet normal/g) || []).length === 12, stl.note);

  await blank();
  const back = await mdl.run({ op: "import", format: "stl", name: "box.stl", data: stl.text });
  const entry = await at(back.created[0]);
  check("welded on the way in: eight vertices, not thirty-six",
        entry.data.count === 8 && entry.data.faces === 12,
        entry.data.preview);

  // The same file as bytes, which is how a binary STL arrives.
  const bytes = new Uint8Array(84 + 50);
  new DataView(bytes.buffer).setUint32(80, 1, true);
  [[0, 0, 0], [8, 0, 0], [0, 8, 0]].forEach((q, i) =>
    q.forEach((v, k) => new DataView(bytes.buffer).setFloat32(84 + 12 + i * 12 + k * 4, v, true)));
  await blank();
  const binary = await mdl.run({ op: "import", format: "stl", name: "tri.stl",
                                 data: toBase64(bytes), encoding: "base64" });
  const one = await at(binary.created[0]);
  check("base64 bytes come in too", one.built && one.data.faces === 1, one.error || one.data.preview);
}

console.log("10. what is refused, and how");
{
  await blank();
  let message = "";
  try { await mdl.run({ op: "import", format: "iges", name: "a.igs", data: "x" }); }
  catch (err) { message = err.message; }
  check("a format the kernel cannot read is refused by name",
        /cannot read "iges"/.test(message), message);

  message = "";
  try { await mdl.run({ op: "import", format: "step", name: "a.step", data: "not a step file" }); }
  catch (err) { message = err.message; }
  check("and rubbish in a real format is refused by the reader",
        /STEP/.test(message), message);

  message = "";
  try { await mdl.run({ op: "import", format: "obj", name: "a.obj", data: "v 0 0 0" }); }
  catch (err) { message = err.message; }
  check("an OBJ with no faces says so", /no faces/.test(message), message);
}

console.log("11. shortened for reading, and refused for building");
{
  await blank();
  const p = await mdl.run({ op: "add", type: "Point" });
  const c = await mdl.run({ op: "add", type: "Cube", refs: { origin: p.id } });
  const step = (await kernel.exportShapes("step")).text;
  void c;
  await blank();
  await mdl.run({ op: "import", format: "step", name: "big.step", data: step });
  const model = await kernel.model();
  const light = lightenModel(model);
  const heavy = model.features.find(f => f.type === "Imported").args.brep;
  const shown = light.features.find(f => f.type === "Imported").args.brep;
  check("the geometry is replaced by its size", isElided(shown) && shown.length < 40, shown);
  check("and the whole of it is accounted for", light.elided === heavy.length,
        light.elided + " vs " + heavy.length);
  check("a model with nothing imported is handed back unchanged",
        lightenModel({ features: [] }).elided === undefined);

  let message = "";
  try { await mdl.run({ op: "model", model: light }); }
  catch (err) { message = err.message; }
  check("rebuilding from the shortened text is refused, by name",
        /shortened so it could be read/.test(message), message);
  check("and the document is untouched",
        (await tree()).features.some(f => f.type === "Imported"));
}

console.log(failures ? "\n" + failures + " failed" : "\nall good");
process.exit(failures ? 1 : 0);
