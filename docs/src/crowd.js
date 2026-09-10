// People, moving through a plan.
//
// The arithmetic behind the Flow package and nothing else: no DOM, no
// OpenCascade, no interface. A floor plate goes in as a grid of walkable and
// blocked cells; what comes out is where everybody is, a tenth of a second
// later, and how crowded it got.
//
// WHAT KIND OF NUMBERS THESE ARE. This is a SIMULATION, and a simulation is a
// model with its assumptions written down rather than a measurement. Two of the
// assumptions are published and named, and the rest are stated:
//
//   Weidmann's speed-density relation - how much a crowd slows itself down.
//     v = v0 (1 - exp(-1.913 (1/rho - 1/5.4))), rho in people per square metre,
//     free speed 1.34 m/s. It is the standard fundamental diagram of pedestrian
//     traffic and it is why a corridor has a capacity at all.
//
//   Fruin's Level of Service - the A to F bands every workplace report quotes,
//     as area per person on a walkway. Not a comfort opinion: the thresholds
//     are where overtaking stops being possible, then where choosing your own
//     speed stops being possible, and so on down.
//
//   Everything else - how people steer round each other, how they pick a door -
//     is a steering model, tuned to look right. It reproduces the queues, the
//     lane forming and the pinch points that make these studies worth doing. It
//     does not predict what one particular person will do, and no simulation
//     does.
//
// So: the geometry is exact, the capacity is published, the behaviour is a
// model. Say which is which on screen, and never let a smooth animation imply
// a precision that is not there.

// The even-odd crossing test is the sketcher's, not a second copy of it: a
// point is inside a ring or it is not, and two answers to that would be one
// answer too many.
import { pointInPolygon } from "./sketch.js";

/* --------------------------------------------------------------- the grid

   A floor plate as two flat arrays: what is blocked, and how far the nearest
   blockage is. Cells are square and metric - 250 mm by default, which is about
   half a person and the resolution these studies are run at.                */

export const BODY = 450;              // mm across the shoulders, near enough
export const FREE_SPEED = 1340;       // mm/s, Weidmann's mean
export const SPEED_SPREAD = 260;      // mm/s, Weidmann's standard deviation
export const JAM_DENSITY = 5.4e-6;    // people per mm^2 - 5.4 per m^2

//! How much of the push between two people is sideways rather than straight
//! back. Zero deadlocks a head-on meeting; this is what makes lanes.
export const SIDESTEP = 0.75;

//! An empty plate. \p cell is in mm.
export function makeGrid(bounds, cell = 250) {
  const width = Math.max(1, Math.ceil((bounds.hi[0] - bounds.lo[0]) / cell));
  const height = Math.max(1, Math.ceil((bounds.hi[1] - bounds.lo[1]) / cell));
  return {
    cell, width, height,
    lo: [bounds.lo[0], bounds.lo[1]],
    blocked: new Uint8Array(width * height),
    clearance: new Float32Array(width * height),
    floor: bounds.floor || 0,
  };
}

export const cellIndex = (grid, i, j) => j * grid.width + i;
export const inGrid = (grid, i, j) => i >= 0 && j >= 0 && i < grid.width && j < grid.height;
//! World millimetres to cell, and back to the middle of that cell.
export const toCell = (grid, x, y) =>
  [Math.floor((x - grid.lo[0]) / grid.cell), Math.floor((y - grid.lo[1]) / grid.cell)];
export const toWorld = (grid, i, j) =>
  [grid.lo[0] + (i + 0.5) * grid.cell, grid.lo[1] + (j + 0.5) * grid.cell];

export const isBlocked = (grid, x, y) => {
  const [i, j] = toCell(grid, x, y);
  return !inGrid(grid, i, j) || grid.blocked[cellIndex(grid, i, j)] === 1;
};

