import { createWasmKernel } from "./wasm-kernel.js";
import { createHttpKernel } from "./http-kernel.js";
import { ENVIRONMENTS, FINISHES, Showroom, findFinish } from "./showroom.js";
import { Mdl } from "./mdl.js";
import { acceptsFrom, dataLines, SAMPLES, sliderSpan } from "./ocaf.js";
import { GraphEditor } from "./graph.js";
import { Agent, agentTrouble } from "./agent.js";
import { SKETCH_CLICKS, SKETCH_RELATIONS, SKETCH_TYPES, nextSketchId, readSketch,
         sketchDirectionAt, sketchElement, sketchHandleAt, sketchHandles,
         sketchMoveHandle, sketchOutline, sketchRelationMarks,
         sketchTangentArc } from "./sketch.js";

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
  picked: [],          // every feature shift-clicked, in the order picked
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
  onStack: () => refreshSteps(),
  // Everything shift-clicked, so a feature that gathers several - a loft's
  // sections, a join's parts - is born wired to what was picked for it.
  picked: () => state.picked,
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

//! Panning is grabbing the model, not pushing the camera: the point under the
//! cursor stays under the cursor. So the camera moves the OTHER way from the
//! drag, and it moves by exactly what one pixel is worth at the distance being
//! looked at - which is what makes it feel like dragging a sheet of paper
//! rather than nudging a view.
function pan(dx, dy) {
  const height = renderer.domElement.clientHeight || 1;
  const perPixel = 2 * view.distance
    * Math.tan((camera.fov * Math.PI / 180) / 2) / height;
  const out = new THREE.Vector3().subVectors(camera.position, view.target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, out);
  // Straight down on the model, "right" is undefined from the world up; take it
  // from the yaw instead, which always knows which way round the view is.
  if (right.lengthSq() < 1e-8) right.set(-Math.sin(view.yaw), Math.cos(view.yaw), 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(out, right).normalize();
  view.target.addScaledVector(right, -dx * perPixel)
             .addScaledVector(up, dy * perPixel);
}
//! Set while something is building the model on its own, so the viewport keeps
//! up with it rather than staring at where the part used to be.
let following = false;

const view = { target: new THREE.Vector3(0, 0, 40), distance: 460, yaw: -0.72, pitch: 0.62,
               // How big the scene is. Every limit below is a multiple of it
               // rather than a number in millimetres, so the same controls work
               // on a bracket and on a building.
               span: 200 };
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
  // The clipping planes follow the camera rather than being fixed. A shopping
  // centre is thirty metres of millimetres and a bracket is a hundred of them;
  // one pair of planes cannot hold both, and a fixed far plane meant the
  // building simply vanished when the view was pulled back far enough to see
  // it - which looked like "fit does not fit".
  const span = Math.max(view.span, 1);
  camera.near = Math.max(0.05, Math.min(view.distance * 0.02, span * 0.02));
  camera.far = view.distance + span * 6;
  camera.updateProjectionMatrix();
}

//! Everything that would be photographed: the built shapes that are showing,
//! leaving out the datums, whose drawn size is arbitrary and would swamp a
//! small part. When there is nothing but datums, they are what there is.
function sceneBounds() {
  const box = new THREE.Box3();
  let any = false;
  for (const [id, { group }] of shapes) {
    const entry = feature(id);
    if (!group.visible || !entry || entry.category === "datum") continue;
    box.expandByObject(group); any = true;
  }
  if (!any) for (const [, { group }] of shapes)
    if (group.visible) { box.expandByObject(group); any = true; }
  return any && !box.isEmpty() ? box : null;
}

//! The part of the canvas you can actually see. The panels float over the
//! model rather than sitting beside it, so a fit to the whole canvas puts a
//! third of the part underneath them - which is what "it does not fit" looked
//! like. Framing to this rectangle instead is the difference.
function freeRect() {
  const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
  const whole = { x: 0, y: 0, w: width, h: height };
  if (!width || !height) return whole;
  // Every panel here is position: fixed, and offsetParent is null for those by
  // definition - so asking it whether they are on screen said "no" every time
  // and quietly gave back the whole canvas. The rectangle is the answer.
  const showing = id => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return null;
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1 ? box : null;
  };
  const pad = 16;
  let left = 0, right = width, top = 0, bottom = height;
  for (const id of ["rail", "sketch-rail", "tree-panel"]) {
    const box = showing(id);
    if (box) left = Math.max(left, box.right + pad);
  }
  for (const id of ["def-panel"]) {
    const box = showing(id);
    if (box) right = Math.min(right, box.left - pad);
  }
  for (const id of ["chip", "sketch-bar"]) {
    const box = showing(id);
    if (box) top = Math.max(top, box.bottom + pad);
  }
  for (const id of ["ai-bar"]) {
    const box = showing(id);
    if (box) bottom = Math.min(bottom, box.top - pad);
  }
  const rect = { x: left, y: top, w: right - left, h: bottom - top };
  // Panels crowding in from every side leave nothing worth aiming at; the
  // whole canvas is a better answer than a sliver.
  if (rect.w < width * 0.3 || rect.h < height * 0.3) return whole;
  return rect;
}

//! How far back the camera has to stand for a sphere of \p radius to fit
//! \p rect, and where to aim so it lands in the middle of it. The window is
//! usually wider than it is tall, so the vertical angle is the one that crops -
//! but not always, and which one it is is what a fit has to answer. That is
//! the whole calculation; the old one multiplied the box diagonal by 1.9.
function frameFor(radius, rect) {
  const width = renderer.domElement.clientWidth || 1;
  const height = renderer.domElement.clientHeight || 1;
  const vertical = camera.fov * Math.PI / 180;
  // The angles the free rectangle subtends, not the ones the canvas does.
  const halfV = Math.atan(Math.tan(vertical / 2) * (rect.h / height));
  const halfH = Math.atan(Math.tan(vertical / 2) * camera.aspect * (rect.w / width));
  const distance = radius / Math.sin(Math.min(halfV, halfH)) * 1.06;
  // And the offset that puts the middle of the rectangle where the middle of
  // the canvas is, in the world, at the distance being looked at.
  const perPixel = 2 * distance * Math.tan(vertical / 2) / height;
  return {
    distance,
    shift: [(rect.x + rect.w / 2 - width / 2) * perPixel,
            (rect.y + rect.h / 2 - height / 2) * perPixel],
  };
}

//! How big what is on screen is, which is what the wheel's limits and the
//! clipping planes are both measured against.
function measureScene() {
  const box = sceneBounds();
  if (!box) return;
  view.span = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
}

