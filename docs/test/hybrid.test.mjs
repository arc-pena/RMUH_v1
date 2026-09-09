// The two factories, through the nodes that stand on them.
//
// Every node here is a driver that reads its arguments off the document and
// makes exactly one HybridShapeFactory or ShapeFactory call. So there are two
// things worth checking and they are different: that the kernel publishes what
// its API can do, and that a node built on one of those calls produces the
// geometry the call promises - measured, because "a sweep appeared" and "the
// sweep is 4 m of 200 mm rail" are different statements.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { apiBrief } from "../src/agent.js";
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
const at = async id => ((await kernel.tree()).tree.features).find(f => f.id === id);
const err = async id => (await at(id)).error || "";
const fresh = () => kernel.loadModel({ format: "ocaf-parametric-model", version: 1,
                                       name: "H", units: "mm", features: [] });
const add = async (type, refs = {}) => (await kernel.addFeature(type, refs)).id;
const set = (id, key, value) => kernel.setParameter(id, key, value);
const point = async (x, y, z) => {
  const id = await add("Point");
  await set(id, "x", x); await set(id, "y", y); await set(id, "z", z);
  return id;
};
const vector = async (dx, dy, dz) => {
  const id = await add("Vector");
  await set(id, "dx", dx); await set(id, "dy", dy); await set(id, "dz", dz);
  return id;
};
//! Length, area or volume of whatever it is wired to.
const QUANTITY = { length: 0, area: 1, volume: 2, "size x": 3, "size y": 4, "size z": 5 };
const gaugeOf = async (id, what) => {
  const gauge = await add("Measure", { shape: id });
  await set(gauge, "quantity", QUANTITY[what]);
  const entry = await at(gauge);
  return entry && entry.data ? Number(entry.data.preview) : NaN;
};
const close = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) < tol;

console.log("1. the kernel says what its API is, not only what its nodes are");
{
  const schema = await kernel.schema();
  check("schema carries an API beside the catalogue", !!schema.api,
    schema.api && schema.api.format);
  const names = (schema.api.factories || []).map(f => f.name);
  check("and it is the two factories", names.join(", ") === "HybridShapeFactory, ShapeFactory",
    names.join(", "));
  const ops = schema.api.factories.flatMap(f => f.operations);
  check("every operation declares what it takes and gives",
    ops.length > 30 && ops.every(o => o.name && o.takes && o.gives && o.summary),
    ops.length + " operations");
  check("the solid factory is where add and remove live",
    schema.api.factories[1].operations.some(o => o.name === "add")
    && schema.api.factories[1].operations.some(o => o.name === "remove"));
  check("and extruding a skin is not, but padding a body is",
    schema.api.factories[0].operations.some(o => o.name === "extrude")
    && schema.api.factories[1].operations.some(o => o.name === "pad"));
  const brief = apiBrief(schema.api);
  check("the assistant is handed it in words", brief.includes("HybridShapeFactory")
    && brief.includes("pointOnCurve(curve, ratio) -> { at, tangent }"),
    brief.length + " chars");
}