//! Paint a footprint into the grid, as blocked. Two passes, and the second one
//! is the important one.
//!
//! The inside is filled by the even-odd rule at each cell centre, which is
//! exact for anything bigger than a cell. But a 100 mm partition on a 250 mm
//! grid can pass BETWEEN two cell centres and land in none of them - and a
//! wall that is in the model, on the screen, and not in the simulation is the
//! worst thing this file could do. So the OUTLINE is rasterised too, and any
//! cell a wall passes through is blocked whether its centre is inside or not.
//!
//! The cost of that is that nothing can be thinner than one cell: a wall is at
//! least `cell` thick to a walker. That is the honest limit of a grid, and it
//! errs towards a wall being there.
export function blockPolygon(grid, polygon) {
  if (polygon.length < 2) return;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(span / (grid.cell * 0.25)));
    for (let n = 0; n <= steps; n++) {
      const k = n / steps;
      const [i2, j2] = toCell(grid, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
      if (inGrid(grid, i2, j2)) grid.blocked[cellIndex(grid, i2, j2)] = 1;
    }
  }
  if (polygon.length < 3) return;
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of polygon) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  const [i0, j0] = toCell(grid, lo[0], lo[1]);
  const [i1, j1] = toCell(grid, hi[0], hi[1]);
  for (let j = Math.max(0, j0); j <= Math.min(grid.height - 1, j1); j++)
    for (let i = Math.max(0, i0); i <= Math.min(grid.width - 1, i1); i++) {
      const [x, y] = toWorld(grid, i, j);
      if (pointInPolygon([x, y], polygon)) grid.blocked[cellIndex(grid, i, j)] = 1;
    }
}

//! How far every free cell is from the nearest blocked one, by the two-pass
//! chamfer transform. People do not walk with their shoulder on the wall, and
//! a path that does looks wrong before anybody can say why - so this is what
//! the route cost is scaled by.
export function clearanceOf(grid) {
  const { width, height, blocked, clearance, cell } = grid;
  const BIG = 1e9;
  for (let k = 0; k < clearance.length; k++) clearance[k] = blocked[k] ? 0 : BIG;
  const near = (k, from, cost) => {
    const value = clearance[from] + cost;
    if (value < clearance[k]) clearance[k] = value;
  };
  const D = cell, S = cell * Math.SQRT2;
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (i > 0) near(k, k - 1, D);
      if (j > 0) near(k, k - width, D);
      if (i > 0 && j > 0) near(k, k - width - 1, S);
      if (i < width - 1 && j > 0) near(k, k - width + 1, S);
    }
  for (let j = height - 1; j >= 0; j--)
    for (let i = width - 1; i >= 0; i--) {
      const k = j * width + i;
      if (i < width - 1) near(k, k + 1, D);
      if (j < height - 1) near(k, k + width, D);
      if (i < width - 1 && j < height - 1) near(k, k + width + 1, S);
      if (i > 0 && j < height - 1) near(k, k + width - 1, S);
    }
  return grid;
}

/* --------------------------------------------------------- the flow field

   The whole reason a crowd simulation can run live. Rather than路 finding a path
   per person per frame, ONE Dijkstra sweep from the destinations gives every
   cell its distance to the nearest one; everybody then just walks downhill.
   Move a desk and it is one sweep to re-route the entire building.          */

//! Distance to the nearest destination, for every cell. \p targets are world
//! points. Walking near a wall is made to cost more, so routes stand off
//! obstacles the way people do rather than shaving the corners.
export function flowField(grid, targets, { standOff = 900, timid = 1.4 } = {}) {
  const { width, height, blocked, clearance, cell } = grid;
  const n = width * height;
  const cost = new Float32Array(n).fill(Infinity);
  const heap = new BucketHeap(cell);

  for (const [x, y] of targets) {
    const [i, j] = toCell(grid, x, y);
    if (!inGrid(grid, i, j)) continue;
    const k = cellIndex(grid, i, j);
    if (blocked[k]) continue;
    cost[k] = 0;
    heap.push(k, 0);
  }
  // Standing off a wall costs a little more per step, up to standOff away;
  // beyond that the middle of a room is all the same.
  const penalty = k => 1 + timid * Math.max(0, 1 - clearance[k] / standOff) ** 2;

  const D = cell, S = cell * Math.SQRT2;
  while (heap.size) {
    const k = heap.pop();
    if (k < 0) break;
    const here = cost[k];
    const i = k % width, j = (k - i) / width;
    for (let d = 0; d < 8; d++) {
      const di = STEP[d][0], dj = STEP[d][1];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= width || nj >= height) continue;
      const nk = nj * width + ni;
      if (blocked[nk]) continue;
      // No cutting a diagonal through the gap between two blocked cells.
      if (di && dj && (blocked[j * width + ni] || blocked[nj * width + i])) continue;
      const step = (di && dj ? S : D) * penalty(nk);
      const next = here + step;
      if (next < cost[nk] - 1e-6) { cost[nk] = next; heap.push(nk, next); }
    }
  }
  return { grid, cost };
}

