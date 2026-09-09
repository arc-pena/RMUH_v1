// People moving through a plan.
//
// A crowd simulation is easy to make look convincing and hard to make right,
// and a smooth animation hides a wrong number perfectly. So the checks here are
// against things a reader can look up - Weidmann's speeds, Fruin's bands, the
// area of a rectangle - and against invariants that would break if the code
// were wrong in the way it is most likely to be wrong: routes through walls,
// people inside furniture, a door with no capacity.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { PluginHost, findPlugin } from "../src/plugin.js";
import { CROWD, CROWD_NODES, crowdColour, footprintOf, plateOf } from "../src/crowd-plugin.js";
import { BODY, FREE_SPEED, FRUIN, addWalker, blockPolygon, clearanceOf, crowdSpeed,
         downhill, flowField, isBlocked, isovist, levelOfService, makeCrowd,
         makeDensity, makeGrid, measureDensity, serviceBreakdown, stepCrowd,
         stranded, toCell, walkDistance } from "../src/crowd.js";
import { typeSpec } from "../src/ocaf.js";
import { readFileSync } from "fs";

const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const init = (await import(DIR + "/replicad_single.js")).default;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const kernel = await createWasmKernel({ initModule: init,
                                        wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });

//! A 20 x 10 m room with a wall across the middle and a 1.2 m doorway in it.
const room = () => {
  const grid = makeGrid({ lo: [0, 0], hi: [20000, 10000], floor: 0 }, 250);
  blockPolygon(grid, [[9500, 0], [10500, 0], [10500, 4400], [9500, 4400]]);
  blockPolygon(grid, [[9500, 5600], [10500, 5600], [10500, 10000], [9500, 10000]]);
  clearanceOf(grid);
  return grid;
};

console.log("1. how fast a crowd walks, against Weidmann");
{
  // The fundamental diagram of pedestrian traffic. Free at nobody, stopped at
  // jam, and the published values in between.
  check("nobody about: free speed", near(crowdSpeed(0), FREE_SPEED, 1),
    crowdSpeed(0).toFixed(0) + " mm/s");
  check("1 person/m² is about 1.06 m/s", near(crowdSpeed(1e-6) / 1000, 1.06, 0.03),
    (crowdSpeed(1e-6) / 1000).toFixed(3));
  check("2 people/m² is about 0.61 m/s", near(crowdSpeed(2e-6) / 1000, 0.61, 0.03),
    (crowdSpeed(2e-6) / 1000).toFixed(3));
  check("at jam density everybody has stopped", crowdSpeed(5.4e-6) === 0);
  check("and it never goes backwards or above free",
    Array.from({ length: 60 }, (_, i) => crowdSpeed(i * 1e-7))
      .every((v, i, all) => v <= FREE_SPEED + 1e-6 && (i === 0 || v <= all[i - 1] + 1e-6)));
}

console.log("\n2. Fruin's bands, at the densities that define them");
{
  // Each threshold is an area per person; a density either side of one must
  // land in the band either side of it.
  const at = perM2 => levelOfService(perM2 * 1e-6).grade;
  check("0.2 p/m² is A (5 m² each)", at(0.2) === "A", at(0.2));
  check("0.35 p/m² is B", at(0.35) === "B", at(0.35));
  check("0.5 p/m² is C", at(0.5) === "C", at(0.5));
  check("0.9 p/m² is D", at(0.9) === "D", at(0.9));
  check("1.5 p/m² is E", at(1.5) === "E", at(1.5));
  check("3 p/m² is F", at(3) === "F", at(3));
  check("empty floor is A", levelOfService(0).grade === "A");
  check("the bands run A to F with no gap",
    FRUIN.map(b => b.grade).join("") === "ABCDEF");
}