console.log("\n2. a profile swept along a rail");
{
  await fresh();
  // A 200 x 200 square section, carried 4000 along +x.
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const east = await vector(1, 0, 0);
  const plane = await add("Plane", { origin, normal: east });   // section stands across the rail
  const section = await add("Circle", { plane });
  await set(section, "radius", 100);

  const far = await point(4000, 0, 0);
  const rail = await add("Polyline", { points: origin });
  await kernel.setReference(rail, "points", far, false, false);
  check("the rail is 4000 long", close(await gaugeOf(rail, "length"), 4000, 1),
    String(await gaugeOf(rail, "length")));

  const sweep = await add("Sweep", { profile: section, spine: rail });
  check("the sweep builds", !(await err(sweep)), await err(sweep));
  check("and it holds the volume of 4 m of 100 mm pipe",
    close(await gaugeOf(sweep, "volume"), Math.PI * 100 * 100 * 4000, 4000),
    (await gaugeOf(sweep, "volume")).toFixed(0) + " vs "
      + (Math.PI * 100 * 100 * 4000).toFixed(0));

  await set(sweep, "cap", 1);
  check("on Surface it is the wall and no ends",
    close(await gaugeOf(sweep, "area"), 2 * Math.PI * 100 * 4000, 2000),
    (await gaugeOf(sweep, "area")).toFixed(0) + " vs "
      + (2 * Math.PI * 100 * 4000).toFixed(0));
  await set(sweep, "cap", 0);

  //! A STRAIGHT rail proves nothing about a sweep, which is how this came to
  //! be wrong in the first place. The rail has to turn.
  //!
  //! Bent to a right angle: 1000 along +x, then 1000 up +z. A mitred corner
  //! takes as much off the outside as it puts on the inside, so a body swept
  //! along it is exactly the section times the 2000 of centreline - and if the
  //! section never turns, it is the section times the 1000 it managed before
  //! the rail left it behind. The two differ by a factor of two, and nothing
  //! on screen tells you which one you are looking at.
  const knee = await point(1000, 0, 0);
  const top = await point(1000, 0, 1000);
  const bentRail = await add("Polyline", { points: origin });
  await kernel.setReference(bentRail, "points", knee, false, false);
  await kernel.setReference(bentRail, "points", top, false, false);
  check("a rail that turns a corner, 2000 of it",
    close(await gaugeOf(bentRail, "length"), 2000, 1), String(await gaugeOf(bentRail, "length")));
  await kernel.setReference(sweep, "spine", bentRail, false, true);
  const bent = await gaugeOf(sweep, "volume");
  check("the section turns with the rail rather than being dragged through it",
    close(bent, Math.PI * 100 * 100 * 2000, 1000),
    bent.toFixed(0) + " vs " + (Math.PI * 100 * 100 * 2000).toFixed(0)
      + " (a section that never turns gives " + (Math.PI * 100 * 100 * 1000).toFixed(0) + ")");
  await set(sweep, "cap", 1);
  check("and the skin is the wall of that same elbow",
    close(await gaugeOf(sweep, "area"), 2 * Math.PI * 100 * 2000, 500),
    (await gaugeOf(sweep, "area")).toFixed(0) + " vs "
      + (2 * Math.PI * 100 * 2000).toFixed(0));
  await set(sweep, "cap", 0);

  // A section with a hole in it sweeps into a body with a bore, not into two
  // bodies one inside the other.
  const hollow = await add("Sketch", { plane, origin });
  await kernel.setSketch(hollow, null, { elements: [
    { id: "c1", type: "circle", c: [0, 0], r: 100 },
    { id: "c2", type: "circle", c: [0, 0], r: 60 },
  ], constraints: [] });
  check("the hollow section is a ring, not a disc",
    close(await gaugeOf(hollow, "area"), Math.PI * (100 * 100 - 60 * 60), 1),
    (await gaugeOf(hollow, "area")).toFixed(0));
  const pipe = await add("Sweep", { profile: hollow, spine: bentRail });
  check("a section with a hole sweeps into a pipe with a bore",
    close(await gaugeOf(pipe, "volume"), Math.PI * (100 * 100 - 60 * 60) * 2000, 1000),
    (await gaugeOf(pipe, "volume")).toFixed(0) + " vs "
      + (Math.PI * (100 * 100 - 60 * 60) * 2000).toFixed(0));
  void up;
}