(function bindControls() {
  let mode = null, lastX = 0, lastY = 0, moved = 0;
  const el = renderer.domElement;

  el.addEventListener("pointerdown", event => {
    // An axis of the handle takes the drag before the camera does.
    if (event.button === 0 && !event.shiftKey && grabGizmo(event)) mode = "gizmo";
    // A sketch is looked at square on, and stays that way: the drag that would
    // orbit pans instead, because a drawing seen at an angle cannot be drawn on.
    // In select, a press that lands on an end takes hold of it.
    else if (sketching()) {
      // Inside a sketch, shift means "and this one too", not "pan" - so the
      // left button always draws or picks and panning is on the other buttons.
      if (event.button !== 0) mode = "pan";
      else mode = grabSketchHandle(event) ? "handle" : "draw";
    }
    else mode = (event.shiftKey || event.button === 1 || event.button === 2) ? "pan" : "orbit";
    lastX = event.clientX; lastY = event.clientY; moved = 0;
    el.setPointerCapture(event.pointerId);
  });
  el.addEventListener("pointermove", event => {
    if (sketching()) {
      const uv = sketchAt(event);
      if (uv && (sketcher.clicks.length || sketcher.hover)) { sketcher.hover = uv; refreshSketch(); }
      else sketcher.hover = uv;
    }
    if (!mode) return;
    if (mode === "gizmo") { dragGizmo(event); return; }
    if (mode === "handle") { dragSketchHandle(event); return; }
    if (mode === "draw") { moved += Math.abs(event.clientX - lastX) + Math.abs(event.clientY - lastY);
                           lastX = event.clientX; lastY = event.clientY; return; }
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (mode === "orbit") {
      view.yaw -= dx * 0.008;
      view.pitch = Math.max(-1.53, Math.min(1.53, view.pitch + dy * 0.008));
    } else {
      pan(dx, dy);
    }
    placeCamera(); draw();
  });
  el.addEventListener("pointerup", event => {
    if (mode === "gizmo") dropGizmo();
    else if (mode === "handle") dropSketchHandle(event);
    else if (mode === "draw") { if (moved < 4) sketchClick(event); }
    // Shift-drag pans, but shift-click still picks - a click is a drag that
    // went nowhere, and holding shift should not stop you choosing things.
    // Shift-drag pans, but shift-click still picks - a click is a drag that
    // went nowhere, and holding shift should not stop you choosing things.
    else if (mode === "pan" && moved < 4 && event.shiftKey && !handEditing() && !sketching())
      pick(event);
    else if (mode === "orbit" && moved < 4 && !pickVertex(event)) {
      // While a mesh is being edited by hand, the viewport belongs to its
      // handles: a click that misses one drops the vertex, it does not walk off
      // to whatever solid happened to be behind it. Esc, or the tree, leaves.
      if (handEditing()) { meshEdit.vertex = -1; refreshMeshEdit(); buildPanel(); }
      else pick(event);
    }
    mode = null;
  });
  el.addEventListener("pointercancel", () => {
    meshEdit.axis = null;
    if (sketcher.drag) { sketcher.drag = null; sketcher.preview = null; refreshSketch(); }
    mode = null;
  });
  //! Double-clicking a sketch opens it - the way a CAD modeller does, and the
  //! same gesture in the tree. Double-clicking inside an open one ends a
  //! spline, which is the only element that does not know how long it is.
  el.addEventListener("dblclick", event => {
    if (sketching()) { endSketchRun(); return; }
    pick(event);
    const entry = feature(state.selected);
    if (entry && entry.sketch) enterSketch(entry.id);
  });
  el.addEventListener("contextmenu", event => event.preventDefault());
  el.addEventListener("wheel", event => {
    event.preventDefault();
    // Measured against how big the scene is. Fixed stops at 20 and 8000 mm meant
    // a thirty-metre building could not be pulled back far enough to be seen,
    // and one turn of the wheel undid a fit.
    const span = Math.max(view.span, 1);
    view.distance = Math.max(span * 0.02, Math.min(span * 40,
      view.distance * (1 + Math.sign(event.deltaY) * 0.12)));
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
  refreshSketch();
  // The wheel's reach and the clipping planes are both multiples of how big the
  // scene is, so it has to be re-measured whenever the scene changes.
  measureScene();
  // While Claude is building, the view follows what it builds: the point of
  // watching is seeing it, and the first thing it adds is usually nowhere near
  // where the camera happens to be pointing.
  if (following) fitView();
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
  vertex: -1,      // the vertex the handle is on - the last one picked
  chosen: [],      // every vertex picked, which the handle moves together
  dots: null,      // the handles
  gizmo: null,     // the three axes on the selected one
  axis: null,      // the one being dragged
  from: null,      // where the drag started, along that axis
  before: null,    // index -> the offset it had when the drag started
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
  const count = vertices.length / 3;
  meshEdit.chosen = meshEdit.chosen.filter(v => v < count);
  if (meshEdit.vertex >= count) meshEdit.vertex = -1;

  const dots = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position",
      new THREE.Float32BufferAttribute(vertices, 3)),
    new THREE.PointsMaterial({ color: THEME.accent, size: 8, sizeAttenuation: false,
                               transparent: true, opacity: 0.95, depthTest: false }));
  dots.renderOrder = 5;
  dots.userData.handles = true;
  const group = new THREE.Group();
  group.add(dots);

  // The ones picked, marked over the top of the rest, so a run of them along an
  // edge reads as a run rather than as a guess.
  if (meshEdit.chosen.length) {
    const marks = meshEdit.chosen.map(v =>
      new THREE.Vector3(vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]));
    const on = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(marks),
      new THREE.PointsMaterial({ color: THEME.datum, size: 13, sizeAttenuation: false,
                                 depthTest: false }));
    on.renderOrder = 6;
    group.add(on);
  }
  world.add(group);
  meshEdit.dots = group;

  if (meshEdit.vertex >= 0) {
    if (!meshEdit.chosen.includes(meshEdit.vertex)) meshEdit.chosen = [meshEdit.vertex];
    const at = new THREE.Vector3(vertices[meshEdit.vertex * 3],
      vertices[meshEdit.vertex * 3 + 1], vertices[meshEdit.vertex * 3 + 2]);
    meshEdit.gizmo = buildGizmo(at);
    world.add(meshEdit.gizmo);
  }
  draw();
}

/* ==========================================================================
   The sketcher.

   A sketch is a drawing in two dimensions and a plane to put it on. Opening
   one takes the viewport over: the camera goes to the plane and stops
   orbiting, the tool rail steps aside for the seven things a drawing is made
   of, and a click is no longer a click on a solid - it is a point on the
   plane, in the plane's own two numbers.

   Nothing here holds any geometry. Every click ends as one line of the model
   description language - {"op":"draw","id":"SK1","type":"line","at":[[0,0],
   [120,0]]} - which goes down the same road as a slider and a wire, and comes
   back as a rebuilt sketch. Drawing a line and typing that line into the model
   file are the same edit, because there is only one of them.
   ========================================================================== */

const sketcher = {
  id: null,          // the sketch being drawn on
  tool: "select",    // a sketch opens ready to look at, not ready to draw
  clicks: [],        // the clicks so far, in the plane's coordinates
  from: null,        // the end a chain is carrying on from: { id, key }
  tangent: true,     // whether an arc off a chain leaves it smoothly
  hover: null,       // where the cursor is on the plane, for the rubber band
  picked: [],        // what a relation will be put on, in the order picked
  relation: -1,      // the relation marker under the cursor's last click, if any
  snapped: null,     // the handle the last click landed on, for coincidence
  drag: null,        // the handle under the cursor, mid-drag
  preview: null,     // the drawing as the drag would leave it, not yet written
  group: null,       // the overlay: handles, the band, what is picked
  orbit: null,       // the view to put back on the way out
};

//! Choosing a tool abandons whatever was half-drawn - a half-drawn thing
//! belongs to the tool that was drawing it.
function pickSketchTool(type) {
  // Reaching for the arc while a chain is live keeps the chain, so the arc can
  // leave it tangentially. Everything else starts clean.
  const carry = type === "arc" && sketcher.from && sketcher.clicks.length === 1;
  sketcher.tool = type;
  if (!carry) { sketcher.clicks = []; sketcher.from = null; sketcher.snapped = null; }
  sketcher.picked = [];
  sketcher.drag = null;
  sketcher.preview = null;
  refreshSketch();
}

//! What the buttons are called. The type names are lower case because they are
//! what the model file says; these are for people.
const SKETCH_LABELS = {
  select: "Select", point: "Point", line: "Polyline", arc: "Arc", circle: "Circle",
  ellipse: "Ellipse", oblong: "Oblong", spline: "Spline",
};

const sketching = () => (sketcher.id && feature(sketcher.id)) || null;

//! The plane, as the kernel last resolved it. The driver writes it down when
//! it builds, so the viewport never has to work out which way a plane's axes
//! point - which is exactly the sum it would get subtly wrong.
function sketchFrame() {
  const entry = sketching();
  const frame = entry && entry.sketch && entry.sketch.frame;
  if (!frame) return null;
  return {
    origin: new THREE.Vector3(...frame.origin),
    x: new THREE.Vector3(...frame.x),
    y: new THREE.Vector3(...frame.y),
    normal: new THREE.Vector3(...frame.normal),
  };
}