console.log("\n3. routes go round walls, not through them");
{
  const grid = room();
  const field = flowField(grid, [[19000, 5000]]);
  const corner = walkDistance(field, 500, 500);
  const straight = Math.hypot(18500, 4500);
  const round = Math.hypot(9000, 4500) + 9000;      // to the door, then along
  check("a route exists from the far corner", corner !== null);
  check("and it is LONGER than the straight line through the wall",
    corner > straight, (corner / 1000).toFixed(2) + " m vs " + (straight / 1000).toFixed(2));
  check("and about as long as going via the door",
    near(corner, round, 2500), (corner / 1000).toFixed(2) + " m vs " + (round / 1000).toFixed(2));

  // The gradient at a point west of the wall must point at the door, not at
  // the destination through it. Getting this wrong walks everybody into a wall
  // and looks, at a glance, exactly like getting it right.
  const way = downhill(field, 2000, 2000);
  const toDoor = [9500 - 2000, 5000 - 2000];
  const length = Math.hypot(toDoor[0], toDoor[1]);
  const agree = way[0] * toDoor[0] / length + way[1] * toDoor[1] / length;
  check("and the gradient at (2,2) points at the doorway", agree > 0.9,
    "cosine " + agree.toFixed(3));

  // Sealed off, there is no route at all - and saying so is the right answer.
  const sealed = makeGrid({ lo: [0, 0], hi: [20000, 10000] }, 250);
  blockPolygon(sealed, [[9500, 0], [10500, 0], [10500, 10000], [9500, 10000]]);
  clearanceOf(sealed);
  const shut = flowField(sealed, [[19000, 5000]]);
  check("a sealed wall means no route, rather than a route through it",
    walkDistance(shut, 500, 500) === null);
  check("but the far side of it is still reachable",
    walkDistance(shut, 19000, 2000) !== null);
}

console.log("\n3b. a wall thinner than the grid still stops people");
{
  //! THE test for the rasteriser. A 100 mm partition on a 250 mm grid can pass
  //! clean between two cell centres and land in none of them - and a wall that
  //! is in the model, on the screen and not in the simulation is the worst
  //! thing this package could do. It looks completely right until somebody
  //! notices the crowd walking through a partition.
  for (const thickness of [500, 250, 100, 60, 20]) {
    const grid = makeGrid({ lo: [0, 0], hi: [10000, 10000] }, 250);
    blockPolygon(grid, [[5000, 0], [5000 + thickness, 0],
                        [5000 + thickness, 10000], [5000, 10000]]);
    clearanceOf(grid);
    const field = flowField(grid, [[9000, 5000]]);
    check("a " + thickness + " mm wall right across is not walked through",
      walkDistance(field, 1000, 5000) === null,
      walkDistance(field, 1000, 5000) === null ? "sealed"
        : "LEAKED at " + (walkDistance(field, 1000, 5000) / 1000).toFixed(2) + " m");
  }
  // And it must not block what it does not touch: a thin wall is one cell
  // thick, not a smear.
  const grid = makeGrid({ lo: [0, 0], hi: [10000, 10000] }, 250);
  blockPolygon(grid, [[5000, 0], [5100, 0], [5100, 6000], [5000, 6000]]);
  clearanceOf(grid);
  const field = flowField(grid, [[9000, 5000]]);
  check("but a wall with a gap left in it is still walkable round",
    walkDistance(field, 1000, 5000) !== null,
    (walkDistance(field, 1000, 5000) / 1000).toFixed(2) + " m round the end");
  const blockedCells = grid.blocked.reduce((a, b) => a + b, 0);
  check("and a 100 mm wall costs one cell of width, not three",
    blockedCells < 6000 / 250 * 2.5, blockedCells + " cells for a 6 m run");
}

