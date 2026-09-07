import { createWasmKernel } from "./wasm-kernel.js";
import { createHttpKernel } from "./http-kernel.js";
import { ENVIRONMENTS, FINISHES, Showroom, findFinish } from "./showroom.js";
import { Mdl } from "./mdl.js";
import { acceptsFrom, dataLines, SAMPLES } from "./ocaf.js";
import { GraphEditor } from "./graph.js";

"use strict";

/* ==========================================================================
   The interface.

   It owns no geometry.  A kernel holds the OCAF document - the label tree, the
   parameters, the B-Rep - and this page mirrors that tree and draws the
   triangles the kernel hands it.  When a parameter changes the kernel
   re-executes the functions downstream of the edit, bumps their revision, and
   the page re-fetches the triangle stream for those shapes only.

   Two kernels answer the same calls:

     the page kernel   OpenCascade compiled to WebAssembly, running right here
     a native kernel   ocafcad serve / python -m ocafpy serve, over HTTP, with
                       real OCAF persistence and STEP export

   Everything below this point talks to `kernel` and never learns which it got.
   ========================================================================== */

let kernel = null;
let ready = false;

const state = {
  schema: null,        // the feature catalogue, from the kernel
  tree: null,          // the mirror of the OCAF document
  report: null,        // what the last regeneration did
  selected: null,      // feature id
  edited: null,        // feature id whose definition the panel shows
  hidden: new Set(),   // per-view hide; the document is not touched
  stream: null,        // what the last triangle fetch cost
};

//! The part the page opens on, so the first thing you see is a real solid.
const STARTER = {
  format: "ocaf-parametric-model", version: 1, name: "Part1", units: "mm",
  features: [
    { id: "PT1", type: "Point",  name: "Origin",      args: { x: 0, y: 0, z: 0 } },
    { id: "VZ",  type: "Vector", name: "Z Direction", args: { dx: 0, dy: 0, dz: 1 } },
    { id: "PL1", type: "Plane",  name: "XY Plane",
      args: { origin: { ref: "PT1" }, normal: { ref: "VZ" }, size: 200 } },
    { id: "CB1", type: "Cube",   name: "Cube.1",
      args: { origin: { ref: "PT1" }, plane: { ref: "PL1" }, dx: 80, dy: 80, dz: 80 } },
  ],
};

/* ==========================================================================
   The one way in.

   Nothing below calls the kernel directly. Every button, every slider, every
   wire dragged in the node graph and every line typed into its console becomes
   one JSON edit, goes through this channel, and the answer redraws whatever is
   open. That is what makes the tree and the graph the same program: they are
   two ways of writing the same text.
   ========================================================================== */

const mdl = new Mdl({
  get kernel() { return kernel; },
  apply: (payload, hint) => applyState(payload, hint),
  setNode: (id, x, y) => graph.setNode(id, x, y),
  readLayout: block => (block === undefined ? graph.layoutJson() : graph.readLayout(block)),
  select: id => select(id, false),
  selected: () => state.selected,
});

//! Runs an edit and redraws from the answer. Refusals land in the definition
//! panel and in the graph console, both.
async function edit(command, options = {}) {
  try { return await mdl.run(command, options); }
  catch (err) { showError(err.message); return null; }
}

const schemaType = type => (state.schema ? state.schema.types.find(t => t.type === type) : null) || null;
const feature = id => state.tree ? state.tree.features.find(f => f.id === id) || null : null;
const argSpec = (spec, key) => spec.args.find(a => a.key === key) || null;

/* ==========================================================================
   Viewport.  Nothing here knows what a cube is - it draws the triangles and
   the polylines the kernel sent for each shape.
   ========================================================================== */

const viewportEl = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewportEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 1, 40000);
const world = new THREE.Group();
scene.add(world);

const key = new THREE.DirectionalLight(0xffffff, 0.78);
const fill = new THREE.DirectionalLight(0xffffff, 0.32);
key.position.set(220, -320, 420);
fill.position.set(-360, 240, 120);
scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.55));

const THEME = {};
let grid = null, axes = null;

function readTheme() {
  const style = getComputedStyle(document.documentElement);
  for (const name of ["shape", "shape-edge", "curve", "accent", "datum", "grid", "grid-axis", "bad"])
    THEME[name] = new THREE.Color(style.getPropertyValue("--" + name).trim() || "#888888");
  viewportEl.style.background =
    `linear-gradient(${style.getPropertyValue("--view-top")}, ${style.getPropertyValue("--view-bottom")})`;
}

function buildGround() {
  for (const old of [grid, axes]) if (old) { world.remove(old); old.geometry.dispose(); old.material.dispose(); }
  grid = new THREE.GridHelper(1000, 20, THEME["grid-axis"], THEME.grid);
  grid.rotation.x = Math.PI / 2;            // OpenCascade is Z-up
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  world.add(grid);

  const span = 520;
  axes = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-span, 0, 0), new THREE.Vector3(span, 0, 0),
      new THREE.Vector3(0, -span, 0), new THREE.Vector3(0, span, 0)]),
    new THREE.LineBasicMaterial({ color: THEME["grid-axis"] }));
  world.add(axes);
}

/* ------------------------------------------------------------ orbit + zoom */
const view = { target: new THREE.Vector3(0, 0, 40), distance: 460, yaw: -0.72, pitch: 0.62 };
const STANDARD_VIEWS = {
  iso:   { yaw: -0.72, pitch: 0.62 },
  top:   { yaw: -Math.PI / 2, pitch: 1.5 },
  front: { yaw: -Math.PI / 2, pitch: 0.001 },
  right: { yaw: 0, pitch: 0.001 },
};

function placeCamera() {
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  camera.position.set(
    view.target.x + view.distance * cp * Math.cos(view.yaw),
    view.target.y + view.distance * cp * Math.sin(view.yaw),
    view.target.z + view.distance * sp);
  camera.up.set(0, 0, 1);
  camera.lookAt(view.target);
}

(function bindControls() {
  let mode = null, lastX = 0, lastY = 0, moved = 0;
  const el = renderer.domElement;

  el.addEventListener("pointerdown", event => {
    // An axis of the handle takes the drag before the camera does.
    if (event.button === 0 && !event.shiftKey && grabGizmo(event)) mode = "gizmo";
    else mode = (event.shiftKey || event.button === 1 || event.button === 2) ? "pan" : "orbit";
    lastX = event.clientX; lastY = event.clientY; moved = 0;
    el.setPointerCapture(event.pointerId);
  });
  el.addEventListener("pointermove", event => {
    if (!mode) return;
    if (mode === "gizmo") { dragGizmo(event); return; }
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (mode === "orbit") {
      view.yaw -= dx * 0.008;
      view.pitch = Math.max(-1.53, Math.min(1.53, view.pitch + dy * 0.008));
    } else {
      const scale = view.distance * 0.0016;
      const away = new THREE.Vector3().subVectors(camera.position, view.target);
      const right = new THREE.Vector3().crossVectors(away, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, away).normalize();
      view.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    }
    placeCamera(); draw();
  });
  el.addEventListener("pointerup", event => {
    if (mode === "gizmo") dropGizmo();
    else if (mode === "orbit" && moved < 4 && !pickVertex(event)) {
      // While a mesh is being edited by hand, the viewport belongs to its
      // handles: a click that misses one drops the vertex, it does not walk off
      // to whatever solid happened to be behind it. Esc, or the tree, leaves.
      if (handEditing()) { meshEdit.vertex = -1; refreshMeshEdit(); buildPanel(); }
      else pick(event);
    }
    mode = null;
  });
  el.addEventListener("pointercancel", () => { meshEdit.axis = null; mode = null; });
  el.addEventListener("contextmenu", event => event.preventDefault());
  el.addEventListener("wheel", event => {
    event.preventDefault();
    view.distance = Math.max(20, Math.min(8000, view.distance * (1 + Math.sign(event.deltaY) * 0.12)));
    if (meshEdit.gizmo) refreshMeshEdit();
    placeCamera(); draw();
  }, { passive: false });
})();

let frameQueued = false;
function draw() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; renderer.render(scene, camera); });
}

function resize() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  draw();
}

/* -------------------------------------------------- the streamed triangles */
const shapes = new Map();   // feature id -> { revision, group }
const pickable = [];

function disposeGroup(group) {
  group.traverse(object => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) [].concat(object.material).forEach(m => m.dispose());
  });
  world.remove(group);
}

//! Turns one shape's triangle stream into scene objects.
//! A datum is drawn faintly because it is scaffolding. A curve a loft is built
//! on is not scaffolding until something consumes it, so it is drawn as
//! geometry - which is also how you find it to wire it up.
const drawsFaint = entry => !!entry && entry.category === "datum" && entry.type !== "Line";

function groupFromStream(mesh, entry) {
  const group = new THREE.Group();
  const datum = drawsFaint(entry);
  group.userData.solid = !datum;
  group.userData.curve = !!entry && entry.produces === "curve";

  if (mesh.positions && mesh.index) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    if (mesh.normals)
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
    geometry.setIndex(mesh.index);

    const material = datum
      ? new THREE.MeshBasicMaterial({ color: THEME.datum, transparent: true, opacity: 0.05,
                                      side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: THEME.shape, metalness: 0.15, roughness: 0.55 });

    const solid = new THREE.Mesh(geometry, material);
    solid.userData.id = mesh.id;
    group.add(solid);
    if (!datum) pickable.push(solid);
  }

  if (mesh.edges && mesh.edges.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.edges, 3));
    // A curve is the feature, not the outline of one, so it is drawn in its own
    // colour at full strength rather than as a solid's tangent edge.
    const curve = !!entry && entry.produces === "curve";
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: datum ? THEME.datum : curve ? THEME.curve : THEME["shape-edge"],
      transparent: true, opacity: datum ? 0.42 : curve ? 1 : 0.4 }));
    group.add(lines);
  }

  // A vertex carries no triangles, so every one is drawn as a marker. A
  // DivideCurve can send two hundred, so they share one geometry between them.
  const marks = mesh.points && mesh.points.length ? mesh.points
              : mesh.point ? mesh.point : null;
  if (marks) {
    const dots = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position",
        new THREE.Float32BufferAttribute(marks, 3)),
      new THREE.PointsMaterial({ color: THEME.datum, size: 6, sizeAttenuation: false,
                                 transparent: true, opacity: 0.9 }));
    group.add(dots);
  }
  return group;
}

const streams = new Map();   // feature id -> the triangles the kernel last sent

function setShape(mesh) {
  streams.set(mesh.id, mesh);
  const existing = shapes.get(mesh.id);
  if (existing) disposeGroup(existing.group);
  const group = groupFromStream(mesh, feature(mesh.id));
  world.add(group);
  shapes.set(mesh.id, { revision: mesh.revision, group });
}

function rebuildPickList() {
  pickable.length = 0;
  for (const { group } of shapes.values())
    group.traverse(object => { if (object.isMesh && object.userData.id) pickable.push(object); });
}

