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
import { CROWD, CROWD_NODES, boundaryRings, crowdColour, footprintOf, plateOf, zSpan }
  from "../src/crowd-plugin.js";
import { BODY, FREE_SPEED, FRUIN, SIDESTEP, addWalker, blockPolygon, cellIndex,
         cellsAllowed, clearanceOf, crowdSpeed, fillRings, toWorld,
         downhill, flowField, isBlocked, isovist, levelOfService, makeCrowd,
         makeDensity, makeGrid, makeTrace, measureDensity, serviceBreakdown,
         stepCrowd, stranded, toCell, walkDistance } from "../src/crowd.js";
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
  // Weidmann's curve reaches exactly zero at 5.4, and taking that literally
  // locks a jammed crowd forever - see section 4e. Fruin's F band is
  // "shuffling", not "stopped", so there is a floor and this is it.
  check("at jam density it is a shuffle, not a full stop",
    crowdSpeed(5.4e-6) > 0 && crowdSpeed(5.4e-6) < FREE_SPEED * 0.1,
    crowdSpeed(5.4e-6).toFixed(0) + " mm/s");
  check("and beyond jam it does not go further, or negative",
    crowdSpeed(20e-6) === crowdSpeed(5.4e-6), crowdSpeed(20e-6).toFixed(0) + " mm/s");
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

console.log("\n4c. the two maps are two different maps");
{
  //! Movement and concentration answer different questions, and showing one
  //! and calling it "the heatmap" is how a circulation problem gets read as an
  //! occupancy problem. A corridor everybody crosses and nobody stays in must
  //! be hot on movement and cold on concentration; a spot where somebody
  //! stands still must be the other way round.
  const grid = makeGrid({ lo: [0, 0], hi: [12000, 4000], floor: 0 }, 250);
  clearanceOf(grid);
  const field = flowField(grid, [[11000, 2000]]);
  const trace = makeTrace(grid);
  const crowd = makeCrowd(60);
  const density = makeDensity(grid);
  let seed = 5;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 20; i++) addWalker(crowd, 800 + rnd() * 400, 1200 + rnd() * 1600, 0, 0, rnd);
  // One person who arrives and then stands there for the rest of the run.
  const sitter = addWalker(crowd, 6000, 3500, 0, 0, rnd);
  crowd.until[sitter] = 1e6;

  let t = 0;
  for (let step = 0; step < 1200; step++) {
    t += 0.05;
    measureDensity(density, crowd, grid, 0.05);
    stepCrowd(crowd, [field], grid, density, 0.05, t, { trace });
  }
  const at = (x, y, map) => {
    const [i, j] = toCell(grid, x, y);
    return trace[map][j * grid.width + i];
  };
  check("the corridor everyone walked is hot on movement",
    at(6000, 2000, "footfall") > 0, at(6000, 2000, "footfall").toFixed(0) + " person-mm");
  check("the spot where one person stood is hotter on concentration",
    at(6000, 3500, "occupancy") > at(6000, 2000, "occupancy"),
    at(6000, 3500, "occupancy").toFixed(1) + " vs " + at(6000, 2000, "occupancy").toFixed(1) + " person-s");
  check("and colder on movement - they never went anywhere",
    at(6000, 3500, "footfall") < at(6000, 2000, "footfall") * 0.2,
    at(6000, 3500, "footfall").toFixed(0) + " vs " + at(6000, 2000, "footfall").toFixed(0));
  check("somewhere nobody went is cold on both",
    at(1000, 3800, "footfall") === 0, at(1000, 3800, "footfall").toFixed(0));
  check("the trace knows how long it ran", near(trace.seconds, t, 0.2),
    trace.seconds.toFixed(1) + " s");

  // Person-metres is a real quantity: the total must match what people walked.
  const walkedTotal = trace.footfall.reduce((a, b) => a + b, 0);
  const bodiesWalked = crowd.journeys.reduce((a, j) => a + j.mm, 0)
    + Array.from({ length: crowd.count }, (_, a) => crowd.walked[a]).reduce((a, b) => a + b, 0);
  check("and the map adds up to the distance everybody actually walked",
    near(walkedTotal, bodiesWalked, bodiesWalked * 0.02 + 1),
    (walkedTotal / 1000).toFixed(1) + " m vs " + (bodiesWalked / 1000).toFixed(1) + " m");
}

