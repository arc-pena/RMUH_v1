import { createWasmKernel } from "./wasm-kernel.js";
import { createHttpKernel } from "./http-kernel.js";
import { ENVIRONMENTS, FINISHES, Showroom, findFinish } from "./showroom.js";

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
  for (const name of ["shape", "shape-edge", "accent", "datum", "grid", "grid-axis", "bad"])
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
    mode = (event.shiftKey || event.button === 1 || event.button === 2) ? "pan" : "orbit";
    lastX = event.clientX; lastY = event.clientY; moved = 0;
    el.setPointerCapture(event.pointerId);
  });
  el.addEventListener("pointermove", event => {
    if (!mode) return;
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
    if (mode === "orbit" && moved < 4) pick(event);
    mode = null;
  });
  el.addEventListener("pointercancel", () => { mode = null; });
  el.addEventListener("contextmenu", event => event.preventDefault());
  el.addEventListener("wheel", event => {
    event.preventDefault();
    view.distance = Math.max(20, Math.min(8000, view.distance * (1 + Math.sign(event.deltaY) * 0.12)));
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
function groupFromStream(mesh, entry) {
  const group = new THREE.Group();
  const datum = entry && entry.category === "datum";
  group.userData.solid = !datum;

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
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: datum ? THEME.datum : THEME["shape-edge"],
      transparent: true, opacity: datum ? 0.42 : 0.4 }));
    group.add(lines);
  }

  // A vertex carries no triangles, so it is drawn as a marker at its location.
  if (mesh.point) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12),
                               new THREE.MeshBasicMaterial({ color: THEME.datum,
                                                             transparent: true, opacity: 0.75 }));
    dot.position.set(mesh.point[0], mesh.point[1], mesh.point[2]);
    group.add(dot);
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
        object.material.color.copy(selected ? THEME.accent : THEME["shape-edge"]);
        object.material.opacity = selected ? 0.8 : 0.4;
      }
    });
  }
  draw();
}

const raycaster = new THREE.Raycaster();
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
  Ribbon: '<path d="M5.2 4.4L2 8l3.2 3.6M10.8 4.4L14 8l-3.2 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M6.3 10.6c1-3.6 2.2-5 3.4-5s1.5 1.1 0 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'
        + '<path d="M6.3 8.6c1.1-2.6 2-3.6 3-3.6" fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round" opacity=".6"/>',
  Fillet: '<path d="M2.5 13.5V8a5.5 5.5 0 015.5-5.5h5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 2.5h5.5M2.5 2.5v5.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/>',
  part: '<path d="M2.5 4.2L8 1.5l5.5 2.7v7.6L8 14.5l-5.5-2.7z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5s6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.3"/>',
};
const svg = body => '<svg viewBox="0 0 16 16" aria-hidden="true">' + body + "</svg>";
const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escapeAttr = s => escapeHtml(s).replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ toolbar */
function buildToolbar() {
  const targets = { datum: "tools-datum", body: "tools-body", operation: "tools-op" };
  for (const host of Object.values(targets)) document.getElementById(host).textContent = "";

  for (const spec of state.schema.types) {
    const button = document.createElement("button");
    button.className = "tool";
    button.innerHTML = svg(ICONS[spec.type] || ICONS.part);
    button.dataset.type = spec.type;
    button.dataset.label = spec.type;
    button.setAttribute("aria-label", spec.type);
    button.addEventListener("click", () => addFeature(spec.type));
    document.getElementById(targets[spec.category]).appendChild(button);
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
      const arg = spec.args.find(a => a.kind === "ref" && a.consumes);
      const accepts = arg ? arg.accepts.split(",") : [];
      const eligible = selected && accepts.includes(selected.type) && !selected.consumedBy;
      button.disabled = !(ready && eligible);
      button.dataset.label = !ready ? "starting…"
        : eligible ? spec.type + " " + selected.name
        : selected && selected.consumedBy
          ? selected.name + " already has a " + (feature(selected.consumedBy) || {}).type
          : "Select a body first";
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

  const sets = [
    { name: "Datums", features: state.tree.features.filter(f => f.category === "datum") },
    { name: "PartBody", features: state.tree.features.filter(f => f.category !== "datum") },
  ];

  for (const set of sets) {
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
  kind.textContent = entry.error ? "error" : consumed ? "hidden" : entry.type.toLowerCase();

  li.append(glyph, label, kind);

  if (!consumed) {
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
  rename.addEventListener("change", async () => {
    try { applyState(await kernel.rename(entry.id, rename.value.trim())); }
    catch (err) { showError(err.message); }
  });

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
                   : refField(entry, arg));
  }

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
  if (entry.category !== "datum" && !entry.consumedBy) {
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
  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "group");
  arg.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option;
    button.setAttribute("aria-pressed", index === current ? "true" : "false");
    // Switching the pattern changes which arguments apply, so the panel is
    // rebuilt rather than refreshed in place.
    button.addEventListener("click", () => pushParameter(entry.id, arg.key, index, true));
    group.appendChild(button);
  });
  field.appendChild(group);

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDataStd_Integer</b>";
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