//! The only reason the revision counter exists: ask for the shapes whose
//! parameters actually moved, and nothing else.
async function syncShapes() {
  const stale = [];
  for (const entry of state.tree.features) {
    const have = shapes.get(entry.id);
    if (entry.built && (!have || have.revision !== entry.revision)) stale.push(entry.id);
  }
  for (const id of [...shapes.keys()]) {
    if (!feature(id)) { disposeGroup(shapes.get(id).group); shapes.delete(id); streams.delete(id); }
  }

  if (stale.length && kernel) {
    const started = performance.now();
    const payload = await kernel.mesh(stale);
    let triangles = 0;
    for (const mesh of payload.features) { setShape(mesh); triangles += mesh.triangles || 0; }
    state.stream = { shapes: stale.length, triangles, ms: Math.round(performance.now() - started) };
    rebuildPickList();
  }

  applyVisibility();
  paintSelection();
  refreshMeshEdit();
  draw();
  if (staging && showroom.ready) showroom.setScene(state.tree.features, streams);
}

function applyVisibility() {
  for (const [id, { group }] of shapes) {
    const entry = feature(id);
    group.visible = !!entry && entry.visible && !state.hidden.has(id);
  }
}

const SELECTED_TINT = 0.42;
function paintSelection() {
  for (const [id, { group }] of shapes) {
    const selected = id === state.selected;
    group.traverse(object => {
      if (object.isMesh && object.material.isMeshStandardMaterial) {
        object.material.color.copy(THEME.shape);
        if (selected) object.material.color.lerp(THEME.accent, SELECTED_TINT);
        object.material.emissive.copy(THEME.accent);
        object.material.emissiveIntensity = selected ? 0.06 : 0;
      }
      if (object.isLineSegments && object.material.isLineBasicMaterial &&
          object.parent && object.parent.userData.solid) {
        // A curve keeps its own colour: the line is the feature, not the
        // silhouette of one, and dimming it to a tangent edge loses it.
        const own = object.parent.userData.curve ? THEME.curve : THEME["shape-edge"];
        object.material.color.copy(selected ? THEME.accent : own);
        object.material.opacity = selected ? 0.9 : object.parent.userData.curve ? 1 : 0.4;
      }
    });
  }
  draw();
}

/* ==========================================================================
   Editing a mesh by hand.

   A feature that holds hand edits - EditMesh - shows its cage vertices as
   handles. Click one, drag an axis, and the move is written into the model
   file as {"12": [4, 0, -2]}: an offset from wherever the mesh upstream put
   that vertex, not a position. So the edit survives a change upstream, reads
   as text, and can be typed instead of dragged.
   ========================================================================== */

const meshEdit = {
  id: null,        // the feature holding the edits
  vertex: -1,      // which vertex is selected
  dots: null,      // the handles
  gizmo: null,     // the three axes on the selected one
  axis: null,      // the one being dragged
  from: null,      // where the drag started, along that axis
  before: null,    // the offset the vertex had when the drag started
};

//! The feature being edited by hand, if the one on the panel holds hand edits.
function handEditing() {
  const entry = feature(state.edited);
  if (!entry) return null;
  const spec = schemaType(entry.type);
  return spec && spec.args.some(a => a.kind === "edits") ? entry : null;
}

const AXES = [
  { key: "x", dir: new THREE.Vector3(1, 0, 0), color: 0xd0473f },
  { key: "y", dir: new THREE.Vector3(0, 1, 0), color: 0x3f9e4d },
  { key: "z", dir: new THREE.Vector3(0, 0, 1), color: 0x2f7fd0 },
];

function clearMeshEdit() {
  for (const key of ["dots", "gizmo"]) {
    if (!meshEdit[key]) continue;
    world.remove(meshEdit[key]);
    disposeGroup(meshEdit[key]);
    meshEdit[key] = null;
  }
}

//! The cage of whatever is being edited, as clickable dots, plus the axes on
//! the one that is selected. Rebuilt whenever the mesh or the selection moves.
function refreshMeshEdit() {
  const entry = handEditing();
  clearMeshEdit();
  if (!entry) { meshEdit.id = null; meshEdit.vertex = -1; draw(); return; }
  if (meshEdit.id !== entry.id) { meshEdit.id = entry.id; meshEdit.vertex = -1; }

  const stream = streams.get(entry.id);
  const vertices = stream && stream.vertices;
  if (!vertices || !vertices.length) { draw(); return; }
  if (meshEdit.vertex >= vertices.length / 3) meshEdit.vertex = -1;

  const dots = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position",
      new THREE.Float32BufferAttribute(vertices, 3)),
    new THREE.PointsMaterial({ color: THEME.accent, size: 8, sizeAttenuation: false,
                               transparent: true, opacity: 0.95, depthTest: false }));
  dots.renderOrder = 5;
  dots.userData.handles = true;
  const group = new THREE.Group();
  group.add(dots);
  world.add(group);
  meshEdit.dots = group;

  if (meshEdit.vertex >= 0) {
    const at = new THREE.Vector3(vertices[meshEdit.vertex * 3],
      vertices[meshEdit.vertex * 3 + 1], vertices[meshEdit.vertex * 3 + 2]);
    meshEdit.gizmo = buildGizmo(at);
    world.add(meshEdit.gizmo);
  }
  draw();
}

//! Three arrows. Sized against the camera distance so they stay the same size
//! on screen however far out you are.
function buildGizmo(at) {
  const group = new THREE.Group();
  group.position.copy(at);
  const span = view.distance * 0.09;
  for (const axis of AXES) {
    const material = new THREE.MeshBasicMaterial({ color: axis.color, depthTest: false,
                                                   transparent: true, opacity: 0.95 });
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(span * 0.022, span * 0.022, span, 8), material);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(span * 0.07, span * 0.2, 12), material);
    // The cylinder is built along Y; each axis turns it onto its own.
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.dir);
    shaft.quaternion.copy(turn);
    tip.quaternion.copy(turn);
    shaft.position.copy(axis.dir).multiplyScalar(span * 0.5);
    tip.position.copy(axis.dir).multiplyScalar(span * 1.1);
    for (const part of [shaft, tip]) {
      part.userData.axis = axis.key;
      part.renderOrder = 6;
      group.add(part);
    }
  }
  return group;
}

const raycaster = new THREE.Raycaster();

//! Where a ray comes closest to an axis through a point - the whole of what
//! dragging one arrow means.
function alongAxis(ray, origin, dir) {
  const w = new THREE.Vector3().subVectors(origin, ray.origin);
  const a = dir.dot(dir), b = dir.dot(ray.direction), c = ray.direction.dot(ray.direction);
  const d = dir.dot(w), e = ray.direction.dot(w);
  const denominator = a * c - b * b;
  if (Math.abs(denominator) < 1e-9) return 0;
  return (b * e - c * d) / denominator;
}

function rayFrom(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
  return raycaster;
}

//! An arrow under the pointer starts a drag; nothing else here does.
function grabGizmo(event) {
  if (!meshEdit.gizmo) return null;
  const hits = rayFrom(event).intersectObjects(meshEdit.gizmo.children, false);
  if (!hits.length) return null;
  const axis = AXES.find(a => a.key === hits[0].object.userData.axis);
  const entry = feature(meshEdit.id);
  const moves = (entry && entry.lists && entry.lists.moves) || {};
  meshEdit.axis = axis;
  meshEdit.from = alongAxis(raycaster.ray, meshEdit.gizmo.position, axis.dir);
  meshEdit.before = (moves[meshEdit.vertex] || [0, 0, 0]).slice();
  return axis;
}

//! Live while the arrow is held: the handle follows, and the mesh is not
//! rebuilt until it is let go - one edit for the drag, not one per frame.
function dragGizmo(event) {
  const axis = meshEdit.axis;
  if (!axis) return;
  const now = alongAxis(rayFrom(event).ray, meshEdit.gizmo.position, axis.dir);
  const step = now - meshEdit.from;
  meshEdit.from = now;
  meshEdit.gizmo.position.addScaledVector(axis.dir, step);
  const scale = (feature(meshEdit.id) || {}).values;
  const factor = scale && Number.isFinite(scale.scale) && Math.abs(scale.scale) > 1e-6
    ? scale.scale : 1;
  const which = { x: 0, y: 1, z: 2 }[axis.key];
  meshEdit.before[which] += step / factor;
  draw();
}

function dropGizmo() {
  if (!meshEdit.axis) return;
  // A hand drag is not worth six decimal places; the file stays readable.
  const offset = meshEdit.before.map(v => Math.round(v * 1000) / 1000);
  meshEdit.axis = null;
  edit({ op: "vertex", id: meshEdit.id, index: meshEdit.vertex,
         x: offset[0], y: offset[1], z: offset[2] });
}

//! A handle under the pointer selects that vertex. The threshold is in pixels,
//! so a vertex is as easy to hit far away as up close.
function pickVertex(event) {
  if (!meshEdit.dots) return false;
  const cast = rayFrom(event);
  cast.params.Points.threshold = view.distance * 0.012;
  const hits = cast.intersectObject(meshEdit.dots.children[0], false);
  if (!hits.length) return false;
  meshEdit.vertex = hits[0].index;
  refreshMeshEdit();
  buildPanel();
  return true;
}

function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(pickable.filter(m => m.parent && m.parent.visible), false);
  select(hits.length ? hits[0].object.userData.id : null, false);
}

function fitView() {
  const box = new THREE.Box3();
  let any = false;
  for (const [id, { group }] of shapes) {
    const entry = feature(id);
    if (!group.visible || !entry || entry.category === "datum") continue;
    box.expandByObject(group); any = true;
  }
  if (!any) for (const [, { group }] of shapes) if (group.visible) { box.expandByObject(group); any = true; }
  if (!any || box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()).length() || 200;
  view.target.copy(box.getCenter(new THREE.Vector3()));
  view.distance = Math.max(120, size * 1.9);
  placeCamera(); draw();
}

/* ==========================================================================
   Interface.
   ========================================================================== */