//! Two numbers on the paper, one point in the world - the same map the kernel
//! builds its edges through.
function sketchToWorld(uv, frame = sketchFrame()) {
  if (!frame) return new THREE.Vector3();
  return frame.origin.clone()
    .addScaledVector(frame.x, uv[0]).addScaledVector(frame.y, uv[1]);
}

//! And back: where a pointer is, on the plane, in the drawing's own numbers.
function sketchAt(event) {
  const frame = sketchFrame();
  if (!frame) return null;
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.origin);
  const hit = rayFrom(event).ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  const away = hit.sub(frame.origin);
  return [Math.round(away.dot(frame.x) * 1e3) / 1e3, Math.round(away.dot(frame.y) * 1e3) / 1e3];
}

//! The drawing as it should be seen. Mid-drag that is the drawing as the drag
//! would leave it - shown, not yet written, because a drag is one edit and it
//! is not finished until the cursor is let go.
const sketchDrawing = () => {
  if (sketcher.preview) return sketcher.preview;
  const entry = sketching();
  return entry && entry.sketch ? readSketch(entry.sketch.drawing) : { elements: [], constraints: [] };
};

//! How far a snap reaches, in the drawing's units: a fixed number of pixels,
//! turned into millimetres by how far away the camera is, so it feels the same
//! zoomed in and zoomed out.
const snapReach = () => view.distance * 0.018;

//! The nearest end of anything already drawn. Landing on one and saying so is
//! what makes a drawn corner a corner rather than two lines that nearly meet.
function nearestHandle(uv, drawing = sketchDrawing()) {
  let best = null, reach = snapReach();
  for (const el of drawing.elements) {
    for (const [key, p] of sketchHandles(el)) {
      const away = Math.hypot(p[0] - uv[0], p[1] - uv[1]);
      if (away < reach) { reach = away; best = { ref: el.id + "." + key, p, id: el.id }; }
    }
  }
  return best;
}

//! Where the relations are drawn. Several holding the same corner would sit on
//! top of one another, so they fan out from it - each one still beside what it
//! governs, and each one separately clickable.
function relationMarks(drawing = sketchDrawing()) {
  const marks = sketchRelationMarks(drawing);
  const step = snapReach() * 0.9;
  const seen = new Map();
  return marks.map(mark => {
    const at = mark.p.map(v => Math.round(v * 10) / 10).join(",");
    const nth = seen.get(at) || 0;
    seen.set(at, nth + 1);
    // Up and to the right of what it holds, then along, the way a drawing
    // board stacks its marks.
    return { ...mark, at: mark.at,
             draw: [mark.p[0] + step * (0.9 + nth * 1.0), mark.p[1] + step * 0.9] };
  });
}

function nearestRelation(uv, drawing = sketchDrawing()) {
  let best = -1, reach = snapReach();
  for (const mark of relationMarks(drawing)) {
    const away = Math.hypot(mark.draw[0] - uv[0], mark.draw[1] - uv[1]);
    if (away < reach) { reach = away; best = mark.at; }
  }
  return best;
}

//! The nearest element, by its own outline. What a relation is put on.
function nearestElement(uv, drawing = sketchDrawing()) {
  let best = null, reach = snapReach() * 1.6;
  for (const el of drawing.elements) {
    const line = sketchOutline(el, 48);
    for (const p of line) {
      const away = Math.hypot(p[0] - uv[0], p[1] - uv[1]);
      if (away < reach) { reach = away; best = el.id; }
    }
  }
  return best;
}

function enterSketch(id) {
  const entry = feature(id);
  if (!entry || !entry.sketch) return;
  if (handEditing()) { meshEdit.id = null; meshEdit.vertex = -1; refreshMeshEdit(); }
  sketcher.id = id;
  sketcher.tool = "select";
  sketcher.clicks = [];
  sketcher.from = null;
  sketcher.picked = [];
  sketcher.relation = -1;
  sketcher.snapped = null;
  sketcher.drag = null;
  sketcher.preview = null;
  sketcher.hover = null;
  sketcher.orbit = { yaw: view.yaw, pitch: view.pitch, distance: view.distance,
                     target: view.target.clone() };
  lookAtSketch();
  buildSketchRail();
  refreshSketch();
  // The drawing is worth having open while you draw on it: the panel shows the
  // JSON, which is the drawing itself and not a report of it.
  select(id, true);
}

function leaveSketch() {
  if (!sketcher.id) return;
  sketcher.id = null;
  sketcher.clicks = [];
  sketcher.from = null;
  sketcher.picked = [];
  sketcher.drag = null;
  sketcher.preview = null;
  if (sketcher.orbit) {
    Object.assign(view, { yaw: sketcher.orbit.yaw, pitch: sketcher.orbit.pitch,
                          distance: sketcher.orbit.distance });
    view.target.copy(sketcher.orbit.target);
    sketcher.orbit = null;
    placeCamera();
  }
  refreshSketch();
  refreshToolbar();
}

//! Square on to the plane, and staying there. The camera sits along the
//! plane's own normal; while a sketch is open the drag that would orbit pans
//! instead, because a drawing seen at an angle is a drawing you cannot draw on.
function lookAtSketch() {
  const frame = sketchFrame();
  if (!frame) return;
  const n = frame.normal;
  view.target.copy(frame.origin);
  view.yaw = Math.atan2(n.y, n.x);
  view.pitch = Math.max(-1.53, Math.min(1.53, Math.asin(Math.max(-1, Math.min(1, n.z)))));
  placeCamera();
  draw();
}

/* ------------------------------------------------------- drawing overlay */