const STEP = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

//! Which way is downhill, at a world point, as a unit vector. Read off the
//! GRADIENT of the cost field rather than off the cheapest neighbour, so a path
//! runs where it wants to rather than in the eight directions a grid has.
export function downhill(field, x, y) {
  const { grid, cost } = field;
  const [i, j] = toCell(grid, x, y);
  if (!inGrid(grid, i, j)) return null;
  const at = (a, b) => {
    if (!inGrid(grid, a, b)) return Infinity;
    return cost[cellIndex(grid, a, b)];
  };
  const here = at(i, j);
  if (!Number.isFinite(here)) return null;
  const east = at(i + 1, j), west = at(i - 1, j);
  const north = at(i, j + 1), south = at(i, j - 1);
  // One-sided where the other side is a wall, which is what keeps the gradient
  // sane against an edge instead of pointing into it.
  const dx = Number.isFinite(east) && Number.isFinite(west) ? (east - west) / 2
           : Number.isFinite(east) ? east - here
           : Number.isFinite(west) ? here - west : 0;
  const dy = Number.isFinite(north) && Number.isFinite(south) ? (north - south) / 2
           : Number.isFinite(north) ? north - here
           : Number.isFinite(south) ? here - south : 0;
  const length = Math.hypot(dx, dy);
  return length < 1e-9 ? null : [-dx / length, -dy / length];
}

//! How far it is to walk from here to the nearest destination, through the
//! plan rather than through the walls. The number a workplace study is
//! actually about - "how far is the tea point" is a route, not a straight line.
export function walkDistance(field, x, y) {
  const [i, j] = toCell(field.grid, x, y);
  if (!inGrid(field.grid, i, j)) return null;
  const d = field.cost[cellIndex(field.grid, i, j)];
  return Number.isFinite(d) ? d : null;
}

//! Dijkstra with buckets instead of a binary heap. Every edge is one of two
//! lengths, so the frontier only ever spans a narrow band of costs - which is
//! the case a bucket queue is for, and it turns the sweep from n log n into n.
class BucketHeap {
  constructor(cell) {
    this.step = cell / 2;
    this.buckets = [];
    this.at = 0;
    this.size = 0;
  }
  push(key, cost) {
    const b = Math.max(this.at, Math.floor(cost / this.step));
    (this.buckets[b] || (this.buckets[b] = [])).push(key);
    this.size++;
  }
  pop() {
    while (this.at < this.buckets.length) {
      const bucket = this.buckets[this.at];
      if (bucket && bucket.length) { this.size--; return bucket.pop(); }
      this.at++;
    }
    this.size = 0;
    return -1;
  }
}

/* ------------------------------------------------------------- the crowd

   Everybody walks downhill on the field, slowed by how crowded it is where
   they are, and pushed apart by whoever is too close. That is the whole model.
   What it is NOT is a prediction about any one person - it is a way of finding
   the pinch points, and pinch points are a property of the plan.            */

//! How fast a crowd at this density walks. Weidmann's fundamental diagram -
//! free at nobody, and the curve down to jam is the reason a corridor has a
//! capacity rather than a width.
//!
//! With ONE correction, and it is not cosmetic. Weidmann's relation reaches
//! exactly zero at 5.4 people a square metre, and a simulation that takes that
//! literally locks solid and stays locked: everybody stops, stopping keeps the
//! density up, and the density keeps everybody stopped. A crowd that jams can
//! then never un-jam itself, which is not what crowds do and not what Fruin
//! says either - his F band is SHUFFLING, not stopped. So there is a floor
//! under it, and the floor is a shuffle.
export const SHUFFLE = 0.08;          // of free speed: about 100 mm/s