const ICONS = {
  Point: '<circle cx="8" cy="8" r="2.4" fill="currentColor"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.2"/>',
  Vector: '<path d="M2 13L12 4" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 2.5L9 3.6l3.4 3.2z" fill="currentColor"/>',
  Line: '<path d="M2 13L14 3" stroke="currentColor" stroke-width="1.5"/><circle cx="2.6" cy="12.6" r="1.6" fill="currentColor"/><circle cx="13.4" cy="3.4" r="1.6" fill="currentColor"/>',
  Plane: '<path d="M1.5 10.5L6 4.5h8.5L10 10.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  Cube: '<path d="M8 1.6l5.6 3v6.8L8 14.4l-5.6-3V4.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.4 4.6L8 7.6l5.6-3M8 7.6v6.8" stroke="currentColor" stroke-width="1.1"/>',
  Sphere: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><ellipse cx="8" cy="8" rx="2.7" ry="6.3" fill="none" stroke="currentColor" stroke-width="1"/>',
  Array: '<rect x="1.6" y="1.6" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.4" y="1.6" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1.6" y="9.4" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.4" y="9.4" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".45"/>',
  // Both written features wear angle brackets; what sits between them says
  // which sample the code starts from.
  Script: '<path d="M5.2 4.4L2 8l3.2 3.6M10.8 4.4L14 8l-3.2 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M6.6 5.2c2.8 0 2.8 1.4 0 1.4M6.6 6.6c2.8 0 2.8 1.4 0 1.4M6.6 8c2.8 0 2.8 1.4 0 1.4M6.6 9.4c2.8 0 2.8 1.4 0 1.4" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>',
  // The building's own silhouette between the brackets: the long slope, the
  // valley, the peak.
  Center: '<path d="M4.6 4.2L1.6 8l3 3.8M11.4 4.2L14.4 8l-3 3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M5.2 11.2c0-2.6.7-3.9 1.6-3.9s1 1.3 1.1 2.4c.2 1.6.9 2.6 1.6-1 .5-2.6 1-3.5 1.4-3.5" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/>',
  Ribbon: '<path d="M5.2 4.4L2 8l3.2 3.6M10.8 4.4L14 8l-3.2 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M6.3 10.6c1-3.6 2.2-5 3.4-5s1.5 1.1 0 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'
        + '<path d="M6.3 8.6c1.1-2.6 2-3.6 3-3.6" fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round" opacity=".6"/>',
  Fillet: '<path d="M2.5 13.5V8a5.5 5.5 0 015.5-5.5h5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 2.5h5.5M2.5 2.5v5.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/>',

  /* ------------------------------------------------------------ numbers */
  Number: '<path d="M2.5 11.5h11" stroke="currentColor" stroke-width="1.2"/>'
        + '<circle cx="10" cy="11.5" r="2.4" fill="currentColor"/>'
        + '<path d="M4 6.6V3.4M2.6 4.6L4 3.2l1.4 1.4M8.4 3.2h3.2M8.4 6.4h3.2" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/>',
  Series: '<circle cx="2.6" cy="8" r="1.3" fill="currentColor"/><circle cx="6.4" cy="8" r="1.3" fill="currentColor"/>'
        + '<circle cx="10.2" cy="8" r="1.3" fill="currentColor"/><circle cx="14" cy="8" r="1.3" fill="currentColor" opacity=".45"/>'
        + '<path d="M2.6 12.6h11.4" stroke="currentColor" stroke-width=".9" opacity=".4"/>',
  Range: '<path d="M2.5 8h11" stroke="currentColor" stroke-width="1.2"/>'
       + '<path d="M2.5 5v6M13.5 5v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
       + '<path d="M6.2 6.4v3.2M9.8 6.4v3.2" stroke="currentColor" stroke-width="1" opacity=".55"/>',
  Math: '<path d="M2.6 5.4h4M4.6 3.4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
      + '<path d="M9.4 3.8l3.6 3.6M13 3.8L9.4 7.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
      + '<path d="M2.6 11.4h4M9.4 10.2h3.6M9.4 12.6h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
      + '<circle cx="4.6" cy="13.4" r=".9" fill="currentColor"/>',
  Expression: '<path d="M4.6 2.8C2.9 2.8 2.9 8 2.9 8s0 5.2 1.7 5.2M11.4 2.8c1.7 0 1.7 5.2 1.7 5.2s0 5.2-1.7 5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
            + '<path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  Panel: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>'
       + '<path d="M4 6.2h6M4 8.4h8M4 10.6h4.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".8"/>',

  /* ------------------------------------------------------------- curves */
  Circle: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3"/>'
        + '<circle cx="8" cy="8" r="1.1" fill="currentColor"/>',
  Polyline: '<path d="M2.2 12.4l3.4-6.2 3.2 3.6 4.9-6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>'
          + '<circle cx="2.2" cy="12.4" r="1.2" fill="currentColor"/><circle cx="5.6" cy="6.2" r="1.2" fill="currentColor"/>'
          + '<circle cx="8.8" cy="9.8" r="1.2" fill="currentColor"/><circle cx="13.7" cy="3.8" r="1.2" fill="currentColor"/>',
  Interpolate: '<path d="M2.2 12.4C4.2 12.4 3.6 5.4 6.4 5.4s2 5.6 4.2 5.6 1.6-7.2 3.2-7.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
             + '<circle cx="2.2" cy="12.4" r="1.2" fill="currentColor"/><circle cx="6.4" cy="5.4" r="1.2" fill="currentColor"/>'
             + '<circle cx="10.6" cy="11" r="1.2" fill="currentColor"/><circle cx="13.8" cy="3.8" r="1.2" fill="currentColor"/>',

  /* ----------------------------------------------------------- analysis */
  EvaluateCurve: '<path d="M1.8 12.6C4.6 12.6 4.2 3.4 8 3.4s3.4 9.2 6.2 9.2" fill="none" stroke="currentColor" stroke-width="1.2"/>'
               + '<circle cx="8" cy="3.4" r="2" fill="currentColor"/>'
               + '<path d="M4.4 3.4h7.2" stroke="currentColor" stroke-width="1" stroke-dasharray="1.6 1.6"/>',
  DivideCurve: '<path d="M1.8 12.6C4.6 12.6 4.2 3.4 8 3.4s3.4 9.2 6.2 9.2" fill="none" stroke="currentColor" stroke-width="1.2"/>'
             + '<circle cx="2.6" cy="11.4" r="1.15" fill="currentColor"/><circle cx="5.2" cy="6.1" r="1.15" fill="currentColor"/>'
             + '<circle cx="8" cy="3.4" r="1.15" fill="currentColor"/><circle cx="10.8" cy="6.1" r="1.15" fill="currentColor"/>'
             + '<circle cx="13.4" cy="11.4" r="1.15" fill="currentColor"/>',
  EvaluateSurface: '<path d="M1.6 10.2L6 5.2h8.4L10 10.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
                 + '<circle cx="8" cy="7.7" r="1.9" fill="currentColor"/>'
                 + '<path d="M8 7.7V2.6" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.6 1.6"/>',
  Measure: '<path d="M1.6 6.2h12.8v3.6H1.6z" fill="none" stroke="currentColor" stroke-width="1.2"/>'
         + '<path d="M4.4 6.2v2M7 6.2v2.9M9.6 6.2v2M12.2 6.2v2.9" stroke="currentColor" stroke-width="1"/>',

  /* --------------------------------------------------------- operations */
  Extrude: '<path d="M2.6 12.6h6.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
         + '<path d="M2.6 12.6V6.4h6.8v6.2M2.6 6.4L5.6 3.4h6.8L9.4 6.4M12.4 3.4v6.2L9.4 12.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  Loft: '<path d="M2.4 12.4c2.6 0 3-1.6 5.6-1.6s3 1.6 5.6 1.6" fill="none" stroke="currentColor" stroke-width="1.25"/>'
      + '<path d="M3.6 8c2.2 0 2.4-1.3 4.4-1.3S10.2 8 12.4 8" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".75"/>'
      + '<path d="M4.8 3.8c1.7 0 1.9-1 3.2-1s1.5 1 3.2 1" fill="none" stroke="currentColor" stroke-width="1" opacity=".5"/>',
  Boolean: '<circle cx="6" cy="8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.25"/>'
         + '<circle cx="10" cy="8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.25"/>'
         + '<path d="M8 4.1a4.4 4.4 0 000 7.8 4.4 4.4 0 000-7.8z" fill="currentColor" opacity=".35"/>',
  /* ------------------------------------------------------- the primitives
     a graph needs before it can compose anything on its own */
  Numbers: '<path d="M1.8 3.4h12.4M1.8 8h12.4M1.8 12.6h12.4" stroke="currentColor" stroke-width="1" opacity=".3"/>'
         + '<path d="M3 2.2v2.4M6.4 2.2v2.4M9.8 2.2v2.4M13.2 2.2v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
         + '<path d="M3 6.8v2.4M6.4 6.8v2.4M9.8 6.8v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
         + '<path d="M3 11.4v2.4M6.4 11.4v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  Join: '<rect x="1.4" y="2.4" width="5.4" height="5.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.15"/>'
      + '<rect x="9.2" y="2.4" width="5.4" height="5.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.15"/>'
      + '<rect x="5.3" y="8.4" width="5.4" height="5.4" rx="1" fill="currentColor" opacity=".25"/>'
      + '<rect x="5.3" y="8.4" width="5.4" height="5.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.15"/>'
      + '<path d="M4.1 7.8v.8h7.8v-.8" fill="none" stroke="currentColor" stroke-width="1"/>',
  Drape: '<path d="M1.6 12.4c2.6 0 3.2-5.2 6.4-5.2s3.8 5.2 6.4 5.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
       + '<circle cx="4" cy="2.4" r="1.15" fill="currentColor"/><circle cx="8" cy="2.4" r="1.15" fill="currentColor"/><circle cx="12" cy="2.4" r="1.15" fill="currentColor"/>'
       + '<path d="M4 4.2v3.9M8 4.2v2M12 4.2v3.9" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 1.5"/>'
       + '<path d="M2.9 8.9L4 10l1.1-1.1M6.9 7L8 8.1 9.1 7M10.9 8.9L12 10l1.1-1.1" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/>',
  PlaceAt: '<path d="M2.2 12.6c2.4 0 3-3.4 5.8-3.4s3.4 3.4 5.8 3.4" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".45"/>'
         + '<rect x="1.2" y="7.2" width="3.4" height="3.4" rx=".6" fill="none" stroke="currentColor" stroke-width="1.2"/>'
         + '<rect x="6.3" y="4.6" width="3.4" height="3.4" rx=".6" fill="none" stroke="currentColor" stroke-width="1.2" transform="rotate(16 8 6.3)"/>'
         + '<rect x="11.4" y="7.2" width="3.4" height="3.4" rx=".6" fill="none" stroke="currentColor" stroke-width="1.2" transform="rotate(-14 13.1 8.9)"/>',

  /* --------------------------------------------------------------- mesh */
  MeshBox: '<path d="M8 1.6l5.6 3v6.8L8 14.4l-5.6-3V4.6z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>'
         + '<path d="M2.4 4.6L8 7.6l5.6-3M8 7.6v6.8M8 1.6v0" stroke="currentColor" stroke-width="1"/>'
         + '<path d="M5.2 3.1v7.6M10.8 3.1v7.6M2.4 8h11.2" stroke="currentColor" stroke-width=".75" opacity=".55"/>',
  MeshGrid: '<path d="M1.6 10.4L6 5.6h8.4L10 10.4z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>'
          + '<path d="M4.1 8h8.4M7.5 5.6L5.1 10.4M10.3 5.6L7.9 10.4" stroke="currentColor" stroke-width=".8" opacity=".7"/>',
  MeshFromShape: '<path d="M2.2 4.6L6.4 2.2l4.2 2.4v4.8L6.4 11.8 2.2 9.4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>'
               + '<path d="M8.4 12.6h5.4M11.6 10.4l2.2 2.2-2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>',
  EditMesh: '<path d="M2.2 11.4L6 5.2l3 3.2 2.4-3.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>'
          + '<rect x="1" y="10.2" width="2.4" height="2.4" fill="currentColor"/>'
          + '<rect x="4.8" y="4" width="2.4" height="2.4" fill="currentColor"/>'
          + '<rect x="7.8" y="7.2" width="2.4" height="2.4" fill="currentColor"/>'
          + '<rect x="10.4" y="3" width="2.4" height="2.4" fill="currentColor"/>'
          + '<path d="M13.6 4.2v4M11.6 6.2h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".6"/>',
  Subdivide: '<path d="M2.4 13.2V6.4L8 3.4l5.6 3v6.8" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round" opacity=".45"/>'
           + '<path d="M3.6 12.6c0-4 1.8-6.2 4.4-6.2s4.4 2.2 4.4 6.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>'
           + '<circle cx="2.4" cy="13.2" r="1.1" fill="currentColor" opacity=".55"/><circle cx="8" cy="3.4" r="1.1" fill="currentColor" opacity=".55"/>'
           + '<circle cx="13.6" cy="13.2" r="1.1" fill="currentColor" opacity=".55"/>',
  Weld: '<circle cx="5.4" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.2"/>'
      + '<circle cx="10.6" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.2"/>'
      + '<path d="M7.1 8h1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<path d="M4.4 3.6l1.4 1.4M11.6 3.6l-1.4 1.4" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".55"/>',
  FillHoles: '<path d="M1.8 4.2h12.4v7.6H1.8z" fill="none" stroke="currentColor" stroke-width="1.15"/>'
           + '<path d="M6 5.6h4.4l1.2 2.4-1.6 2.4H6.4L5 8z" fill="currentColor" opacity=".35"/>'
           + '<path d="M6 5.6h4.4l1.2 2.4-1.6 2.4H6.4L5 8z" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round"/>',
  MeshMerge: '<path d="M2 5.4h4.6v5.2H2z" fill="none" stroke="currentColor" stroke-width="1.15"/>'
           + '<path d="M9.4 5.4H14v5.2H9.4z" fill="none" stroke="currentColor" stroke-width="1.15"/>'
           + '<path d="M6.6 5.4h2.8v5.2H6.6z" fill="none" stroke="currentColor" stroke-width="1.05" stroke-dasharray="1.7 1.5" opacity=".85"/>'
           + '<path d="M6.6 7.4h2.8M6.6 8.8h2.8" stroke="currentColor" stroke-width=".8" opacity=".45"/>',
  MeshTransform: '<path d="M2.4 9.6L6 6.4l3.4 3 3.6-3.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>'
               + '<path d="M8 14.2V11M6.5 12.5L8 11l1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>'
               + '<path d="M8 1.8v3.4M6.5 3.3L8 1.8l1.5 1.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>',
  MeshDisplace: '<path d="M1.8 11.2h12.4" stroke="currentColor" stroke-width="1.1" opacity=".45"/>'
              + '<path d="M1.8 8.4c2 0 2-4.4 4.1-4.4s2.1 4.4 4.2 4.4 2.1-3 4.1-3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>'
              + '<path d="M3.6 11.2V9.4M7 11.2V6.6M10.4 11.2V9M13.6 11.2V7" stroke="currentColor" stroke-width=".85" opacity=".6"/>',

  Project: '<path d="M3 4.4C5 4.4 5 1.8 8 1.8s3 2.6 5 2.6" fill="none" stroke="currentColor" stroke-width="1.2"/>'
         + '<path d="M1.6 12.4h12.8" stroke="currentColor" stroke-width="1.2"/>'
         + '<path d="M3 6v4.6M8 3.4v7M13 6v4.6" stroke="currentColor" stroke-width="1" stroke-dasharray="1.6 1.8" opacity=".7"/>',
  part: '<path d="M2.5 4.2L8 1.5l5.5 2.7v7.6L8 14.5l-5.5-2.7z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  // A slider that could be taken from somewhere else wears this.
  wire: '<path d="M6.6 9.4L9.4 6.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
      + '<path d="M8.6 4.4l1.1-1.1a2.6 2.6 0 013.6 3.6l-1.1 1.1M7.4 11.6l-1.1 1.1a2.6 2.6 0 01-3.6-3.6l1.1-1.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5s6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.3"/>',
};
const svg = body => '<svg viewBox="0 0 16 16" aria-hidden="true">' + body + "</svg>";
const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escapeAttr = s => escapeHtml(s).replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ toolbar */
function buildToolbar() {
  const rail = document.getElementById("rail");
  rail.textContent = "";
  const targets = {};
  const groups = state.schema.categories
    || [{ key: "datum" }, { key: "data" }, { key: "curve" },
        { key: "body" }, { key: "analysis" }, { key: "operation" }];
  groups.forEach((group, index) => {
    if (index) rail.appendChild(document.createElement("hr"));
    const box = document.createElement("div");
    box.dataset.group = group.key;
    rail.appendChild(box);
    targets[group.key] = box;
  });

  for (const spec of state.schema.types) {
    const button = document.createElement("button");
    button.className = "tool";
    button.innerHTML = svg(ICONS[spec.type] || ICONS.part);
    button.dataset.type = spec.type;
    button.dataset.label = spec.type;
    button.setAttribute("aria-label", spec.type);
    button.addEventListener("click", () => addFeature(spec.type));
    (targets[spec.category] || targets.operation || rail).appendChild(button);
  }
  document.getElementById("btn-def-close").innerHTML = svg(ICONS.close);
}