console.log("\n3. a curve offset from another");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const plane = await add("Plane", { origin, normal: up });
  const circle = await add("Circle", { plane });
  await set(circle, "radius", 1000);

  const offset = await add("ParallelCurve", { curve: circle });
  await set(offset, "distance", 250);
  check("the offset builds with no support at all", !(await err(offset)), await err(offset));
  const flat = await gaugeOf(offset, "length");
  check("and a flat curve carries its own plane - the circle grew by the offset",
    close(flat, 2 * Math.PI * 1250, 2) || close(flat, 2 * Math.PI * 750, 2),
    flat.toFixed(1) + " vs " + (2 * Math.PI * 1250).toFixed(1) + " or "
      + (2 * Math.PI * 750).toFixed(1));

  await set(offset, "distance", 0);
  check("offsetting by nothing hands the curve back",
    close(await gaugeOf(offset, "length"), 2 * Math.PI * 1000, 2),
    (await gaugeOf(offset, "length")).toFixed(1));
}

console.log("\n3b. offsetting what a sketch drew");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const plane = await add("Plane", { origin, normal: up });
  const sketch = await add("Sketch", { plane, origin });
  const draw = elements => kernel.setSketch(sketch, null, { elements, constraints: [] });
  const line = (id, a, b) => ({ id, type: "line", a, b });

  // An L-shaped spine: 400 along u, then 300 along v. Open at both ends.
  await draw([line("e1", [0, 0], [400, 0]), line("e2", [400, 0], [400, 300])]);
  check("the spine is as long as it is drawn", close(await gaugeOf(sketch, "length"), 700, 0.01),
    String(await gaugeOf(sketch, "length")));

  const off = await add("ParallelCurve", { curve: sketch });
  await set(off, "distance", 50);
  check("an open spine offsets", !(await err(off)), await err(off));
  // Outside the corner the offset rounds it: the two legs, plus a quarter of a
  // circle of the offset radius. Inside, the corner is mitred and each leg
  // loses the offset.
  const out = await gaugeOf(off, "length");
  check("outside the corner it gains a quarter arc",
    close(out, 700 + Math.PI * 50 / 2, 0.05), out.toFixed(2) + " vs "
      + (700 + Math.PI * 50 / 2).toFixed(2));
  await set(off, "distance", -50);
  const back = await gaugeOf(off, "length");
  check("inside it, the corner is mitred and it loses one offset per leg",
    close(back, 700 - 100, 0.05), back.toFixed(2) + " vs 600.00");
  //! THE test for this node. Told an open spine is closed, OpenCascade walks
  //! out along one side, round the end and back along the other - a racetrack
  //! that builds, has no error on it, and measures THE SAME for +50 as for
  //! -50. Nothing downstream would ever notice, so the check is here.
  check("and the two sides are different curves, not one loop round both",
    Math.abs(out - back) > 100, out.toFixed(2) + " vs " + back.toFixed(2));

  // Several runs on one sketch: each is offset as itself. Poured into a single
  // wire they make a broken one, which OpenCascade answers with "command not
  // done" rather than with anything you could act on.
  await draw([line("e1", [0, 0], [400, 0]), line("e2", [400, 0], [400, 300]),
              line("e3", [0, 900], [400, 900]), line("e4", [400, 900], [400, 1200])]);
  await set(off, "distance", 50);
  check("two separate runs on one sketch both offset",
    close(await gaugeOf(off, "length"), 2 * (700 + Math.PI * 50 / 2), 0.1),
    (await gaugeOf(off, "length")).toFixed(2));

  // One straight segment lies in every plane through it, so which side is
  // fifty away has no answer - except that a sketch wrote down its plane.
  await draw([line("e1", [0, 0], [400, 0])]);
  await set(off, "distance", 50);
  check("a lone straight segment offsets, because the sketch knows its plane",
    !(await err(off)) && close(await gaugeOf(off, "length"), 400, 0.01),
    (await err(off)) || String(await gaugeOf(off, "length")));

  // And it goes sideways in the sketch's plane, one way then the other. The
  // length alone cannot show that - a line moved anywhere is still 400 long -
  // so the two offsets and the original are measured together: how far apart
  // they stand is what the offset actually did.
  const other = await add("ParallelCurve", { curve: sketch });
  await set(other, "distance", -50);
  const spread = await add("Join", { parts: sketch });
  await kernel.setReference(spread, "parts", off, false, false);
  await kernel.setReference(spread, "parts", other, false, false);
  check("it goes sideways in the plane, and the sign says which side",
    close(await gaugeOf(spread, "size y"), 100, 0.01),
    (await gaugeOf(spread, "size y")).toFixed(3) + " across, want 100");
  check("all three are still 400 long - it moved them, it did not stretch them",
    close(await gaugeOf(spread, "length"), 1200, 0.01),
    String(await gaugeOf(spread, "length")));

  // A closed loop is the other half, and it is exact both ways.
  await draw([line("e1", [0, 0], [400, 0]), line("e2", [400, 0], [400, 300]),
              line("e3", [400, 300], [0, 300]), line("e4", [0, 300], [0, 0])]);
  await set(off, "distance", 50);
  check("a closed loop grows by a full circle of the offset",
    close(await gaugeOf(off, "length"), 1400 + 2 * Math.PI * 50, 0.05),
    (await gaugeOf(off, "length")).toFixed(2));
  await set(off, "distance", -50);
  check("and shrinks by the offset off each of its eight corners",
    close(await gaugeOf(off, "length"), 1000, 0.05),
    (await gaugeOf(off, "length")).toFixed(2));
}