export function crowdSpeed(density, free = FREE_SPEED) {
  if (!(density > 0)) return free;
  if (density >= JAM_DENSITY) return free * SHUFFLE;
  return Math.max(free * SHUFFLE,
    free * (1 - Math.exp(-1.913 * (1 / density - 1 / JAM_DENSITY) * 1e-6)));
}

//! Fruin's Level of Service for a walkway, as area per person in mm^2. The
//! bands every workplace report quotes, and each one is a thing that stops
//! being possible rather than an opinion about comfort.
export const FRUIN = [
  { grade: "A", over: 3.25e6, meaning: "free flow - you pick your own speed and line" },
  { grade: "B", over: 2.32e6, meaning: "you can still overtake without thinking about it" },
  { grade: "C", over: 1.39e6, meaning: "overtaking needs a gap; speed is mostly yours" },
  { grade: "D", over: 0.93e6, meaning: "speed is set by the crowd, not by you" },
  { grade: "E", over: 0.46e6, meaning: "shuffling; every crossing move is a negotiation" },
  { grade: "F", over: 0, meaning: "jammed - contact is unavoidable" },
];

//! The grade for a density in people per square millimetre.
export function levelOfService(density) {
  const area = density > 0 ? 1 / density : Infinity;
  return FRUIN.find(band => area > band.over) || FRUIN[FRUIN.length - 1];
}

//! A crowd. Positions and velocities live in flat arrays because they are
//! stepped sixty times a second and read straight into a vertex buffer.
export function makeCrowd(limit = 400) {
  return {
    limit, count: 0,
    x: new Float32Array(limit), y: new Float32Array(limit),
    vx: new Float32Array(limit), vy: new Float32Array(limit),
    free: new Float32Array(limit),        // this person's own free speed
    goal: new Int8Array(limit),           // which field they are following
    born: new Float32Array(limit),        // when, in seconds
    walked: new Float32Array(limit),      // how far, in mm
    until: new Float32Array(limit),       // standing still until this time
    done: 0, journeys: [],                // finished trips, in seconds
    stranded: 0,                          // people who cannot reach anywhere
  };
}

export function addWalker(crowd, x, y, goal, now, random = Math.random) {
  if (crowd.count >= crowd.limit) return -1;
  const at = crowd.count++;
  crowd.x[at] = x; crowd.y[at] = y;
  crowd.vx[at] = 0; crowd.vy[at] = 0;
  // Weidmann's spread, not one speed for everybody: a crowd that all walks at
  // 1.34 m/s never forms a queue, and queues are the entire point.
  crowd.free[at] = Math.max(500, FREE_SPEED + gauss(random) * SPEED_SPREAD);
  crowd.goal[at] = goal;
  crowd.born[at] = now;
  crowd.walked[at] = 0;
  crowd.until[at] = 0;
  return at;
}

export function removeWalker(crowd, at) {
  const last = --crowd.count;
  for (const key of ["x", "y", "vx", "vy", "free", "goal", "born", "walked", "until"])
    crowd[key][at] = crowd[key][last];
}