//! Fillet waits for its input, the way a CAD operation does.
function refreshToolbar() {
  const selected = feature(state.selected);
  for (const button of document.querySelectorAll(".tool[data-type]")) {
    const spec = schemaType(button.dataset.type);
    if (!spec) continue;
    if (spec.category === "operation") {
      const arg = spec.args.find(a => (a.kind === "ref" || a.kind === "refs") && a.consumes);
      const eligible = selected && arg && acceptsFrom(arg.accepts, selected)
        && !selected.consumedBy;
      button.disabled = !(ready && eligible);
      button.dataset.label = !ready ? "starting…"
        : eligible ? spec.type + " " + selected.name
        : selected && selected.consumedBy
          ? selected.name + " already has a " + (feature(selected.consumedBy) || {}).type
        : arg ? "Select " + arg.accepts.split(",").join(" or ") + " first"
        : spec.type;
    } else {
      button.disabled = !ready;
      button.dataset.label = spec.type;
    }
  }
}

/* ------------------------------------------------------- specification tree */
function buildTree() {
  const list = document.getElementById("tree");
  list.textContent = "";
  if (!state.tree) return;

  // The tree keeps CATIA's two sets and adds one: the features that compute
  // rather than build have no place in a part body.
  const sets = [
    { name: "Datums", features: state.tree.features.filter(f => f.category === "datum") },
    { name: "Parameters", optional: true,
      features: state.tree.features.filter(f => f.category === "data") },
    { name: "Meshes", optional: true,
      features: state.tree.features.filter(f => f.category === "mesh") },
    { name: "PartBody", features: state.tree.features.filter(f =>
        f.category !== "datum" && f.category !== "data" && f.category !== "mesh") },
  ];

  for (const set of sets) {
    // Datums and PartBody are always there, the way CATIA has them. The sets
    // that only exist when something is in them do not announce themselves.
    if (!set.features.length && set.optional) continue;
    const header = document.createElement("li");
    header.className = "set-label";
    header.textContent = set.name;
    list.appendChild(header);

    const branch = document.createElement("ul");
    branch.className = "branch";
    if (!set.features.length) {
      const empty = document.createElement("li");
      empty.className = "node";
      empty.innerHTML = '<span class="kind" style="padding-left:22px">empty</span>';
      branch.appendChild(empty);
    }
    for (const entry of set.features) branch.appendChild(treeNode(entry));
    list.appendChild(branch);
  }
}

function treeNode(entry) {
  const consumed = !!entry.consumedBy;
  const hidden = state.hidden.has(entry.id);

  const li = document.createElement("li");
  li.className = "node pick " + entry.category + (consumed ? " consumed" : "")
    + (entry.error ? " failed" : "") + (entry.id === state.selected ? " selected" : "");
  li.tabIndex = 0;
  li.title = consumed
    ? entry.name + " is consumed by " + (feature(entry.consumedBy) || {}).name
      + " — it stays in the tree, not in the 3D view"
    : (schemaType(entry.type) || {}).summary || entry.type;

  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.innerHTML = svg(ICONS[entry.type] || ICONS.part);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;

  const kind = document.createElement("span");
  kind.className = "kind";
  // A feature that computes says what it computed, where a solid says its type.
  kind.textContent = entry.error ? "error"
    : consumed ? "hidden"
    : entry.data && !entry.built
      ? entry.data.count + " " + entry.data.kind + (entry.data.count === 1 ? "" : "s")
      : entry.type.toLowerCase();

  li.append(glyph, label, kind);

  if (!consumed && entry.built) {
    const eye = document.createElement("button");
    eye.className = "eye" + (hidden ? " off" : "");
    eye.innerHTML = svg(hidden ? ICONS.eyeOff : ICONS.eye);
    eye.title = hidden ? "Show in 3D" : "Hide in 3D";
    eye.addEventListener("click", event => {
      event.stopPropagation();
      hidden ? state.hidden.delete(entry.id) : state.hidden.add(entry.id);
      buildTree(); applyVisibility(); draw();
    });
    li.appendChild(eye);
  }

  li.addEventListener("click", () => select(entry.id, false));
  li.addEventListener("dblclick", () => select(entry.id, true));
  li.addEventListener("keydown", event => {
    if (event.key === "Enter") { select(entry.id, true); event.preventDefault(); }
  });
  return li;
}