console.log("\n4d. people who arrive can be sent somewhere else");
{
  //! A floor where everybody leaves the moment they arrive is a drain. Given
  //! somewhere else to go they go, which is what makes flows CROSS.
  const grid = makeGrid({ lo: [0, 0], hi: [12000, 6000], floor: 0 }, 250);
  clearanceOf(grid);
  const fields = [flowField(grid, [[1000, 3000]]), flowField(grid, [[11000, 3000]])];
  const crowd = makeCrowd(20);
  const density = makeDensity(grid);
  let seed = 9;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 10; i++) addWalker(crowd, 5500 + rnd() * 1000, 2000 + rnd() * 2000, 1, 0, rnd);

  let t = 0, swaps = 0;
  for (let step = 0; step < 3000; step++) {
    t += 0.05;
    measureDensity(density, crowd, grid, 0.05);
    stepCrowd(crowd, fields, grid, density, 0.05, t, {
      recycle: (a, now) => { swaps++; return { goal: crowd.goal[a] === 0 ? 1 : 0, dwell: 2 }; },
    });
  }
  check("nobody was removed - they are all still walking", crowd.count === 10,
    crowd.count + " on the floor");
  check("they turned round and went back, many times over", swaps > 20, swaps + " arrivals");
  check("and every one was counted as a journey", crowd.done === swaps,
    crowd.done + " journeys, " + swaps + " arrivals");
  // Dwell measured rather than asserted: the same run twice, once with people
  // stopping for eight seconds when they arrive and once with them turning
  // straight round. The difference between the medians has to be the dwell.
  const median = dwell => {
    const c = makeCrowd(20), d = makeDensity(grid);
    let s2 = 9;
    const r2 = () => (s2 = (s2 * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 10; i++) addWalker(c, 5500 + r2() * 1000, 2000 + r2() * 2000, 1, 0, r2);
    let time = 0;
    for (let step = 0; step < 3000; step++) {
      time += 0.05;
      measureDensity(d, c, grid, 0.05);
      stepCrowd(c, fields, grid, d, 0.05, time,
        { recycle: a => ({ goal: c.goal[a] === 0 ? 1 : 0, dwell }) });
    }
    const times = c.journeys.map(j => j.seconds).sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  };
  const brisk = median(0), lingering = median(8);
  check("stopping for eight seconds adds eight seconds to a journey",
    near(lingering - brisk, 8, 1.5),
    brisk.toFixed(1) + " s becomes " + lingering.toFixed(1) + " s");
}

