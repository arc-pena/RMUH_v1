// The Flow package.
//
// A workplace consultant's question is never "does it fit". It is "what
// happens when three hundred people try to use it at once", and the honest
// answer to that has always needed either a simulation or a building. This is
// the simulation, over the plan you are drawing, updating while you drag.
//
// The trick that makes it live is one field. Rather than finding a route per
// person per frame, ONE sweep out from the destinations gives every cell its
// distance to the nearest one, and everybody walks downhill on it. Move a desk
// and it is a single sweep to re-route the whole floor - which is why this can
// run as an overlay on the model rather than as a job you submit.
//
// WHAT KIND OF NUMBERS THESE ARE. The plan is exact: obstacles come from the
// model, cut at a height you choose. The capacity is published - Weidmann's
// speed-density relation and Fruin's Levels of Service, both named on screen.
// The behaviour is a MODEL: how people steer round each other is tuned to look
// right, and it reproduces the queues, the lanes and the pinch points that make
// these studies worth doing. It does not predict what any one person will do.
// Read it for where the plan fails, not for a headcount at a moment.

import { ARG } from "./ocaf.js";
import { offerPlugin } from "./plugin.js";
import { BODY, FRUIN, SHUFFLE, addWalker, cellsAllowed, clearanceOf, blockPolygon,
         crowdSpeed, densityAt, fillRings, removeWalker, surfaceAt,
         CLIMB, SLOPE_LIMIT, inGrid, cellIndex,
         downhill, flowField, isBlocked, isovist, levelOfService, makeCrowd,
         makeDensity, makeGrid, makeTrace, measureDensity, serviceBreakdown,
         stepCrowd, stranded, toCell, toWorld, walkDistance } from "./crowd.js";

/* ------------------------------------------------------------ the nodes */

const ROLES = ["Entrance", "Exit", "Desk cluster", "Amenity", "Core"];

export const CROWD_NODES = [
  { type: "Portal", guid: "9a1b2c30-00d0-4c00-9e00-caf0000000d0", category: "datum",
    produces: "point",
    summary: "Somewhere people come from or go to - a door, a lift core, a tea point, "
           + "a desk cluster. Put one at each end of the journeys you care about and "
           + "the Flow mode walks people between them. The rate is how many arrive a "
           + "minute, which is the number a brief actually gives you.",
    args: [ARG.ref("at", "At", ["point"], false),
           ARG.choice("role", "Role", ROLES, 0),
           ARG.real("rate", "People a minute", 20, 0, 400, 1, ""),
           ARG.real("width", "Clear width", 1200, 300, 20000, 50)] },

  { type: "WalkDistance", guid: "9a1b2c30-00d1-4c00-9e00-caf0000000d1",
    category: "analysis", produces: "number",
    summary: "How far it is to WALK from one point to another - round the furniture, "
           + "through the doors - rather than the straight line through three walls "
           + "that a measurement gives you. The number behind \"how far is the nearest "
           + "tea point\", and the one that changes when you move a desk.",
    args: [ARG.ref("from", "From", ["point"], false),
           ARG.ref("to", "To", ["point"], false),
           ARG.refs("obstacles", "Around", ["solid"]),
           ARG.real("cut", "Cut height", 1100, 50, 20000, 50),
           ARG.real("grain", "Grid", 250, 50, 2000, 50)] },

  { type: "Floor", guid: "9a1b2c30-00d3-4c00-9e00-caf0000000d3",
    category: "analysis", produces: "text",
    summary: "Which geometry people walk ON, as against the geometry they walk ROUND. "
           + "Wire a sketch's face, a slab, or the face of an imported extrusion into "
           + "it and its outline becomes the edge of the floor and its inner loops "
           + "become holes - a lightwell, a core, an atrium. Without one, Flow assumes "
           + "everything it can cut is an obstacle and the floor is the ground the walls "
           + "stand on, which is right for a plan drawn in walls and wrong for a plate "
           + "drawn as a face. Nothing in the geometry says which you meant.",
    args: [ARG.refs("of", "Floor plates", ["solid", "plane"])] },

  { type: "Isovist", guid: "9a1b2c30-00d2-4c00-9e00-caf0000000d2",
    category: "analysis", produces: "curve",
    summary: "Everything visible from one point, as the polygon you can see and the "
           + "area of it. The oldest measure in space syntax and the one workplace "
           + "layout turns on: can you see the tea point, can your desk be seen from "
           + "the door, does this corner feel like a corner.",
    args: [ARG.ref("at", "At", ["point"], false),
           ARG.refs("obstacles", "Blocked by", ["solid"]),
           ARG.real("eye", "Eye height", 1200, 50, 20000, 50),
           ARG.real("reach", "Reach", 40000, 1000, 500000, 1000),
           ARG.real("rays", "Rays", 180, 24, 720, 12, "")] },
];

/* ------------------------------------------------------- the floor plate

   The one piece of geometry this package needs: what blocks a person, seen
   from above. A solid is cut at a height and the outline of the cut is the
   footprint - which is why a desk at 720 blocks nothing at eye height and a
   screen at 1600 blocks everything.                                          */

//! The footprint of a shape at a cut height, as world polygons. Taken from the
//! shape's own triangles rather than a section, because the triangles are
//! already there and every triangle crossing the plane leaves a segment.
export function footprintOf(mesh, cut) {
  const rings = [];
  const p = mesh.positions, index = mesh.index;
  if (!p || !index) return rings;
  const segments = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const corner = [0, 1, 2].map(k => {
      const at = index[t + k] * 3;
      return [p[at], p[at + 1], p[at + 2]];
    });
    const crossing = [];
    for (let e = 0; e < 3; e++) {
      const a = corner[e], b = corner[(e + 1) % 3];
      if ((a[2] > cut) === (b[2] > cut)) continue;
      const k = (cut - a[2]) / (b[2] - a[2]);
      crossing.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
    if (crossing.length === 2) segments.push(crossing);
  }
  return ringsFromSegments(segments);
}

//! Loose segments welded end to end into closed rings. They come out of a slice
//! in no order at all, and a ring that will not close is kept anyway and closed
//! by force: a footprint with a hairline gap in it lets the whole crowd walk
//! through a wall.
export function ringsFromSegments(segments, weld = 20) {
  const rings = [];
  if (!segments.length) return rings;
  const key = p2 => Math.round(p2[0] / weld) + "," + Math.round(p2[1] / weld);
  const ends = new Map();
  for (const seg of segments)
    for (const end of [0, 1]) {
      const k = key(seg[end]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ seg, end });
    }
  const used = new Set();
  for (const start of segments) {
    if (used.has(start)) continue;
    used.add(start);
    const ring = [start[0], start[1]];
    for (let guard = 0; guard < segments.length + 2; guard++) {
      const here = ends.get(key(ring[ring.length - 1])) || [];
      const next = here.find(h => !used.has(h.seg));
      if (!next) break;
      used.add(next.seg);
      ring.push(next.seg[1 - next.end]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

//! The outline of a FLAT thing: the edges its triangles do not share.
//!
//! A face has a boundary and its holes have boundaries, and a tessellation of
//! it says so exactly - an edge between two triangles is interior, an edge
//! belonging to one triangle is on the edge of the face. Nothing needs to be
//! cut and nothing needs a height, which is what makes this the way to read a
//! sketch's face, or the face of an imported extrusion, as a floor.
export function boundaryRings(mesh, weld = 20) {
  const p = mesh.positions, index = mesh.index;
  if (!p || !index) return [];
  const at = k => [Math.round(p[k * 3] / weld), Math.round(p[k * 3 + 1] / weld)];
  const seen = new Map();
  for (let t = 0; t + 2 < index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = at(index[t + e]), b = at(index[t + (e + 1) % 3]);
      // Undirected, and welded to the grid the ring builder uses, so two
      // triangles that meet along an edge agree that they do.
      const key = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])
        ? a + "|" + b : b + "|" + a;
      const had = seen.get(key);
      if (had) had.count++;
      else seen.set(key, { count: 1, a: [p[index[t + e] * 3], p[index[t + e] * 3 + 1]],
                           b: [p[index[t + (e + 1) % 3] * 3], p[index[t + (e + 1) % 3] * 3 + 1]] });
    }
  const segments = [];
  for (const edge of seen.values()) if (edge.count === 1) segments.push([edge.a, edge.b]);
  return ringsFromSegments(segments, weld);
}

//! What a thing looks like as a floor. A slab has a thickness, so it is cut
//! halfway up and the cut is its outline with its holes in it. A face has no
//! thickness to cut, so its own boundary is the answer.
export function floorRings(mesh) {
  const span = zSpan([mesh]);
  if (!span) return boundaryRings(mesh);
  // Cut near the BASE, not the middle. For a slab the two are the same; for
  // anything tall they are not, and what a floor plate means is the outline of
  // what it stands on - the middle of a building is a section through its
  // walls, which is a different drawing entirely.
  const at = span[0] + Math.max(1, (span[1] - span[0]) * 0.05);
  const low = footprintOf(mesh, at);
  return low.length ? low : boundaryRings(mesh);
}

//! Where the top of a floor is, so people stand ON it rather than inside it.
export const floorLevel = meshes => {
  let top = -Infinity;
  for (const mesh of meshes) {
    if (!mesh.positions) continue;
    for (let i = 2; i < mesh.positions.length; i += 3)
      if (mesh.positions[i] > top) top = mesh.positions[i];
  }
  return Number.isFinite(top) ? top : null;
};

//! A grid of the whole scene at a cut height, with everything blocked in.
//! \p include are extra world points the plate must cover - the ends of a walk,
//! the eye of an isovist. Without them the grid is padded around the FURNITURE,
//! and a point beyond the furniture falls off the edge and reads as blocked,
//! which comes back as "that point is inside something" about a point standing
//! in open floor.
//! Top and bottom of everything drawn, or null when there is nothing. What the
//! cut has to land between.
export function zSpan(meshes) {
  let lo = Infinity, hi = -Infinity;
  for (const mesh of meshes) {
    if (!mesh.positions) continue;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      const z = mesh.positions[i];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  return Number.isFinite(lo) && hi - lo > 1 ? [lo, hi] : null;
}

/* ================================================================= walking

   The mesh is king.

   What people can walk on is not an outline rasterised into a bitmap - it is
   the triangles of the model, filtered. Three things about a triangle decide
   it: which way it faces (up, or it is a ceiling), how steep it is (past about
   1:8 you are climbing), and whether anything stands in the headroom over it.
   That is the whole test, and it is the same test on a flat office floor, a
   ramp, a stepped terrace and the transition of a skate bowl.

   The grid is still a grid, because a quarter of a million Dijkstra cells in
   170 ms is what makes the thing interactive - but every cell now carries the
   HEIGHT of the surface under it, taken from the triangles. So a cell with no
   walkable triangle over it has no floor at all, which is what a void is, and
   a person's feet are at the height of the surface they are standing on rather
   than at one number for the whole plate.
   ========================================================================== */

//! Every triangle of every mesh, as three corners.
function eachTriangle(meshes, fn) {
  for (const mesh of meshes) {
    const p = mesh.positions, index = mesh.index;
    if (!p || !index) continue;
    for (let t = 0; t + 2 < index.length; t += 3) {
      const k0 = index[t] * 3, k1 = index[t + 1] * 3, k2 = index[t + 2] * 3;
      fn([p[k0], p[k0 + 1], p[k0 + 2]], [p[k1], p[k1 + 1], p[k1 + 2]],
         [p[k2], p[k2 + 1], p[k2 + 2]]);
    }
  }
}

//! Every cell whose middle falls inside a triangle, with the height of the
//! triangle there. Seen from above: a wall is edge-on and covers nothing,
//! which is right for a floor and wrong for an obstruction - so obstructions
//! trace the edges as well.
function overTriangle(grid, a, b, c, fn) {
  const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0]);
  const miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1]);
  const [i0, j0] = toCell(grid, minx, miny);
  const [i1, j1] = toCell(grid, maxx, maxy);
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-9) return;                 // edge-on: no floor in it
  for (let j = Math.max(0, j0); j <= Math.min(grid.height - 1, j1); j++)
    for (let i = Math.max(0, i0); i <= Math.min(grid.width - 1, i1); i++) {
      const [x, y] = toWorld(grid, i, j);
      const w0 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / area;
      const w1 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      fn(cellIndex(grid, i, j), a[2] * w0 + b[2] * w1 + c[2] * w2);
    }
}