console.log("\n4. a crowd through a door");
{
  const grid = room();
  const field = flowField(grid, [[19000, 5000]]);
  const crowd = makeCrowd(300);
  const density = makeDensity(grid);
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 120; i++)
    addWalker(crowd, 600 + rnd() * 8000, 600 + rnd() * 8800, 0, 0, rnd);
  const started = crowd.count;

  let t = 0, insideWall = 0;
  for (let step = 0; step < 6000 && crowd.count; step++) {
    t += 0.05;
    measureDensity(density, crowd, grid, 0.05);
    stepCrowd(crowd, [field], grid, density, 0.05, t);
    for (let a = 0; a < crowd.count; a++)
      if (isBlocked(grid, crowd.x[a], crowd.y[a])) insideWall++;
  }
  check("everybody got there", crowd.done === started, crowd.done + " of " + started);
  check("and nobody was ever inside a wall", insideWall === 0, insideWall + " wall-frames");
  check("it took minutes, not seconds - a 1.2 m door is the bottleneck",
    t > 40 && t < 600, t.toFixed(0) + " s for " + started + " people");

  // Throughput through a 1.2 m door. Published free-flow capacity is about
  // 1.2-1.4 people/s/m; a queued door is lower. Anything above 2 would mean
  // people are passing through each other.
  const perSecondPerMetre = started / t / 1.2;
  check("door throughput is physically possible",
    perSecondPerMetre > 0.2 && perSecondPerMetre < 2.0,
    perSecondPerMetre.toFixed(2) + " people/s/m");

  const times = crowd.journeys.map(j => j.seconds).sort((a, b) => a - b);
  check("the first away is much quicker than the last",
    times[times.length - 1] > times[0] * 3,
    times[0].toFixed(1) + " s to " + times[times.length - 1].toFixed(1) + " s");
  check("and everybody walked at least the straight-line distance",
    crowd.journeys.every(j => j.mm > 8000),
    Math.min(...crowd.journeys.map(j => j.mm)).toFixed(0) + " mm shortest");
  check("the queue reached a real density", Math.max(...density.peak) * 1e6 > 1.5,
    (Math.max(...density.peak) * 1e6).toFixed(2) + " p/m²");
}

console.log("\n4b. cut off is not the same as arrived");
{
  //! The finding that a simulation is FOR. Seal the only way through and the
  //! people on the far side have not arrived - they are trapped, and reporting
  //! them as a hundred and fifty successful journeys is the worst lie this
  //! package could tell, because it looks like good news.
  const grid = room();
  const field = flowField(grid, [[19000, 5000]]);
  const crowd = makeCrowd(80);
  const density = makeDensity(grid);
  let seed = 11;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 40; i++) addWalker(crowd, 1000 + rnd() * 6000, 1000 + rnd() * 8000, 0, 0, rnd);

  let t = 0;
  for (let step = 0; step < 60; step++) {
    t += 0.05;
    measureDensity(density, crowd, grid, 0.05);
    stepCrowd(crowd, [field], grid, density, 0.05, t);
  }
  check("with the door open, nobody is cut off", crowd.stranded === 0,
    crowd.stranded + " stranded");
  const walkingBefore = crowd.count, doneBefore = crowd.done;

  // Now brick the doorway up, exactly as dragging a wall would.
  blockPolygon(grid, [[9500, 4400], [10500, 4400], [10500, 5600], [9500, 5600]]);
  clearanceOf(grid);
  const sealed = flowField(grid, [[19000, 5000]]);
  let report = null;
  for (let step = 0; step < 40; step++) {
    t += 0.05;
    measureDensity(density, crowd, grid, 0.05);
    report = stepCrowd(crowd, [sealed], grid, density, 0.05, t);
  }
  check("sealing it does NOT count everybody as having arrived",
    crowd.done === doneBefore, crowd.done + " arrived, was " + doneBefore);
  check("it reports them cut off instead", crowd.stranded === walkingBefore,
    crowd.stranded + " of " + walkingBefore + " cut off");
  check("and the step says so too", report.stranded === walkingBefore
    && report.arrived === 0, JSON.stringify(report));
  check("they are still there to be seen, not quietly removed",
    crowd.count === walkingBefore, crowd.count + " still on the floor");
}