function refreshSketch() {
  if (sketcher.group) { world.remove(sketcher.group); disposeGroup(sketcher.group); sketcher.group = null; }
  const bar = document.getElementById("sketch-bar");
  const rail = document.getElementById("sketch-rail");
  const entry = sketching();
  bar.hidden = rail.hidden = !entry;
  document.getElementById("rail").hidden = !!entry;
  if (!entry) { draw(); return; }

  document.getElementById("sketch-who").textContent = entry.name;
  document.getElementById("sketch-hint").textContent = sketchHint();
  for (const button of rail.querySelectorAll(".tool[data-sketch]"))
    button.classList.toggle("on", button.dataset.sketch === sketcher.tool);
  for (const button of rail.querySelectorAll(".tool[data-relation]"))
    button.classList.toggle("ready", relationReady(button.dataset.relation));
  // The tangent switch is only a question while there is something to be
  // tangent to, so it is only asked then.
  const smooth = document.getElementById("sketch-tangent");
  smooth.hidden = !(sketcher.from && sketcher.clicks.length === 1);
  smooth.setAttribute("aria-pressed", sketcher.tangent ? "true" : "false");
  // Only offered when there is one in hand, because it is the one button here
  // that takes something away.
  document.getElementById("sketch-unrelate").hidden = sketcher.relation < 0;

  const frame = sketchFrame();
  if (!frame) { draw(); return; }
  const group = new THREE.Group();
  const drawing = sketchDrawing();

  // The drawing itself, over the top of everything. The kernel already built
  // these edges and the viewport already draws them - but behind the solid the
  // sketch was padded into, and a line you cannot see is a line you cannot
  // draw against.
  for (const el of drawing.elements) {
    const line = sketchOutline(el, 64).map(p => sketchToWorld(p, frame));
    if (line.length < 2) continue;
    const over = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(line),
      new THREE.LineBasicMaterial({ color: THEME.curve, depthTest: false,
                                    transparent: true, opacity: 0.85 }));
    over.renderOrder = 5;
    group.add(over);
  }

  // Every end of everything, as a dot. These are what a click snaps to and
  // what a coincidence is put between.
  const dots = [];
  for (const el of drawing.elements)
    for (const [, p] of sketchHandles(el)) dots.push(sketchToWorld(p, frame));
  if (dots.length) {
    const cloud = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(dots),
      new THREE.PointsMaterial({ color: THEME.datum, size: 6, sizeAttenuation: false,
                                 depthTest: false }));
    cloud.renderOrder = 6;
    group.add(cloud);
  }

  // The relations, each beside what it holds. They are not geometry, so they
  // are drawn rather than built: a small glyph you can click, and take off.
  for (const mark of relationMarks(drawing)) {
    const chosen = mark.at === sketcher.relation;
    const colour = chosen ? THEME.accent : THEME.datum;
    const at = sketchToWorld(mark.draw, frame);
    const size = snapReach() * 0.42;
    const glyph = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(
        RELATION_GLYPH[mark.type].map(([u, v]) =>
          sketchToWorld([mark.draw[0] + u * size, mark.draw[1] + v * size], frame))),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
    glyph.renderOrder = 8;
    group.add(glyph);
    // A thread back to what it holds, so a fanned-out mark still says which
    // corner it belongs to.
    for (const on of mark.on) {
      const tie = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([at, sketchToWorld(on, frame)]),
        new THREE.LineBasicMaterial({ color: colour, depthTest: false,
                                      transparent: true, opacity: chosen ? 0.7 : 0.28 }));
      tie.renderOrder = 8;
      group.add(tie);
    }
  }

  // What a relation would be put on, drawn over the top of it.
  for (const id of sketcher.picked) {
    const el = drawing.elements.find(e => e.id === String(id).split(".")[0]);
    if (!el) continue;
    const line = sketchOutline(el, 48).map(p => sketchToWorld(p, frame));
    if (line.length < 2) continue;
    const shown = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(line),
      new THREE.LineBasicMaterial({ color: THEME.accent, depthTest: false }));
    shown.renderOrder = 7;
    group.add(shown);
  }

  // The element being drawn, following the cursor. Made the same way the real
  // one will be, so what is shown is what will be written.
  const band = sketchBand(drawing);
  if (band) {
    const line = sketchOutline(band, 48).map(p => sketchToWorld(p, frame));
    if (line.length >= 2) {
      const rubber = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(line),
        new THREE.LineDashedMaterial({ color: THEME.accent, dashSize: 6, gapSize: 4,
                                       depthTest: false }));
      rubber.computeLineDistances();
      rubber.renderOrder = 7;
      group.add(rubber);
    }
  }

  world.add(group);
  sketcher.group = group;
  draw();
}

//! The element the clicks so far would make if the cursor were the last one.
//! Made the same way the real one will be, so what is shown is what will be
//! written - including a tangent arc, which is worth seeing before you commit
//! to it.
function sketchBand(drawing) {
  if (!sketcher.hover || !sketcher.clicks.length) return null;
  const wanted = SKETCH_CLICKS[sketcher.tool];
  const clicks = [...sketcher.clicks, sketcher.hover];
  const smooth = tangentHere(drawing);
  if (smooth && sketcher.tool === "arc")
    return sketchTangentArc(sketcher.clicks[0], smooth, sketcher.hover, "band");
  if (wanted && clicks.length < wanted)
    // Not enough yet to be what it will be; show the straight run of clicks.
    return { id: "band", type: "spline", pts: clicks, closed: false };
  try { return sketchElement(sketcher.tool, "band", clicks); } catch (e) { return null; }
}

//! The direction the chain is travelling, when there is a chain and tangency is
//! wanted. This is what makes the next arc leave the last line smoothly rather
//! than at a kink - the move a CAD sketcher is built around.
function tangentHere(drawing = sketchDrawing()) {
  // Only the arc tool leaves smoothly. Carrying on with the line tool is a
  // polyline, and a polyline's corners are corners.
  if (sketcher.tool !== "arc") return null;
  if (!sketcher.tangent || !sketcher.from || sketcher.clicks.length !== 1) return null;
  const el = drawing.elements.find(e => e.id === sketcher.from.id);
  return el ? sketchDirectionAt(el, sketcher.from.key) : null;
}

function sketchHint() {
  if (sketcher.tool === "select" && sketcher.picked.length === 1 && sketcher.relation < 0)
    return "1 picked · shift-click another, then a relation";
  if (sketcher.relation >= 0) {
    const drawing = sketchDrawing();
    const held = drawing.constraints[sketcher.relation];
    return (held ? held.type : "relation") + " · Delete to take it off";
  }
  if (sketcher.tool === "select") {
    if (sketcher.picked.length)
      return sketcher.picked.length + " picked · apply a relation, or Esc";
    return "select · drag an end to move it · click to pick, then relate";
  }
  const wanted = SKETCH_CLICKS[sketcher.tool] || 0;
  const smooth = tangentHere();
  if (smooth) return "arc · tangent to the last segment · click where it ends";
  if (sketcher.tool === "arc" && sketcher.from && sketcher.clicks.length === 1)
    return "arc · 2 more clicks · Tangent to carry on smoothly";
  if (sketcher.tool === "line" && sketcher.clicks.length)
    return "polyline · click for the next corner · Esc or Enter to stop";
  if (!wanted) return "spline · click points, Enter or double-click to finish";
  const left = wanted - sketcher.clicks.length;
  return sketcher.tool + " · " + (left > 0 ? left + " more click" + (left === 1 ? "" : "s")
                                           : "click to place");
}

/* --------------------------------------------------------------- clicking */

//! One click on the plane. In select it picks or starts a drag; with a tool it
//! collects clicks until there are enough to be something, and writes it.
function sketchClick(event) {
  const uv = sketchAt(event);
  if (!uv) return;
  const drawing = sketchDrawing();

  if (sketcher.tool === "select") {
    // A relation's own mark is the first thing under the cursor: it is drawn
    // over the drawing, and clicking one is how it is taken off again.
    const relation = nearestRelation(uv, drawing);
    if (relation >= 0) {
      sketcher.relation = sketcher.relation === relation ? -1 : relation;
      sketcher.picked = [];
      refreshSketch();
      return;
    }
    sketcher.relation = -1;
    // Picking is what select is for: ends for a coincidence, whole elements
    // for everything else. Shift adds to what is picked, here as everywhere
    // else; clicking nothing clears, the way a canvas does.
    const handle = nearestHandle(uv, drawing);
    const want = handle ? handle.ref : nearestElement(uv, drawing);
    pickInSketch(want, event.shiftKey);
    return;
  }

  // Asked before the click is added, because whether this click finishes a
  // tangent arc depends on what was there before it, not after.
  const smooth = tangentHere(drawing);
  const snap = nearestHandle(uv, drawing);
  const at = snap ? snap.p.slice() : uv;
  if (!sketcher.clicks.length && !sketcher.from) sketcher.snapped = snap ? snap.ref : null;
  sketcher.clicks.push(at);
  // A tangent arc needs only where it ends: where it starts and which way it
  // leaves are both already settled by the element before it.
  const enough = smooth ? 2 : SKETCH_CLICKS[sketcher.tool];
  if (enough && sketcher.clicks.length >= enough) commitSketchElement(snap, smooth);
  else refreshSketch();
}

//! Which handle of a freshly drawn element is its start and which its end.
const SKETCH_ENDS = { line: ["a", "b"], arc: ["start", "end"], spline: null };