//! The three edges of a triangle, walked in cell-sized steps. This is how a
//! wall thinner than a cell still stops somebody: seen from above it is a line,
//! and a line covers no cell middles at all.
function alongEdges(grid, a, b, c, fn) {
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const span = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(span / (grid.cell * 0.4)));
    for (let n = 0; n <= steps; n++) {
      const k = n / steps;
      const [i, j] = toCell(grid, p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k);
      if (inGrid(grid, i, j)) fn(cellIndex(grid, i, j), p[2] + (q[2] - p[2]) * k);
    }
  }
}

//! The lowest point of anything here: the ground a plan drawn in walls is
//! standing on.
function lowestOf(meshes) {
  let low = Infinity;
  for (const mesh of meshes) {
    if (!mesh.positions) continue;
    for (let i = 2; i < mesh.positions.length; i += 3)
      if (mesh.positions[i] < low) low = mesh.positions[i];
  }
  return Number.isFinite(low) ? low : null;
}

//! Which way a triangle faces and how steep it is, as the cosine of the angle
//! from horizontal. Facing down is not a floor however flat it is: that is a
//! ceiling, and the underside of the slab you are standing on.
function facing(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  // SIGNED, and this is the whole of a bug that put a crowd round the edge of
  // a floor plate and none of it on the plate.
  //
  // Take the absolute value and the UNDERSIDE of a slab counts as a floor. A
  // 120 mm slab then has two: the top at 120, and the soffit at 0. The lower
  // one wins, everybody is standing under the slab, the slab itself is in
  // their headroom - so every cell over the plate is blocked, and the only
  // walkable ground left is the strip around the outside. Which is exactly
  // where they were standing.
  //
  // A floor points up. A ceiling is not a floor however flat it is.
  return len > 1e-9 ? nz / len : 0;
}

//! Reads the walkable surface out of the triangles and into the grid.
//!
//! Two passes, and they cannot be one. The first finds the highest walkable
//! surface under the cut, for every cell. Only then is it possible to ask
//! whether anything stands in the headroom over that surface, which is what
//! makes a wall a wall - because "over" means over the floor, and the floor is
//! what the first pass just worked out.
//! A floor smaller than this is not a floor - it is the top of something. The
//! same number pruneIslands uses, because it is the same question.
const MIN_FLOOR = 4e6;

//! How many people this will ever hold at once, and it is a measured number
//! rather than a round one. The crowd step is a spatial hash rebuilt every
//! frame and a neighbour walk per person, and on the machine this was written
//! on it costs 2 ms at 600 people, 5.8 at 3000, 13 at 6000 and 32 at 12000 -
//! against a 16.6 ms budget for the WHOLE frame at 60 Hz, drawing included. So
//! four thousand is where it stops: past there the picture would still be
//! moving, but the clock on it would be a lie.
export const CROWD_LIMIT = 4000;

//! And how much tail the whole crowd gets between them, in line segments.
//! Twenty thousand is nine hundred people with the full twenty-three steps
//! each, which is what this drew before there were ever four thousand of them.
const TRAIL_SEGMENTS = 20000;

//! And how many to put on a plate that nobody has said a number for. Density,
//! not a count: sixty people is a busy room and an empty masterplan, and the
//! whole complaint about a 500 m site was that it looked deserted at the same
//! sixty. One person per ten square metres is a well-used public space, which
//! is what somebody opening the package wants to see.
export const peopleFor = area =>
  Math.max(20, Math.min(CROWD_LIMIT, Math.round(area / 1e8) * 10));

export function surfaceFrom(grid, meshes, options = {}) {
  // The mesh first, on its own terms: only what this storey actually has to
  // stand on, no borrowing and no invented ground.
  const read = readSurface(grid, meshes, options, false);
  if (read.standing * grid.cell * grid.cell >= MIN_FLOOR) return read;

  // Nothing to stand on. THEN the two rules for a model that drew no floor: a
  // floor above the cut is still a floor, and walls standing on nothing are
  // standing on the ground.
  return readSurface(grid, meshes, options, true);
}

function readSurface(grid, meshes, {
  cut = Infinity, slope = SLOPE_LIMIT, headroom = 2000, floors = null,
} = {}, lenient = false) {
  const surface = grid.surface, blocked = grid.blocked;
  surface.fill(NaN);
  blocked.fill(0);
  // The slope limit as a ratio becomes a limit on how much of the normal points
  // up: 1:8 is 7.1 degrees, and the cosine of that is what a triangle's normal
  // has to beat.
  const upright = 1 / Math.sqrt(1 + slope * slope);
  const under = floors && floors.length ? floors : meshes;
  let steep = 0, flat = 0, ceilings = 0;

  // Two answers per cell: the highest walkable surface at or under the cut, and
  // the lowest one above it. The cut is which storey you are standing on.
  const above = new Float32Array(surface.length).fill(NaN);
  let covered = 0;
  eachTriangle(under, (a, b, c) => {
    const up = facing(a, b, c);
    // Three answers, not two, because "not a floor" has two reasons and they
    // are worth telling apart: a soffit is not a steep floor, it is a ceiling.
    if (up <= 0) { ceilings++; return; }
    if (up < upright) { steep++; return; }
    flat++;
    overTriangle(grid, a, b, c, (k, z) => {
      if (z <= cut) {
        if (Number.isNaN(surface[k])) covered++;
        if (Number.isNaN(surface[k]) || z > surface[k]) surface[k] = z;
      } else if (Number.isNaN(above[k]) || z < above[k]) above[k] = z;
    });
  });

  // Where this storey HAS a floor, that floor is the whole of it: no triangle
  // under your feet means nothing under your feet. Assume ground beside a slab
  // that IS in the model and a 599 m2 plate comes back as 1038 m2 of walkable,
  // the extra 439 m2 being thin air off the edge - which is exactly where the
  // crowd was found standing.
  if (lenient) {
    // A storey whose floor is above the cut still has a floor. Refusing to see
    // it because a slider is in the wrong place is the interface arguing with
    // the geometry.
    for (let k = 0; k < surface.length; k++) {
      if (Number.isNaN(surface[k])) surface[k] = above[k];
      if (!Number.isNaN(surface[k])) covered++;
    }

    // Walls standing on nothing stand on the ground.
    //
    // A plan drawn as walls and furniture has no floor in it - the floor is the
    // ground they are sitting on, and it is not in the model because nobody
    // draws it. So where nothing walkable was found, the ground is assumed at
    // the lowest level of the model, which is what those walls are standing on.
    //
    // Only for a model that drew no floor, and a model that drew one drew most
    // of it: a plate covers its own extent, while wall tops and shelves cover a
    // few per cent of it.
    //
    // Never when somebody has NAMED the floor. Then a void is a void, and
    // ground under a lightwell would be a storey that is not there.
    const drew = covered > surface.length * 0.12;
    const ground = (floors && floors.length) || drew ? null : lowestOf(under);
    if (ground !== null)
      for (let k = 0; k < surface.length; k++)
        if (Number.isNaN(surface[k])) surface[k] = ground;
  }

  eachTriangle(meshes, (a, b, c) => {
    const blockIf = (k, z) => {
      const floor = surface[k];
      if (Number.isNaN(floor)) return;
      // 50 mm of tolerance so the floor does not obstruct itself, and a
      // person's height above it: anything in that band is in the way.
      if (z > floor + 50 && z < floor + headroom) blocked[k] = 1;
    };
    overTriangle(grid, a, b, c, blockIf);
    alongEdges(grid, a, b, c, blockIf);
  });

  // No triangle to stand on is not "blocked by something" - it is a void, the
  // edge of the world, the middle of an atrium. Either way nobody walks there.
  for (let k = 0; k < surface.length; k++)
    if (Number.isNaN(surface[k])) blocked[k] = 1;

  const islands = pruneIslands(grid);
  let standing = 0;
  for (let k = 0; k < surface.length; k++) if (!blocked[k]) standing++;
  return { steep, flat, ceilings, standing, islands };
}

//! A desk top is horizontal, so the triangles say you can stand on it. You
//! cannot: it is 720 mm up, nobody steps that far, and a floor plate with the
//! desks marked as walkable is a floor plate that has not understood desks.
//!
//! The test is size. A surface people use is metres across; a surface that is
//! a patch is furniture, a shelf, a plinth, the top of a wall. So the walkable
//! cells are gathered into connected pieces - connected meaning a step you
//! could actually take, which is where the climb limit comes in - and the
//! pieces too small to be a room are not floor.
export function pruneIslands(grid, minArea = 4e6) {
  const { width, height, blocked, surface, cell } = grid;
  const seen = new Int32Array(blocked.length).fill(-1);
  const pieces = [];
  const stack = [];
  for (let start = 0; start < blocked.length; start++) {
    if (blocked[start] || seen[start] >= 0) continue;
    const id = pieces.length;
    let count = 0;
    stack.push(start);
    seen[start] = id;
    while (stack.length) {
      const k = stack.pop();
      count++;
      const i = k % width, j = (k - i) / width;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
        const nk = nj * width + ni;
        if (blocked[nk] || seen[nk] >= 0) continue;
        // Connected means a step somebody could take. A 720 mm rise between
        // two cells is not two pieces of one floor, it is a floor and a desk.
        if (Math.abs(surface[nk] - surface[k]) > CLIMB) continue;
        seen[nk] = id;
        stack.push(nk);
      }
    }
    pieces.push(count);
  }
  const cells = Math.max(1, Math.ceil(minArea / (cell * cell)));
  let dropped = 0;
  for (let k = 0; k < blocked.length; k++) {
    if (blocked[k]) continue;
    if (pieces[seen[k]] >= cells) continue;
    blocked[k] = 1;
    dropped++;
  }
  return { pieces: pieces.length, dropped };
}