console.log("\n4. a surface given a thickness");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const east = await vector(1, 0, 0);
  const plane = await add("Plane", { origin, normal: east });
  const circle = await add("Circle", { plane });
  await set(circle, "radius", 500);
  const skin = await add("Extrude", { profile: circle, direction: east });
  await set(skin, "distance", 2000);
  await set(skin, "cap", 1);
  check("the skin is a tube with no volume",
    close(await gaugeOf(skin, "area"), 2 * Math.PI * 500 * 2000, 2000),
    (await gaugeOf(skin, "area")).toFixed(0));

  const thick = await add("ThickSurface", { surface: skin });
  await set(thick, "thickness", 50);
  check("thickening it builds", !(await err(thick)), await err(thick));
  // Which side a one-sided thickness grows towards is the surface's own
  // normal, so either wall is the right answer; what is NOT is a negative
  // volume, which is what a shell thickened inside out measures.
  const wall = (a, b) => Math.PI * (b * b - a * a) * 2000;
  const one = await gaugeOf(thick, "volume");
  check("and it is a 50 mm wall of that tube, the right way out",
    one > 0 && (close(one, wall(500, 550), wall(500, 550) * 0.02)
                || close(one, wall(450, 500), wall(450, 500) * 0.02)),
    one.toFixed(0) + " vs " + wall(450, 500).toFixed(0) + " or " + wall(500, 550).toFixed(0));

  await set(thick, "thickness", -50);
  check("the sign of the thickness is how you ask for the other side",
    Math.abs((await gaugeOf(thick, "volume")) - one) > wall(450, 500) * 0.05,
    (await gaugeOf(thick, "volume")).toFixed(0) + " vs " + one.toFixed(0));

  await set(thick, "thickness", 50);
  await set(thick, "sides", 1);
  check("on Both sides the surface ends up down the middle of the wall",
    close(await gaugeOf(thick, "volume"), wall(475, 525), wall(475, 525) * 0.02),
    (await gaugeOf(thick, "volume")).toFixed(0) + " vs " + wall(475, 525).toFixed(0));
}

console.log("\n5. where two things cross");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const base = await add("Plane", { origin, normal: up });
  const box = await add("Cube", { origin, plane: base });
  for (const [k, v] of [["dx", 1000], ["dy", 1000], ["dz", 1000]]) await set(box, k, v);

  const half = await point(0, 0, 400);
  const cut = await add("Plane", { origin: half, normal: up });
  await set(cut, "size", 4000);
  const section = await add("Intersect", { a: box, b: cut });
  check("the section builds", !(await err(section)), await err(section));
  check("and it is the perimeter of the box at that height",
    close(await gaugeOf(section, "length"), 4000, 1),
    (await gaugeOf(section, "length")).toFixed(1));
  check("it cut nothing - the box is still whole",
    close(await gaugeOf(box, "volume"), 1e9, 1), (await gaugeOf(box, "volume")).toFixed(0));

  await set(half, "z", 1400);
  check("raised clear of the box it says so rather than building nothing",
    (await err(section)).length > 0, await err(section));
}