console.log("\n4e. two crowds walking into each other must pass, not lock");
{
  //! The benchmark every pedestrian model is judged on, and TWO separate
  //! things are needed to pass it. Both were found by running it.
  //!
  //! Weidmann's relation reaches exactly zero at jam density. Take that
  //! literally and a crowd that jams can never un-jam: everybody stops,
  //! stopping holds the density up, and the density holds everybody stopped.
  //! Hence the shuffle floor - and Fruin's F band is "shuffling", not
  //! "stopped", so the floor is what the standard says as well.
  //!
  //! And pushing people apart along the line between them gives a head-on
  //! meeting no way out: every push is met by an equal one back and nobody has
  //! a reason to go round. Real people step aside, consistently to one side.
  //! One rotational bias, the same for everybody, breaks the symmetry.
  //!
  //! A 1.2 m corridor with eighty people is where both matter: without the
  //! sidestep NOBODY gets through, with it almost everybody does.
  const corridor = (widthMm, people, sidestep) => {
    const grid = makeGrid({ lo: [0, 0], hi: [20000, widthMm + 200], floor: 0 }, 250);
    blockPolygon(grid, [[0, 0], [20000, 0], [20000, 100], [0, 100]]);
    blockPolygon(grid, [[0, widthMm + 100], [20000, widthMm + 100],
                        [20000, widthMm + 200], [0, widthMm + 200]]);
    clearanceOf(grid);
    const mid = (widthMm + 200) / 2;
    const east = flowField(grid, [[19000, mid]]), west = flowField(grid, [[1000, mid]]);
    const crowd = makeCrowd(200), density = makeDensity(grid);
    let seed = 21;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < people / 2; i++) {
      addWalker(crowd, 2000 + rnd() * 3000, 200 + rnd() * (widthMm - 200), 0, 0, rnd);
      addWalker(crowd, 15000 + rnd() * 3000, 200 + rnd() * (widthMm - 200), 1, 0, rnd);
    }
    const started = crowd.count;
    let t = 0;
    for (let step = 0; step < 8000 && crowd.count; step++) {
      t += 0.05;
      measureDensity(density, crowd, grid, 0.05);
      stepCrowd(crowd, [east, west], grid, density, 0.05, t, { sidestep });
    }
    return { done: crowd.done, started, stuck: crowd.count, seconds: t };
  };

  const roomy = corridor(3000, 40, SIDESTEP);
  check("in a 3 m corridor two crowds pass each other",
    roomy.done >= roomy.started * 0.9,
    roomy.done + " of " + roomy.started + " in " + roomy.seconds.toFixed(0) + " s");

  const tight = corridor(1200, 80, SIDESTEP);
  const locked = corridor(1200, 80, 0);
  check("in a 1.2 m corridor with eighty people, the sidestep gets them through",
    tight.done >= tight.started * 0.75,
    tight.done + " of " + tight.started);
  check("and without it NOBODY gets through - it locks solid",
    locked.done === 0 && locked.stuck === locked.started,
    locked.done + " arrive, " + locked.stuck + " still stuck after "
      + locked.seconds.toFixed(0) + " s");

  // The shuffle floor, which is what lets the sidestep act at all.
  check("a jammed crowd shuffles rather than freezing",
    crowdSpeed(9e-6) > 0 && crowdSpeed(9e-6) < FREE_SPEED * 0.15,
    crowdSpeed(9e-6).toFixed(0) + " mm/s at 9 people/m²");
  check("and speed still falls the whole way down to it",
    crowdSpeed(0.5e-6) > crowdSpeed(2e-6) && crowdSpeed(2e-6) > crowdSpeed(4e-6),
    [0.5, 2, 4].map(d => crowdSpeed(d * 1e-6).toFixed(0)).join(" > "));
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
    CROWD.nodes.map(n => n.type).join(",") === "Portal,WalkDistance,Floor,Isovist"
    && CROWD.nodes.every(n => typeSpec(n.type) === null),
    CROWD.nodes.map(n => n.type).join(","));
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