export function plateOf(meshes, cut, grain, {
  pad = 1000, include = [], maxCells, floors = [], slope = SLOPE_LIMIT, headroom = 2000,
} = {}) {
  // The plan extent of whatever can be a floor. With a Floor node that is the
  // named plates; without one it is everything, because anything with a
  // near-horizontal top is something somebody could stand on.
  const under = floors.length ? floors : meshes;
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], low = Infinity;
  for (const mesh of under) {
    if (!mesh.positions) continue;
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      lo = [Math.min(lo[0], mesh.positions[i]), Math.min(lo[1], mesh.positions[i + 1])];
      hi = [Math.max(hi[0], mesh.positions[i]), Math.max(hi[1], mesh.positions[i + 1])];
      low = Math.min(low, mesh.positions[i + 2]);
    }
  }
  if (!Number.isFinite(lo[0])) return null;
  const walls = { lo: [...lo], hi: [...hi] };
  for (const point of include) {
    lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
    hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
  }
  // A named floor ends where it ends: one cell of margin, no more, because the
  // triangles say where the edge is. Without one the ground is assumed under
  // the whole box, and the margin is what keeps a point asked for - the ends of
  // a walk, a portal - comfortably on the plate rather than on its boundary.
  const skirt = floors.length ? grain : Math.max(pad, grain * 2);
  const bounds = { lo: [lo[0] - skirt, lo[1] - skirt], hi: [hi[0] + skirt, hi[1] + skirt],
                   floor: Number.isFinite(low) ? low : 0 };
  const grid = makeGrid(bounds, grain, maxCells);

  const read = surfaceFrom(grid, meshes, { cut, slope, headroom, floors });
  // The lowest place anybody is standing, for the things that still want one
  // number: where the plan is drawn, how high the arrows float.
  let base = Infinity;
  for (let k = 0; k < grid.surface.length; k++)
    if (!grid.blocked[k] && grid.surface[k] < base) base = grid.surface[k];
  if (Number.isFinite(base)) grid.floor = base;

  clearanceOf(grid);

  // Where the floor actually is, which is not where the model is. Destinations
  // and spawns are spread over THIS box, so on a dome - walkable in the middle,
  // too steep at the edges - they land on the walkable cap rather than in the
  // ring of nothing around it, and a crowd that had nowhere to go now has four
  // corners to go to.
  let flo = [Infinity, Infinity], fhi = [-Infinity, -Infinity];
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++)
      if (!grid.blocked[j * grid.width + i]) {
        const [x, y] = toWorld(grid, i, j);
        flo = [Math.min(flo[0], x), Math.min(flo[1], y)];
        fhi = [Math.max(fhi[0], x), Math.max(fhi[1], y)];
      }
  const walkable = Number.isFinite(flo[0]) ? { lo: flo, hi: fhi } : walls;

  return {
    grid, read,
    // What to draw: the edge of the walkable surface, wherever it is - the
    // outside of the plate, the lip of a void, the face of a wall, the line
    // where a ramp turns into a climb. One rule, and it draws all of them.
    rings: maskOutline(grid),
    plate: floors.length ? floors.flatMap(floorRings) : [],
    carved: floors.length > 0,
    refused: false,
    inside: walkable,
    footprint: walls,
  };
}

//! The boundary of the walkable surface, as segments. Between a cell somebody
//! can stand in and one they cannot, whatever the reason - and the reason does
//! not matter to the line.
export function maskOutline(grid) {
  const out = [];
  const free = k => !grid.blocked[k];
  const half = grid.cell / 2;
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++) {
      const k = cellIndex(grid, i, j);
      if (!free(k)) continue;
      const [x, y] = toWorld(grid, i, j);
      if (i === 0 || !free(cellIndex(grid, i - 1, j)))
        out.push([[x - half, y - half], [x - half, y + half]]);
      if (i === grid.width - 1 || !free(cellIndex(grid, i + 1, j)))
        out.push([[x + half, y - half], [x + half, y + half]]);
      if (j === 0 || !free(cellIndex(grid, i, j - 1)))
        out.push([[x - half, y - half], [x + half, y - half]]);
      if (j === grid.height - 1 || !free(cellIndex(grid, i, j + 1)))
        out.push([[x - half, y + half], [x + half, y + half]]);
    }
  return out;
}

/* -------------------------------------------------------------- drivers */

function crowdDrivers(kit) {
  const K = kit.toolkit();

  //! The plate a node works over: the shapes wired into it, or every solid in
  //! the document when none are. Built per rebuild rather than cached, because
  //! that is exactly when the plan has changed.
  const plateFor = (f, key, cut, grain, include = []) => {
    const shapes = K.F.references(f, key).map(K.F.shape).filter(Boolean);
    if (!shapes.length) return null;
    const meshes = shapes.map(shape => K.tessellate(shape, 0));
    return plateOf(meshes, cut, grain, { include });
  };

  return {
    Portal: {
      precondition: f => K.readPoint(K.F.reference(f, "at")) ? null
        : "a Portal needs a point to stand at",
      build: f => {
        const at = K.readPoint(K.F.reference(f, "at"));
        const role = ROLES[K.F.choice(f, "role", 0)];
        const rate = K.F.real(f, "rate", 20);
        const width = K.F.real(f, "width", 1200);
        // Drawn as the width it is: a 900 door and a 3 m opening behave very
        // differently and should not look the same on the plan.
        const half = width / 2;
        const bar = K.hybrid.polyline([[at[0] - half, at[1], at[2]],
                                       [at[0] + half, at[1], at[2]]], false);
        return {
          shape: K.hybrid.join([bar, K.hybrid.pointVertex(at)]),
          data: { ...K.points([at]),
                  lines: [role, rate + " people a minute",
                          (width / 1000).toFixed(2) + " m clear"] },
        };
      },
    },

    //! A marker, not geometry. It builds nothing and consumes nothing - what it
    //! holds is a list of which features are the floor, and the Flow mode reads
    //! that list off the tree. Saying it as a node rather than as a setting is
    //! what makes it part of the model: it is in the file, it undoes, and the
    //! assistant can wire one.
    Floor: {
      precondition: f => K.F.references(f, "of").length ? null
        : "wire the floor plate into it - a sketch's face, a slab, or the face of "
          + "an imported extrusion",
      build: f => {
        const on = K.F.references(f, "of");
        const named = on.map(K.F.name);
        const built = on.filter(K.F.shape).length;
        return { data: K.text([
          named.length === 1 ? named[0] : named.length + " plates",
          built === on.length ? "people walk on this" : (on.length - built) + " not built yet",
          named.join(", "),
        ]) };
      },
    },

    WalkDistance: {
      precondition: f => {
        if (!K.readPoint(K.F.reference(f, "from"))) return "no point to walk from";
        if (!K.readPoint(K.F.reference(f, "to"))) return "no point to walk to";
        if (!K.F.references(f, "obstacles").length)
          return "wire in what to walk around - without obstacles this is a straight line";
        return null;
      },
      //! Through the plan, not through the walls. The same field the Flow view
      //! walks people down, so the number here and the route there agree.
      build: f => {
        const from = K.readPoint(K.F.reference(f, "from"));
        const to = K.readPoint(K.F.reference(f, "to"));
        const cut = K.F.real(f, "cut", 1100);
        const grain = K.F.real(f, "grain", 250);
        const plate = plateFor(f, "obstacles", cut, grain, [from, to]);
        if (!plate) throw new Error("nothing there has a footprint at " + cut + " mm");

        const field = flowField(plate.grid, [[to[0], to[1]]]);
        const walk = walkDistance(field, from[0], from[1]);
        const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
        if (walk === null)
          throw new Error("there is no way to walk between those two - "
            + (isBlocked(plate.grid, from[0], from[1]) ? "the start is inside something"
             : isBlocked(plate.grid, to[0], to[1]) ? "the end is inside something"
             : "they are in separate rooms"));

        // The route itself, walked downhill, so the number has a line you can
        // look at rather than being a number you have to believe.
        const lift = (x, y) => {
          const z = surfaceAt(plate.grid, x, y);
          return z === null ? plate.grid.floor : z;
        };
        const route = [[from[0], from[1], lift(from[0], from[1])]];
        let x = from[0], y = from[1];
        for (let step = 0; step < 4000; step++) {
          const way = downhill(field, x, y);
          if (!way) break;
          x += way[0] * grain * 0.7;
          y += way[1] * grain * 0.7;
          route.push([x, y, lift(x, y)]);
          if (walkDistance(field, x, y) < grain * 1.5) break;
        }
        route.push([to[0], to[1], lift(to[0], to[1])]);

        const minutes = walk / 1340 / 60;
        return {
          shape: K.hybrid.polyline(route, false),
          data: { ...K.numbers([walk, straight, walk / Math.max(1, straight)]),
                  lines: [
                    (walk / 1000).toFixed(2) + " m to walk",
                    (straight / 1000).toFixed(2) + " m as the crow flies",
                    "detour " + (walk / Math.max(1, straight)).toFixed(2) + "x",
                    minutes < 1 ? Math.round(minutes * 60) + " s at 1.34 m/s"
                                : minutes.toFixed(1) + " min at 1.34 m/s",
                  ] },
        };
      },
    },

    Isovist: {
      precondition: f => K.readPoint(K.F.reference(f, "at")) ? null
        : "an isovist needs a point to look from",
      build: f => {
        const at = K.readPoint(K.F.reference(f, "at"));
        const eye = K.F.real(f, "eye", 1200);
        const plate = plateFor(f, "obstacles", eye, 200, [at]);
        if (!plate) throw new Error("wire in what blocks the view");
        if (isBlocked(plate.grid, at[0], at[1]))
          throw new Error("that point is inside something - there is nothing to see");

        const seen = isovist(plate.grid, at[0], at[1],
          { rays: Math.round(K.F.real(f, "rays", 180)),
            reach: K.F.real(f, "reach", 40000) });
        const ring = seen.points.map(p => {
          const z = surfaceAt(plate.grid, p[0], p[1]);
          return [p[0], p[1], z === null ? plate.grid.floor : z];
        });
        // How round it is: a circle scores 1, a long corridor much less. The
        // number that says "enclosed" as against "open" without an opinion.
        const perimeter = ring.reduce((sum, p, i) => {
          const q = ring[(i + 1) % ring.length];
          return sum + Math.hypot(q[0] - p[0], q[1] - p[1]);
        }, 0);
        const compact = 4 * Math.PI * seen.area / Math.max(1, perimeter * perimeter);
        return {
          shape: K.hybrid.polyline(ring, true),
          data: { ...K.numbers([seen.area / 1e6, compact]),
                  lines: [(seen.area / 1e6).toFixed(1) + " m² visible",
                          "compactness " + compact.toFixed(2) + " (a circle is 1)",
                          "at " + (eye / 1000).toFixed(2) + " m eye height"] },
        };
      },
    },
  };
}

/* ---------------------------------------------------------- the ramps */

//! Crowding, in the colours everybody already reads: clear, then amber, then
//! red. Deliberately NOT the same ramp the Climate package uses - blue is cold
//! there and empty here, and two ramps that look alike and mean opposite
//! things is how a drawing gets misread.
const CROWD_RAMP = [
  [0.00, [0.16, 0.74, 0.62]], [0.30, [0.42, 0.80, 0.42]],
  [0.55, [0.96, 0.84, 0.26]], [0.75, [0.95, 0.55, 0.16]],
  [1.00, [0.83, 0.15, 0.20]],
];

export function crowdColour(t) {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < CROWD_RAMP.length; i++) {
    if (u > CROWD_RAMP[i][0]) continue;
    const [t0, a] = CROWD_RAMP[i - 1], [t1, b] = CROWD_RAMP[i];
    const k = t1 === t0 ? 0 : (u - t0) / (t1 - t0);
    return [0, 1, 2].map(c => a[c] + (b[c] - a[c]) * k);
  }
  return CROWD_RAMP[CROWD_RAMP.length - 1][1];
}

const rgbText = c => "rgb(" + c.map(v => Math.round(v * 255)).join(",") + ")";
const make = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const safe = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* --------------------------------------------------------- the Flow view */

class FlowView {
  constructor(kit) {
    this.kit = kit;
    this.on = false;
    this.running = true;
    this.cut = 1100;
    //! One in this many is the steepest a person will walk up rather than climb.
    this.slopeRatio = 8;
    // Whether the cut is where somebody put it, or still where it started. A
    // cut nobody has chosen follows the model in.
    this.cutChosen = false;
    this.span = null;
    this.grain = 250;
    // A crowd that is jammed from the first second shows you nothing except
    // that it is jammed: it starts where it flows, and you wind it up until it
    // stops, because the number where it stops is the answer you came for.
    // Where it starts is a density rather than a count, worked out from the
    // plate as soon as there is one - sixty people is a busy room and a
    // deserted masterplan.
    this.population = 60;
    this.peopleChosen = false;
    // When the floor's colours were last written. See paintHeat.
    this.heatAt = null;
    this.show = { agents: true, trails: true, density: true, field: false, plate: true };
    this.map = "footfall";               // which of the three the floor shows
    this.headings = new Float32Array(CROWD_LIMIT);
    this.plate = null;
    this.fields = [];
    this.portals = [];
    this.crowd = makeCrowd(CROWD_LIMIT);
    this.density = null;
    this.clock = 0;
    this.seed = 12345;
    this.build();
  }