console.log("\n6. leaning the sides of a body over");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const base = await add("Plane", { origin, normal: up });
  const box = await add("Cube", { origin, plane: base });
  for (const [k, v] of [["dx", 1000], ["dy", 1000], ["dz", 1000]]) await set(box, k, v);

  const draft = await add("Draft", { body: box, neutral: base, direction: up });
  await set(draft, "angle", 10);
  check("the draft builds", !(await err(draft)), await err(draft));
  // Held at the neutral plane and leaning with height. A positive angle
  // pulling up tapers the body IN as it rises, which is what lets a moulding
  // leave its mould; a negative one leans it out, which is a battered wall.
  const frustum = top => 1000 * (1000 * 1000 + top * top + 1000 * top) / 3;
  const lean = deg => 1000 + 2 * 1000 * Math.tan(deg * Math.PI / 180);
  check("a positive angle tapers the body in, the way a mould releases",
    close(await gaugeOf(draft, "volume"), frustum(lean(-10)), frustum(lean(-10)) * 0.01),
    (await gaugeOf(draft, "volume")).toFixed(0) + " vs " + frustum(lean(-10)).toFixed(0));
  await set(draft, "angle", -10);
  check("and a negative one leans it out - a battered wall",
    close(await gaugeOf(draft, "volume"), frustum(lean(10)), frustum(lean(10)) * 0.01),
    (await gaugeOf(draft, "volume")).toFixed(0) + " vs " + frustum(lean(10)).toFixed(0));
  await set(draft, "angle", 10);
  check("the box it drafted is untouched",
    close(await gaugeOf(box, "volume"), 1e9, 1), (await gaugeOf(box, "volume")).toFixed(0));

  await set(draft, "angle", 0);
  check("an angle of zero is refused in words, not built as nothing",
    (await err(draft)).includes("zero") || (await err(draft)).includes("nothing"),
    await err(draft));
}

console.log("\n7. extruding up to a plane instead of by a number");
{
  await fresh();
  const origin = await point(0, 0, 0);
  const up = await vector(0, 0, 1);
  const base = await add("Plane", { origin, normal: up });
  const disc = await add("Circle", { plane: base });
  await set(disc, "radius", 500);

  const ceilingAt = await point(0, 0, 3200);
  const ceiling = await add("Plane", { origin: ceilingAt, normal: up });
  const column = await add("Extrude", { profile: disc, direction: up });
  await set(column, "limit", 1);
  await kernel.setReference(column, "until", ceiling, false, true);
  check("the column builds up to the plane", !(await err(column)), await err(column));
  check("and it is as tall as the plane is high",
    close(await gaugeOf(column, "volume"), Math.PI * 500 * 500 * 3200, 1e5),
    (await gaugeOf(column, "volume")).toFixed(0) + " vs "
      + (Math.PI * 500 * 500 * 3200).toFixed(0));

  await set(ceilingAt, "z", 4500);
  check("raising the ceiling makes the column follow it",
    close(await gaugeOf(column, "volume"), Math.PI * 500 * 500 * 4500, 1e5),
    (await gaugeOf(column, "volume")).toFixed(0));

  await set(column, "limit", 0);
  await set(column, "distance", 2000);
  check("switching back to a distance still works",
    close(await gaugeOf(column, "volume"), Math.PI * 500 * 500 * 2000, 1e5),
    (await gaugeOf(column, "volume")).toFixed(0));
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall checks passed");
process.exit(failures ? 1 : 0);