console.log("\n5. crowding, measured");
{
  const grid = makeGrid({ lo: [0, 0], hi: [10000, 10000] }, 250);
  clearanceOf(grid);
  const crowd = makeCrowd(200);
  const density = makeDensity(grid);
  // 100 people in a 10 x 10 m room is 1 per m², which is Fruin D.
  let seed = 3;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 100; i++) addWalker(crowd, rnd() * 10000, rnd() * 10000, 0, 0, rnd);
  measureDensity(density, crowd, grid, 0);
  const mean = density.now.reduce((a, b) => a + b, 0) / density.now.length;
  check("100 people in 100 m² measures about 1 per m²",
    near(mean * 1e6, 1, 0.25), (mean * 1e6).toFixed(3) + " p/m²");
  check("which is Fruin D", levelOfService(mean).grade === "D", levelOfService(mean).grade);
  const service = serviceBreakdown(density, grid);
  check("the breakdown adds up to the occupied floor",
    near(service.bands.reduce((a, b) => a + b.area, 0), service.occupied, 1),
    (service.occupied / 1e6).toFixed(0) + " m²");
  check("and its shares add to one",
    near(service.bands.reduce((a, b) => a + b.share, 0), 1, 1e-6));
}

console.log("\n6. what you can see from where you stand");
{
  const open = makeGrid({ lo: [0, 0], hi: [10000, 10000] }, 250);
  clearanceOf(open);
  const all = isovist(open, 5000, 5000, { rays: 360 });
  check("in a clear 10 x 10 room you can see all 100 m²",
    near(all.area / 1e6, 100, 1.5), (all.area / 1e6).toFixed(2) + " m²");

  const split = room();
  const west = isovist(split, 3000, 5000, { rays: 360 });
  const corner = isovist(split, 1000, 1000, { rays: 360 });
  check("standing level with the doorway you see through it",
    west.area / 1e6 > 95, (west.area / 1e6).toFixed(1) + " m² of a 95 m² half");
  check("standing in the far corner you see less",
    corner.area < west.area, (corner.area / 1e6).toFixed(1) + " m²");
  check("and never more than the whole floor",
    west.area / 1e6 < 200 && corner.area / 1e6 < 200);
}

console.log("\n7. the floor plate, cut out of real geometry");
{
  await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "F",
                           units: "mm", features: [] });
  const point = async (x, y, z) => {
    const id = (await kernel.addFeature("Point", {})).id;
    for (const [k, v] of [["x", x], ["y", y], ["z", z]]) await kernel.setParameter(id, k, v);
    return id;
  };
  const up = (await kernel.addFeature("Vector", {})).id;
  await kernel.setParameter(up, "dx", 0);
  await kernel.setParameter(up, "dz", 1);
  const o = await point(0, 0, 0);
  const plane = (await kernel.addFeature("Plane", { origin: o, normal: up })).id;
  // A screen 2 m tall and a desk 720 high, side by side.
  const screenAt = await point(1000, 1000, 0);
  const screen = (await kernel.addFeature("Cube", { origin: screenAt, plane })).id;
  for (const [k, v] of [["dx", 2000], ["dy", 100], ["dz", 2000]])
    await kernel.setParameter(screen, k, v);
  const deskAt = await point(5000, 1000, 0);
  const desk = (await kernel.addFeature("Cube", { origin: deskAt, plane })).id;
  for (const [k, v] of [["dx", 1600], ["dy", 800], ["dz", 720]])
    await kernel.setParameter(desk, k, v);

  const meshes = (await kernel.mesh([screen, desk])).features;
  check("both bodies meshed", meshes.length === 2 && meshes.every(m => m.positions.length));

  const high = plateOf(meshes, 1100, 250);
  const low = plateOf(meshes, 400, 250);
  check("at 1.1 m the screen blocks and the desk does not",
    high.rings.length === 1, high.rings.length + " footprints");
  check("at 0.4 m both of them do", low.rings.length === 2, low.rings.length + " footprints");
  check("above everything, nothing does", plateOf(meshes, 2500, 250) === null);

  // The screen's footprint must be where the screen is, and the right size.
  const ring = high.rings[0];
  const lo = [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1]))];
  const hi = [Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))];
  check("and it is 2000 x 100 where the screen is",
    near(hi[0] - lo[0], 2000, 1) && near(hi[1] - lo[1], 100, 1) && near(lo[0], 1000, 1),
    (hi[0] - lo[0]) + " x " + (hi[1] - lo[1]) + " at " + lo[0] + "," + lo[1]);
  check("the raster blocks inside the screen and not beside it",
    isBlocked(high.grid, 2000, 1050) && !isBlocked(high.grid, 2000, 2000));

  // The plate is padded around the FURNITURE, so a point beyond the furniture
  // used to fall off the grid and read as blocked - which came back as "that
  // point is inside something" about somebody standing in open floor.
  const far = [12000, 6000];
  check("a point well clear of everything is off the plain plate",
    isBlocked(high.grid, far[0], far[1]));
  const wide = plateOf(meshes, 1100, 250, { include: [far] });
  check("but the plate covers it when it is asked to",
    !isBlocked(wide.grid, far[0], far[1]));
  check("and that does not move what counts as inside the building",
    near(wide.inside.hi[0], high.inside.hi[0], 1),
    wide.inside.hi[0] + " vs " + high.inside.hi[0]);
}