  random = () => (this.seed = (this.seed * 48271) % 2147483647) / 2147483647;

  /* ------------------------------------------------------------ the DOM */

  build() {
    const { THREE } = this.kit;
    this.group = new THREE.Group();
    this.plateGroup = new THREE.Group();
    this.fieldGroup = new THREE.Group();
    this.group.add(this.plateGroup, this.fieldGroup);
    this.group.visible = false;
    this.kit.world.add(this.group);

    this.bar = make("section", "float fl-bar");
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <div class="fl-row">
        <span class="fl-tag">People</span>
        <input type="range" id="fl-people" min="0" max="600" step="10" value="60">
        <input type="number" class="fl-read fl-type" id="fl-people-read"
               min="0" step="10" value="60" aria-label="How many people">
        <button class="btn" id="fl-play">Pause</button>
        <button class="btn" id="fl-reset">Reset</button>
      </div>
      <div class="fl-row">
        <span class="fl-tag">Cut at</span>
        <input type="range" id="fl-cut" min="100" max="2400" step="50" value="1100">
        <span class="fl-read" id="fl-cut-read">1.10 m</span>
        <span class="fl-tag" style="width:auto">Grid</span>
        <input type="range" id="fl-grain" min="50" max="800" step="10" value="250">
        <input type="number" class="fl-read fl-type" id="fl-grain-read"
               min="10" step="10" value="250" aria-label="Grid spacing in millimetres">
        <span class="fl-unit">mm</span>
        <span class="fl-tag" style="width:auto">Walk up to 1:</span>
        <input type="number" class="fl-read fl-type" id="fl-slope"
               min="1" max="60" step="1" value="8" aria-label="Steepest walkable slope, as one in">
      </div>
      <div class="fl-row fl-toggles">
        <span class="fl-tag">Draw</span>
        <span class="seg" id="fl-show">
          <button data-show="plate" aria-pressed="true">plan</button>
          <button data-show="agents" aria-pressed="true">people</button>
          <button data-show="trails" aria-pressed="true">trails</button>
          <button data-show="field" aria-pressed="false">routes</button>
        </span>
        <span class="seg" id="fl-map">
          <button data-map="footfall" aria-pressed="true">movement</button>
          <button data-map="occupancy" aria-pressed="false">concentration</button>
          <button data-map="live" aria-pressed="false">right now</button>
          <button data-map="off" aria-pressed="false">off</button>
        </span>
        <button class="btn" id="fl-plan">Plan view</button>
        <span class="fl-note" id="fl-note"></span>
      </div>`;
    document.body.appendChild(this.bar);

    this.panel = make("aside", "float fl-panel");
    this.panel.hidden = true;
    document.body.appendChild(this.panel);

    this.wire();
    this.makeDrawing();
  }

  wire() {
    const q = id => this.bar.querySelector("#" + id);
    // A number of people is a decision about the study, not a range somebody
    // else chose: a 500 m masterplan at sixty people is a deserted masterplan.
    // So the slider's top end follows the plate - what a well-used floor of
    // this size holds - and the field beside it takes anything up to the limit
    // this can actually step in a frame, which is CROWD_LIMIT and is the only
    // hard stop here.
    const setPeople = (many, fromField) => {
      const wanted = Math.max(0, Math.min(CROWD_LIMIT, Math.round(Number(many) || 0)));
      this.population = wanted;
      this.peopleChosen = true;
      const slider = q("fl-people");
      if (wanted > Number(slider.max)) slider.max = String(wanted);
      slider.value = String(wanted);
      if (!fromField) q("fl-people-read").value = String(wanted);
      this.refresh();
    };
    q("fl-people").addEventListener("input", e => setPeople(e.target.value, false));
    q("fl-people-read").addEventListener("change", e => setPeople(e.target.value, true));
    q("fl-people-read").addEventListener("keydown", e => e.stopPropagation());
    q("fl-cut").addEventListener("input", e => {
      this.cut = +e.target.value;
      // Moved by hand: from here it stays where it was put, and only a model
      // that no longer reaches it moves it again.
      this.cutChosen = true;
      q("fl-cut-read").textContent = (this.cut / 1000).toFixed(2) + " m";
      this.queueRebuild();
    });
    // Typed rather than dragged: any spacing at all, from a hundred millimetres
    // to twenty metres. The slider is for adjusting what is there, so its top
    // end follows whatever was typed rather than capping it - a slider that
    // will not go where the work needs it is a slider in the way.
    const setGrain = (mm, fromField) => {
      const wanted = Math.max(10, Math.round(Number(mm) || 0));
      this.grain = wanted;
      const slider = q("fl-grain");
      if (wanted > Number(slider.max)) slider.max = String(wanted);
      if (wanted < Number(slider.min)) slider.min = String(wanted);
      slider.value = String(wanted);
      if (!fromField) q("fl-grain-read").value = String(wanted);
      this.queueRebuild();
    };
    // Steepness, as a ramp is written on a drawing: 1 in 8. Past about there a
    // person is climbing, and where that line falls is a judgement about the
    // building - a hospital wants 1:20, a hillside path will take 1:5 - so it
    // is a number somebody sets rather than one baked in here.
    q("fl-slope").addEventListener("change", e => {
      this.slopeRatio = Math.max(1, Math.round(Number(e.target.value) || 8));
      e.target.value = String(this.slopeRatio);
      this.queueRebuild();
    });
    q("fl-slope").addEventListener("keydown", e => e.stopPropagation());
    q("fl-grain-read").addEventListener("change", e => setGrain(e.target.value, true));
    q("fl-grain-read").addEventListener("keydown", e => e.stopPropagation());
    q("fl-grain").addEventListener("input", e => {
      this.grain = Math.max(10, +e.target.value);
      q("fl-grain-read").value = String(this.grain);
      this.queueRebuild();
    });
    q("fl-play").addEventListener("click", e => {
      this.running = !this.running;
      e.target.textContent = this.running ? "Pause" : "Play";
    });
    q("fl-reset").addEventListener("click", () => this.reset());
    q("fl-show").addEventListener("click", e => {
      const button = e.target.closest("[data-show]");
      if (!button) return;
      const key = button.dataset.show;
      this.show[key] = !this.show[key];
      button.setAttribute("aria-pressed", this.show[key] ? "true" : "false");
      this.applyVisibility();
    });
    q("fl-map").addEventListener("click", e => {
      const button = e.target.closest("[data-map]");
      if (!button) return;
      this.map = button.dataset.map;
      this.show.density = this.map !== "off";
      for (const other of q("fl-map").querySelectorAll("[data-map]"))
        other.setAttribute("aria-pressed", other.dataset.map === this.map ? "true" : "false");
      this.applyVisibility();
      this.paintHeat(true);
      this.refresh();
    });
    q("fl-plan").addEventListener("click", () => this.planView());
  }

  /* -------------------------------------------------------- the drawing */

  makeDrawing() {
    const { THREE } = this.kit;
    this.makePeople();

    // Trails: where everybody has just been, as a fading ribbon per person.
    this.trailLength = 24;
    const trail = new THREE.BufferGeometry();
    trail.setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(CROWD_LIMIT * this.trailLength * 3), 3));
    trail.setAttribute("color",
      new THREE.BufferAttribute(new Float32Array(CROWD_LIMIT * this.trailLength * 3), 3));
    trail.setDrawRange(0, 0);
    this.trails = new THREE.LineSegments(trail, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.trails.renderOrder = 11;
    this.group.add(this.trails);
    this.history = new Float32Array(CROWD_LIMIT * this.trailLength * 2);
    this.historyAt = 0;
  }

  //! People, one instanced mesh per STATE rather than one mesh with a colour
  //! per person. Per-instance colour is a define the renderer decides on at
  //! compile time, and a colour buffer created after the first frame does not
  //! always earn it - so this uses nothing but a material colour, which cannot
  //! fail. It is better design as well as safer: five named states can go in a
  //! legend, and a continuous ramp over speed cannot.
  makePeople() {
    const { THREE } = this.kit;
    const person = mergedPerson(THREE);
    this.bodies = { fine: person, coarse: mergedPerson(THREE, true) };
    this.bodyNow = "fine";
    this.states = [
      { key: "walking",  colour: 0x2fa88d, says: "walking freely" },
      { key: "slowed",   colour: 0x9fd14e, says: "slowed by the crowd" },
      { key: "queueing", colour: 0xf0a52a, says: "queueing - shuffling forward" },
      { key: "stopped",  colour: 0xd4372f, says: "stopped - not moving at all" },
      { key: "waiting",  colour: 0x5b8fc7, says: "at a destination" },
      { key: "cut",      colour: 0x8a3ec0, says: "cannot reach anywhere" },
    ];
    this.crowdMeshes = this.states.map(state => {
      // FLAT, not lit: the colour of a person carries data here, and a shaded
      // body is darker on one side, which corrupts the very thing being read.
      const mesh = new THREE.InstancedMesh(person,
        new THREE.MeshBasicMaterial({ color: state.colour }), CROWD_LIMIT);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
    this.spot = new THREE.Object3D();
    this.headings = new Float32Array(CROWD_LIMIT);
  }

  //! The crowding map, as a texture on a plane rather than a mesh per cell:
  //! twenty thousand cells is twenty thousand quads, and it is one upload.
  makePlate() {
    const { THREE } = this.kit;
    this.heatAt = null;                        // a new plate is a new texture
    while (this.plateGroup.children.length) {
      const child = this.plateGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
    if (!this.plate) return;
    const { grid } = this.plate;
    const w = grid.width, h = grid.height;

    this.pixels = new Uint8Array(w * h * 4);
    const texture = new THREE.DataTexture(this.pixels, w, h, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    this.heat = texture;

    // Drawn ON the surface, not on one flat plane over it. A ramp, a terrace or
    // the floor of a bowl has a different height every metre, and a heat map
    // floating above it at one level is a heat map of somewhere else.
    //
    // The display mesh is capped at 160 squares a side however fine the
    // simulation grid is: a quarter of a million vertices is a quarter of a
    // million vertices, and the texture carries the detail anyway.
    const steps = [Math.min(w, 160), Math.min(h, 160)];
    const geometry = new THREE.PlaneGeometry(w * grid.cell, h * grid.cell,
                                             steps[0], steps[1]);
    const at = geometry.attributes.position;
    const across = w * grid.cell, down = h * grid.cell;
    for (let v = 0; v < at.count; v++) {
      const x = grid.lo[0] + across / 2 + at.getX(v);
      const y = grid.lo[1] + down / 2 + at.getY(v);
      const z = surfaceAt(grid, x, y);
      at.setZ(v, (z === null ? grid.floor : z) - grid.floor + 2);
    }
    at.needsUpdate = true;
    geometry.computeVertexNormals();
    const plane = new THREE.Mesh(geometry,
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false,
                                    side: THREE.DoubleSide }));
    plane.position.set(grid.lo[0] + across / 2, grid.lo[1] + down / 2, grid.floor);
    plane.renderOrder = 10;
    this.plateGroup.add(plane);
    this.heatPlane = plane;

    // The plan itself, as the outlines the footprints really are - drawn from
    // the rings rather than from the raster, so a wall is a line and not a
    // staircase.
    const points = [];
    const lift = p => {
      const z = surfaceAt(grid, p[0], p[1]);
      return new THREE.Vector3(p[0], p[1], (z === null ? grid.floor : z) + 6);
    };
    for (const ring of this.plate.rings) {
      // A two-point ring is a segment: the mask outline comes as segments, and
      // wrapping one round on itself draws it twice.
      const last = ring.length === 2 ? 1 : ring.length;
      for (let i = 0; i < last; i++)
        points.push(lift(ring[i]), lift(ring[(i + 1) % ring.length]));
    }
    const outline = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x22303c, transparent: true, opacity: 0.9 }));
    outline.renderOrder = 13;
    this.plateGroup.add(outline);
    this.outline = outline;
    this.applyVisibility();
  }

  //! Where the routes go, as arrows on the field. Off by default because it is
  //! a lot of lines - but it is the picture that says WHY the crowd goes where
  //! it goes, which the people alone never quite do.
  makeField() {
    const { THREE } = this.kit;
    while (this.fieldGroup.children.length) {
      const child = this.fieldGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    if (!this.plate || !this.fields.length || !this.show.field) return;
    const { grid } = this.plate;
    const every = Math.max(1, Math.round(1200 / grid.cell));
    const points = [], colours = [];
    for (let j = 0; j < grid.height; j += every)
      for (let i = 0; i < grid.width; i += every) {
        if (grid.blocked[j * grid.width + i]) continue;
        const [x, y] = toWorld(grid, i, j);
        const way = downhill(this.fields[0], x, y);
        if (!way) continue;
        const reach = grid.cell * every * 0.42;
        const tip = [x + way[0] * reach, y + way[1] * reach];
        const on = surfaceAt(grid, x, y);
        const z = (on === null ? grid.floor : on) + 4;
        points.push(new THREE.Vector3(x - way[0] * reach, y - way[1] * reach, z),
                    new THREE.Vector3(tip[0], tip[1], z));
        // Dark at the destination, light far from it: the field's own gradient
        // read as a picture.
        const far = Math.min(1, walkDistance(this.fields[0], x, y) / 40000);
        for (let n = 0; n < 2; n++) colours.push(0.35 + far * 0.3, 0.45 + far * 0.25, 0.55);
      }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    const arrows = new THREE.LineSegments(geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 }));
    arrows.renderOrder = 9;
    this.fieldGroup.add(arrows);
  }

  applyVisibility() {
    if (this.heatPlane) this.heatPlane.visible = this.show.density;
    if (this.outline) this.outline.visible = this.show.plate;
    for (const mesh of this.crowdMeshes) mesh.visible = this.show.agents;
    this.trails.visible = this.show.trails;
    this.fieldGroup.visible = this.show.field;
    if (this.show.field && !this.fieldGroup.children.length) this.makeField();
    this.kit.draw();
  }
}

//! ---- the simulation, on the class ----
Object.assign(FlowView.prototype, {

  //! Read the plan out of the model and the portals out of the document, then
  //! sweep the field. This is what runs when you move a desk, and it is one
  //! Dijkstra - which is why it can run while you are still dragging.
  rebuild() {
    const features = this.kit.tree().features || [];
    // What somebody said is the floor. Everything else that can be cut is an
    // obstacle, which is the right assumption for a plan drawn in walls and the
    // wrong one for a plate drawn as a face - so the Floor node exists to say
    // which, and nothing here guesses.
    const isFloor = new Set();
    for (const f of features)
      if (f.type === "Floor")
        for (const id of (f.lists && f.lists.of) || []) isFloor.add(id);

    const meshes = [], floors = [];
    for (const [id, mesh] of this.kit.streams()) {
      const entry = features.find(f => f.id === id);
      if (!entry || this.kit.hidden().has(id)) continue;
      // A body a boolean has swallowed is not in the room any more. It is still
      // in the tree, and its triangles are still in the stream, so without this
      // the wall that was fused into another wall blocks the floor twice.
      if (entry.consumedBy || entry.visible === false) continue;
      if (!(mesh.positions && mesh.index)) continue;
      // A floor is a floor even when it is a datum plane or a sketch face,
      // which is why this test comes before the ones that throw those away.
      if (isFloor.has(id)) { floors.push(mesh); continue; }
      if (entry.category === "datum") continue;
      if (entry.type === "Portal" || entry.type === "Floor") continue;
      meshes.push(mesh);
    }
    this.portals = features
      .filter(f => f.type === "Portal" && f.data && f.data.preview)
      .map(f => {
        const said = String(f.data.preview);
        const at = said.replace(/[()]/g, "").split(",").map(Number);
        // A desk or a tea point is somewhere people STAY; an exit is somewhere
        // they leave by. The dwell is what puts the heat on an occupancy map.
        const dwell = /Desk/.test(said) ? 90 : /Amenity/.test(said) ? 40
                    : /Core/.test(said) ? 12 : 0;
        return { id: f.id, name: f.name, at, dwell,
                 role: /Exit|Amenity|Core|Desk/.test(said) ? "to" : "from" };
      })
      .filter(p => p.at.length >= 2 && p.at.every(Number.isFinite));

    // Where the model actually is, before anything is cut through it. A part
    // drawn here sits on z = 0; a building imported from a STEP file sits where
    // its file says it sits, which may be four metres up or a hundred - and a
    // cut fixed between 0.1 and 2.4 m would never touch it.
    this.span = zSpan(meshes);
    this.rangeCut();

    // One Dijkstra sweep runs per destination, so what a rebuild costs is cells
    // times fields - and the grid is sized against that rather than against
    // cells alone. A plate with twenty places to walk to gets a coarser grid
    // than the same plate with one, because it is doing twenty times the work.
    const sweeps = Math.max(1, this.portals.filter(p => p.role === "to").length || 4);
    this.plate = (meshes.length || floors.length)
      ? plateOf(meshes, this.cut, this.grain,
                { include: this.portals.map(p => [p.at[0], p.at[1]]),
                  maxCells: cellsAllowed(sweeps), floors,
                  slope: 1 / Math.max(1, this.slopeRatio) })
      : null;
    const note = this.bar.querySelector("#fl-note");
    if (!this.plate) {
      this.fields = [];
      // Say where the model is, not just that the cut missed it. "Nothing at
      // this height" with no heights in it is the least useful true sentence
      // an interface can produce.
      note.textContent = meshes.length || floors.length
        ? "nothing in this model can be walked on"
          + (this.span ? " - it spans " + (this.span[0] / 1000).toFixed(2) + " to "
              + (this.span[1] / 1000).toFixed(2) + " m" : "")
          + ". Every face is either steeper than 1:" + this.slopeRatio
          + ", facing down, or has something standing on it"
        : "nothing in the model to walk on";
      this.floorHint(note, meshes, floors);
      this.goals = [];
      this.makePlate();
      return;
    }
    this.density = makeDensity(this.plate.grid);
    // The traces are about a floor. Change the floor and what was worn into
    // the old one is about a plan that no longer exists.
    if (!this.trace || this.trace.footfall.length !== this.plate.grid.blocked.length)
      this.trace = makeTrace(this.plate.grid);

    // ONE FIELD PER DESTINATION, not one field to a single drain. That is what
    // makes the flows cross: somebody heading for the tea point and somebody
    // heading for the lifts meet in the corridor, and the place they meet is
    // the finding. A single shared destination gives a river, and a river tells
    // you nothing about a floor plate.
    this.goals = this.goalList();
    this.fields = this.goals.map(goal => flowField(this.plate.grid, goal.at));
    this.floors = floors.length;
    const grid = this.plate.grid;
    // A grid coarser than the thing it is measuring is not a measurement. It
    // is allowed - a masterplan may want twenty metres - but a floor that came
    // out as four cells should say so rather than reporting nought square
    // metres as if the building had vanished.
    if (grid.width * grid.height < 24) {
      this.fields = [];
      this.goals = [];
      note.textContent = "the grid is coarser than the floor - " + grid.cell
        + " mm cells over " + Math.round(grid.width * grid.cell / 1000) + " × "
        + Math.round(grid.height * grid.cell / 1000) + " m is "
        + (grid.width * grid.height) + " cells. Type a smaller spacing.";
      this.makePlate();
      return;
    }
    // How many people this floor is worth, now that its size is known. The
    // slider's top end is what a well-used floor of this size holds - three
    // times the default, so there is room to crowd it - and the number itself
    // follows the area until somebody sets one, because sixty people is a busy
    // room and a deserted masterplan and it should not be both.
    this.sizeCrowd();

    note.textContent = (this.walkableArea() / 1e6).toFixed(0) + " m² walkable · "
      + (this.plate.plate && this.plate.plate.length
          ? this.plate.plate.length === 1 ? "1 floor plate"
            : "1 floor plate with " + (this.plate.plate.length - 1)
              + (this.plate.plate.length === 2 ? " opening" : " openings")
          : "read off the mesh")

      + " · " + this.goals.length + (this.goals.length === 1 ? " destination" : " destinations")
      + (this.portals.length ? "" : ", the corners of the floor")
      // Said when it happens, because a grid that quietly refused what was
      // asked of it is a measurement of something else.
      // What the mesh gave and what it refused. An import that comes out with
      // no floor at all is usually all-steep or all-ceiling, and knowing which
      // is the difference between a bug and a model.
      + (this.plate.read && this.plate.read.steep
          ? " · " + this.plate.read.steep + " faces steeper than 1:" + this.slopeRatio
          : "")
      + (this.plate.read && this.plate.read.islands && this.plate.read.islands.dropped
          ? " · " + this.plate.read.islands.dropped + " cells of desk and shelf tops "
            + "dropped - horizontal, but nobody steps 300 mm up"
          : "")
      + (this.plate.refused
          ? " · the floor outline could not be read - it left nowhere to stand, so it is "
            + "being treated as an obstacle again. Wire the Floor node to the face or the "
            + "slab itself rather than to a whole building"
          : "")
      + (grid.coarsened
          ? " · grid " + grid.cell + " mm, not the " + grid.asked + " mm asked for: "
            + (grid.width * grid.height / 1000).toFixed(0) + "k cells is what this plate can "
            + "carry with " + this.goals.length
            + (this.goals.length === 1 ? " destination" : " destinations") + " to sweep"
          : "");
    this.makePlate();
    this.makeField();
    this.rescue();
    this.trim();
  },

  //! Nobody stands in a wall, over a void, or off the edge of the plate.
  //!
  //! The step already refuses a move into a blocked cell, so this is not about
  //! walking - it is about the floor changing under somebody. Move a desk onto
  //! a person, cut the plate smaller, drop the cut through a different storey,
  //! and whoever was standing there is now inside something. They are put on
  //! the nearest free cell, and if there is not one within reach they are taken
  //! off the floor rather than left hovering.
  rescue() {
    if (!this.plate || !this.crowd) return;
    const { grid } = this.plate;
    let moved = 0;
    for (let a = this.crowd.count - 1; a >= 0; a--) {
      if (!isBlocked(grid, this.crowd.x[a], this.crowd.y[a])) continue;
      const spot = this.nearestFreeAt([this.crowd.x[a], this.crowd.y[a]]);
      if (spot) {
        this.crowd.x[a] = spot[0];
        this.crowd.y[a] = spot[1];
        this.crowd.vx[a] = this.crowd.vy[a] = 0;
        moved++;
      } else removeWalker(this.crowd, a);
    }
    return moved;
  },

  //! The cut slider's range follows the model rather than the other way round.
  //! Everything about a floor plate is a height, and a height means nothing
  //! without knowing where the floor is - so the ends of the slider are the top
  //! and bottom of what is in the scene, and the first cut is a metre and a
  //! tenth above the lowest thing in it, which is where a person's shoulders
  //! are.
  //! Said when the plate came out empty and a Floor node is what is missing. A
  //! solid cut through the middle is solid, and if that solid IS the floor the
  //! only thing wrong is that nobody said so.
  floorHint(note, meshes, floors) {
    if (floors.length || !meshes.length) return;
    note.textContent += " · if what you are cutting IS the floor - a slab, or a "
      + "sketch's face - add a Floor node and wire it in, and its outline becomes "
      + "the edge of the plate rather than an obstacle";
  },

  //! One rebuild a frame, however many times a slider says it moved. Dragging
  //! fires an event per pixel, and a rebuild of a masterplan is a hundred and
  //! seventy milliseconds - so without this the drag is the rebuild queue and
  //! the page stops answering.
  queueRebuild() {
    if (this.rebuildQueued) return;
    this.rebuildQueued = requestAnimationFrame(() => {
      this.rebuildQueued = 0;
      if (this.on) this.rebuild();
    });
  },

  rangeCut() {
    const slider = this.bar.querySelector("#fl-cut");
    const read = this.bar.querySelector("#fl-cut-read");
    if (!this.span) return;
    const [lo, hi] = this.span;
    // Head height above the top of the model, not the top of it: a 120 mm slab
    // spans 120 mm, and a cut that can only be inside those 120 mm can only
    // ever be inside the slab.
    const min = Math.round(lo), max = Math.round(hi + 2000);
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(Math.max(10, Math.round((max - min) / 200)));
    // Snapped on the way in, and again if the model moved out from under the
    // cut. A cut the person chose inside the model is left alone.
    if (!this.cutChosen || this.cut < min || this.cut > max) {
      this.cut = Math.min(max, Math.max(min, Math.round(lo + 1100)));
      this.cutChosen = true;
    }
    slider.value = String(this.cut);
    read.textContent = (this.cut / 1000).toFixed(2) + " m";
  },

  //! Walkable floor INSIDE the footprints - the number a schedule of areas
  //! would recognise. The padded grid outside the building is not floor.
  //! Every cell somebody could stand in. Counted off the grid rather than
  //! sampled over a box, because the walkable surface is the grid now.
  //! The people control, sized to the plate. Never past CROWD_LIMIT, which is
  //! what a frame can actually step - a slider that can be dragged into a
  //! freeze is a slider that lies about what the software does.
  sizeCrowd() {
    const slider = this.bar.querySelector("#fl-people");
    const field = this.bar.querySelector("#fl-people-read");
    if (!slider || !field) return;
    const many = peopleFor(this.walkableArea());
    slider.max = String(Math.min(CROWD_LIMIT, Math.max(200, many * 3)));
    field.max = String(CROWD_LIMIT);
    if (this.peopleChosen) {
      // Somebody's own number, kept - but not past what this can step.
      this.population = Math.min(this.population, CROWD_LIMIT);
    } else {
      this.population = many;
    }
    slider.value = String(Math.min(this.population, Number(slider.max)));
    field.value = String(this.population);
  },

  walkableArea() {
    if (!this.plate) return 0;
    const { grid } = this.plate;
    let cells = 0;
    for (let k = 0; k < grid.blocked.length; k++) if (!grid.blocked[k]) cells++;
    return cells * grid.cell * grid.cell;
  },

  //! Everywhere anybody might be heading, one entry per place. A portal is one
  //! goal; with no portals placed, the four corners of the floor - so opening
  //! the mode on any plan immediately shows people crossing it, which is the
  //! thing you wanted to look at, rather than an empty room and a form to fill
  //! in first.
  goalList() {
    if (!this.plate) return [];
    const { grid, inside } = this.plate;
    const going = this.portals.filter(p => p.role === "to");
    if (going.length)
      return going.map(p => ({ name: p.name, dwell: p.dwell, at: [[p.at[0], p.at[1]]] }));

    const corners = [];
    const span = [inside.hi[0] - inside.lo[0], inside.hi[1] - inside.lo[1]];
    for (const [fx, fy, name] of [[0.12, 0.12, "south-west"], [0.88, 0.12, "south-east"],
                                  [0.88, 0.88, "north-east"], [0.12, 0.88, "north-west"]]) {
      const want = [inside.lo[0] + span[0] * fx, inside.lo[1] + span[1] * fy];
      const spot = isBlocked(grid, want[0], want[1]) ? this.nearestFreeAt(want) : want;
      if (spot) corners.push({ name, dwell: 6, at: [spot] });
    }
    return corners;
  },

  nearestFreeAt(want) {
    const { grid } = this.plate;
    const [i, j] = toCell(grid, want[0], want[1]);
    // As far as the grid goes. Stopping at forty cells was a limit of 10 m on a
    // 250 mm grid, and on a plate whose walkable part is a cap in the middle of
    // a much larger model that is not far enough to find it.
    const reach = grid.width + grid.height;
    for (let r = 1; r < reach; r++)
      for (let d = 0; d < 8 * r; d++) {
        const angle = d / (8 * r) * Math.PI * 2;
        const ni = i + Math.round(Math.cos(angle) * r), nj = j + Math.round(Math.sin(angle) * r);
        if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) continue;
        if (!grid.blocked[nj * grid.width + ni]) return toWorld(grid, ni, nj);
      }
    return null;
  },

  //! Where somebody goes when they get where they were going. Anywhere but
  //! here, and they stop for a bit when they arrive - because a person at a
  //! desk is what an occupancy map is made of, and a floor where everybody
  //! leaves the moment they arrive is a drain rather than a building.
  somewhereElse(a, now) {
    if (this.goals.length < 2) return null;
    let goal = this.crowd.goal[a];
    for (let tries = 0; tries < 8 && goal === this.crowd.goal[a]; tries++)
      goal = Math.floor(this.random() * this.goals.length);
    const stay = this.goals[this.crowd.goal[a]].dwell || 0;
    return { goal, dwell: stay * (0.4 + this.random() * 1.6) };
  },

  //! Where people come from: Entrance and Desk portals, or anywhere free.
  spawn() {
    if (!this.plate) return null;
    const { grid } = this.plate;
    const coming = this.portals.filter(p => p.role === "from");
    if (coming.length) {
      const pick = coming[Math.floor(this.random() * coming.length)];
      const spread = 1500;
      for (let tries = 0; tries < 24; tries++) {
        const x = pick.at[0] + (this.random() - 0.5) * spread;
        const y = pick.at[1] + (this.random() - 0.5) * spread;
        if (isBlocked(grid, x, y)) continue;
        if (this.density && densityAt(this.density, grid, x, y) > 1.2e-6) continue;
        return [x, y];
      }
      return null;
    }
    // Anywhere on the floor, not in one corner of it. With several
    // destinations the interesting thing is people crossing, and a crowd that
    // all starts in the same third spends its first minute being a queue.
    // Not on top of somebody who is already there, either: a spawn that
    // ignores the crowd packs people past jam density.
    const { inside } = this.plate;
    for (let tries = 0; tries < 80; tries++) {
      const x = inside.lo[0] + this.random() * (inside.hi[0] - inside.lo[0]);
      const y = inside.lo[1] + this.random() * (inside.hi[1] - inside.lo[1]);
      if (isBlocked(grid, x, y)) continue;
      // Somewhere they can actually get somewhere from - when there is anywhere
      // to get to. A plate with no destinations on it yet is still a plate to
      // stand on, and walkDistance of a field that does not exist is a crash.
      if (this.fields.length && walkDistance(this.fields[0], x, y) === null) continue;
      if (this.density && densityAt(this.density, grid, x, y) > 1.2e-6) continue;
      return [x, y];
    }
    return null;
  },

  //! Top the crowd back up to the number asked for, and let go of anybody over
  //! it. People arriving are removed by the step, so this is what keeps a
  //! steady state rather than a wave.
  trim() {
    if (!this.plate || !this.fields.length) return;
    while (this.crowd.count > this.population) {
      const at = Math.floor(this.random() * this.crowd.count);
      this.crowd.x[at] = this.crowd.x[this.crowd.count - 1];
      this.crowd.y[at] = this.crowd.y[this.crowd.count - 1];
      this.crowd.count--;
    }
    let guard = 0;
    while (this.crowd.count < this.population && guard++ < 200) {
      const at = this.spawn();
      if (!at) break;
      // Sent to the destination they are FURTHEST from, so a new arrival has a
      // journey to make rather than being spawned on top of where they were
      // going and counted as having walked 1.6 m.
      let goal = 0, best = -Infinity;
      for (let g = 0; g < this.fields.length; g++) {
        const how = walkDistance(this.fields[g], at[0], at[1]);
        const wish = how === null ? -1 : how * (0.6 + this.random() * 0.8);
        if (wish > best) { best = wish; goal = g; }
      }
      addWalker(this.crowd, at[0], at[1], goal, this.clock, this.random);
    }
  },

  reset() {
    this.crowd = makeCrowd(CROWD_LIMIT);
    this.clock = 0;
    this.heatAt = null;                        // the clock went back; paint again
    this.sinceDensity = 0;
    this.historyAt = 0;
    this.history.fill(0);
    if (this.density) { this.density.peak.fill(0); this.density.seen.fill(0); this.density.seconds = 0; }
    if (this.plate) this.trace = makeTrace(this.plate.grid);
    this.trim();
    this.refresh();
  },

  //! One frame. Everything that moves, moves here.
  tick(dt) {
    if (!this.on || !this.plate || !this.fields.length) return;
    if (this.running) {
      const step = Math.min(0.05, dt);
      this.clock += step;
      // The crowding field, and it is the other cost that is the size of the
      // PLATE rather than of the crowd: a clear, two blur passes and a divide
      // over every cell, which on a quarter of a million of them is 10 ms a
      // frame whether there are two hundred people out there or four thousand.
      // Nobody's speed changes in a sixtieth of a second because of how close
      // somebody is standing, so on a plate that size it is measured ten times
      // a second instead of sixty - with the elapsed time, so the seconds it
      // integrates are still real seconds.
      const cells = this.plate.grid.width * this.plate.grid.height;
      const every = Math.min(0.2, cells / 2.5e6);
      this.sinceDensity = (this.sinceDensity || 0) + step;
      if (this.sinceDensity >= every) {
        measureDensity(this.density, this.crowd, this.plate.grid, this.sinceDensity);
        this.sinceDensity = 0;
      }
      stepCrowd(this.crowd, this.fields, this.plate.grid, this.density, step, this.clock,
        { trace: this.trace, recycle: (a, now) => this.somewhereElse(a, now) });
      this.trim();
      this.remember();
    }
    this.paintPeople();
    this.paintHeat();
    if (this.running && Math.floor(this.clock * 2) !== this.lastReport) {
      this.lastReport = Math.floor(this.clock * 2);
      this.refresh();
    }
  },

  remember() {
    const n = this.trailLength;
    this.historyAt = (this.historyAt + 1) % n;
    for (let a = 0; a < this.crowd.count; a++) {
      const at = (a * n + this.historyAt) * 2;
      this.history[at] = this.crowd.x[a];
      this.history[at + 1] = this.crowd.y[a];
    }
  },

  paintPeople() {
    const { grid } = this.plate;
    const base = grid.floor;
    const buckets = this.states.map(() => 0);
    for (let a = 0; a < this.crowd.count; a++) {
      const going = Math.hypot(this.crowd.vx[a], this.crowd.vy[a]);
      const share = going / Math.max(1, this.crowd.free[a]);
      // Which state, in the order somebody reading the floor would ask:
      // can they get anywhere at all, are they waiting on purpose, and only
      // then how well they are moving.
      const cut = stranded(this.fields[this.crowd.goal[a]] || this.fields[0],
                           grid, this.crowd.x[a], this.crowd.y[a]);
      // The bands are tied to the shuffle floor rather than to round numbers:
      // somebody moving at the floor is shuffling in a queue, which is what
      // Fruin's F band IS, and calling that "stopped" reports a slow queue as
      // a deadlock.
      const at = cut ? 5
        : this.clock < this.crowd.until[a] ? 4
        : share > 0.75 ? 0 : share > 0.40 ? 1 : share > SHUFFLE * 1.35 ? 2 : 3;

      // Feet on the surface they are standing on, which on a ramp, a terrace
      // or the floor of a bowl is a different height every step.
      const under = surfaceAt(grid, this.crowd.x[a], this.crowd.y[a]);
      this.spot.position.set(this.crowd.x[a], this.crowd.y[a],
                             under === null ? base : under);
      // Facing where they are going, and holding the last heading when they
      // stop - somebody standing still is facing somewhere, not north.
      if (going > 20) this.headings[a] = Math.atan2(this.crowd.vy[a], this.crowd.vx[a]);
      this.spot.rotation.set(0, 0, (this.headings[a] || 0) - Math.PI / 2);
      this.spot.updateMatrix();
      const mesh = this.crowdMeshes[at];
      if (buckets[at] < mesh.instanceMatrix.count)
        mesh.setMatrixAt(buckets[at]++, this.spot.matrix);
    }
    this.tally = buckets;
    // The cheaper body once there are more of them than there are pixels to
    // tell them apart with.
    const want = this.crowd.count > 1200 ? "coarse" : "fine";
    if (this.bodies && want !== this.bodyNow) {
      this.bodyNow = want;
      for (const mesh of this.crowdMeshes) mesh.geometry = this.bodies[want];
    }
    this.crowdMeshes.forEach((mesh, i) => {
      mesh.count = buckets[i];
      mesh.instanceMatrix.needsUpdate = true;
    });
    if (this.show.trails) this.paintTrails(grid.floor + 60);
  },

  paintTrails(z) {
    const n = this.trailLength;
    const position = this.trails.geometry.attributes.position.array;
    const colour = this.trails.geometry.attributes.color.array;
    // A budget of segments, shared out. Everybody keeps a tail; with four
    // thousand people on the plate it is four steps long instead of
    // twenty-three, because a hundred thousand line segments rewritten every
    // frame is where the drawing stops being free - and at that density the
    // long tails were a solid wash anyway.
    const span = Math.max(3, Math.min(n, Math.round(TRAIL_SEGMENTS / Math.max(1, this.crowd.count))));
    const first = Math.max(1, n - span);
    let at = 0;
    for (let a = 0; a < this.crowd.count; a++)
      for (let s = first; s < n; s++) {
        const older = (a * n + (this.historyAt + s) % n) * 2;
        const newer = (a * n + (this.historyAt + s + 1) % n) * 2;
        const ax = this.history[older], ay = this.history[older + 1];
        const bx = this.history[newer], by = this.history[newer + 1];
        if (!ax && !ay) continue;
        // A trail must not leap across the room when somebody is removed and
        // the last one is swapped into their slot.
        if (Math.hypot(bx - ax, by - ay) > 2000) continue;
        const fade = (s - first + 1) / (n - first + 1) * 0.85;
        position[at * 3] = ax; position[at * 3 + 1] = ay; position[at * 3 + 2] = z - 40;
        colour[at * 3] = 0.35 * fade; colour[at * 3 + 1] = 0.62 * fade; colour[at * 3 + 2] = 0.72 * fade;
        at++;
        position[at * 3] = bx; position[at * 3 + 1] = by; position[at * 3 + 2] = z - 40;
        colour[at * 3] = 0.35 * fade; colour[at * 3 + 1] = 0.62 * fade; colour[at * 3 + 2] = 0.72 * fade;
        at++;
      }
    this.trails.geometry.setDrawRange(0, at);
    this.trails.geometry.attributes.position.needsUpdate = true;
    this.trails.geometry.attributes.color.needsUpdate = true;
  },

  //! The crowding map. Scaled to Fruin F rather than to whatever the busiest
  //! cell happens to be, so the colour means the same thing from one run to the
  //! next and from one scheme to the next - which is the whole point of
  //! putting two schemes side by side.
  //! The floor, showing one of three different things. They are different
  //! maps and they answer different questions - see makeTrace in crowd.js.
  //!
  //!   movement       where the walking happened, ever. The desire lines.
  //!   concentration  where people WERE. The queues, the desks, the waiting.
  //!   right now      this instant, in Fruin bands. What the crowd is doing.
  //!
  //! The first two are scaled to their own busiest cell, because "twice as
  //! walked-on as anywhere else" is the question; the third is scaled to
  //! Fruin F, because a density means the same thing everywhere.
  //! The floor's colours. Rate limited, because this is the one thing here
  //! whose cost is the SIZE OF THE PLATE rather than the size of the crowd: a
  //! masterplan is a quarter of a million cells, every one of them written and
  //! the whole texture uploaded, and doing that at sixty frames a second cost
  //! 29 ms of every frame with two hundred people on the plate and 34 with four
  //! thousand. The crowd was never the problem. Twice a second on a plate that
  //! size is a heat map that still looks live and gives the frame back.
  paintHeat(force = false) {
    if (!this.heat || !this.show.density || this.map === "off") return;
    const { grid } = this.plate;
    const cells = grid.width * grid.height;
    const every = Math.min(0.5, Math.max(0.05, cells / 500000));
    if (!force && this.heatAt !== null && this.clock - this.heatAt < every) return;
    this.heatAt = this.clock;
    const live = this.map === "live";
    const values = live ? this.density.now
                : this.map === "occupancy" ? this.trace.occupancy : this.trace.footfall;
    let full = 2.17e-6;                        // people/mm², the top of Fruin E
    if (!live) {
      full = 0;
      for (let k = 0; k < values.length; k++) if (values[k] > full) full = values[k];
      full = full || 1;
    }
    for (let j = 0; j < grid.height; j++)
      for (let i = 0; i < grid.width; i++) {
        const k = j * grid.width + i;
        const at = k * 4;
        if (grid.blocked[k]) {
          this.pixels[at] = 34; this.pixels[at + 1] = 48; this.pixels[at + 2] = 60;
          this.pixels[at + 3] = 235;
          continue;
        }
        // The accumulated maps are shown on a square root: a doorway that
        // everybody uses is fifty times the corner nobody does, and on a
        // straight scale that leaves everywhere but the doorway black.
        const raw = values[k] / full;
        const value = live ? raw : Math.sqrt(Math.max(0, raw));
        const rgb = crowdColour(value);
        this.pixels[at] = rgb[0] * 255;
        this.pixels[at + 1] = rgb[1] * 255;
        this.pixels[at + 2] = rgb[2] * 255;
        this.pixels[at + 3] = Math.min(225, 18 + value * 300);
      }
    this.heat.needsUpdate = true;
  },

  planView() {
    if (!this.plate) return;
    const { grid } = this.plate;
    this.kit.lookDown([grid.lo[0] + grid.width * grid.cell / 2,
                       grid.lo[1] + grid.height * grid.cell / 2, grid.floor],
                      Math.max(grid.width, grid.height) * grid.cell * 0.62);
  },

  /* ---------------------------------------------------------- the panel */

  refresh() {
    const rows = [];
    const service = this.plate && this.density
      ? serviceBreakdown(this.density, this.plate.grid) : null;

    rows.push(block("Right now", [
      pairOf("people walking", String(this.crowd.count - this.crowd.stranded)),
      pairOf("arrived", String(this.crowd.done)),
      ...(this.crowd.stranded ? [
        pairOf("CUT OFF", String(this.crowd.stranded)),
        '<p class="fl-small fl-warn">' + this.crowd.stranded
        + " people can reach no destination from where they are standing. They are "
        + "drawn in purple. That is the plan telling you something.</p>"] : []),
      pairOf("elapsed", this.clock < 90 ? this.clock.toFixed(0) + " s"
                                       : (this.clock / 60).toFixed(1) + " min"),
      pairOf("destinations", this.goals.length
        + (this.portals.length ? " portals" : " corners")),
      // On a floor this size, what is on it - and, when the ceiling is what is
      // deciding the number rather than the floor, that it is.
      ...(this.plate ? [pairOf("one person per",
        (this.walkableArea() / 1e6 / Math.max(1, this.crowd.count)).toFixed(1) + " m²")] : []),
      ...(this.population >= CROWD_LIMIT && this.plate
          && peopleFor(this.walkableArea()) >= CROWD_LIMIT ? [
        '<p class="fl-small">' + CROWD_LIMIT + " is as many as this steps in a frame, "
        + "and a floor this size would hold more. What is on it is a sample of a "
        + "fuller crowd, not the whole of one - the maps are still right, the "
        + "queues are not.</p>"] : []),
    ]));

    if (this.crowd.journeys.length) {
      const times = this.crowd.journeys.map(j => j.seconds).sort((a, b) => a - b);
      const walked = this.crowd.journeys.map(j => j.mm).sort((a, b) => a - b);
      const at = q => times[Math.min(times.length - 1, Math.floor(q * times.length))];
      rows.push(block("Journeys", [
        pairOf("median", fmtTime(at(0.5))),
        pairOf("slowest tenth", fmtTime(at(0.9))),
        pairOf("median distance", (walked[Math.floor(walked.length / 2)] / 1000).toFixed(1) + " m"),
        pairOf("counted", String(this.crowd.journeys.length)),
        '<p class="fl-small">Measured over the last ' + this.crowd.journeys.length
        + " completed trips, not over the whole run.</p>",
      ]));
    }

    if (service && service.occupied > 0) {
      const bars = service.bands.map(band => {
        const width = Math.max(0, band.share * 100);
        return '<div class="fl-los"><b>' + band.grade + "</b>"
          + '<span class="fl-los-bar"><i style="width:' + width.toFixed(1) + "%;background:"
          + rgbText(crowdColour(FRUIN.indexOf(band) / (FRUIN.length - 1))) + '"></i></span>'
          + "<em>" + (band.share * 100).toFixed(0) + "%</em></div>";
      }).join("");
      // The LAST band with anything real in it. FRUIN runs A to F, so `find`
      // returns the emptiest - which reported a jammed floor as "free flow".
      const worst = [...service.bands].reverse().find(b => b.share > 0.02)
        || service.bands[0];
      rows.push(block("Crowding, by Fruin band", [
        bars,
        pairOf("occupied", (service.occupied / 1e6).toFixed(0) + " m²"),
        pairOf("worst band in use", worst.grade),
        '<p class="fl-small">' + safe(worst.meaning) + "</p>",
        '<p class="fl-small">Fruin\u2019s Levels of Service, as area per person on a '
        + "walkway. Share of the OCCUPIED floor, not of the whole plate.</p>",
      ]));
    }

    if (this.tally) {
      const total = Math.max(1, this.tally.reduce((a, b) => a + b, 0));
      rows.push(block("What the crowd is doing", this.states.map((state, i) =>
        '<div class="fl-los"><b style="background:' + rgbText([
          ((state.colour >> 16) & 255) / 255, ((state.colour >> 8) & 255) / 255,
          (state.colour & 255) / 255]) + '"></b>'
        + '<span class="fl-los-bar"><i style="width:'
        + (this.tally[i] / total * 100).toFixed(1) + "%;background:" + rgbText([
          ((state.colour >> 16) & 255) / 255, ((state.colour >> 8) & 255) / 255,
          (state.colour & 255) / 255]) + '"></i></span>'
        + "<em>" + this.tally[i] + "</em></div>"
        + '<p class="fl-legend">' + safe(state.says) + "</p>")));
    }

    rows.push(block("Worn into the floor", this.traceSummary()));

    rows.push(block("What this is", [
      '<p class="fl-small">The plan is exact - your model, cut at '
      + (this.cut / 1000).toFixed(2) + " m. Speed against crowding is Weidmann\u2019s "
      + "relation (1.34 m/s free, stopped at 5.4 people/m²). How people steer round "
      + "each other is a MODEL, tuned to look right: read this for where the plan "
      + "fails, not for a headcount at a moment.</p>",
    ]));

    this.panel.innerHTML = '<div class="panel-head"><h2>Flow</h2>'
      + '<span class="fl-clock">' + (this.running ? "running" : "paused") + "</span></div>"
      + '<div class="fl-body">' + rows.join("") + "</div>";
  },

  /* ------------------------------------------------------------- modes */

  enter() {
    this.on = true;
    // A fresh look at whatever is in the scene now: a model imported since the
    // last visit sits somewhere else, and the cut follows it in.
    this.cutChosen = false;
    this.bar.hidden = false;
    this.panel.hidden = false;
    this.group.visible = true;
    document.body.classList.add("flowing");
    this.kit.setModelVisible(false);
    this.rebuild();
    this.reset();
    // Raked, not flat. People drawn as bodies are people from an angle and
    // circles from directly above, and the whole point of drawing them as
    // bodies was so that they read as people.
    this.overView();
  },

  overView() {
    if (!this.plate) return;
    const { grid } = this.plate;
    this.kit.frameOn([grid.lo[0] + grid.width * grid.cell / 2,
                      grid.lo[1] + grid.height * grid.cell / 2, grid.floor],
                     Math.max(grid.width, grid.height) * grid.cell * 0.6);
  },

  leave() {
    this.on = false;
    if (this.rebuildQueued) { cancelAnimationFrame(this.rebuildQueued); this.rebuildQueued = 0; }
    this.bar.hidden = true;
    this.panel.hidden = true;
    this.group.visible = false;
    document.body.classList.remove("flowing");
    this.kit.setModelVisible(true);
    this.kit.draw();
  },

  //! The traces are the reason to run this at all, so they get a line each.
  traceSummary() {
    if (!this.trace || !this.plate) return [];
    const { grid } = this.plate;
    const area = grid.cell * grid.cell;
    let walked = 0, stood = 0, used = 0, floor = 0;
    for (let k = 0; k < this.trace.footfall.length; k++) {
      if (grid.blocked[k]) continue;
      floor++;
      walked += this.trace.footfall[k];
      stood += this.trace.occupancy[k];
      if (this.trace.footfall[k] > 0) used++;
    }
    return [
      pairOf("floor walked on", floor ? Math.round(used / floor * 100) + "%" : "—"),
      pairOf("person-km walked", (walked / 1e6).toFixed(2)),
      pairOf("person-hours on floor", (stood / 3600).toFixed(2)),
      '<p class="fl-small">Movement is person-metres of walking per square metre - the '
      + "desire lines. Concentration is person-seconds - where people actually were. A "
      + "lobby everybody crosses and nobody stays in is hot on one and cold on the "
      + "other, which is why they are two maps.</p>",
    ];
  },

  //! The model changed. Everything else in this program throws its analysis
  //! away here - this one does NOT, because watching the crowd re-route while
  //! you drag the wall is the entire point of it. The plan is rebuilt and the
  //! field re-swept; the people stay where they are and start walking the new
  //! way on the next frame. Anybody who ends up inside the thing you just moved
  //! is pushed out rather than left in the wall.
  invalidate() {
    if (!this.on) { this.plate = null; return; }
    this.rebuild();
    if (!this.plate) return;
    for (let a = 0; a < this.crowd.count; a++)
      if (isBlocked(this.plate.grid, this.crowd.x[a], this.crowd.y[a])) {
        const out = this.nearestFree(this.crowd.x[a], this.crowd.y[a]);
        if (out) { this.crowd.x[a] = out[0]; this.crowd.y[a] = out[1]; }
      }
  },

  nearestFree(x, y) {
    const { grid } = this.plate;
    const [i, j] = toCell(grid, x, y);
    for (let r = 1; r < 24; r++)
      for (let d = 0; d < 8 * r; d++) {
        const angle = d / (8 * r) * Math.PI * 2;
        const ni = i + Math.round(Math.cos(angle) * r), nj = j + Math.round(Math.sin(angle) * r);
        if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) continue;
        if (!grid.blocked[nj * grid.width + ni]) return toWorld(grid, ni, nj);
      }
    return null;
  },

  dispose() {
    this.leave();
    this.bar.remove();
    this.panel.remove();
    this.kit.world.remove(this.group);
  },
});

const fmtTime = seconds => seconds < 90 ? seconds.toFixed(0) + " s"
  : Math.floor(seconds / 60) + " min " + Math.round(seconds % 60) + " s";
const pairOf = (label, value) =>
  '<div class="fl-pair"><span>' + safe(label) + "</span><b>" + safe(value) + "</b></div>";
const block = (title, rows) =>
  '<section class="fl-block"><h3>' + safe(title) + "</h3>" + rows.join("") + "</section>";

//! A soft round dot, drawn once into a canvas. A square person reads as a
//! pixel; a round one reads as a person.
function discTexture(THREE) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const pen = canvas.getContext("2d");
  const glow = pen.createRadialGradient(32, 32, 4, 32, 32, 30);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.55, "rgba(255,255,255,1)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  pen.fillStyle = glow;
  pen.beginPath();
  pen.arc(32, 32, 30, 0, Math.PI * 2);
  pen.fill();
  return new THREE.CanvasTexture(canvas);
}

/* ------------------------------------------------------- the declaration */

export const CROWD = offerPlugin({
  id: "flow",
  name: "Flow & Floor Plate",
  version: 1,
  summary: "Pedestrian movement over the plan you are drawing, live. Put portals where "
         + "people come from and go to, and watch them route round the furniture - "
         + "move a wall and the whole floor re-routes while you drag. Crowding in "
         + "Fruin bands, journey times, walking distances and isovists.",

  nodes: CROWD_NODES,

  api: {
    name: "FlowFactory",
    summary: "Pedestrian movement over a rasterised floor plate. The plan is exact - "
           + "it is your model, cut at a height. Speed against crowding is Weidmann's "
           + "published relation and the service bands are Fruin's. How people steer "
           + "round one another is a model tuned to look right: it reproduces queues, "
           + "lane formation and pinch points, and it does not predict any one person.",
    operations: [
      { name: "boundaryRings", takes: "mesh", gives: "rings",
        summary: "The outline of a flat thing and the outlines of its holes, read off "
               + "the edges its triangles do not share. What lets a sketch's face, or "
               + "the face of an imported extrusion, be used as a floor without cutting "
               + "anything." },
      { name: "floorRings", takes: "mesh", gives: "rings",
        summary: "The same, for whatever it is handed: a slab is cut halfway up its "
               + "own thickness, a face has no thickness to cut so its boundary is the "
               + "answer." },
      { name: "fillRings", takes: "grid, rings, { carve }", gives: "nothing, it marks the grid",
        summary: "Rings that know about each other: a ring inside a ring is a HOLE, so "
               + "a cell is solid when it is inside an odd number of them. With carve, "
               + "the same arithmetic means the opposite - what is inside is floor and "
               + "everything else is off the plate." },
      { name: "plateOf", takes: "meshes, cut, grain", gives: "{ grid, rings, plate }",
        summary: "The walkable floor, from the model's own triangles cut at a height. "
               + "A desk at 720 blocks nothing at eye level; a screen at 1600 blocks "
               + "everything - which is why the cut height is the first control." },
      { name: "flowField", takes: "grid, targets, options", gives: "{ grid, cost }",
        summary: "One Dijkstra sweep from every destination at once, giving each cell "
               + "its distance to the nearest. This is what makes the whole thing live: "
               + "everybody walks downhill on it, so re-routing a floor of five hundred "
               + "people is one sweep rather than five hundred searches." },
      { name: "downhill", takes: "field, x, y", gives: "a unit vector",
        summary: "Which way to walk, read off the gradient of the cost field rather "
               + "than off the cheapest neighbour - so routes run where they want to "
               + "rather than in the eight directions a grid has." },
      { name: "walkDistance", takes: "field, x, y", gives: "mm",
        summary: "How far it is to walk, through the plan rather than through the "
               + "walls. What \"how far is the tea point\" actually means." },
      { name: "stepCrowd", takes: "crowd, fields, grid, density, dt, now", gives: "arrivals",
        summary: "One step of everybody: downhill on the field, slowed by how crowded "
               + "it is here, pushed apart by whoever is too close and by whatever wall "
               + "is too close. Lanes form in a two-way corridor without anybody being "
               + "told to form one." },
      { name: "crowdSpeed", takes: "density, free", gives: "mm/s",
        summary: "Weidmann's fundamental diagram: free at nobody, stopped at 5.4 people "
               + "a square metre. The reason a corridor has a capacity rather than a "
               + "width." },
      { name: "levelOfService", takes: "density", gives: "a Fruin band",
        summary: "A to F, as area per person. Each band is something that stops being "
               + "possible - overtaking, then choosing your own speed - rather than an "
               + "opinion about comfort." },
      { name: "serviceBreakdown", takes: "density, grid", gives: "share of floor per band",
        summary: "How the occupied floor divides between the bands: the table a "
               + "workplace report puts on the page." },
      { name: "isovist", takes: "grid, x, y, options", gives: "{ points, area }",
        summary: "Everything visible from a point, cast on the same grid the plan is "
               + "on - so what blocks a view is exactly what blocks a walk." },
    ],
  },

  view: { key: "flow", label: "Flow", title: "Watch people move through the plan" },

  resources: [],

  async start(kit) {
    const view = kit.THREE ? new FlowView(kit) : null;
    return {
      drivers: crowdDrivers(kit),
      view,
      dispose: () => { if (view) view.dispose(); },
    };
  },
});

//! One person, as one geometry: a body, a head and a nose that says which way
//! they are facing. Merged by hand because r128's merge helper lives in an
//! addon this page does not carry, and three draw calls per state instead of
//! one is three times the cost for no gain.
function mergedPerson(THREE, coarse = false) {
  // Two bodies, and which one is drawn is decided by how many there are. At
  // four thousand the fine one is 960,000 triangles a frame for a crowd whose
  // members are four pixels tall; the coarse one is an eighth of that and looks
  // the same at that size. Below a thousand people they are people, and the
  // fine one is what they are drawn with.
  const sides = coarse ? 5 : 10;
  const body = new THREE.CylinderGeometry(BODY * 0.34, BODY * 0.30, 1150, sides);
  body.rotateX(Math.PI / 2);                        // z is up in this world
  body.translate(0, 0, 575);
  const head = coarse ? new THREE.SphereGeometry(BODY * 0.30, 5, 3)
                      : new THREE.SphereGeometry(BODY * 0.30, 12, 9);
  head.translate(0, 0, 1420);
  const nose = new THREE.ConeGeometry(BODY * 0.15, BODY * 0.5, coarse ? 4 : 7);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, BODY * 0.40, 900);

  const parts = [body, head, nose].map(g => g.index ? g.toNonIndexed() : g);
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let at = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, at * 3);
    normal.set(part.attributes.normal.array, at * 3);
    at += part.attributes.position.count;
  }
  const person = new THREE.BufferGeometry();
  person.setAttribute("position", new THREE.BufferAttribute(position, 3));
  person.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return person;
}
