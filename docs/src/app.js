import { createWasmKernel } from "./wasm-kernel.js";
import { createHttpKernel } from "./http-kernel.js";

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

  if (mesh.positions && mesh.index) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    if (mesh.normals)
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
    geometry.setIndex(mesh.index);

    const material = datum
      ? new THREE.MeshBasicMaterial({ color: THEME.datum, transparent: true, opacity: 0.1,
                                      side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: THEME.shape, metalness: 0.18, roughness: 0.5 });

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
      transparent: true, opacity: datum ? 0.85 : 0.45 }));
    group.add(lines);
  }

  // A vertex carries no triangles, so it is drawn as a marker at its location.
  if (mesh.point) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(3.2, 16, 12),
                               new THREE.MeshBasicMaterial({ color: THEME.datum }));
    dot.position.set(mesh.point[0], mesh.point[1], mesh.point[2]);
    group.add(dot);
  }
  return group;
}

function setShape(mesh) {
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
    if (!feature(id)) { disposeGroup(shapes.get(id).group); shapes.delete(id); }
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
}

function applyVisibility() {
  for (const [id, { group }] of shapes) {
    const entry = feature(id);
    group.visible = !!entry && entry.visible && !state.hidden.has(id);
  }
}

function paintSelection() {
  for (const [id, { group }] of shapes) {
    const selected = id === state.selected;
    group.traverse(object => {
      if (object.isMesh && object.material.isMeshStandardMaterial) {
        object.material.color.copy(selected ? THEME.accent : THEME.shape);
        object.material.emissive.copy(selected ? THEME.accent : new THREE.Color(0x000000));
        object.material.emissiveIntensity = selected ? 0.18 : 0;
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
  Fillet: '<path d="M2.5 13.5V8a5.5 5.5 0 015.5-5.5h5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 2.5h5.5M2.5 2.5v5.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/>',
  part: '<path d="M2.5 4.2L8 1.5l5.5 2.7v7.6L8 14.5l-5.5-2.7z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/>',
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
    button.className = "tool" + (spec.category === "operation" ? " primary" : "");
    button.innerHTML = svg(ICONS[spec.type] || ICONS.part) + "<span>" + spec.type + "</span>";
    button.dataset.type = spec.type;
    button.addEventListener("click", () => addFeature(spec.type));
    document.getElementById(targets[spec.category]).appendChild(button);
  }
  document.getElementById("root-glyph").innerHTML = svg(ICONS.part);
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
      button.title = !ready ? "The kernel is still starting"
        : eligible ? "Apply " + spec.type + " to " + selected.name
        : selected && selected.consumedBy
          ? selected.name + " is already consumed by " + (feature(selected.consumedBy) || {}).name
          : "Select a body in the tree or the 3D view first";
    } else {
      button.disabled = !ready;
      button.title = ready ? spec.summary : "The kernel is still starting";
    }
  }
}

/* ------------------------------------------------------- specification tree */
function buildTree() {
  const list = document.getElementById("tree");
  list.textContent = "";
  if (!state.tree) return;
  document.getElementById("doc-title").textContent = state.tree.name;

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
  host.textContent = "";
  const entry = feature(state.edited);
  document.getElementById("def-entry").textContent = entry ? entry.entry : "";

  if (!entry) {
    host.innerHTML =
      '<div class="empty"><h3>No feature open</h3>' +
      "<p>This panel is where a feature is defined — the OCAF arguments behind it, on sliders.</p><ol>" +
      "<li>Click a feature in the tree, or a body in the 3D view.</li>" +
      "<li><b>Double-click</b> it to open its definition here.</li>" +
      "<li>Drag a slider: OpenCascade re-runs only the functions downstream of the edit " +
      "and streams back the triangles for the shapes that changed.</li></ol>" +
      "<p style=\"margin-top:14px\">With a body selected, <b>Fillet</b> in the toolbar consumes it: " +
      "the fillet joins the tree and the body leaves the 3D view.</p></div>";
    return;
  }

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

  for (const arg of spec.args)
    host.appendChild(arg.kind === "real" ? realField(entry, arg) : refField(entry, arg));

  const actions = document.createElement("div");
  actions.className = "actions";
  if (entry.category !== "datum" && !entry.consumedBy) {
    const fillet = document.createElement("button");
    fillet.className = "tool primary";
    fillet.innerHTML = svg(ICONS.Fillet) + "<span>Apply fillet</span>";
    fillet.addEventListener("click", () => { state.selected = entry.id; addFeature("Fillet"); });
    actions.appendChild(fillet);
  }
  const remove = document.createElement("button");
  remove.className = "tool";
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
  const host = document.getElementById("log");
  host.textContent = "";
  const count = document.getElementById("log-count");
  const report = state.report;
  if (!report) { count.textContent = ""; return; }
  count.textContent = report.executed.length + "/" + report.functions;

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

  document.getElementById("status-regen").innerHTML =
    "<b>" + report.executed.length + "</b> executed · <b>" + report.skipped.length + "</b> up to date" +
    (report.failed.length ? " · <b>" + report.failed.length + "</b> failed" : "");
}

/* -------------------------------------------------------------- operations */
let inFlight = false, pendingParam = null;

//! A slider fires far faster than the kernel can rebuild, so the newest value
//! wins and everything in between is dropped.
async function pushParameter(id, key, value) {
  pendingParam = { id, key, value };
  if (inFlight || !ready) return;
  inFlight = true;
  try {
    while (pendingParam) {
      const next = pendingParam;
      pendingParam = null;
      applyState(await kernel.setParameter(next.id, next.key, next.value), { keepPanel: true });
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
    : "nothing selected";
  buildTree(); buildPanel(); refreshToolbar(); paintSelection();
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
  const shown = state.tree.features.filter(f => f.category !== "datum" && f.visible).length;
  document.getElementById("stamp").innerHTML =
    "<b>" + escapeHtml(state.tree.name) + "</b><br>" +
    state.tree.features.length + " features · " + shown + " shown · " + state.tree.units;
  document.getElementById("brand-sub").textContent =
    "TDocStd_Document · " + state.tree.features.length + " functions";
  document.getElementById("status-kernel").textContent =
    kernel ? kernel.description : "starting OpenCascade…";
}

/* ----------------------------------------------------------- which kernel */

function setLink(active) {
  const chip = document.getElementById("btn-link");
  chip.classList.toggle("live", !!active);
  document.getElementById("link-label").textContent = !active ? "starting…"
    : active.kind === "wasm" ? "in this page"
    : (active.base ? active.base.replace(/^https?:\/\//, "") : "same origin");

  const banner = document.getElementById("banner");
  banner.innerHTML = (!active || active.kind !== "wasm") ? "" :
    '<div class="banner"><span class="dot"></span><div><b>Running in this page.</b> ' +
    "OpenCascade is compiled to WebAssembly and building the geometry here — the " +
    "same kernel, the same B-Rep. Start a native kernel for OCAF persistence, " +
    "STEP and OBJ export." +
    "<code>ocaf/build/ocafcad serve --ui docs/parametric-cad.html</code></div></div>";
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

for (const button of document.querySelectorAll(".view-tools button")) {
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

addEventListener("keydown", event => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "f" || event.key === "F") fitView();
});

(async function start() {
  readTheme();
  buildGround();
  placeCamera();
  resize();

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