function commitSketchElement(endSnap, smooth = null) {
  const clicks = sketcher.clicks.slice();
  const opening = sketcher.snapped;
  const carried = sketcher.from;
  sketcher.clicks = [];
  sketcher.snapped = null;
  if (clicks.length < 2) { refreshSketch(); return; }

  const drawing = sketchDrawing();
  const id = nextSketchId(drawing);
  const tool = sketcher.tool;

  // Tangency is said, not computed here: the edit names the end to leave and
  // the point to reach, and the op works out the arc. So the line in the
  // console is the whole of what happened, and replaying it draws the same arc.
  const carry = smooth ? carried.id + "." + carried.key : null;
  const edits = [carry
    ? { op: "draw", id: sketcher.id, type: "arc", at: [clicks[1]], from: carry, as: id }
    : { op: "draw", id: sketcher.id, type: tool, at: clicks, as: id }];

  const pair = SKETCH_ENDS[tool === "select" ? "line" : tool];
  // An element drawn onto the end of another is meant to stay on it. The snap
  // put it there; the coincidence keeps it there when either is moved. A chain
  // carries its own join, so the corner holds without a second click.
  // A tangent arc already starts where the chain left off; it needs no second
  // way of being told so.
  const joinTo = carry ? null : (opening || (carried && carried.id + "." + carried.key));
  if (pair && joinTo)
    edits.push({ op: "relate", id: sketcher.id, type: "coincident",
                 of: [id + "." + pair[0], joinTo] });
  if (pair && endSnap && endSnap.ref !== joinTo)
    edits.push({ op: "relate", id: sketcher.id, type: "coincident",
                 of: [id + "." + pair[1], endSnap.ref] });

  // A line keeps going: this is a polyline tool, so the end of the segment just
  // drawn is the start of the next one, and switching to the arc tool now
  // carries the tangent with it. Anything else is one element and stops.
  const chains = tool === "line" || tool === "arc";
  if (chains && pair) {
    sketcher.from = { id, key: pair[1] };
    sketcher.clicks = [endSnap ? endSnap.p.slice() : clicks[clicks.length - 1]];
  } else {
    sketcher.from = null;
  }
  mdl.runAll(edits).catch(err => showError(err.message));
}

//! Enter, a double-click, or Esc: that was the last point. A spline needs it
//! because it is however long you make it; a chain needs it because it would
//! otherwise carry on for ever.
function endSketchRun() {
  if (!SKETCH_CLICKS[sketcher.tool] && sketcher.clicks.length >= 2) {
    commitSketchElement(null);
    sketcher.from = null;
    sketcher.clicks = [];
    refreshSketch();
    return true;
  }
  if (sketcher.clicks.length || sketcher.from) {
    sketcher.clicks = [];
    sketcher.from = null;
    sketcher.snapped = null;
    refreshSketch();
    return true;
  }
  return false;
}

/* --------------------------------------------------------------- dragging */

//! Dragging an end of an element. The drawing is changed as the cursor moves so
//! it can be seen, but only the end of the drag is written - one edit, one
//! step to undo, however far the cursor travelled.
function grabSketchHandle(event) {
  if (!sketching() || sketcher.tool !== "select") return false;
  const uv = sketchAt(event);
  if (!uv) return false;
  const found = nearestHandle(uv);
  if (!found) return false;
  sketcher.drag = { ref: found.ref, at: found.p.slice(), moved: false };
  return true;
}

function dragSketchHandle(event) {
  const uv = sketchAt(event);
  if (!uv || !sketcher.drag) return;
  sketcher.drag.at = uv;
  sketcher.drag.moved = true;
  // Shown from the drawing as it would be, without writing anything yet.
  const preview = sketchDrawing();
  const found = sketchHandleAt(preview, sketcher.drag.ref);
  if (found) { sketchMoveHandle(found.el, found.key, uv); sketcher.preview = preview; }
  refreshSketch();
}

function dropSketchHandle(event) {
  const drag = sketcher.drag;
  sketcher.drag = null;
  sketcher.preview = null;
  if (!drag) return;
  if (!drag.moved) {
    // Taken hold of and let go without moving: that is a click, and a click on
    // an end picks it. Two picked ends are what a coincidence is made from.
    sketcher.relation = -1;
    pickInSketch(drag.ref, !!(event && event.shiftKey));
    return;
  }
  edit({ op: "drag", id: sketcher.id, handle: drag.ref, to: drag.at });
}

//! One thing picked in the drawing - an end, or a whole element. Shift adds
//! and takes away; without it a pick is a set of one. Written once because a
//! click on a handle and a click on an element arrive by different roads.
function pickInSketch(want, add) {
  if (!want) { if (!add) sketcher.picked = []; refreshSketch(); return; }
  if (!add) {
    sketcher.picked = sketcher.picked.length === 1 && sketcher.picked[0] === want ? [] : [want];
  } else if (sketcher.picked.includes(want)) {
    sketcher.picked = sketcher.picked.filter(p => p !== want);
  } else sketcher.picked.push(want);
  refreshSketch();
}

/* -------------------------------------------------------------- relations */

//! Taking a relation off. What it held comes apart again, which is the point.
function dropRelation() {
  const at = sketcher.relation;
  if (at < 0) return;
  sketcher.relation = -1;
  edit({ op: "unrelate", id: sketcher.id, at });
}

const relationReady = key => {
  const spec = SKETCH_RELATIONS.find(r => r.key === key);
  if (!spec) return false;
  const wanted = spec.of === "handle";
  const usable = sketcher.picked.filter(p => p.includes(".") === wanted);
  return usable.length >= spec.takes;
};

//! Select first, then say what should hold - the way every parametric sketcher
//! works. A relation with nothing picked says what it wants rather than doing
//! nothing.
function putRelation(key) {
  const spec = SKETCH_RELATIONS.find(r => r.key === key);
  if (!spec) return;
  const wanted = spec.of === "handle";
  const usable = sketcher.picked.filter(p => p.includes(".") === wanted);
  if (usable.length < spec.takes) {
    document.getElementById("sketch-hint").textContent =
      spec.label + " · pick " + spec.takes + " "
      + (wanted ? "ends" : spec.of === "line" ? "lines" : "elements") + " first";
    return;
  }
  const of = usable.slice(0, spec.takes);
  sketcher.picked = [];
  edit({ op: "relate", id: sketcher.id, type: key, of });
}

/* -------------------------------------------------------------- the rail */

//! The rail the sketcher draws with: the seven things a drawing is made of,
//! then the six ways one part of it can be held against another.
function buildSketchRail() {
  const rail = document.getElementById("sketch-rail");
  if (rail.dataset.built) return;
  rail.dataset.built = "1";

  const tools = document.createElement("div");
  tools.dataset.group = "elements";
  // Select comes first and is where the sketcher starts, because opening a
  // sketch should not arm a tool: the first thing you want to do to a drawing
  // is usually look at it and push something.
  for (const type of ["select", ...SKETCH_TYPES]) {
    const button = document.createElement("button");
    button.className = "tool";
    button.dataset.sketch = type;
    button.dataset.label =
      type === "select" ? "Select · drag an end, or pick things to relate"
      : type === "line" ? "Polyline · click corner after corner"
      : type === "arc" ? "Arc · 3 clicks, or tangent to what you just drew"
      : SKETCH_CLICKS[type] ? SKETCH_LABELS[type] + " · " + SKETCH_CLICKS[type] + " clicks"
      : SKETCH_LABELS[type] + " · click points, Enter to finish";
    button.setAttribute("aria-label", type);
    button.innerHTML = svg(SKETCH_ICONS[type]);
    button.addEventListener("click", () => pickSketchTool(type));
    tools.appendChild(button);
  }
  rail.appendChild(tools);
  rail.appendChild(document.createElement("hr"));

  const relations = document.createElement("div");
  relations.dataset.group = "relations";
  for (const spec of SKETCH_RELATIONS) {
    const button = document.createElement("button");
    button.className = "tool";
    button.dataset.relation = spec.key;
    button.dataset.label = spec.label + " · " + spec.hint;
    button.setAttribute("aria-label", spec.label);
    button.innerHTML = svg(SKETCH_ICONS[spec.key]);
    button.addEventListener("click", () => putRelation(spec.key));
    relations.appendChild(button);
  }
  rail.appendChild(relations);
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
  // Every vertex picked moves, each from wherever it already was - so pushing a
  // run of them keeps whatever shape the run had.
  meshEdit.before = {};
  for (const at of meshEdit.chosen) meshEdit.before[at] = (moves[at] || [0, 0, 0]).slice();
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
  for (const at of Object.keys(meshEdit.before)) meshEdit.before[at][which] += step / factor;
  draw();
}