/* -------------------------------------------------------- definition panel */
function buildPanel() {
  const host = document.getElementById("def");
  const panel = document.getElementById("def-panel");
  host.textContent = "";
  const entry = feature(state.edited);
  panel.hidden = !entry;
  // A script needs room to be read; everything else stays narrow.
  panel.classList.toggle("wide", !!entry && !!entry.code);
  if (!entry) return;

  const spec = schemaType(entry.type);
  const head = document.createElement("div");
  head.className = "def-head";
  head.innerHTML =
    '<div class="name-row"><input class="name" id="feature-name" value="' + escapeAttr(entry.name) +
    '" aria-label="Feature name"' + "" + ">" +
    '<span class="badge ' + entry.category + '">' + entry.type + "</span></div>" +
    '<div class="meta">' + entry.entry + " · TFunction_Function<br>{" + spec.guid + "}<br>" +
    "revision " + entry.revision + (entry.built ? "" : " · not built") + "</div>";
  host.appendChild(head);

  const rename = head.querySelector("#feature-name");
  rename.addEventListener("change", () =>
    edit({ op: "rename", id: entry.id, name: rename.value.trim() }));

  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = spec.summary;
  host.appendChild(summary);

  const slot = document.createElement("div");
  slot.id = "def-notice";
  host.appendChild(slot);
  refreshPanelNotice();

  for (const arg of spec.args) {
    if (!argApplies(entry, arg)) continue;
    if (arg.kind === "code") continue;   // the editor goes below the parameters
    host.appendChild(arg.kind === "real" ? realField(entry, arg)
                   : arg.kind === "choice" ? choiceField(entry, arg)
                   : arg.kind === "edits" ? editsField(entry, arg)
                   : arg.kind === "text" ? textField(entry, arg)
                   : refField(entry, arg));
  }

  // What the feature computed, as opposed to what it built. A Panel is nothing
  // but this; a DivideCurve has it as well as geometry.
  if (entry.data) host.appendChild(dataField(entry));

  // Whatever the script declared for itself, as sliders.
  if (entry.params && entry.params.length) {
    const head = document.createElement("div");
    head.className = "params-head";
    head.textContent = "Parameters";
    host.appendChild(head);
    for (const param of entry.params) host.appendChild(scriptField(entry, param));
  }
  if (entry.code !== undefined) host.appendChild(codeEditor(entry));

  const actions = document.createElement("div");
  actions.className = "actions";
  // The shortcut is only a shortcut when the operation would take this feature.
  const filletSpec = schemaType("Fillet");
  const filletArg = filletSpec && filletSpec.args.find(a => a.kind === "ref" && a.consumes);
  if (!entry.consumedBy && filletArg && acceptsFrom(filletArg.accepts, entry)) {
    const fillet = document.createElement("button");
    fillet.className = "btn primary";
    fillet.innerHTML = svg(ICONS.Fillet) + "<span>Apply fillet</span>";
    fillet.addEventListener("click", () => { state.selected = entry.id; addFeature("Fillet"); });
    actions.appendChild(fillet);
  }
  const remove = document.createElement("button");
  remove.className = "btn";
  remove.textContent = "Delete feature";
  remove.addEventListener("click", () => deleteFeature(entry.id));
  actions.appendChild(remove);
  host.appendChild(actions);
}

//! Two surfaces, one document: a value changed in the node graph has to appear
//! on the panel's slider, and the other way round. Only the control under the
//! pointer is left alone.
function refreshPanelValues() {
  const entry = feature(state.edited);
  const host = document.getElementById("def");
  if (!entry || !host) return;
  const values = { ...entry.values };
  for (const param of entry.params || []) values[param.key] = param.value;
  for (const [key, value] of Object.entries(values)) {
    for (const prefix of ["p-", "n-", "s-", "sn-"]) {
      const input = host.querySelector("#" + prefix + key);
      if (input && input !== document.activeElement)
        input.value = input.type === "number" ? round(value) : value;
    }
    const group = host.querySelector('.segmented[data-key="' + key + '"]');
    if (group)
      [...group.children].forEach((button, index) =>
        button.setAttribute("aria-pressed", index === Math.round(value) ? "true" : "false"));
    const pick = host.querySelector('select.many[data-key="' + key + '"]');
    if (pick && pick !== document.activeElement) pick.value = String(Math.round(value));
  }
}

//! The panel is not rebuilt while a slider is being dragged - that would take
//! the slider out from under the pointer - so the feature's state is refreshed
//! on its own.
function refreshPanelNotice() {
  const slot = document.getElementById("def-notice");
  if (!slot) return;
  slot.textContent = "";
  const entry = feature(state.edited);
  if (!entry) return;
  if (entry.error) slot.appendChild(notice(entry.error, "bad"));
  else if (entry.consumedBy)
    slot.appendChild(notice("Consumed by " + (feature(entry.consumedBy) || {}).name +
      ". It stays in the tree; its result is replaced in the 3D view.", "info"));
}

//! An argument governed by a choice is shown only for the alternative it
//! belongs to, so one feature can carry two patterns without two dialogs.
function argApplies(entry, arg) {
  return !arg.showWhen || entry.values[arg.showWhen.key] === arg.showWhen.equals;
}

function choiceField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const current = entry.values[arg.key];

  field.innerHTML = '<div class="field-head"><label>' + arg.label + "</label></div>";
  // Two or three alternatives read as a switch. Eight do not fit in a panel this
  // wide, and squeezing them to four letters each helps nobody.
  if (arg.options.length > 3) {
    const pick = document.createElement("select");
    pick.className = "many";
    pick.dataset.key = arg.key;
    pick.innerHTML = arg.options.map((option, index) =>
      '<option value="' + index + '"' + (index === current ? " selected" : "") + ">" +
      escapeHtml(option) + "</option>").join("");
    // Switching the pattern changes which arguments apply, so the panel is
    // rebuilt rather than refreshed in place.
    pick.addEventListener("change", () =>
      pushParameter(entry.id, arg.key, Number(pick.value), true));
    field.appendChild(pick);
  } else {
    const group = document.createElement("div");
    group.className = "segmented";
    group.dataset.key = arg.key;
    group.setAttribute("role", "group");
    arg.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.setAttribute("aria-pressed", index === current ? "true" : "false");
      button.addEventListener("click", () => pushParameter(entry.id, arg.key, index, true));
      group.appendChild(button);
    });
    field.appendChild(group);
  }

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDataStd_Integer</b>";
  field.appendChild(path);
  return field;
}

//! One line of text: a list of numbers, typed. Applied when you leave the
//! field, because a half-typed list is not a list.
function textField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const value = (entry.texts && entry.texts[arg.key]) || "";
  field.innerHTML = '<div class="field-head"><label for="t-' + arg.key + '">' +
    escapeHtml(arg.label) + "</label>" +
    (arg.hint ? '<span class="kind">' + escapeHtml(arg.hint) + "</span>" : "") + "</div>";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "line";
  input.id = "t-" + arg.key;
  input.spellcheck = false;
  input.value = value;
  input.addEventListener("change", () =>
    edit({ op: "code", id: entry.id, key: arg.key, text: input.value }, { keepPanel: true }));
  field.appendChild(input);

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDataStd_AsciiString</b>";
  field.appendChild(path);
  return field;
}

//! The hand edits, both ways round: the vertex under the handle can be typed
//! as three numbers, and the whole set can be read and cleared. Dragging in the
//! viewport and typing here write the same line of JSON.
function editsField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const moves = (entry.lists && entry.lists[arg.key]) || {};
  const count = Object.keys(moves).length;
  field.innerHTML = '<div class="field-head"><label>' + arg.label + "</label>" +
    '<span class="kind">' + (count ? count + (count === 1 ? " vertex" : " vertices") : "none") +
    "</span></div>";

  const hint = document.createElement("div");
  hint.className = "attr-path";
  hint.style.marginTop = "0";
  hint.textContent = meshEdit.id === entry.id
    ? (meshEdit.vertex >= 0 ? "vertex " + meshEdit.vertex + " · drag an axis, or type below"
                            : "click a handle in the viewport · Esc to leave")
    : "open this feature to show its handles";
  field.appendChild(hint);

  if (meshEdit.id === entry.id && meshEdit.vertex >= 0) {
    const at = meshEdit.vertex;
    const offset = moves[at] || [0, 0, 0];
    const row = document.createElement("div");
    row.className = "triple";
    ["X", "Y", "Z"].forEach((axis, i) => {
      const cell = document.createElement("label");
      cell.innerHTML = "<span>" + axis + "</span>";
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.5";
      input.value = round(offset[i]);
      input.addEventListener("change", () => {
        const next = offset.slice();
        next[i] = Number(input.value) || 0;
        edit({ op: "vertex", id: entry.id, index: at, x: next[0], y: next[1], z: next[2] });
      });
      cell.appendChild(input);
      row.appendChild(cell);
    });
    field.appendChild(row);
  }

  if (count) {
    const actions = document.createElement("div");
    actions.className = "wired";
    actions.innerHTML = "<span>" + count + " moved, in the model file under <b>" +
      escapeHtml(arg.key) + "</b></span>";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear all";
    clear.addEventListener("click", async () => {
      // One vertex at a time, so every undo is one edit in the console too.
      for (const index of Object.keys(moves))
        await edit({ op: "vertex", id: entry.id, index: Number(index), x: 0, y: 0, z: 0 });
    });
    actions.appendChild(clear);
    field.appendChild(actions);
  }

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDataStd_AsciiString</b>";
  field.appendChild(path);
  return field;
}

//! The readout. Long lists are shown to a limit with a count, because the
//! point is to see the shape of the data, not to scroll through it.
function dataField(entry) {
  const field = document.createElement("div");
  field.className = "field";
  const data = entry.data;
  field.innerHTML = '<div class="field-head"><label>' +
    (entry.type === "Panel" ? "Watching" : data.kind === "mesh" ? "Mesh" : "Computed") +
    "</label><span class=\"kind\">" +
    (data.kind === "mesh" ? data.faces + (data.faces === 1 ? " face" : " faces")
      : data.count + " " + data.kind + (data.count === 1 ? "" : "s")) + "</span></div>";
  const box = document.createElement("div");
  box.className = "readout";
  box.textContent = data.preview || "—";
  field.appendChild(box);
  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = entry.entry + ":103 · <b>" +
    (data.kind === "text" ? "TDataStd_ExtStringArray" : "TDataStd_RealArray") + "</b>";
  field.appendChild(path);
  return field;
}

function notice(text, kind) {
  const div = document.createElement("div");
  div.className = "notice" + (kind === "info" ? " info" : "");
  div.textContent = text;
  return div;
}
function showError(message) {
  const host = document.getElementById("def");
  const existing = host.querySelector(".notice.api");
  if (existing) existing.remove();
  const div = notice(message, "bad");
  div.classList.add("api");
  host.prepend(div);
}