function realField(entry, arg) {
  const field = document.createElement("div");
  field.className = "field";
  const value = entry.values[arg.key];
  const path = entry.labels[arg.key] || entry.entry;

  field.innerHTML =
    '<div class="field-head"><label for="p-' + arg.key + '">' + arg.label + "</label>" +
    '<span class="value-box"><input type="number" id="n-' + arg.key + '" value="' + round(value) +
    '" step="' + arg.step + '" min="' + arg.min + '" max="' + arg.max + '"' +
    "><span class=\"unit\">" + (arg.unit || "") + "</span></span></div>" +
    '<input type="range" id="p-' + arg.key + '" min="' + arg.min + '" max="' + arg.max +
    '" step="' + arg.step + '" value="' + value + '"' + "" + ">" +
    '<div class="attr-path">' + path + " · <b>TDataStd_Real</b></div>";

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
      applyState(await kernel.setCode(entry.id, entry.codeKey, area.value));
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
  const current = entry.refs[arg.key] || "";
  const accepts = arg.accepts.split(",");
  const options = state.tree.features.filter(other =>
    other.id !== entry.id && accepts.includes(other.type) && !dependsOn(other.id, entry.id));

  field.innerHTML = '<div class="field-head"><label>' + arg.label + "</label>" +
    '<span class="kind">' + accepts.join(" / ") + "</span></div>";

  const select = document.createElement("select");
  select.innerHTML = '<option value="">— not set —</option>' + options.map(option =>
    '<option value="' + escapeAttr(option.id) + '"' + (option.id === current ? " selected" : "") +
    ">" + escapeHtml(option.name) + "</option>").join("");
  select.addEventListener("change", async () => {
    try {
      applyState(await kernel.setReference(entry.id, arg.key, select.value));
    } catch (err) { showError(err.message); }
  });
  field.appendChild(select);

  const path = document.createElement("div");
  path.className = "attr-path";
  path.innerHTML = (entry.labels[arg.key] || entry.entry) + " · <b>TDF_Reference</b>" +
    (current ? " → " + (feature(current) || {}).entry : "") +
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
    const entry = feature(current);
    return entry ? Object.values(entry.refs).some(target => target && walk(target)) : false;
  };
  return walk(id);
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
      applyState(await kernel.setParameter(next.id, next.key, next.value),
                 { keepPanel: !next.rebuildPanel });
    }
  } catch (err) { showError(err.message); }
  finally { inFlight = false; }
}

async function addFeature(type) {
  if (!ready) return;
  const spec = schemaType(type);
  const refs = {};
  const selected = feature(state.selected);

  // Pre-fill the inputs the way a CAD command does: the selected body for an
  // operation, the first datum of the right type otherwise.
  for (const arg of spec.args) {
    if (arg.kind !== "ref") continue;
    const accepts = arg.accepts.split(",");
    let target = (arg.consumes && selected && accepts.includes(selected.type) && !selected.consumedBy)
      ? selected : null;
    // Never pick a body another operation has already swallowed.
    if (!target)
      target = state.tree.features.find(f =>
        accepts.includes(f.type) && !(arg.consumes && f.consumedBy)) || null;
    if (target) refs[arg.key] = target.id;
  }

  try {
    const payload = await kernel.addFeature(type, refs);
    applyState(payload);
    select(payload.id, true);
    if (spec.category !== "datum") fitView();
  } catch (err) { showError(err.message); }
}

async function deleteFeature(id) {
  try {
    if (state.selected === id) state.selected = null;
    if (state.edited === id) state.edited = null;
    applyState(await kernel.deleteFeature(id));
  } catch (err) {
    state.edited = id;
    buildPanel();
    showError(err.message);
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
  if (options.keepPanel) refreshPanelNotice();
  else buildPanel();
  refreshToolbar();
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
    const payload = await kernel.setAppearance(entry.id, appearance);
    if (payload.tree) state.tree = payload.tree;
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
  try { text = JSON.stringify(await kernel.model(), null, 2); }
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
    applyState(await kernel.loadModel(document.getElementById("model-text").value));
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
  if (event.key === "Escape") {
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