function dropGizmo() {
  if (!meshEdit.axis) return;
  const moves = meshEdit.before;
  meshEdit.axis = null;
  // One line of the language per vertex, run in order: a drag of six vertices
  // is six edits and one step to undo, and the file says exactly what moved.
  const edits = Object.keys(moves).map(at => {
    // A hand drag is not worth six decimal places; the file stays readable.
    const offset = moves[at].map(v => Math.round(v * 1000) / 1000);
    return { op: "vertex", id: meshEdit.id, index: Number(at),
             x: offset[0], y: offset[1], z: offset[2] };
  });
  if (edits.length) mdl.runAll(edits).catch(err => showError(err.message));
}

//! A handle under the pointer selects that vertex. The threshold is in pixels,
//! so a vertex is as easy to hit far away as up close.
//! Shift adds to what is picked and takes it away again; a plain click starts
//! over. The handle goes on the last one picked and moves all of them, which is
//! how every modeller does it and what makes pushing a whole edge possible.
function pickVertex(event) {
  if (!meshEdit.dots) return false;
  const cast = rayFrom(event);
  cast.params.Points.threshold = view.distance * 0.012;
  const hits = cast.intersectObject(meshEdit.dots.children[0], false);
  if (!hits.length) return false;
  const at = hits[0].index;
  if (event.shiftKey) {
    if (meshEdit.chosen.includes(at)) {
      meshEdit.chosen = meshEdit.chosen.filter(v => v !== at);
      meshEdit.vertex = meshEdit.chosen.length ? meshEdit.chosen[meshEdit.chosen.length - 1] : -1;
    } else {
      meshEdit.chosen.push(at);
      meshEdit.vertex = at;
    }
  } else {
    meshEdit.chosen = [at];
    meshEdit.vertex = at;
  }
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
  const id = hits.length ? hits[0].object.userData.id : null;
  if (event.shiftKey && id) pickAlso(id); else select(id, false);
}