//! A number, and the wire that may be driving it. Driven, the slider shows what
//! is arriving and stops taking input - the value is somewhere else now, and
//! the way to change it is to go there or pull the wire off.
function realField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const value = entry.values[arg.key];
  const path = entry.labels[arg.key] || entry.entry;
  const from = entry.driven ? entry.driven[arg.key] : null;
  const count = entry.lists ? entry.lists[arg.key] : null;

  field.innerHTML =
    '<div class="field-head"><label for="p-' + arg.key + '">' + arg.label + "</label>" +
    '<span class="value-box"><input type="number" id="n-' + arg.key + '" value="' + round(value) +
    '" step="' + arg.step + '" min="' + arg.min + '" max="' + arg.max + '"' +
    (from ? " disabled" : "") + "><span class=\"unit\">" + (arg.unit || "") + "</span></span></div>" +
    '<input type="range" id="p-' + arg.key + '" min="' + arg.min + '" max="' + arg.max +
    '" step="' + arg.step + '" value="' + value + '"' + (from ? " disabled" : "") + ">";

  if (from) {
    const wire = document.createElement("div");
    wire.className = "wired";
    const source = (feature(from) || {}).name || from;
    wire.innerHTML = '<span title="' + escapeAttr(source +
      (count > 1 ? " sends " + count + " values; this input reads the first" : "")) +
      '">driven by <b>' + escapeHtml(source) + "</b>" +
      (count > 1 ? " · " + count + " values" : "") + "</span>";
    const off = document.createElement("button");
    off.type = "button";
    off.textContent = "Unwire";
    off.addEventListener("click", () => edit({ op: "disconnect", id: entry.id, key: arg.key }));
    wire.appendChild(off);
    field.appendChild(wire);
  }

  const drivers = state.tree.features.filter(other =>
    other.id !== entry.id && other.produces === "number" && !dependsOn(other.id, entry.id));
  if (!from && drivers.length) {
    const pick = document.createElement("select");
    pick.className = "drive";
    pick.hidden = true;
    pick.innerHTML = '<option value="">— take this from a number —</option>' +
      drivers.map(d => '<option value="' + escapeAttr(d.id) + '">' + escapeHtml(d.name) +
        "</option>").join("");
    pick.addEventListener("change", () => pick.value &&
      edit({ op: "connect", id: entry.id, key: arg.key, from: pick.value }));
    field.appendChild(pick);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "drive-toggle";
    toggle.title = "Drive this from a number";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = svg(ICONS.wire);
    toggle.addEventListener("click", () => {
      pick.hidden = !pick.hidden;
      toggle.setAttribute("aria-expanded", pick.hidden ? "false" : "true");
      if (!pick.hidden) pick.focus();
    });
    field.querySelector(".field-head").appendChild(toggle);
  }

  const trail = document.createElement("div");
  trail.className = "attr-path";
  trail.innerHTML = path + " · <b>TDataStd_Real</b>" +
    (from ? " · <b>TDF_Reference</b> → " + escapeHtml((feature(from) || {}).entry || from) : "");
  field.appendChild(trail);

  const slider = field.querySelector('input[type="range"]');
  const number = field.querySelector('input[type="number"]');
  const send = raw => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    slider.value = v; number.value = round(v);
    pushParameter(entry.id, arg.key, v);
  };
  slider.addEventListener("input", () => send(slider.value));
  number.addEventListener("change", () => send(number.value));
  return field;
}

//! A parameter the script declared. It is stored on a label of its own, so it
//! reads and writes exactly like a catalogue argument.
function scriptField(entry, param) {
  const field = document.createElement("div");
  field.className = "field";

  // A declared parameter that names its alternatives gets a switch, the same
  // one a catalogue choice gets.
  if (param.options) {
    field.innerHTML = '<div class="field-head"><label>' + escapeHtml(param.label) + "</label></div>";
    const group = document.createElement("div");
    group.className = "segmented";
    group.dataset.key = param.key;
    group.setAttribute("role", "group");
    param.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option;
      button.setAttribute("aria-pressed", index === Math.round(param.value) ? "true" : "false");
      button.addEventListener("click", () => pushParameter(entry.id, param.key, index, true));
      group.appendChild(button);
    });
    field.appendChild(group);

    const path = document.createElement("div");
    path.className = "attr-path";
    path.innerHTML = escapeHtml(param.key) + " · <b>TDataStd_Real</b> · declared by the script";
    field.appendChild(path);
    return field;
  }

  field.innerHTML =
    '<div class="field-head"><label for="s-' + param.key + '">' + escapeHtml(param.label) + "</label>" +
    '<span class="value-box"><input type="number" id="sn-' + param.key + '" value="' +
    round(param.value) + '" step="' + param.step + '" min="' + param.min + '" max="' + param.max +
    '"><span class="unit">' + escapeHtml(param.unit || "") + "</span></span></div>" +
    '<input type="range" id="s-' + param.key + '" min="' + param.min + '" max="' + param.max +
    '" step="' + param.step + '" value="' + param.value + '">' +
    '<div class="attr-path">' + escapeHtml(param.key) + " · <b>TDataStd_Real</b> · declared by the script</div>";

  const slider = field.querySelector('input[type="range"]');
  const number = field.querySelector('input[type="number"]');
  const send = raw => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    slider.value = v; number.value = round(v);
    pushParameter(entry.id, param.key, v);
  };
  slider.addEventListener("input", () => send(slider.value));
  number.addEventListener("change", () => send(number.value));
  return field;
}

//! The source of a Script feature. Applied on demand rather than on every
//! keystroke, because a half-written function is not a model.
function codeEditor(entry) {
  const editor = document.createElement("div");
  editor.className = "editor";
  editor.innerHTML =
    '<div class="editor-head"><label for="code-area"><b>Code</b></label>' +
    '<span class="kind" style="font-family:var(--mono);font-size:9.5px;color:var(--ink-3)">' +
    (entry.labels[entry.codeKey] || entry.entry) + " · TDataStd_AsciiString</span></div>";

  const area = document.createElement("textarea");
  area.id = "code-area";
  area.spellcheck = false;
  area.value = entry.code;
  editor.appendChild(area);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Return an object with params and build(p, k). k gives you box, "
    + "cylinder, sphere, sector, beam, tube, move, rotate, cut, fuse, common, fillet "
    + "and compound. Declared parameters become the sliders above.";
  editor.appendChild(hint);

  const row = document.createElement("div");
  row.className = "row";
  const apply = document.createElement("button");
  apply.className = "btn primary";
  apply.textContent = "Run";
  const revert = document.createElement("button");
  revert.className = "btn";
  revert.textContent = "Revert";
  const status = document.createElement("span");
  status.className = "spacer";
  status.style.cssText = "font-size:11px;color:var(--ink-3);text-align:right";
  row.append(apply, revert, status);
  editor.appendChild(row);

  const run = async () => {
    apply.disabled = true;
    status.textContent = "running…";
    try {
      await mdl.run({ op: "code", id: entry.id, key: entry.codeKey, text: area.value });
      status.textContent = "";
    } catch (err) {
      status.textContent = err.message.slice(0, 60);
    } finally { apply.disabled = false; }
  };
  apply.addEventListener("click", run);
  revert.addEventListener("click", () => { area.value = entry.code; status.textContent = ""; });

  // Tab belongs to the code, not to the next control.
  area.addEventListener("keydown", event => {
    if (event.key === "Tab") {
      event.preventDefault();
      const at = area.selectionStart;
      area.setRangeText("  ", at, area.selectionEnd, "end");
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run(); }
  });
  return editor;
}

function refField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const many = arg.kind === "refs";
  const wired = many ? (entry.lists[arg.key] || []) : [entry.refs[arg.key] || ""].filter(Boolean);
  const accepts = arg.accepts.split(",");
  const options = state.tree.features.filter(other =>
    other.id !== entry.id && acceptsFrom(accepts, other) && !dependsOn(other.id, entry.id));

  field.innerHTML = '<div class="field-head"><label>' + arg.label + "</label>" +
    '<span class="kind">' + accepts.join(" / ") + (many ? " · in order" : "") + "</span></div>";

  // One wire is a dropdown. Several are a list, each with the way to remove it,
  // and a dropdown at the end that adds the next one.
  for (const id of many ? wired : []) {
    const row = document.createElement("div");
    row.className = "wired";
    row.innerHTML = "<span>" + escapeHtml((feature(id) || {}).name || id) + "</span>";
    const off = document.createElement("button");
    off.type = "button";
    off.textContent = "Remove";
    off.addEventListener("click", () =>
      edit({ op: "disconnect", id: entry.id, key: arg.key, from: id }));
    row.appendChild(off);
    field.appendChild(row);
  }

  const select = document.createElement("select");
  const current = many ? "" : wired[0] || "";
  const free = many ? options.filter(o => !wired.includes(o.id)) : options;
  select.innerHTML = '<option value="">' + (many ? "— add a section —" : "— not set —") +
    "</option>" + free.map(option =>
      '<option value="' + escapeAttr(option.id) + '"' + (option.id === current ? " selected" : "") +
      ">" + escapeHtml(option.name) + "</option>").join("");
  select.addEventListener("change", () => edit(select.value
    ? { op: "connect", id: entry.id, key: arg.key, from: select.value }
    : { op: "disconnect", id: entry.id, key: arg.key }));
  field.appendChild(select);

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDF_Reference</b>" +
    (wired.length && !many ? " → " + (feature(wired[0]) || {}).entry : "") +
    (many ? " × " + wired.length : "") +
    (arg.consumes ? " · consumes the body" : "");
  field.appendChild(path);
  return field;
}