console.log("a floor is a floor, and a ring inside a ring is a hole");
{
  // Two squares, one inside the other. Nothing in the geometry says whether
  // that is a slab with a lightwell or a wall around a courtyard, and the
  // answer is opposite in the two cases - so somebody has to say which.
  const face = (outer, inner) => {
    const positions = [], index = [];
    for (const [x, y] of outer) positions.push(x, y, 0);
    for (const [x, y] of inner) positions.push(x, y, 0);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      index.push(k, j, 4 + k, j, 4 + j, 4 + k);
    }
    return { positions, index };
  };
  const plate = face([[0, 0], [20000, 0], [20000, 20000], [0, 20000]],
                     [[8000, 8000], [12000, 8000], [12000, 12000], [8000, 12000]]);

  const rings = boundaryRings(plate);
  check("a flat face gives up its outline and its hole",
        rings.length === 2, String(rings.length));
  check("the outline first, and it is the big one",
        Math.max(...rings[0].map(p => p[0])) === 20000,
        JSON.stringify(rings.map(r => Math.max(...r.map(p => p[0])))));

  // As a floor: walk on it, round the hole. 20 x 20 m less a 4 x 4 m lightwell.
  const asFloor = plateOf([], 1100, 500, { floors: [plate] });
  const walkable = asFloor.grid.blocked.length
    - asFloor.grid.blocked.reduce((n, v) => n + v, 0);
  check("as a floor it is what the outline encloses, less the hole",
        Math.abs(walkable * 0.25 - 384) < 12, (walkable * 0.25).toFixed(0) + " m² of 384");
  check("and the plate is published, so the note can say what it found",
        asFloor.plate.length === 2, String(asFloor.plate.length));

  // As obstacles, the same two rings mean the opposite: solid between them,
  // and the hole in the middle is air. Filling each ring on its own - which is
  // what this used to do - made the hole solid too.
  const grid = makeGrid({ lo: [0, 0], hi: [20000, 20000], floor: 0 }, 500);
  fillRings(grid, rings);
  const inside = (x, y) => grid.blocked[cellIndex(grid, ...toCell(grid, x, y))];
  check("as obstacles the ring between them is solid", inside(2000, 2000) === 1);
  check("and the hole in the middle is not", inside(10000, 10000) === 0,
        "a hole filled solid is the bug this is here for");
}

console.log("nobody stands in a void, or off the edge of the plate");
{
  // An L-shaped plate with a void in it. The bounding box of an L contains a
  // quarter that is not floor at all, so a spawn that picks anywhere in the
  // box puts people in mid-air - which is what "it built a bounding box floor"
  // means.
  const ring = pts => {
    const positions = [], index = [];
    for (const [x, y] of pts) positions.push(x, y, 3000);
    // a fan from the first point: enough of a tessellation to have a boundary
    for (let k = 1; k + 1 < pts.length; k++) index.push(0, k, k + 1);
    return { positions, index };
  };
  const ell = ring([[0, 0], [20000, 0], [20000, 8000], [8000, 8000],
                    [8000, 20000], [0, 20000]]);
  const plate = plateOf([], 1100, 500, { floors: [ell] });
  check("an L-shaped plate is read as an L", !!plate && plate.carved,
        plate ? String(plate.carved) : "no plate");
  check("people stand on top of it, not inside it", plate.grid.floor === 3000,
        String(plate.grid.floor));

  // The corner the L does not occupy must be off the floor.
  const off = isBlocked(plate.grid, 16000, 16000);
  const on = isBlocked(plate.grid, 4000, 4000);
  check("the notch of the L is not floor", off === true, String(off));
  check("and the arms of it are", on === false, String(on));

  // Every cell that is walkable has to be inside the outline. Sampled rather
  // than proved, which is what a grid lets you do.
  let outside = 0, walkable = 0;
  for (let j = 0; j < plate.grid.height; j++)
    for (let i = 0; i < plate.grid.width; i++) {
      if (plate.grid.blocked[cellIndex(plate.grid, i, j)]) continue;
      walkable++;
      const [x, y] = toWorld(plate.grid, i, j);
      if (x > 8600 && y > 8600) outside++;
    }
  check("nothing walkable is in the notch", outside === 0,
        outside + " of " + walkable + " walkable cells were in mid-air");
}