//! Everything in view, and no further back than it has to be. The bounding
//! sphere is used rather than the box because a sphere looks the same from
//! every angle, so the framing does not change when the model is turned.
function fitView() {
  const box = sceneBounds();
  if (!box) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  view.span = Math.max(sphere.radius, 1);
  const framing = frameFor(view.span, freeRect());
  view.target.copy(sphere.center);
  view.distance = framing.distance;
  // Aiming off-centre by the same amount the free rectangle is off-centre puts
  // the part in the clear rather than behind a panel.
  placeCamera();
  const out = new THREE.Vector3().subVectors(camera.position, view.target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, out);
  if (right.lengthSq() < 1e-8) right.set(-Math.sin(view.yaw), Math.cos(view.yaw), 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(out, right).normalize();
  view.target.addScaledVector(right, -framing.shift[0])
             .addScaledVector(up, framing.shift[1]);
  placeCamera(); draw();
}

/* ==========================================================================
   Interface.
   ========================================================================== */

//! The sketcher's own rail. Seven shapes and six relations, drawn the way a
//! drawing board draws them.
//! Each relation as a run of line segments in its own little square, drawn on
//! the sketch plane beside what it holds. Pairs of points: every two make one
//! segment, which is what THREE.LineSegments wants.
const RELATION_GLYPH = {
  // two rings, meeting
  coincident: [[-0.9, 0], [-0.1, 0], [0.1, 0], [0.9, 0],
               [-0.35, -0.55], [0.35, -0.55], [-0.35, 0.55], [0.35, 0.55],
               [-0.35, -0.55], [-0.35, 0.55], [0.35, -0.55], [0.35, 0.55]],
  horizontal: [[-0.9, 0.35], [0.9, 0.35], [-0.9, -0.35], [0.9, -0.35]],
  vertical:   [[-0.35, -0.9], [-0.35, 0.9], [0.35, -0.9], [0.35, 0.9]],
  parallel:   [[-0.6, -0.9], [-0.1, 0.9], [0.2, -0.9], [0.7, 0.9]],
  perpendicular: [[-0.8, -0.8], [0.8, -0.8], [-0.2, -0.8], [-0.2, 0.9],
                  [-0.2, -0.4], [0.2, -0.4], [0.2, -0.4], [0.2, -0.8]],
  tangent:    [[-0.9, -0.7], [0.9, -0.7],
               [-0.5, -0.7], [-0.5, -0.3], [-0.5, -0.3], [0, 0.3],
               [0, 0.3], [0.5, -0.3], [0.5, -0.3], [0.5, -0.7]],
};

const SKETCH_ICONS = {
  // The cursor itself: what the sketcher hands you before you ask for a tool.
  select: '<path d="M3.4 2.2l9.4 5.1-4 1-1.6 4.2z" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
  point: '<circle cx="8" cy="8" r="2.2" fill="currentColor"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2" stroke="currentColor" stroke-width="1"/>',
  line: '<path d="M2.6 13.4L13.4 2.6" stroke="currentColor" stroke-width="1.4"/><circle cx="2.6" cy="13.4" r="1.5" fill="currentColor"/><circle cx="13.4" cy="2.6" r="1.5" fill="currentColor"/>',
  arc: '<path d="M2.4 12.4A9 9 0 0112.4 2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="2.4" cy="12.4" r="1.4" fill="currentColor"/><circle cx="12.4" cy="2.4" r="1.4" fill="currentColor"/>',
  circle: '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="6.2" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/>',
  oblong: '<rect x="1.6" y="4.6" width="12.8" height="6.8" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  spline: '<path d="M1.8 11.5c2.6 0 2.6-7 5.2-7s2.6 7 5.2 7 2.6-3 2.6-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',

  coincident: '<path d="M2 11.5L7.4 6.1M14 4.5L8.6 9.9" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  horizontal: '<path d="M1.8 8h12.4" stroke="currentColor" stroke-width="1.6"/><path d="M1.8 12.5h12.4" stroke="currentColor" stroke-width=".9" stroke-dasharray="2 2" opacity=".5"/>',
  vertical: '<path d="M8 1.8v12.4" stroke="currentColor" stroke-width="1.6"/><path d="M12.5 1.8v12.4" stroke="currentColor" stroke-width=".9" stroke-dasharray="2 2" opacity=".5"/>',
  parallel: '<path d="M3.4 13.6L7.6 2.4M8.8 13.6L13 2.4" stroke="currentColor" stroke-width="1.4"/>',
  perpendicular: '<path d="M3 13h10M4.6 13V3" stroke="currentColor" stroke-width="1.4"/><path d="M4.6 10.6h2.4v2.4" fill="none" stroke="currentColor" stroke-width="1"/>',
  tangent: '<circle cx="9" cy="9" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.6 4.6h12.8" stroke="currentColor" stroke-width="1.4"/>',
};

const ICONS = {
  Point: '<circle cx="8" cy="8" r="2.4" fill="currentColor"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.2"/>',
  Vector: '<path d="M2 13L12 4" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 2.5L9 3.6l3.4 3.2z" fill="currentColor"/>',
  Line: '<path d="M2 13L14 3" stroke="currentColor" stroke-width="1.5"/><circle cx="2.6" cy="12.6" r="1.6" fill="currentColor"/><circle cx="13.4" cy="3.4" r="1.6" fill="currentColor"/>',
  // A sheet with a drawing on it: the plane, and two dimensions of lines.
  Sketch: '<path d="M1.6 11.2L5.6 4.6h8.8L10.4 11.2z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" opacity=".55"/>'
        + '<path d="M4.6 9.6h5.4M7.6 6.2v3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
        + '<circle cx="4.6" cy="9.6" r="1.15" fill="currentColor"/><circle cx="10" cy="9.6" r="1.15" fill="currentColor"/>',
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
  undo: '<path d="M3.4 7.6h6.2a3.6 3.6 0 010 7.2H6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.2 4.2L2.8 7.6l3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  redo: '<path d="M12.6 7.6H6.4a3.6 3.6 0 000 7.2h3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.8 4.2l3.4 3.4-3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
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

/* ------------------------------------------------------------ the labels */

//! Every button that carries a data-label gets one, wherever it is: the tool
//! rail, the sketcher's rail, anything added later. One element, fixed to the
//! window, placed beside whatever the cursor is on - because a rail that
//! scrolls clips anything drawn beside a button inside it, which is what was
//! quietly happening to all of these.
(function labelOnHover() {
  const tip = document.getElementById("tip");
  let shown = null;

  const place = target => {
    const box = target.getBoundingClientRect();
    tip.textContent = target.dataset.label || "";
    tip.classList.toggle("dim", !!target.disabled);
    tip.classList.add("on");
    const width = tip.offsetWidth, height = tip.offsetHeight;
    // A button in a row along the top is labelled below it; one in a rail down
    // the side is labelled beside it. Either way it must not cover its
    // neighbours, which is the whole reason it is not a browser tooltip.
    const below = box.top < 80;
    let x = below ? box.left + box.width / 2 - width / 2 : box.right + 9;
    let y = below ? box.bottom + 8 : box.top + box.height / 2 - height / 2;
    if (!below && x + width > innerWidth - 6) x = box.left - 9 - width;
    tip.style.left = Math.max(6, Math.min(innerWidth - width - 6, x)) + "px";
    tip.style.top = Math.max(6, Math.min(innerHeight - height - 6, y)) + "px";
  };

  const hide = () => { shown = null; tip.classList.remove("on"); };

  addEventListener("pointerover", event => {
    const target = event.target.closest && event.target.closest("[data-label]");
    if (!target) { if (shown) hide(); return; }
    shown = target;
    place(target);
  }, true);
  addEventListener("pointerout", event => {
    if (shown && event.target === shown) hide();
  }, true);
  // A button that vanishes under the cursor - a rail swapped for another one -
  // must not leave its label behind.
  addEventListener("pointerdown", hide, true);
  addEventListener("scroll", () => { if (shown) place(shown); }, true);
})();
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
  document.getElementById("ai-close").innerHTML = svg(ICONS.close);
  document.getElementById("btn-undo").innerHTML = svg(ICONS.undo);
  document.getElementById("btn-redo").innerHTML = svg(ICONS.redo);
  refreshSteps();
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
    + (entry.error ? " failed" : "")
    + (entry.id === state.selected ? " selected" : "")
    + (state.picked.length > 1 && state.picked.includes(entry.id) ? " alongside" : "");
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
    // A sketch says what is drawn on it, ahead of everything else: it is what
    // you want to know about a sketch, and a sketch stays worth opening after
    // a pad has consumed it - which is the whole point of one. Only the count
    // here, though: the tree has a name to fit in beside it, and the whole of
    // it is in the panel.
    : entry.sketch ? (entry.sketch.drawing.elements.length || "empty")
        + (entry.sketch.drawing.elements.length === 1 ? " element"
           : entry.sketch.drawing.elements.length ? " elements" : "")
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

  li.addEventListener("click", event => {
    if (event.shiftKey) pickAlso(entry.id); else select(entry.id, false);
  });
  li.addEventListener("dblclick", () => {
    // A sketch opens into the sketcher, the way a CAD modeller does. Everything
    // else opens its definition.
    if (entry.sketch) { select(entry.id, false); enterSketch(entry.id); return; }
    select(entry.id, true);
  });
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
                   : arg.kind === "sketch" ? sketchField(entry, arg)
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
//! The drawing, in the panel. It says what is in the sketch, opens the
//! sketcher, and shows the JSON - which is the drawing itself, not a report of
//! it, so editing the text here is editing the sketch.
function sketchField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const drawing = (entry.sketch && entry.sketch.drawing) || { elements: [], constraints: [] };
  field.innerHTML = '<div class="field-head"><label>' + arg.label + "</label>" +
    '<span class="kind">' + escapeHtml((entry.sketch && entry.sketch.summary) || "empty") +
    "</span></div>";

  const open = document.createElement("button");
  open.className = "row-btn";
  open.type = "button";
  open.textContent = sketcher.id === entry.id ? "Close the sketcher" : "Draw on it…";
  open.addEventListener("click", () =>
    (sketcher.id === entry.id ? leaveSketch() : enterSketch(entry.id)));
  field.appendChild(open);

  const area = document.createElement("textarea");
  area.className = "code";
  area.rows = 7;
  area.spellcheck = false;
  area.value = JSON.stringify(drawing, null, 1);
  area.addEventListener("change", () => {
    let parsed;
    try { parsed = JSON.parse(area.value); }
    catch (err) { showError("the drawing is not valid JSON: " + err.message); return; }
    edit({ op: "sketch", id: entry.id, drawing: parsed });
  });
  field.appendChild(area);

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = escapeHtml(entry.labels[arg.key] || "") + " · <b>TDataStd_AsciiString</b>";
  field.appendChild(path);
  return field;
}

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

  // The declared range is how far the slider travels, not a limit on the value:
  // a number typed or wired may be anywhere. So the track stretches to hold
  // whatever it is actually showing, and the handle never sits lying at one end.
  const span = sliderSpan(arg, value);
  field.innerHTML =
    '<div class="field-head"><label for="p-' + arg.key + '">' + arg.label + "</label>" +
    '<span class="value-box"><input type="number" id="n-' + arg.key + '" value="' + round(value) +
    '" step="' + arg.step + '"' +
    (from ? " disabled" : "") + "><span class=\"unit\">" + (arg.unit || "") + "</span></span></div>" +
    '<input type="range" id="p-' + arg.key + '" min="' + span.min + '" max="' + span.max +
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

//! Shift adds to what is picked and takes it away again; a plain click starts
//! over. The set is what a Loft's sections and a Join's parts are wired from,
//! and what Delete removes - so picking several is worth doing.
function pickAlso(id) {
  if (!id) { state.picked = []; select(null, false); return; }
  state.picked = state.picked.includes(id)
    ? state.picked.filter(p => p !== id)
    : [...state.picked, id];
  // The panel follows the last one picked, and the set is kept: this is the
  // one path that adds rather than replaces.
  select(state.picked.length ? state.picked[state.picked.length - 1] : null, false, true);
}

//! \p keep leaves the picked set alone; without it a selection is a set of
//! one, so there is only ever one answer to "what is selected".
function select(id, openDefinition, keep = false) {
  if (!keep) state.picked = id ? [id] : [];
  state.selected = id;
  if (openDefinition || (id && state.edited && id !== state.edited)) state.edited = id;
  const entry = feature(id);
  document.getElementById("status-sel").innerHTML = entry
    ? "<b>" + escapeHtml(entry.name) + "</b> · " + entry.entry + " · " + entry.type
    : "click a body · double-click to edit it";
  buildTree(); buildPanel(); refreshToolbar(); paintSelection();
  refreshMeshEdit();
  // Selecting anything else leaves the sketch; the tree is a way out too.
  if (sketcher.id && id !== sketcher.id) leaveSketch();
  else if (sketcher.id) refreshSketch();
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
  // The graph may be on another screen; the drawing is not. Draw… on a sketch
  // node opens the sketcher here.
  onSketch: id => { focus(); enterSketch(id); },
});
document.getElementById("btn-graph").addEventListener("click", () => graph.toggle());
/* ----------------------------------------------------------- undo, redo */