console.log("\n8. a package, loaded and put away");
{
  check("it is on the shelf", !!findPlugin("flow"));
  check("declared with the package off",
    CROWD.nodes.length === 3 && CROWD.nodes.every(n => typeSpec(n.type) === null));
  check("and its API is declared operation by operation",
    CROWD.api.operations.length >= 8
    && CROWD.api.operations.every(o => o.name && o.takes && o.gives && o.summary));

  const host = new PluginHost({
    toolkit: () => kernel.toolkit(),
    installDrivers: (specs, builders) => kernel.installDrivers(specs, builders),
    removeDrivers: specs => kernel.removeDrivers(specs),
    typesInUse: types => kernel.typesInUse(types),
  });
  await host.load("flow");
  check("loaded, and its nodes are catalogue types",
    CROWD_NODES.every(n => typeSpec(n.type) !== null));

  // A walk round a real obstacle, through the real kernel.
  const at = async id => ((await kernel.tree()).tree.features).find(f => f.id === id);
  const put = async (x, y) => {
    const id = (await kernel.addFeature("Point", {})).id;
    await kernel.setParameter(id, "x", x);
    await kernel.setParameter(id, "y", y);
    return id;
  };
  const a = await put(0, 1050), b = await put(4000, 1050);
  const screenId = ((await kernel.tree()).tree.features).find(f => f.type === "Cube").id;
  const walk = (await kernel.addFeature("WalkDistance",
    { from: a, to: b, obstacles: screenId })).id;
  const entry = await at(walk);
  check("a WalkDistance node builds", !entry.error, entry.error || "");
  check("and it is longer than the 4 m straight line it would be without the screen",
    entry.data.preview.includes("m to walk") && Number(entry.data.preview.split(" ")[0]) > 4.0,
    entry.data.preview);

  const portal = (await kernel.addFeature("Portal", { at: a })).id;
  check("a Portal builds and says what it is", !(await at(portal)).error,
    (await at(portal)).data.preview);

  let refused = "";
  try { await host.unload("flow"); } catch (e) { refused = e.message; }
  check("it will not unload while its nodes are in the model", /still in the model/.test(refused),
    refused);
  await kernel.deleteFeature(walk);
  await kernel.deleteFeature(portal);
  await host.unload("flow");
  check("and with them gone it does", !host.isLoaded("flow")
    && CROWD_NODES.every(n => typeSpec(n.type) === null));
}

console.log("\n9. the crowding ramp");
{
  check("empty is calm, jammed is red",
    crowdColour(0)[1] > crowdColour(0)[0] && crowdColour(1)[0] > crowdColour(1)[1]);
  check("and it stays inside the box",
    Array.from({ length: 41 }, (_, i) => crowdColour(i / 40))
      .every(c => c.every(v => v >= 0 && v <= 1)));
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall checks passed");
process.exit(failures ? 1 : 0);