//! True when \p id already depends on \p onId - the guard that stops the
//! reference dropdown from offering a cycle.
function dependsOn(id, onId) {
  const seen = new Set();
  const walk = current => {
    if (current === onId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return wiresOf(current).some(target => walk(target));
  };
  return walk(id);
}

//! Everything a feature reads from: reference arguments, sliders being driven,
//! and every wire into an input that takes several.
function wiresOf(id) {
  const entry = feature(id);
  if (!entry) return [];
  const out = Object.values(entry.refs || {}).filter(Boolean);
  for (const value of Object.values(entry.lists || {}))
    if (Array.isArray(value)) out.push(...value.filter(Boolean));
  return out;
}

/* ---------------------------------------------------------------------- log */
function buildLog() {
  const host = document.getElementById("log-pop");
  const summary = document.getElementById("status-regen");
  host.textContent = "";
  const report = state.report;
  if (!report) { summary.textContent = "ready"; return; }

  // The status bar carries the shape of the last regeneration; the detail is
  // one click away rather than permanently on screen.
  summary.innerHTML = report.failed.length
    ? '<span class="err">' + escapeHtml(report.failed[0].name) + " failed</span>"
    : '<span class="ran">' + report.executed.length + "</span> of " + report.functions +
      " rebuilt" + (state.stream ? " · " + state.stream.triangles.toLocaleString() + " tris" : "");

  const line = (text, className) => {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    host.appendChild(div);
  };
  line("regenerated " + report.executed.length + " of " + report.functions + " functions", "head");
  for (const e of report.executed) line("+ " + e.name + "  rev " + e.revision, "ran");
  for (const e of report.failed) line("! " + e.name + ": " + e.message, "err");
  for (const e of report.skipped) line("= " + e.name, "same");
  if (state.stream)
    line("streamed " + state.stream.shapes + " shape" + (state.stream.shapes === 1 ? "" : "s") +
         " · " + state.stream.triangles.toLocaleString() + " triangles · " + state.stream.ms + " ms",
         "stream");
}

/* -------------------------------------------------------------- operations */
let inFlight = false, pendingParam = null;

//! A slider fires far faster than the kernel can rebuild, so the newest value
//! wins and everything in between is dropped.
async function pushParameter(id, key, value, rebuildPanel = false) {
  pendingParam = { id, key, value, rebuildPanel };
  if (inFlight || !ready) return;
  inFlight = true;
  try {
    while (pendingParam) {
      const next = pendingParam;
      pendingParam = null;
      await mdl.run({ op: "set", id: next.id, key: next.key, value: next.value },
                    { keepPanel: !next.rebuildPanel });
    }
  } catch (err) { showError(err.message); }
  finally { inFlight = false; }
}

async function addFeature(type) {
  if (!ready) return;
  const spec = schemaType(type);
  // No refs: the edit wires the inputs itself, the way a CAD command does - the
  // selected body for an operation, the first datum of the right type for the
  // rest. Typing the same edit into the graph console gets the same wiring.
  const payload = await edit({ op: "add", type });
  if (!payload) return;
  select(payload.id, true);
  if (spec.category !== "datum") fitView();
}

async function deleteFeature(id) {
  const was = { selected: state.selected, edited: state.edited };
  if (state.selected === id) state.selected = null;
  if (state.edited === id) state.edited = null;
  if (!(await edit({ op: "delete", id }))) {
    state.selected = was.selected;
    state.edited = was.edited;
    buildPanel();
  }
}

function select(id, openDefinition) {
  state.selected = id;
  if (openDefinition || (id && state.edited && id !== state.edited)) state.edited = id;
  const entry = feature(id);
  document.getElementById("status-sel").innerHTML = entry
    ? "<b>" + escapeHtml(entry.name) + "</b> · " + entry.entry + " · " + entry.type
    : "click a body · double-click to edit it";
  buildTree(); buildPanel(); refreshToolbar(); paintSelection();
  refreshMeshEdit();
  if (graph.showing) graph.update();
  if (staging) refreshStageSelection();
}

//! Everything the kernel says, in one place: mirror the tree, redraw the
//! panels, then fetch the triangles for whatever it rebuilt.
function applyState(payload, options = {}) {
  if (payload.tree) state.tree = payload.tree;
  if (payload.report) state.report = payload.report;
  buildTree();
  buildLog();
  updateStamp();
  if (options.keepPanel) { refreshPanelNotice(); refreshPanelValues(); }
  else buildPanel();
  refreshToolbar();
  graph.sync();
  syncShapes().then(buildLog).catch(err => showError(err.message));
}

function updateStamp() {
  if (!state.tree) return;
  document.getElementById("doc-title").textContent = state.tree.name;
  document.getElementById("doc-count").textContent =
    state.tree.features.length + " features · " + state.tree.units;
  document.getElementById("status-kernel").textContent =
    kernel ? (kernel.kind === "wasm" ? "OpenCascade · in page" : kernel.description) : "starting…";
}

/* ----------------------------------------------------------- which kernel */

function setLink(active) {
  const chip = document.getElementById("btn-link");
  chip.classList.toggle("live", !!active);
  document.getElementById("link-label").textContent = !active ? "starting…"
    : active.kind === "wasm" ? "wasm"
    : (active.base ? active.base.replace(/^https?:\/\//, "") : "same origin");
}

//! Hands the interface over to a kernel: catalogue first, then the document,
//! then the triangles. Nothing above here knows which kernel it got.
async function attachKernel(next, model) {
  kernel = next;
  ready = false;
  state.schema = await kernel.schema();
  buildToolbar();

  for (const [, { group }] of shapes) disposeGroup(group);
  shapes.clear();
  state.stream = null;

  const payload = model ? await kernel.loadModel(model) : await kernel.tree();
  ready = true;
  setLink(kernel);
  applyState(payload);

  const bodies = state.tree.features.filter(f => f.category !== "datum");
  select(bodies.length ? bodies[bodies.length - 1].id : null, true);
  fitView();
}

const boot = message => {
  const el = document.getElementById("boot-message");
  if (el) el.textContent = message;
};

//! The kernel travels in this page gzipped - 22 MB of WebAssembly packs down to
//! about 9 MB of text. Inflating it with the browser's own decompressor and
//! feeding that straight to the streaming compiler means the module is being
//! compiled while it is still being unpacked.
function packedKernelBytes() {
  const element = document.getElementById("kernel-payload");
  if (!element) throw new Error("this page is missing its kernel payload");
  const packed = atob(element.textContent.trim());
  const bytes = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) bytes[i] = packed.charCodeAt(i);
  return bytes;
}

function kernelResponse() {
  if (typeof DecompressionStream !== "function")
    throw new Error("this browser cannot unpack the kernel (no DecompressionStream)");
  const stream = new Blob([packedKernelBytes()]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, { headers: { "Content-Type": "application/wasm" } });
}

let pageKernel = null;
async function usePageKernel() {
  if (!pageKernel) {
    boot("unpacking and compiling OpenCascade");
    const instantiateWasm = (imports, onReady) => {
      WebAssembly.instantiateStreaming(kernelResponse(), imports)
        .then(result => onReady(result.instance, result.module))
        .catch(() => {
          // Some browsers refuse to stream-compile a synthesised response.
          new Response(kernelResponse().body).arrayBuffer()
            .then(buffer => WebAssembly.instantiate(buffer, imports))
            .then(result => onReady(result.instance, result.module));
        });
      return {};   // emscripten reads this as "the instance is coming later"
    };
    pageKernel = await createWasmKernel({ initModule: replicadInit, instantiateWasm, onProgress: boot });
  }
  await attachKernel(pageKernel, STARTER);
}

async function useNativeKernel(base) {
  const model = kernel ? await kernel.model() : null;
  const next = await createHttpKernel(base);
  // Carry the part across rather than dropping the user back on the starter.
  await attachKernel(next, model);
  try { localStorage.setItem("ocafcad/base", base); } catch (e) { /* private window */ }
}

/* ------------------------------------------------------------------- boot */
const modalLink = document.getElementById("modal-link");
const modal = document.getElementById("modal");

document.getElementById("btn-link").addEventListener("click", () => modalLink.showModal());
document.getElementById("btn-disconnect").addEventListener("click", async () => {
  modalLink.close();
  const model = kernel ? await kernel.model() : null;
  await attachKernel(pageKernel, model || STARTER);
});
document.getElementById("btn-connect").addEventListener("click", async () => {
  const button = document.getElementById("btn-connect");
  const url = document.getElementById("link-url").value.trim().replace(/\/$/, "");
  button.textContent = "Connecting…";
  try {
    await useNativeKernel(url);
    modalLink.close();
    button.textContent = "Connect";
  } catch (err) {
    button.textContent = "No kernel at that address";
    setTimeout(() => { button.textContent = "Connect"; }, 2600);
  }
});

/* ------------------------------------------------------------------ samples

   A worked example, loaded whole. It replaces the document, so it takes two
   clicks: one to open the list, one to choose - and the list says so.
   -------------------------------------------------------------------------- */

const sampleMenu = document.getElementById("sample-menu");

function buildSampleMenu() {
  sampleMenu.textContent = "";
  for (const sample of SAMPLES) {
    const button = document.createElement("button");
    button.innerHTML = "<b>" + escapeHtml(sample.name) + "</b><span>" +
      escapeHtml(sample.summary) + "</span>";
    button.addEventListener("click", async () => {
      sampleMenu.hidden = true;
      state.hidden.clear();
      state.selected = null;
      state.edited = null;
      // Straight down the same channel as everything else, so it lands in the
      // graph console like any other edit.
      if (await edit({ op: "model", model: sample.model })) fitView();
    });
    sampleMenu.appendChild(button);
  }
  const warn = document.createElement("div");
  warn.className = "warn";
  warn.textContent = "replaces what is open · copy it out with Model first";
  sampleMenu.appendChild(warn);
}

document.getElementById("btn-sample").addEventListener("click", event => {
  if (!sampleMenu.hidden) { sampleMenu.hidden = true; return; }
  if (!sampleMenu.childElementCount) buildSampleMenu();
  const rect = event.currentTarget.getBoundingClientRect();
  sampleMenu.style.left = Math.min(rect.left, innerWidth - 336) + "px";
  sampleMenu.style.top = rect.bottom + 8 + "px";
  sampleMenu.hidden = false;
});
addEventListener("pointerdown", event => {
  if (!sampleMenu.hidden && !sampleMenu.contains(event.target) &&
      !document.getElementById("btn-sample").contains(event.target)) sampleMenu.hidden = true;
}, true);

/* --------------------------------------------------------------- node graph
   The specification tree read the other way round. It owns no state of its own
   beyond where the nodes sit, and even that is written into the model file, so
   a part opens laid out the way it was left.
   -------------------------------------------------------------------------- */

const graph = new GraphEditor({
  mdl,
  read: () => ({ tree: state.tree, schema: state.schema, selected: state.selected }),
  get icons() { return ICONS; },
  openDefinition: id => { select(id, true); toggleTree(true); },
  onOpen: () => document.getElementById("btn-graph").setAttribute("aria-pressed", "true"),
  onClose: () => document.getElementById("btn-graph").setAttribute("aria-pressed", "false"),
});
document.getElementById("btn-graph").addEventListener("click", () => graph.toggle());

/* ----------------------------------------------------------------- showroom

   The modelling view and the stage are two renderers over one document: the
   kernel's triangles go to both, and neither owns the model.                */

const showroom = new Showroom({
  canvas: document.getElementById("stage-canvas"),
  payloadId: "showroom-payload",
});
const stage = document.getElementById("showroom");
const stageUi = document.getElementById("stage-ui");
let staging = false;

function buildStageControls() {
  const finishes = document.getElementById("stage-finishes");
  for (const finish of FINISHES) {
    const button = document.createElement("button");
    button.className = "swatch";
    button.dataset.finish = finish.key;
    button.title = finish.label;
    button.setAttribute("aria-label", finish.label);
    button.setAttribute("aria-pressed", "false");
    const [r, g, b] = finish.color;
    button.style.background = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    if (finish.metalness > 0.5)
      button.style.backgroundImage =
        "linear-gradient(140deg, rgba(255,255,255,.75), rgba(255,255,255,0) 55%)";
    button.addEventListener("click", () => applyFinish(finish.key));
    finishes.appendChild(button);
  }

  const envs = document.getElementById("stage-envs");
  for (const preset of ENVIRONMENTS) {
    const button = document.createElement("button");
    button.textContent = preset.label;
    button.dataset.env = preset.key;
    button.setAttribute("aria-pressed", preset.key === showroom.environment ? "true" : "false");
    button.addEventListener("click", () => {
      showroom.applyEnvironment(preset.key);
      for (const other of envs.children)
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      syncStageToggles();
    });
    envs.appendChild(button);
  }
}

//! The scene presets carry their own floor and reflection, so the toggles
//! follow whichever stage is showing rather than arguing with it.
function syncStageToggles() {
  document.getElementById("btn-stage-ground")
    .setAttribute("aria-pressed", showroom.ground && showroom.ground.enabled ? "true" : "false");
  document.getElementById("btn-stage-reflect")
    .setAttribute("aria-pressed", showroom.reflection > 0.01 ? "true" : "false");
}

function refreshStageSelection() {
  const entry = feature(state.selected);
  document.getElementById("stage-part").textContent = entry ? entry.name : "nothing selected";
  const current = entry && entry.appearance ? entry.appearance.finish : null;
  for (const button of document.querySelectorAll("#stage-finishes .swatch"))
    button.setAttribute("aria-pressed", button.dataset.finish === current ? "true" : "false");
  if (showroom.ready) showroom.highlight(state.selected);
}

async function applyFinish(key) {
  const entry = feature(state.selected);
  if (!entry) return;
  const appearance = { finish: key, color: findFinish(key).color };
  showroom.paint(entry.id, appearance);
  try {
    await mdl.run({ op: "appearance", id: entry.id, appearance }, { keepPanel: true });
  } catch (err) { showError(err.message); }
  refreshStageSelection();
}

function stageResize() {
  if (!showroom.ready) return;
  showroom.resize(innerWidth, innerHeight);
}

async function enterShowroom() {
  const button = document.getElementById("btn-stage");
  const was = button.textContent;
  button.disabled = true;
  button.textContent = "opening…";
  try {
    const firstTime = !showroom.ready;
    await showroom.start();
    if (firstTime) {
      buildStageControls();
      showroom.onPick = id => { state.selected = id; refreshStageSelection(); };
      addEventListener("resize", stageResize);
    }
    stageResize();
    showroom.setScene(state.tree.features, streams);
    syncStageToggles();

    // Arrive from where the modelling camera was looking, then ease to the
    // hero view - the move is the transition.
    showroom.orbit.yaw = -(view.yaw * 180 / Math.PI) - 90;
    showroom.orbit.pitch = Math.max(-8, Math.min(80, view.pitch * 180 / Math.PI));
    showroom.place();

    staging = true;
    document.body.classList.add("staging");
    stage.classList.add("on");
    requestAnimationFrame(() => stageUi.classList.add("shown"));
    showroom.frame(null, 950);
    button.textContent = was;
  } catch (err) {
    button.textContent = err.message.slice(0, 34);
    setTimeout(() => { button.textContent = was; }, 3200);
  } finally { button.disabled = false; }
}

function leaveShowroom() {
  staging = false;
  showroom.turntable = false;
  document.getElementById("btn-stage-spin").setAttribute("aria-pressed", "false");
  stageUi.classList.remove("shown");
  stage.classList.remove("on");
  document.body.classList.remove("staging");
  buildTree(); buildPanel(); refreshToolbar();
}

document.getElementById("btn-stage").addEventListener("click", enterShowroom);
document.getElementById("btn-stage-exit").addEventListener("click", leaveShowroom);
document.getElementById("btn-stage-ground").addEventListener("click", event => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
  showroom.setGroundVisible(on);
});
document.getElementById("btn-stage-reflect").addEventListener("click", event => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
  showroom.setReflection(on ? 0.42 : 0);
});
document.getElementById("btn-stage-spin").addEventListener("click", event => {
  showroom.turntable = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", showroom.turntable ? "true" : "false");
});
document.getElementById("stage-exposure").addEventListener("input", event => {
  showroom.setExposure(Number(event.target.value));
});