//! Both are edits, so they go down the same channel as everything else and are
//! recorded the same way. What they walk is the stack of model files the
//! channel keeps: every edit that changed the document remembers what it said
//! before, so undo is never a guess about what an edit did.
function step(back) {
  mdl.run({ op: back ? "undo" : "redo" })
     .then(() => { select(state.selected, false); refreshSteps(); })
     .catch(err => { showError(err.message); refreshSteps(); });
}

function refreshSteps() {
  const undo = document.getElementById("btn-undo");
  const redo = document.getElementById("btn-redo");
  undo.disabled = !mdl.undoable;
  redo.disabled = !mdl.redoable;
  undo.dataset.label = mdl.undoable ? "Undo " + mdl.undoable + " (Ctrl+Z)" : "Nothing to undo";
  redo.dataset.label = mdl.redoable ? "Redo " + mdl.redoable + " (Ctrl+Shift+Z)" : "Nothing to redo";
}

document.getElementById("btn-undo").addEventListener("click", () => step(true));
document.getElementById("btn-redo").addEventListener("click", () => step(false));
// Every edit moves the stack, wherever it came from - a slider here, a wire in
// the node graph, a line typed into the console.
mdl.watch(() => refreshSteps());

document.getElementById("sketch-done").addEventListener("click", leaveSketch);
document.getElementById("sketch-unrelate").addEventListener("click", dropRelation);
document.getElementById("sketch-tangent").addEventListener("click", () => {
  sketcher.tangent = !sketcher.tangent;
  refreshSketch();
});

/* ----------------------------------------------------------------------- AI

   Claude, working the one channel everything else works. It is handed the op
   table, the catalogue and the document, and what it writes goes through
   mdl.run exactly as a dragged wire does - so there is nothing it can do that
   could not have been typed into the console, and watching it work is watching
   nodes appear and wire themselves up.
   ========================================================================== */

const agent = new Agent({
  mdl,
  // The model file as the kernel writes it - the same text the Model dialog
  // shows and the same one a sample loads. There is only one of it.
  read: async () => ({
    schema: state.schema,
    model: await kernel.model(),
    errors: (state.tree ? state.tree.features : [])
      .filter(f => f.error).map(f => f.id + ' "' + f.name + '": ' + f.error),
  }),
  onBusy: busy => {
    following = busy;
    if (busy) fitView();
    aiBar.classList.toggle("working", busy);
    document.getElementById("ai-stop").hidden = !busy;
    document.getElementById("ai-send").disabled = busy;
    document.getElementById("ai-state").textContent = busy ? "building" : "ask";
  },
});

const aiBar = document.getElementById("ai-bar");
const aiLog = document.getElementById("ai-log");

function aiSay(className, text) {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  aiLog.appendChild(line);
  aiLog.scrollTop = aiLog.scrollHeight;
  return line;
}

//! How many lines are behind the fold, so a shut panel still says there is
//! something to look at.
function aiCount() {
  const fold = document.getElementById("ai-fold");
  fold.dataset.count = aiLog.childElementCount || "";
}

//! What Claude is doing, as it does it. An edit that lands is one line of the
//! language, shown as the language - because that is exactly what was sent.
function aiEvent(event, running) {
  if (event.kind === "text") {
    if (!running.said) running.said = aiSay("said", "");
    running.said.textContent = event.text;
    aiLog.scrollTop = aiLog.scrollHeight;
    return;
  }
  if (event.kind === "edit" || event.kind === "refused") {
    const line = document.createElement("div");
    line.className = event.kind === "refused" ? "bad" : "did";
    if (event.kind === "refused") {
      line.textContent = "refused: " + JSON.stringify(event.edit) + " — " + event.message;
    } else {
      const what = document.createElement("b");
      what.textContent = event.edit.op;
      const rest = document.createElement("span");
      const { op, ...fields } = event.edit;
      rest.textContent = JSON.stringify(fields);
      line.append(what, rest);
    }
    aiLog.appendChild(line);
    aiLog.scrollTop = aiLog.scrollHeight;
    aiCount();
    // The next thing it says starts a new line rather than growing this one.
    running.said = null;
  }
}

async function aiAsk() {
  const field = document.getElementById("ai-prompt");
  const prompt = field.value.trim();
  if (!prompt || agent.busy) return;
  field.value = "";
  aiSay("asked", prompt);
  const running = { said: null };
  try {
    await agent.ask(prompt, event => aiEvent(event, running));
  } catch (err) {
    aiSay("bad", agentTrouble(err));
  }
}

//! The working is worth watching the first time and in the way the tenth, so
//! it folds down to the prompt alone and stays that way until it is opened
//! again. What is happening is still on screen: it is the model.
function foldAI(shut) {
  aiBar.classList.toggle("folded", shut);
  const fold = document.getElementById("ai-fold");
  fold.setAttribute("aria-pressed", shut ? "true" : "false");
  fold.dataset.label = shut ? "Show what it is doing" : "Hide what it is doing";
  remember("ocafcad/ai-fold", shut ? "shut" : "open");
  aiLog.scrollTop = aiLog.scrollHeight;
}

function openAI(open) {
  aiBar.hidden = !open;
  document.getElementById("btn-ai").setAttribute("aria-pressed", open ? "true" : "false");
  if (!open) { agent.stop(); return; }
  document.getElementById("ai-prompt").focus();
  // Said once, on the first opening, so nobody types into a bar that cannot ask.
  if (!aiBar.dataset.checked) {
    aiBar.dataset.checked = "1";
    agent.ready().then(sample => {
      if (!sample) aiSay("bad", agentTrouble({ message: "no-sample" }));
    });
  }
}

document.getElementById("ai-fold").addEventListener("click", () =>
  foldAI(!aiBar.classList.contains("folded")));
document.getElementById("btn-ai").addEventListener("click", () => openAI(aiBar.hidden));
document.getElementById("ai-send").addEventListener("click", aiAsk);
document.getElementById("ai-stop").addEventListener("click", () => {
  agent.stop();
  aiSay("bad", "Stopped. Ask for something else, or say what to change.");
});
document.getElementById("ai-close").addEventListener("click", () => openAI(false));
document.getElementById("ai-prompt").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); aiAsk(); }
  event.stopPropagation();
});

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
  // Undo works even from a field: it is the one shortcut people expect
  // everywhere, and the browser's own would only undo the typing.
  if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    step(!event.shiftKey);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    step(false);
    return;
  }
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "f" || event.key === "F") { if (sketching()) lookAtSketch(); else fitView(); }
  if (event.key === "t" || event.key === "T") toggleTree();
  if (event.key === "g" || event.key === "G") graph.toggle();
  if (event.key === "a" || event.key === "A") openAI(aiBar.hidden);
  if (sketching() && sketcher.relation >= 0 &&
      (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    dropRelation();
    return;
  }
  if (event.key === "Enter" && sketching()) { endSketchRun(); return; }
  if (event.key === "Escape") {
    sampleMenu.hidden = true;
    if (!aiBar.hidden) { openAI(false); return; }
    if (staging) return leaveShowroom();
    // Out of the sketcher a step at a time: the half-drawn element, then what
    // is picked, then the sketch itself.
    if (sketching()) {
      if (endSketchRun()) return;
      if (sketcher.relation >= 0) { sketcher.relation = -1; refreshSketch(); return; }
      if (sketcher.picked.length) { sketcher.picked = []; refreshSketch(); return; }
      if (sketcher.tool !== "select") { pickSketchTool("select"); return; }
      leaveSketch();
      return;
    }
    state.edited = null; buildPanel(); logPop.hidden = true;
  }
});

(async function start() {
  readTheme();
  buildGround();
  placeCamera();
  resize();

  if (recall("ocafcad/tree") === "off") treePanel.hidden = true;
  foldAI(recall("ocafcad/ai-fold") === "shut");

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