const gauss = random => {
  const u = Math.max(1e-9, random()), v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

//! One step of the whole crowd, \p dt seconds. Everyone is pushed by three
//! things and nothing else: where the field says to go, whoever is too close,
//! and whatever wall is too close.
export function stepCrowd(crowd, fields, grid, density, dt, now, options = {}) {
  const { trace = null, recycle = null, sidestep = SIDESTEP } = options;
  const hash = new SpatialHash(grid.cell * 4);
  for (let a = 0; a < crowd.count; a++) hash.add(a, crowd.x[a], crowd.y[a]);

  const mark = (a, moved) => {
    if (!trace) return;
    const [i, j] = toCell(grid, crowd.x[a], crowd.y[a]);
    if (!inGrid(grid, i, j)) return;
    const k = cellIndex(grid, i, j);
    trace.footfall[k] += moved;
    trace.occupancy[k] += dt;
  };

  const arrived = [], stuck = [];
  for (let a = 0; a < crowd.count; a++) {
    const field = fields[crowd.goal[a]];
    if (!field) continue;
    const x = crowd.x[a], y = crowd.y[a];

    // Somebody who has arrived somewhere and is staying a while. They still
    // count - a person at a desk is occupancy, and leaving them out is what
    // makes an occupancy map look like a corridor map.
    if (now < crowd.until[a]) {
      crowd.vx[a] *= 0.5; crowd.vy[a] *= 0.5;
      mark(a, 0);
      continue;
    }

    // Arrived and STRANDED are not the same thing, and telling them apart is
    // the whole difference between a simulation and a demonstration. Somebody
    // with no route has no gradient to follow, exactly like somebody standing
    // on the destination - and counting the first as the second reports a
    // sealed fire exit as a hundred and fifty successful journeys.
    const togo = walkDistance(field, x, y);
    if (togo === null) { stuck.push(a); continue; }
    if (togo < grid.cell * 1.5) { arrived.push(a); continue; }
    const want = downhill(field, x, y);
    if (!want) { arrived.push(a); continue; }

    // How fast this person can go here: their own free speed, held down by how
    // crowded this cell is.
    const local = densityAt(density, grid, x, y);
    const speed = Math.min(crowd.free[a], crowdSpeed(local, crowd.free[a]));

    let px = want[0] * speed, py = want[1] * speed;

    // Everybody too close pushes back, harder the closer they are - and
    // SIDEWAYS as well as away.
    //
    // The sideways part is the whole thing. Push people apart along the line
    // between them and two crowds walking into each other lock solid: every
    // push is met by an equal one back, nobody has any reason to go round, and
    // the middle of the room turns into a knot that never clears. It looks
    // like congestion and it is actually a model with no way out of a
    // head-on meeting.
    //
    // Real people step to a side, and consistently to the same side. One
    // rotational bias, the same for everybody, breaks the symmetry - and lanes
    // form on their own, which is exactly what a real corridor does without
    // anybody being told to.
    for (const b of hash.near(x, y)) {
      if (b === a) continue;
      const dx = x - crowd.x[b], dy = y - crowd.y[b];
      const gap = Math.hypot(dx, dy);
      if (gap > BODY * 2.2 || gap < 1e-6) continue;
      const push = (1 - gap / (BODY * 2.2)) ** 2 * crowd.free[a] * 1.9;
      px += dx / gap * push;
      py += dy / gap * push;
      // Rotated a quarter turn from the push: always the same way round, so
      // two people meeting head-on both step the same side and pass.
      px += dy / gap * push * sidestep;
      py += -dx / gap * push * sidestep;
    }

    // And so does a wall, from the clearance field, which is already there.
    const away = wallPush(grid, x, y);
    if (away) {
      px += away[0] * crowd.free[a] * 1.4;
      py += away[1] * crowd.free[a] * 1.4;
    }

    // Ease towards the wanted velocity rather than snapping to it: half a
    // second of reaction is what stops the crowd looking like iron filings.
    const ease = Math.min(1, dt / 0.5);
    crowd.vx[a] += (px - crowd.vx[a]) * ease;
    crowd.vy[a] += (py - crowd.vy[a]) * ease;
    const going = Math.hypot(crowd.vx[a], crowd.vy[a]);
    if (going > speed && going > 1e-6) {
      crowd.vx[a] *= speed / going;
      crowd.vy[a] *= speed / going;
    }

    let nx = x + crowd.vx[a] * dt, ny = y + crowd.vy[a] * dt;
    // A step into a wall is refused per axis, so somebody who meets a wall at
    // an angle slides along it instead of stopping dead against it.
    if (isBlocked(grid, nx, ny)) {
      if (!isBlocked(grid, nx, y)) ny = y;
      else if (!isBlocked(grid, x, ny)) nx = x;
      else { nx = x; ny = y; crowd.vx[a] = crowd.vy[a] = 0; }
    }
    const moved = Math.hypot(nx - x, ny - y);
    crowd.walked[a] += moved;
    crowd.x[a] = nx; crowd.y[a] = ny;
    mark(a, moved);
  }
  if (trace) trace.seconds += dt;

  // Stranded people stand still rather than vanishing. They are the finding:
  // a plan where forty people cannot reach an exit is the plan telling you
  // something, and removing them would remove the news.
  for (const a of stuck) { crowd.vx[a] *= 0.6; crowd.vy[a] *= 0.6; }
  crowd.stranded = stuck.length;

  // Backwards, because removing swaps the last one into the gap.
  arrived.sort((p, q) => q - p);
  for (const a of arrived) {
    crowd.journeys.push({ seconds: now - crowd.born[a], mm: crowd.walked[a] });
    if (crowd.journeys.length > 500) crowd.journeys.shift();
    crowd.done++;
    // A floor where everybody leaves as soon as they arrive is a drain, not a
    // building. Given somewhere else to go, they go: which is what makes the
    // flows CROSS, and a footfall map of crossing flows is the thing a plan is
    // actually judged on.
    const next = recycle ? recycle(a, now) : null;
    if (next && Number.isFinite(next.goal)) {
      crowd.goal[a] = next.goal;
      crowd.born[a] = now;
      crowd.walked[a] = 0;
      crowd.until[a] = now + (next.dwell || 0);
    } else removeWalker(crowd, a);
  }
  return { arrived: arrived.length, stranded: stuck.length };
}

//! Can this person get anywhere at all? Asked by the view so it can colour
//! them, and by anybody who wants to know how many are cut off.
export const stranded = (field, grid, x, y) => walkDistance(field, x, y) === null;

//! Which way is away from the nearest wall, or null out in the open. Read off
//! the clearance field's gradient - the field is already computed, so this is
//! four lookups rather than a search.
function wallPush(grid, x, y) {
  const [i, j] = toCell(grid, x, y);
  if (!inGrid(grid, i, j)) return null;
  const at = (a, b) => inGrid(grid, a, b) ? grid.clearance[cellIndex(grid, a, b)] : 0;
  const here = at(i, j);
  if (here > BODY) return null;
  const dx = at(i + 1, j) - at(i - 1, j), dy = at(i, j + 1) - at(i, j - 1);
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const strength = 1 - here / BODY;
  return [dx / length * strength, dy / length * strength];
}

class SpatialHash {
  constructor(cell) { this.cell = cell; this.bins = new Map(); }
  key(x, y) { return Math.floor(x / this.cell) + "," + Math.floor(y / this.cell); }
  add(index, x, y) {
    const k = this.key(x, y);
    let bin = this.bins.get(k);
    if (!bin) this.bins.set(k, bin = []);
    bin.push(index);
  }
  near(x, y) {
    const ci = Math.floor(x / this.cell), cj = Math.floor(y / this.cell);
    const out = [];
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const found = this.bins.get(i + "," + j);
        if (found) out.push(...found);
      }
    return out;
  }
}

