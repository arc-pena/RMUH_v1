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
import { BODY, FRUIN, SHUFFLE, addWalker, clearanceOf, blockPolygon, crowdSpeed, densityAt,
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
  if (!segments.length) return rings;

  // The segments come out in no order at all, so they are welded end to end.
  // A ring that will not close is kept anyway and closed by force: a footprint
  // with a hairline gap in it lets the whole crowd walk through a wall.
  const key = p2 => Math.round(p2[0] / 20) + "," + Math.round(p2[1] / 20);
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

//! A grid of the whole scene at a cut height, with everything blocked in.
//! \p include are extra world points the plate must cover - the ends of a walk,
//! the eye of an isovist. Without them the grid is padded around the FURNITURE,
//! and a point beyond the furniture falls off the edge and reads as blocked,
//! which comes back as "that point is inside something" about a point standing
//! in open floor.
export function plateOf(meshes, cut, grain, { pad = 1000, include = [] } = {}) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], floor = Infinity;
  const rings = [];
  for (const mesh of meshes) {
    for (const ring of footprintOf(mesh, cut)) {
      rings.push(ring);
      for (const point of ring) {
        lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
        hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
      }
    }
    if (mesh.positions)
      for (let i = 2; i < mesh.positions.length; i += 3)
        floor = Math.min(floor, mesh.positions[i]);
  }
  if (!Number.isFinite(lo[0])) return null;
  const walls = { lo: [...lo], hi: [...hi] };
  for (const point of include) {
    lo = [Math.min(lo[0], point[0]), Math.min(lo[1], point[1])];
    hi = [Math.max(hi[0], point[0]), Math.max(hi[1], point[1])];
  }
  const bounds = { lo: [lo[0] - pad, lo[1] - pad], hi: [hi[0] + pad, hi[1] + pad],
                   floor: Number.isFinite(floor) ? floor : 0 };
  const grid = makeGrid(bounds, grain);
  for (const ring of rings) blockPolygon(grid, ring);
  clearanceOf(grid);
  // What the footprints themselves span, as against the padded grid. People
  // belong inside the building; without this they wander round the outside of
  // it, which looks like a bug because it is one.
  return { grid, rings, inside: walls };
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
        const route = [[from[0], from[1], plate.grid.floor]];
        let x = from[0], y = from[1];
        for (let step = 0; step < 4000; step++) {
          const way = downhill(field, x, y);
          if (!way) break;
          x += way[0] * grain * 0.7;
          y += way[1] * grain * 0.7;
          route.push([x, y, plate.grid.floor]);
          if (walkDistance(field, x, y) < grain * 1.5) break;
        }
        route.push([to[0], to[1], plate.grid.floor]);

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
        const ring = seen.points.map(p => [p[0], p[1], plate.grid.floor]);
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
    this.grain = 250;
    // Sixty on a floor, not two hundred. A crowd that is jammed from the first
    // second shows you nothing except that it is jammed; start where it flows
    // and wind it up until it stops, because the number where it stops is the
    // answer you came for.
    this.population = 60;
    this.show = { agents: true, trails: true, density: true, field: false, plate: true };
    this.map = "footfall";               // which of the three the floor shows
    this.headings = new Float32Array(900);
    this.plate = null;
    this.fields = [];
    this.portals = [];
    this.crowd = makeCrowd(900);
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
        <span class="fl-read" id="fl-people-read">60</span>
        <button class="btn" id="fl-play">Pause</button>
        <button class="btn" id="fl-reset">Reset</button>
      </div>
      <div class="fl-row">
        <span class="fl-tag">Cut at</span>
        <input type="range" id="fl-cut" min="100" max="2400" step="50" value="1100">
        <span class="fl-read" id="fl-cut-read">1.10 m</span>
        <span class="fl-tag" style="width:auto">Grid</span>
        <input type="range" id="fl-grain" min="100" max="800" step="50" value="250">
        <span class="fl-read" id="fl-grain-read">250 mm</span>
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
    q("fl-people").addEventListener("input", e => {
      this.population = +e.target.value;
      q("fl-people-read").textContent = this.population;
    });
    q("fl-cut").addEventListener("input", e => {
      this.cut = +e.target.value;
      q("fl-cut-read").textContent = (this.cut / 1000).toFixed(2) + " m";
      this.rebuild();
    });
    q("fl-grain").addEventListener("input", e => {
      this.grain = +e.target.value;
      q("fl-grain-read").textContent = this.grain + " mm";
      this.rebuild();
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
      this.paintHeat();
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
      new THREE.BufferAttribute(new Float32Array(900 * this.trailLength * 3), 3));
    trail.setAttribute("color",
      new THREE.BufferAttribute(new Float32Array(900 * this.trailLength * 3), 3));
    trail.setDrawRange(0, 0);
    this.trails = new THREE.LineSegments(trail, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.trails.renderOrder = 11;
    this.group.add(this.trails);
    this.history = new Float32Array(900 * this.trailLength * 2);
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
        new THREE.MeshBasicMaterial({ color: state.colour }), 900);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
    this.spot = new THREE.Object3D();
    this.headings = new Float32Array(900);
  }

  //! The crowding map, as a texture on a plane rather than a mesh per cell:
  //! twenty thousand cells is twenty thousand quads, and it is one upload.
  makePlate() {
    const { THREE } = this.kit;
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

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w * grid.cell, h * grid.cell),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    plane.position.set(grid.lo[0] + w * grid.cell / 2,
                       grid.lo[1] + h * grid.cell / 2, grid.floor + 2);
    plane.renderOrder = 10;
    this.plateGroup.add(plane);
    this.heatPlane = plane;

    // The plan itself, as the outlines the footprints really are - drawn from
    // the rings rather than from the raster, so a wall is a line and not a
    // staircase.
    const points = [];
    for (const ring of this.plate.rings)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        points.push(new THREE.Vector3(a[0], a[1], grid.floor + 6),
                    new THREE.Vector3(b[0], b[1], grid.floor + 6));
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
        points.push(new THREE.Vector3(x - way[0] * reach, y - way[1] * reach, grid.floor + 4),
                    new THREE.Vector3(tip[0], tip[1], grid.floor + 4));
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
    const meshes = [];
    for (const [id, mesh] of this.kit.streams()) {
      const entry = (this.kit.tree().features || []).find(f => f.id === id);
      if (!entry || entry.category === "datum" || this.kit.hidden().has(id)) continue;
      if (entry.type === "Portal") continue;             // a portal is not a wall
      if (mesh.positions && mesh.index) meshes.push(mesh);
    }
    this.portals = (this.kit.tree().features || [])
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

    this.plate = meshes.length
      ? plateOf(meshes, this.cut, this.grain,
                { include: this.portals.map(p => [p.at[0], p.at[1]]) })
      : null;
    const note = this.bar.querySelector("#fl-note");
    if (!this.plate) {
      this.fields = [];
      note.textContent = "nothing in the model has a footprint at this height";
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
    note.textContent = (this.walkableArea() / 1e6).toFixed(0) + " m² walkable · "
      + this.plate.rings.length + " footprints"
      + " · " + this.goals.length + (this.goals.length === 1 ? " destination" : " destinations")
      + (this.portals.length ? "" : ", the corners of the floor");
    this.makePlate();
    this.makeField();
    this.trim();
  },

  //! Walkable floor INSIDE the footprints - the number a schedule of areas
  //! would recognise. The padded grid outside the building is not floor.
  walkableArea() {
    if (!this.plate) return 0;
    const { grid, inside } = this.plate;
    let cells = 0;
    for (let y = inside.lo[1]; y <= inside.hi[1]; y += grid.cell)
      for (let x = inside.lo[0]; x <= inside.hi[0]; x += grid.cell)
        if (!isBlocked(grid, x, y)) cells++;
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
    for (let r = 1; r < 40; r++)
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
      if (walkDistance(this.fields[0], x, y) === null) continue;
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
    this.crowd = makeCrowd(900);
    this.clock = 0;
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
      measureDensity(this.density, this.crowd, this.plate.grid, step);
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
    const z = grid.floor;
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

      this.spot.position.set(this.crowd.x[a], this.crowd.y[a], z);
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
    let at = 0;
    for (let a = 0; a < this.crowd.count; a++)
      for (let s = 1; s < n; s++) {
        const older = (a * n + (this.historyAt + s) % n) * 2;
        const newer = (a * n + (this.historyAt + s + 1) % n) * 2;
        const ax = this.history[older], ay = this.history[older + 1];
        const bx = this.history[newer], by = this.history[newer + 1];
        if (!ax && !ay) continue;
        // A trail must not leap across the room when somebody is removed and
        // the last one is swapped into their slot.
        if (Math.hypot(bx - ax, by - ay) > 2000) continue;
        const fade = s / n * 0.85;
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
  paintHeat() {
    if (!this.heat || !this.show.density || this.map === "off") return;
    const { grid } = this.plate;
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
      { name: "plateOf", takes: "meshes, cut, grain", gives: "{ grid, rings }",
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
function mergedPerson(THREE) {
  const body = new THREE.CylinderGeometry(BODY * 0.34, BODY * 0.30, 1150, 10);
  body.rotateX(Math.PI / 2);                        // z is up in this world
  body.translate(0, 0, 575);
  const head = new THREE.SphereGeometry(BODY * 0.30, 12, 9);
  head.translate(0, 0, 1420);
  const nose = new THREE.ConeGeometry(BODY * 0.15, BODY * 0.5, 7);
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