console.log("it has to work at both ends of the scale, and never lock up");
{
  // A masterplan and a lobby are the same tool. What must not happen at either
  // end is the browser stopping: past a certain size a grid is not slow, it is
  // stuck, and a tool that hangs is worse than one that says it coarsened.
  const slab = (x0, y0, x1, y1) => {
    const positions = [];
    for (const z of [0, 3000])
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) positions.push(x, y, z);
    return { positions, index: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
                                0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6] };
  };

  check("a cell budget is a budget of cells TIMES fields",
        cellsAllowed(1) > cellsAllowed(4) && cellsAllowed(4) > cellsAllowed(20),
        [cellsAllowed(1), cellsAllowed(4), cellsAllowed(20)].join(" / "));
  check("and it never goes below something worth measuring", cellsAllowed(500) >= 20000,
        String(cellsAllowed(500)));

  // 500 m of masterplan, asked for at 100 mm: 25 million cells, which is not a
  // grid, it is a hang.
  const big = plateOf([slab(0, 0, 500000, 500000)], 1500, 100,
                      { maxCells: cellsAllowed(4) });
  check("a masterplan at 100 mm coarsens rather than trying",
        !!big && big.grid.coarsened && big.grid.cell > 100, big ? String(big.grid.cell) : "no plate");
  check("to something that fits the budget",
        big.grid.width * big.grid.height <= cellsAllowed(4) * 1.1,
        (big.grid.width * big.grid.height) + " vs " + cellsAllowed(4));
  check("and it still covers the whole 500 m",
        big.grid.width * big.grid.cell >= 500000, String(big.grid.width * big.grid.cell));
  check("it says what it did", big.grid.asked === 100 && big.grid.cell !== 100,
        big.grid.asked + " -> " + big.grid.cell);

  // A building footprint at the same spacing is left alone: 40 m at 100 mm is
  // 160,000 cells, which is a grid.
  const small = plateOf([slab(0, 0, 40000, 40000)], 1500, 100, { maxCells: cellsAllowed(4) });
  check("a building at 100 mm is left at 100 mm",
        !!small && !small.grid.coarsened && small.grid.cell === 100,
        small ? small.grid.cell + " coarsened=" + small.grid.coarsened : "no plate");

  // And 20 m spacing, which nothing used to allow, is a grid like any other.
  const coarse = plateOf([slab(0, 0, 500000, 500000)], 1500, 20000, { maxCells: cellsAllowed(4) });
  check("and 20 m spacing is allowed, because a masterplan may want it",
        !!coarse && coarse.grid.cell === 20000 && !coarse.grid.coarsened,
        coarse ? String(coarse.grid.cell) : "no plate");

  // The one that used to lock the page: the field sweep itself. On a plate this
  // big the costs are tens of thousands of millimetres, where one float32 step
  // is coarser than the tolerance the sweep used to compare with - so two cells
  // improved each other by less than the rounding, for ever. It returning at
  // all is the test.
  const started = Date.now();
  const field = flowField(big.grid, [[2000, 2000]]);
  const took = Date.now() - started;
  let reached = 0;
  for (const c of field.cost) if (Number.isFinite(c)) reached++;
  check("the field sweep finishes on a masterplan-sized grid", reached > 1000,
        reached + " cells reached in " + took + " ms");
  check("and it finishes quickly enough to run while a slider moves", took < 2000,
        took + " ms");
}

console.log("the cut has to be able to reach the model");
{
  // A part drawn here sits on z = 0. A building imported from a STEP file sits
  // where its file says it sits, and a cut slider fixed to 0.1 - 2.4 m would
  // never touch a plate four metres up.
  const box = (z0, z1) => {
    const positions = [];
    for (const z of [z0, z1])
      for (const [x, y] of [[0, 0], [4000, 0], [4000, 4000], [0, 4000]]) positions.push(x, y, z);
    return { positions, index: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] };
  };
  check("it says where the model is", JSON.stringify(zSpan([box(4200, 7400)])) === "[4200,7400]",
        JSON.stringify(zSpan([box(4200, 7400)])));
  check("and nothing when there is nothing to measure", zSpan([]) === null);
  check("a flat thing is not a span", zSpan([box(0, 0.5)]) === null);
  const span = zSpan([box(0, 3000), box(4200, 7400)]);
  check("two storeys span both", JSON.stringify(span) === "[0,7400]", JSON.stringify(span));
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall checks passed");
process.exit(failures ? 1 : 0);