/* ----------------------------------------------------------- the traces

   The two maps a movement study is read from, and they are NOT the same map.

     FOOTFALL   how much walking happened here, ever. Person-metres per square
                metre. This is the desire-line map: the routes people actually
                took, worn into the floor. Empty where nobody goes even if the
                room is full of people standing.

     OCCUPANCY  how long people were here. Person-seconds per square metre.
                This is where people ARE: the queue, the desk, the tea point.
                Bright where a corridor is busy and brighter where anybody
                stops.

   A busy corridor is hot on both. A lift lobby that everybody crosses and
   nobody stays in is hot on footfall and cold on occupancy. A desk cluster is
   the other way round. Showing one and calling it "the heatmap" is how a
   circulation problem gets read as an occupancy problem.                     */

export function makeTrace(grid) {
  return {
    footfall: new Float32Array(grid.width * grid.height),   // person-mm
    occupancy: new Float32Array(grid.width * grid.height),  // person-seconds
    seconds: 0,
  };
}

/* ------------------------------------------------------------- crowding */

//! People per square millimetre, per cell. Counted into the same grid the plan
//! is on, then blurred over about a metre - because a density measured in
//! quarter-metre squares is either one person or none, and neither is a
//! density.
export function makeDensity(grid) {
  return { now: new Float32Array(grid.width * grid.height),
           peak: new Float32Array(grid.width * grid.height),
           seen: new Float32Array(grid.width * grid.height), seconds: 0 };
}