let lastSpin = performance.now();
(function spinLoop(now) {
  const dt = Math.min(0.1, ((now || performance.now()) - lastSpin) / 1000);
  lastSpin = now || performance.now();
  if (staging && showroom.ready) showroom.spin(dt);
  requestAnimationFrame(spinLoop);
})();

/* ---------------------------------------------------------------- exporting */

//! The viewer's own save dialog, where the page is allowed to offer one. Served
//! by a local kernel, or opened as a file, there is no such surface at all.
let downloads;
const saveFile = async (filename, data) => {
  if (downloads === undefined) {
    const host = typeof claude !== "undefined" ? claude : null;
    downloads = host && typeof host.use === "function"
      ? await host.use("downloads").catch(() => null)
      : null;
  }
  if (!downloads) return { status: "unavailable" };
  return downloads.save({ filename, data });
};

const stepDialog = document.getElementById("modal-step");
document.getElementById("btn-step-close").addEventListener("click", () => stepDialog.close());
document.getElementById("btn-step-copy").addEventListener("click", async () => {
  const button = document.getElementById("btn-step-copy");
  const area = document.getElementById("step-text");
  try { await navigator.clipboard.writeText(area.value); button.textContent = "Copied"; }
  catch (e) { area.select(); button.textContent = "Press Ctrl+C"; }
  setTimeout(() => { button.textContent = "Copy"; }, 1600);
});

document.getElementById("btn-step").addEventListener("click", async () => {
  const button = document.getElementById("btn-step");
  const was = button.textContent;
  button.disabled = true;
  button.textContent = "writing…";
  try {
    const step = await kernel.exportStep();
    const summary = step.solids + " solid" + (step.solids === 1 ? "" : "s")
      + " · " + Math.round(step.text.length / 1024) + " KB · " + step.units;
    const stem = (step.name || "part").replace(/[^\w.-]+/g, "-");

    let saved = null;
    try {
      saved = await saveFile(stem + ".step", step.text);
    } catch (err) {
      // The viewer's save allowlist has no .step, so the same text goes out
      // under an extension it does accept and is renamed on the way in.
      if (err && err.code === "rejected_extension") {
        try { saved = await saveFile(stem + ".step.txt", step.text); }
        catch (retry) { saved = { status: retry && retry.code === "declined" ? "declined" : "failed" }; }
      } else {
        saved = { status: err && err.code === "declined" ? "declined" : "failed" };
      }
    }

    if (saved && saved.status === "saved") {
      button.textContent = "saved";
      setTimeout(() => { button.textContent = was; }, 2000);
      return;
    }
    if (saved && saved.status === "declined") { button.textContent = was; return; }

    // No save surface here: hand over the text instead.
    document.getElementById("step-summary").textContent = summary;
    document.getElementById("step-note").textContent =
      "ISO-10303-21, written by OpenCascade. This view cannot save files, so copy "
      + "the text and keep it as a .step file — or connect a native kernel, which "
      + "writes one straight to disk.";
    document.getElementById("step-text").value = step.text;
    stepDialog.showModal();
    button.textContent = was;
  } catch (err) {
    button.textContent = err.message.slice(0, 40);
    setTimeout(() => { button.textContent = was; }, 3200);
  } finally { button.disabled = false; }
});

document.getElementById("btn-model").addEventListener("click", async () => {
  let text;
  try { text = await mdl.modelText(); }
  catch (err) { text = "// " + err.message; }
  document.getElementById("model-text").value = text;
  modal.showModal();
});
document.getElementById("btn-close").addEventListener("click", () => modal.close());
document.getElementById("btn-copy").addEventListener("click", async () => {
  const button = document.getElementById("btn-copy");
  const area = document.getElementById("model-text");
  try { await navigator.clipboard.writeText(area.value); button.textContent = "Copied"; }
  catch (e) { area.select(); button.textContent = "Press Ctrl+C"; }
  setTimeout(() => { button.textContent = "Copy"; }, 1600);
});
document.getElementById("btn-load").addEventListener("click", async () => {
  const button = document.getElementById("btn-load");
  try {
    await mdl.run({ op: "model", model: document.getElementById("model-text").value });
    modal.close();
    fitView();
  } catch (err) {
    button.textContent = err.message.slice(0, 48);
    setTimeout(() => { button.textContent = "Rebuild"; }, 3200);
  }
});

for (const button of document.querySelectorAll("#view-tools button")) {
  button.addEventListener("click", () => {
    const name = button.dataset.view;
    if (name === "fit") return fitView();
    Object.assign(view, STANDARD_VIEWS[name]);
    placeCamera(); draw();
  });
}

//! Materials carry theme colours, so a theme change rebuilds them from the
//! triangles the kernel already sent - no rebuild of the geometry.
function repaintTheme() {
  readTheme();
  buildGround();
  const ids = [...shapes.keys()];
  for (const { group } of shapes.values()) disposeGroup(group);
  shapes.clear();
  if (kernel && ids.length) {
    kernel.mesh(ids).then(payload => {
      for (const mesh of payload.features) setShape(mesh);
      rebuildPickList(); applyVisibility(); paintSelection(); draw();
    }).catch(() => {});
  }
  draw();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaintTheme);
new MutationObserver(repaintTheme).observe(document.documentElement, { attributeFilter: ["data-theme"] });
addEventListener("resize", resize);
new ResizeObserver(resize).observe(viewportEl);

const treePanel = document.getElementById("tree-panel");
const logPop = document.getElementById("log-pop");
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch (e) { /* private */ } };
const recall = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };

function toggleTree(force) {
  treePanel.hidden = force === undefined ? !treePanel.hidden : !force;
  remember("ocafcad/tree", treePanel.hidden ? "off" : "on");
}
document.getElementById("btn-tree").addEventListener("click", () => toggleTree());
document.getElementById("btn-def-close").addEventListener("click", () => {
  state.edited = null;
  buildPanel();
});
document.getElementById("btn-log").addEventListener("click", () => { logPop.hidden = !logPop.hidden; });
addEventListener("pointerdown", event => {
  if (!logPop.hidden && !logPop.contains(event.target) &&
      !document.getElementById("btn-log").contains(event.target)) logPop.hidden = true;
}, true);

addEventListener("keydown", event => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "f" || event.key === "F") fitView();
  if (event.key === "t" || event.key === "T") toggleTree();
  if (event.key === "g" || event.key === "G") graph.toggle();
  if (event.key === "Escape") {
    sampleMenu.hidden = true;
    if (staging) return leaveShowroom();
    state.edited = null; buildPanel(); logPop.hidden = true;
  }
});

(async function start() {
  readTheme();
  buildGround();
  placeCamera();
  resize();

  if (recall("ocafcad/tree") === "off") treePanel.hidden = true;

  const params = new URLSearchParams(location.search);
  let remembered = null;
  try { remembered = localStorage.getItem("ocafcad/base"); } catch (e) { /* private window */ }
  document.getElementById("link-url").value = remembered || "http://127.0.0.1:8787";

  // A native kernel serving this very page wins: it is already the document.
  const asked = params.get("api");
  const sameOrigin = location.protocol.startsWith("http") ? "" : null;
  for (const candidate of [asked, sameOrigin].filter(c => c !== null && c !== undefined)) {
    try {
      boot("connecting to the kernel");
      await useNativeKernel(candidate);
      document.getElementById("boot").hidden = true;
      return;
    } catch (err) { /* fall through to the kernel in this page */ }
  }

  try {
    await usePageKernel();
  } catch (err) {
    boot("could not start OpenCascade: " + err.message);
    document.getElementById("boot").classList.add("failed");
    return;
  }
  document.getElementById("boot").hidden = true;
})();