export function measureDensity(density, crowd, grid, dt = 0, spread = 2) {
  const { width, height, cell } = grid;
  const counts = density.now;
  counts.fill(0);
  for (let a = 0; a < crowd.count; a++) {
    const [i, j] = toCell(grid, crowd.x[a], crowd.y[a]);
    if (inGrid(grid, i, j)) counts[cellIndex(grid, i, j)] += 1;
  }
  // A box blur twice is near enough a Gaussian and is two passes of adds.
  blur(counts, width, height, spread);
  blur(counts, width, height, spread);
  const area = cell * cell;
  for (let k = 0; k < counts.length; k++) {
    counts[k] /= area;
    if (counts[k] > density.peak[k]) density.peak[k] = counts[k];
    if (dt > 0) density.seen[k] += counts[k] * dt;
  }
  if (dt > 0) density.seconds += dt;
  return density;
}

export const densityAt = (density, grid, x, y) => {
  const [i, j] = toCell(grid, x, y);
  return inGrid(grid, i, j) ? density.now[cellIndex(grid, i, j)] : 0;
};

function blur(values, width, height, radius) {
  const line = new Float32Array(Math.max(width, height));
  const span = radius * 2 + 1;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) line[i] = values[j * width + i];
    for (let i = 0; i < width; i++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++)
        sum += line[Math.min(width - 1, Math.max(0, i + d))];
      values[j * width + i] = sum / span;
    }
  }
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) line[j] = values[j * width + i];
    for (let j = 0; j < height; j++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++)
        sum += line[Math.min(height - 1, Math.max(0, j + d))];
      values[j * width + i] = sum / span;
    }
  }
}

//! How the plate's occupied area breaks down by Fruin grade, right now. The
//! table a workplace report puts on the page.
export function serviceBreakdown(density, grid) {
  const tally = new Map(FRUIN.map(band => [band.grade, 0]));
  let occupied = 0;
  const area = grid.cell * grid.cell;
  for (let k = 0; k < density.now.length; k++) {
    if (grid.blocked[k] || density.now[k] <= 0) continue;
    occupied += area;
    const grade = levelOfService(density.now[k]).grade;
    tally.set(grade, tally.get(grade) + area);
  }
  return { occupied, bands: FRUIN.map(band => ({
    ...band, area: tally.get(band.grade),
    share: occupied > 0 ? tally.get(band.grade) / occupied : 0 })) };
}

/* -------------------------------------------------------------- isovist

   What you can see from where you stand. The oldest measure in space syntax
   and the one workplace design actually turns on: whether you can see the tea
   point, whether your desk can be seen from the door.                       */

//! The visible polygon from a point, as \p rays world points around it, and
//! its area. Cast on the same grid the plan is on, so what blocks a view is
//! exactly what blocks a walk.
export function isovist(grid, x, y, { rays = 180, reach = 60000 } = {}) {
  const points = [];
  let area = 0;
  const step = grid.cell * 0.6;
  for (let r = 0; r < rays; r++) {
    const angle = (r / rays) * Math.PI * 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let travelled = 0;
    while (travelled < reach) {
      const nx = x + dx * (travelled + step), ny = y + dy * (travelled + step);
      if (isBlocked(grid, nx, ny)) break;
      travelled += step;
    }
    // The march stops at the last clear sample, so it stops up to one step
    // short of the wall - which took 3% off the area of a plain rectangular
    // room. Six halvings put the last step within a couple of millimetres.
    let far = travelled + step;
    for (let i = 0; i < 6; i++) {
      const mid = (travelled + far) / 2;
      if (isBlocked(grid, x + dx * mid, y + dy * mid)) far = mid; else travelled = mid;
    }
    points.push([x + dx * travelled, y + dy * travelled]);
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += (a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y);
  }
  return { points, area: Math.abs(area) / 2 };
}
