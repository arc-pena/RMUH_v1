// The OCAF document, in the shape OpenCascade gives it.
//
// Labels form a tree; each carries attributes under the names OCAF uses. A
// feature is a label with a TFunction_Function attribute naming its driver; the
// driver reads the argument labels beneath it and writes a TNaming_NamedShape.
// Regeneration walks the dependency graph the drivers describe and executes
// only the functions the logbook marks as touched or impacted.
//
// The geometry itself is not here. Drivers are registered from outside with a
// build() that calls a real kernel - OpenCascade compiled to WebAssembly in the
// browser, the same OpenCascade natively behind the HTTP kernel.

/* ------------------------------------------------------------- catalogue */

//! The script a new Script feature starts with: a spiral stair, whose treads,
//! risers, centre pole, stringer and handrail are separate solids driven by the
//! parameters it declares. Edit it and the feature becomes something else.
export const SPIRAL_STAIR = `({
  params: [
    { key: "steps",            label: "Steps",             def: 13,  min: 3,   max: 40,   step: 1, unit: "" },
    { key: "rise",             label: "Rise per step",     def: 190, min: 120, max: 280,  step: 5 },
    { key: "sweep",            label: "Total sweep",       def: 270, min: 90,  max: 1080, step: 5, unit: "deg" },
    { key: "innerRadius",      label: "Inner radius",      def: 110, min: 60,  max: 400,  step: 5 },
    { key: "outerRadius",      label: "Outer radius",      def: 700, min: 300, max: 1600, step: 10 },
    { key: "treadThickness",   label: "Tread thickness",   def: 45,  min: 10,  max: 90,   step: 1 },
    { key: "treadGap",         label: "Gap between treads",def: 2,   min: 0,   max: 20,   step: 0.5, unit: "deg" },
    { key: "riserThickness",   label: "Riser thickness",   def: 18,  min: 0,   max: 40,   step: 1 },
    { key: "poleRadius",       label: "Centre pole radius",def: 75,  min: 30,  max: 250,  step: 5 },
    { key: "stringerDepth",    label: "Stringer depth",    def: 180, min: 0,   max: 400,  step: 5 },
    { key: "stringerThickness",label: "Stringer thickness",def: 14,  min: 4,   max: 40,   step: 1 },
    { key: "railHeight",       label: "Handrail height",   def: 900, min: 700, max: 1200, step: 10 },
    { key: "railWidth",        label: "Handrail width",    def: 58,  min: 20,  max: 110,  step: 2 },
    { key: "railThickness",    label: "Handrail thickness",def: 34,  min: 12,  max: 90,   step: 2 },
  ],

  build(p, k) {
    const parts = [];
    const step  = p.sweep / p.steps;        // degrees of turn per tread
    const turns = p.sweep / 360;
    const climb = p.steps * p.rise;         // height gained over the whole run
    const pitch = climb / turns;            // rise per full turn, for the helices

    // Centre pole.
    parts.push(k.cylinder(p.poleRadius, climb + p.rise));

    // Tread and riser are modelled once. Every step is that same shape at a
    // different location, so the kernel builds and meshes them only once.
    const tread = k.sector(p.innerRadius, p.outerRadius, step - p.treadGap, p.treadThickness);
    const riser = p.riserThickness > 0
      ? k.box(p.outerRadius - p.innerRadius, p.riserThickness, p.rise - p.treadThickness,
              { at: [p.innerRadius, -p.riserThickness / 2, 0] })
      : null;

    for (let i = 0; i < p.steps; i++) {
      const angle = i * step;
      parts.push(k.move(k.rotate(tread, angle), [0, 0, (i + 1) * p.rise - p.treadThickness]));
      if (riser) parts.push(k.move(k.rotate(riser, angle), [0, 0, i * p.rise]));
    }

    // A section swept along a helix: one continuous solid, not a chain of
    // segments. The helix starts at [radius, 0, 0], so that is where the
    // profile is placed, facing along the tangent there; [1, 0, 0] is the
    // radial direction at that point, which is what puts a rail's width across
    // the stair rather than up it.
    const swept = (radius, z, profileAt) => {
      const spine = k.move(k.helix(radius, pitch, turns), [0, 0, z]);
      const tangent = k.helixTangent(radius, pitch);
      return k.sweep(profileAt([radius, 0, z], tangent), spine);
    };

    // Stringer: a rectangular section under the outer edge of the treads.
    if (p.stringerDepth > 0)
      parts.push(swept(p.outerRadius - p.stringerThickness / 2,
        p.rise - p.treadThickness - p.stringerDepth / 2,
        (at, tangent) => k.rectangle(p.stringerThickness, p.stringerDepth,
                                     { at, axis: tangent, xdir: [1, 0, 0] })));

    // Handrail: an elliptical section - wider than it is deep, the way a rail
    // sits in the hand - swept along the same helix a rail height above the
    // tread noses.
    parts.push(swept(p.outerRadius - p.railWidth / 2 - 30,
      p.rise + p.railHeight,
      (at, tangent) => k.ellipse(p.railWidth / 2, p.railThickness / 2,
                                 { at, axis: tangent, xdir: [1, 0, 0] })));

    return k.compound(parts);
  }
})`;

const real = (key, label, def, min, max, step, unit = "mm") =>
  ({ key, label, kind: "real", def, min, max, step, unit });
const ref = (key, label, accepts, consumes = false) =>
  ({ key, label, kind: "ref", accepts, consumes });
//! Source the user edits, held as a TDataStd_AsciiString.
const code = (key, label, def) => ({ key, label, kind: "code", def });
//! A fixed set of alternatives, held as a TDataStd_Integer index.
const choice = (key, label, options, def = 0) =>
  ({ key, label, kind: "choice", options, def });
//! Only shown, and only read, when another argument has this value. It is how
//! one feature carries two patterns without two features in the tree.
const when = (arg, key, equals) => ({ ...arg, showWhen: { key, equals } });

//! One table drives the toolbar, the label layout (an argument's index here is
//! its OCAF child tag), the sliders and the neutral file format. It mirrors
//! ocaf/src/Schema.cxx entry for entry, GUIDs included.
export const CATALOGUE = [
  { type: "Point", guid: "9a1b2c30-0001-4c00-9e00-caf000000001", category: "datum",
    summary: "A location in space. Drives origins and centres.",
    args: [real("x", "X", 0, -500, 500, 0.5), real("y", "Y", 0, -500, 500, 0.5),
           real("z", "Z", 0, -500, 500, 0.5)] },
  { type: "Vector", guid: "9a1b2c30-0002-4c00-9e00-caf000000002", category: "datum",
    summary: "A direction. Orients lines, planes and the solids placed on them.",
    args: [real("dx", "dX", 0, -100, 100, 0.1, ""), real("dy", "dY", 0, -100, 100, 0.1, ""),
           real("dz", "dZ", 1, -100, 100, 0.1, "")] },
  { type: "Line", guid: "9a1b2c30-0003-4c00-9e00-caf000000003", category: "datum",
    summary: "A bounded line: a start point, a direction, a length.",
    args: [ref("origin", "Start point", ["Point"]), ref("direction", "Direction", ["Vector"]),
           real("length", "Length", 100, 1, 1000, 1)] },
  { type: "Plane", guid: "9a1b2c30-0004-4c00-9e00-caf000000004", category: "datum",
    summary: "A planar datum: an origin point and a normal vector.",
    args: [ref("origin", "Origin", ["Point"]), ref("normal", "Normal", ["Vector"]),
           real("size", "Display size", 160, 10, 1000, 5)] },
  { type: "Cube", guid: "9a1b2c30-0010-4c00-9e00-caf000000010", category: "body",
    summary: "A box placed at a point, oriented by a plane, sized in three axes.",
    args: [ref("origin", "Corner point", ["Point"]), ref("plane", "Placement plane", ["Plane"]),
           real("dx", "Length X", 80, 1, 500, 1), real("dy", "Length Y", 80, 1, 500, 1),
           real("dz", "Length Z", 80, 1, 500, 1)] },
  { type: "Sphere", guid: "9a1b2c30-0011-4c00-9e00-caf000000011", category: "body",
    summary: "A sphere centred on a point.",
    args: [ref("center", "Centre point", ["Point"]), real("radius", "Radius", 50, 1, 400, 1)] },
  { type: "Array", guid: "9a1b2c30-0021-4c00-9e00-caf000000021", category: "operation",
    summary: "Repeats a body in a grid or around an axis. One feature in the tree, "
           + "however many copies it makes.",
    args: [ref("source", "Feature", ["Cube", "Sphere", "Fillet", "Array", "Script"], true),
           choice("mode", "Pattern", ["Rectangular", "Polar"], 0),
           when(real("countX", "Count X", 3, 1, 40, 1, ""), "mode", 0),
           when(real("spacingX", "Spacing X", 120, -600, 600, 1), "mode", 0),
           when(real("countY", "Count Y", 1, 1, 40, 1, ""), "mode", 0),
           when(real("spacingY", "Spacing Y", 120, -600, 600, 1), "mode", 0),
           when(real("countZ", "Count Z", 1, 1, 20, 1, ""), "mode", 0),
           when(real("spacingZ", "Spacing Z", 120, -600, 600, 1), "mode", 0),
           when(ref("center", "Centre", ["Point"]), "mode", 1),
           when(ref("axis", "Axis", ["Vector"]), "mode", 1),
           when(real("count", "Count", 6, 1, 120, 1, ""), "mode", 1),
           when(real("angle", "Sweep", 360, -360, 360, 5, "°"), "mode", 1)] },
  { type: "Script", guid: "9a1b2c30-0030-4c00-9e00-caf000000030", category: "body",
    summary: "A feature you write. The code declares its own parameters and returns "
           + "a shape, so anything the kernel can build can become a feature.",
    args: [code("code", "Code", SPIRAL_STAIR)] },
  { type: "Fillet", guid: "9a1b2c30-0020-4c00-9e00-caf000000020", category: "operation",
    summary: "Rounds every edge of a body. The body stays in the tree but leaves the 3D view.",
    args: [ref("body", "Body", ["Cube", "Sphere", "Fillet", "Array", "Script"], true),
           real("radius", "Radius", 10, 0.1, 200, 0.5)] },
];

export const FIRST_ARG_TAG = 1, RESULT_TAG = 100, ERROR_TAG = 101, REVISION_TAG = 102;

//! A Script feature declares its own parameters, so they cannot live in the
//! catalogue. Each gets a label of its own under the feature, carrying the
//! parameter's name and value exactly as a catalogue argument would; the
//! declaration itself is cached beside them so the interface can draw the
//! sliders without compiling anything.
export const PARAM_TAG_BASE = 10, PARAM_TAG_LIMIT = 50, SPECS_TAG = 51;

const byType = new Map(CATALOGUE.map(t => [t.type, t]));
const byGuid = new Map(CATALOGUE.map(t => [t.guid, t]));
export const typeSpec = type => byType.get(type) || null;
const argIndex = (spec, key) => spec.args.findIndex(a => a.key === key);

/* ------------------------------------------------------------- TDF labels */

export class Label {
  constructor(tag, parent) {
    this.tag = tag;
    this.parent = parent;
    this.children = new Map();
    this.attr = Object.create(null);
    this.nextTag = 0;
  }
  findChild(tag, create = false) {
    let child = this.children.get(tag);
    if (!child && create) { child = new Label(tag, this); this.children.set(tag, child); }
    return child || null;
  }
  newChild() { return this.findChild(++this.nextTag, true); }
  childList() { return [...this.children.values()].sort((a, b) => a.tag - b.tag); }
  get entry() {
    const parts = [];
    for (let l = this; l.parent; l = l.parent) parts.unshift(l.tag);
    return "0:" + parts.join(":");
  }
}

/* ------------------------------------------------- reading a feature label */

export const F = {
  spec: f => (f && byGuid.get(f.attr.TFunction_Function)) || null,
  name: f => (f && f.attr.TDataStd_Name) || "",
  id: f => (f && f.attr.TDataStd_AsciiString) || "",
  visible: f => f.attr.TDataStd_Integer !== 0,
  setVisible: (f, v) => { f.attr.TDataStd_Integer = v ? 1 : 0; },
  revision: f => {
    const label = f.findChild(REVISION_TAG);
    return label ? label.attr.TDataStd_Integer || 0 : 0;
  },
  bumpRevision: f => {
    const label = f.findChild(REVISION_TAG, true);
    label.attr.TDataStd_Integer = (label.attr.TDataStd_Integer || 0) + 1;
  },

  argLabel(f, key, create = false) {
    const spec = F.spec(f);
    if (!spec) return null;
    const index = argIndex(spec, key);
    if (index < 0) return null;
    const label = f.findChild(FIRST_ARG_TAG + index, create);
    if (label && create) label.attr.TDataStd_Name = key;
    return label;
  },
  real(f, key, fallback = 0) {
    const label = F.argLabel(f, key);
    return label && typeof label.attr.TDataStd_Real === "number" ? label.attr.TDataStd_Real : fallback;
  },
  setReal(f, key, value) { F.argLabel(f, key, true).attr.TDataStd_Real = value; },
  choice(f, key, fallback = 0) {
    const label = F.argLabel(f, key);
    return label && typeof label.attr.TDataStd_Integer === "number"
      ? label.attr.TDataStd_Integer : fallback;
  },
  setChoice(f, key, index) { F.argLabel(f, key, true).attr.TDataStd_Integer = index; },

  code(f, key, fallback = "") {
    const label = F.argLabel(f, key);
    return label && typeof label.attr.TDataStd_AsciiString === "string"
      ? label.attr.TDataStd_AsciiString : fallback;
  },
  setCode(f, key, text) { F.argLabel(f, key, true).attr.TDataStd_AsciiString = text; },

  //! What the script last declared, so the panel can draw its sliders without
  //! compiling the code again.
  paramSpecs(f) {
    const label = f.findChild(SPECS_TAG);
    if (!label || typeof label.attr.TDataStd_AsciiString !== "string") return [];
    try { return JSON.parse(label.attr.TDataStd_AsciiString); } catch (e) { return []; }
  },
  setParamSpecs(f, specs) {
    f.findChild(SPECS_TAG, true).attr.TDataStd_AsciiString = JSON.stringify(specs);
  },

  paramLabels(f) {
    return f.childList().filter(l => l.tag >= PARAM_TAG_BASE && l.tag < PARAM_TAG_LIMIT
                                     && l.attr.TDataStd_Name);
  },
  paramLabel(f, key) {
    return F.paramLabels(f).find(l => l.attr.TDataStd_Name === key) || null;
  },
  paramValue(f, key, fallback = 0) {
    const label = F.paramLabel(f, key);
    return label && typeof label.attr.TDataStd_Real === "number" ? label.attr.TDataStd_Real : fallback;
  },
  paramValues(f) {
    const values = {};
    for (const label of F.paramLabels(f)) values[label.attr.TDataStd_Name] = label.attr.TDataStd_Real;
    return values;
  },
  setParamValue(f, key, value) {
    let label = F.paramLabel(f, key);
    if (!label) {
      for (let tag = PARAM_TAG_BASE; tag < PARAM_TAG_LIMIT; tag++)
        if (!f.findChild(tag)) { label = f.findChild(tag, true); break; }
      if (!label) throw new Error("a script may declare at most "
        + (PARAM_TAG_LIMIT - PARAM_TAG_BASE) + " parameters");
      label.attr.TDataStd_Name = key;
    }
    label.attr.TDataStd_Real = value;
    return label;
  },

  //! Brings the stored parameters into line with what the script now declares:
  //! values already there are kept, new ones take their default, and parameters
  //! the script dropped are forgotten.
  syncParams(f, specs) {
    const wanted = new Set(specs.map(spec => spec.key));
    for (const label of F.paramLabels(f))
      if (!wanted.has(label.attr.TDataStd_Name)) f.children.delete(label.tag);
    for (const spec of specs) {
      const existing = F.paramLabel(f, spec.key);
      const value = existing && typeof existing.attr.TDataStd_Real === "number"
        ? existing.attr.TDataStd_Real : spec.def;
      F.setParamValue(f, spec.key, clampTo(spec, value));
    }
    F.setParamSpecs(f, specs);
  },

  //! An argument is live only when its condition holds; the rest are carried
  //! but not read, so switching a pattern back keeps the values you had.
  applies(f, arg) {
    if (!arg.showWhen) return true;
    return F.choice(f, arg.showWhen.key, 0) === arg.showWhen.equals;
  },
  reference(f, key) {
    const label = F.argLabel(f, key);
    return label ? label.attr.TDF_Reference || null : null;
  },
  setReference(f, key, target) { F.argLabel(f, key, true).attr.TDF_Reference = target; },

  resultLabel: (f, create = false) => f.findChild(RESULT_TAG, create),
  shape(f) {
    const result = F.resultLabel(f);
    return result ? result.attr.TNaming_NamedShape || null : null;
  },
  error(f) {
    const label = f.findChild(ERROR_TAG);
    return label ? label.attr.TDataStd_AsciiString || "" : "";
  },
  setError(f, message) { f.findChild(ERROR_TAG, true).attr.TDataStd_AsciiString = message; },
};

/* ----------------------------------------------------------------- logbook */

export class Logbook {
  constructor() { this.touched = new Set(); this.impacted = new Set(); }
  touch(label) { this.touched.add(label); }
  impact(label) { this.impacted.add(label); }
  isModified(label) { return this.touched.has(label) || this.impacted.has(label); }
  clear() { this.touched.clear(); this.impacted.clear(); }
}

/* ----------------------------------------------------------------- drivers */

//! A driver is registered against its type's GUID and supplies two things: a
//! check that runs before the kernel is called, and the build itself.
export class Driver {
  constructor(spec, { precondition, build, release, describeError }) {
    this.spec = spec;
    this.precondition = precondition || (() => null);
    this.build = build;
    this.release = release || (() => {});
    // Each kernel knows how its own failures arrive; ours is the fallback.
    this.describeError = describeError || kernelMessage;
  }

  //! A reference argument depends on the *result* of the feature it points at.
  //! That is what orders the graph: edit a cube and its fillet must follow.
  arguments(f) {
    const args = [];
    for (const child of f.childList()) {
      if (child.tag === RESULT_TAG || child.tag === ERROR_TAG || child.tag === REVISION_TAG) continue;
      if (child.attr.TDF_Reference) args.push(F.resultLabel(child.attr.TDF_Reference, true));
      args.push(child);
    }
    return args;
  }
  results(f) { return [F.resultLabel(f, true)]; }
  mustExecute(f, log) {
    return log.isModified(f) || this.arguments(f).some(a => log.isModified(a));
  }

  //! Never lets the kernel take the process with it: the arguments are checked
  //! first, the call itself is guarded, and a failure keeps the last good shape
  //! so the rest of the tree still regenerates.
  execute(f, log) {
    const objection = this.precondition(f);
    if (objection) { F.setError(f, objection); return 1; }

    let shape = null;
    try {
      shape = this.build(f);
    } catch (err) {
      F.setError(f, this.describeError(err));
      return 1;
    }
    if (!shape) { F.setError(f, "the driver produced no shape"); return 1; }

    const result = F.resultLabel(f, true);
    if (result.attr.TNaming_NamedShape) this.release(result.attr.TNaming_NamedShape);
    result.attr.TNaming_NamedShape = shape;

    F.setError(f, "");
    F.bumpRevision(f);
    log.impact(result);
    log.impact(f);
    return 0;
  }
}

//! OpenCascade throws Standard_Failure, which arrives as a pointer, a number or
//! an Error depending on how it crossed the boundary. Say something useful
//! whichever it was.
export function kernelMessage(err) {
  if (!err) return "the kernel failed without a message";
  if (typeof err === "string") return err;
  if (typeof err === "number") return "kernel fault (code " + err + ")";
  if (err.message) return err.message.replace(/^Error:\s*/, "");
  return String(err);
}

/* ---------------------------------------------------------------- document */

export class Doc {
  constructor(drivers, title = "Part1", units = "mm") {
    this.drivers = drivers;              // guid -> Driver
    this.root = new Label(0, null);
    this.main = this.root.findChild(1, true);
    this.main.attr.TDataStd_Name = title;
    this.main.attr.TDataStd_AsciiString = units;
    this.featuresRoot = this.main.findChild(1, true);
    this.log = new Logbook();
    this.title = title;
    this.units = units;
  }

  features() { return this.featuresRoot.childList().filter(l => l.attr.TFunction_Function); }
  find(reference) {
    return this.features().find(f => F.id(f) === reference || F.name(f) === reference) || null;
  }
  driverOf(f) { return this.drivers.get(f.attr.TFunction_Function) || null; }

  uniqueName(type) {
    const used = new Set(this.features().map(F.name));
    for (let i = 1; ; i++) if (!used.has(type + "." + i)) return type + "." + i;
  }
  uniqueId(type) {
    const used = new Set(this.features().map(F.id));
    const stem = type.slice(0, 2).toUpperCase();
    for (let i = 1; ; i++) if (!used.has(stem + i)) return stem + i;
  }

  addFeature(type, id, name) {
    const spec = typeSpec(type);
    if (!spec) throw new Error('unknown feature type "' + type + '"');
    if (id && this.find(id)) throw new Error('duplicate feature id "' + id + '"');

    const f = this.featuresRoot.newChild();
    f.attr.TFunction_Function = spec.guid;
    f.attr.TDataStd_AsciiString = id || this.uniqueId(type);
    f.attr.TDataStd_Name = name || this.uniqueName(type);
    F.setVisible(f, true);
    for (const arg of spec.args) {
      const label = F.argLabel(f, arg.key, true);
      if (arg.kind === "real") label.attr.TDataStd_Real = arg.def;
      else if (arg.kind === "choice") label.attr.TDataStd_Integer = arg.def;
      else if (arg.kind === "code") label.attr.TDataStd_AsciiString = arg.def;
    }
    F.resultLabel(f, true);
    this.log.touch(f);
    return f;
  }

  dependents(f) {
    return this.features().filter(other =>
      F.spec(other).args.some(a => a.kind === "ref" && F.reference(other, a.key) === f));
  }

  deleteFeature(f) {
    const readers = this.dependents(f);
    if (readers.length) throw new Error(F.name(readers[0]) + " still reads from " + F.name(f));
    const shape = F.shape(f);
    const driver = this.driverOf(f);
    if (shape && driver) driver.release(shape);
    this.featuresRoot.children.delete(f.tag);
  }

  setParameter(f, key, value) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key && a.kind !== "ref" && a.kind !== "code");
    if (!Number.isFinite(value)) throw new Error("'" + key + "' must be a number");

    if (!arg) {
      // Not in the catalogue - it may be one the script declared for itself.
      const declared = F.paramSpecs(f).find(p => p.key === key);
      if (!declared) throw new Error(F.name(f) + " has no parameter '" + key + "'");
      const stored = clampTo(declared, value);
      this.log.touch(F.setParamValue(f, key, stored));
      return stored;
    }

    const label = F.argLabel(f, key, true);
    let stored;
    if (arg.kind === "choice") {
      stored = Math.min(arg.options.length - 1, Math.max(0, Math.round(value)));
      label.attr.TDataStd_Integer = stored;
    } else {
      // Out-of-range values reach the kernel as nonsense; stop them at the door.
      stored = Math.min(arg.max, Math.max(arg.min, value));
      label.attr.TDataStd_Real = stored;
    }
    this.log.touch(label);
    return stored;
  }

  //! Editing the source is an edit like any other: the label is touched and the
  //! solver re-runs this feature and everything downstream of it.
  setCode(f, key, text) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key && a.kind === "code");
    if (!arg) throw new Error(F.name(f) + " has no code to edit");
    if (typeof text !== "string") throw new Error("the code must be text");
    F.setCode(f, key, text);
    this.log.touch(F.argLabel(f, key));
  }

  setReference(f, key, target) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key && a.kind === "ref");
    if (!arg) throw new Error(F.name(f) + " has no reference argument '" + key + "'");
    if (target && !arg.accepts.includes(F.spec(target).type))
      throw new Error(arg.label + " takes " + arg.accepts.join(" or ") + ", not " + F.spec(target).type);
    if (target && this.dependsOn(target, f))
      throw new Error(F.name(target) + " already depends on " + F.name(f));
    F.setReference(f, key, target);
    this.log.touch(F.argLabel(f, key));
  }

  //! True when \p f reads, directly or not, from \p other.
  dependsOn(f, other) {
    const seen = new Set();
    const walk = current => {
      if (current === other) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      return F.spec(current).args.some(a => {
        const target = a.kind === "ref" ? F.reference(current, a.key) : null;
        return target ? walk(target) : false;
      });
    };
    return walk(f);
  }

  //! Kahn's algorithm over producer -> consumer edges: the order
  //! TFunction_Iterator derives from the same Arguments()/Results() lists.
  order() {
    const features = this.features();
    const producer = new Map(features.map(f => [F.resultLabel(f, true), f]));
    const incoming = new Map(features.map(f => [f, new Set()]));
    const outgoing = new Map(features.map(f => [f, new Set()]));

    for (const f of features)
      for (const a of this.driverOf(f).arguments(f)) {
        const from = producer.get(a);
        if (from && from !== f) { incoming.get(f).add(from); outgoing.get(from).add(f); }
      }

    const ready = features.filter(f => incoming.get(f).size === 0);
    const sorted = [];
    while (ready.length) {
      const f = ready.shift();
      sorted.push(f);
      for (const next of outgoing.get(f)) {
        incoming.get(next).delete(f);
        if (incoming.get(next).size === 0) ready.push(next);
      }
    }
    for (const f of features) if (!sorted.includes(f)) sorted.push(f); // a cycle must not hide the rest
    return sorted;
  }

  recompute(all = false) {
    const report = { functions: 0, executed: [], skipped: [], failed: [] };
    if (all) for (const f of this.features()) this.log.touch(f);

    for (const f of this.order()) {
      const driver = this.driverOf(f);
      if (!driver) continue;
      report.functions++;
      const entry = () => ({ id: F.id(f), name: F.name(f), revision: F.revision(f) });

      if (!driver.mustExecute(f, this.log)) { report.skipped.push(entry()); continue; }
      if (driver.execute(f, this.log) === 0) report.executed.push(entry());
      else report.failed.push({ ...entry(), message: F.error(f) });
    }
    this.log.clear();
    this.updateVisibility();
    return report;
  }

  //! A body consumed by an operation stays in the tree and leaves the 3D view.
  updateVisibility() {
    const features = this.features();
    for (const f of features) F.setVisible(f, true);
    for (const f of features)
      for (const arg of F.spec(f).args) {
        if (arg.kind !== "ref" || !arg.consumes) continue;
        const source = F.reference(f, arg.key);
        if (source) F.setVisible(source, false);
      }
  }
  consumedBy(f) {
    for (const other of this.features())
      for (const arg of F.spec(other).args)
        if (arg.kind === "ref" && arg.consumes && F.reference(other, arg.key) === f) return other;
    return null;
  }

  /* --------------------------------------------------- the wire formats */

  //! The document a front-end mirrors. Identical in shape to TreeToJson() in
  //! the native kernel, so the interface cannot tell the two apart.
  treeJson() {
    return {
      format: "ocaf-tree", version: 1, name: this.title, units: this.units,
      features: this.features().map(f => {
        const spec = F.spec(f);
        const values = {}, refs = {}, labels = {};
        for (const arg of spec.args) {
          const label = F.argLabel(f, arg.key, true);
          labels[arg.key] = label.entry;
          if (arg.kind === "real") values[arg.key] = F.real(f, arg.key, arg.def);
          else if (arg.kind === "choice") values[arg.key] = F.choice(f, arg.key, arg.def);
          else if (arg.kind === "code") { /* published separately, below */ }
          else {
            const target = F.reference(f, arg.key);
            refs[arg.key] = target ? F.id(target) : null;
          }
        }
        const consumer = this.consumedBy(f);
        const entry = {
          id: F.id(f), name: F.name(f), type: spec.type, category: spec.category,
          entry: f.entry, visible: F.visible(f), revision: F.revision(f),
          built: !!F.shape(f), values, refs, labels,
        };
        // A script publishes its source and the parameters it declared, so the
        // panel can draw an editor and a slider per parameter without knowing
        // anything about what the script builds.
        const source = spec.args.find(a => a.kind === "code");
        if (source) {
          entry.code = F.code(f, source.key, source.def);
          entry.codeKey = source.key;
          const stored = F.paramValues(f);
          entry.params = F.paramSpecs(f).map(p => ({ ...p, value: stored[p.key] ?? p.def }));
        }
        if (F.error(f)) entry.error = F.error(f);
        if (consumer) entry.consumedBy = F.id(consumer);
        return entry;
      }),
    };
  }

  modelJson() {
    return {
      format: "ocaf-parametric-model", version: 1, name: this.title, units: this.units,
      features: this.features().map(f => {
        const spec = F.spec(f);
        const args = {};
        for (const arg of spec.args) {
          if (arg.kind === "real") args[arg.key] = round(F.real(f, arg.key, arg.def));
          else if (arg.kind === "choice") args[arg.key] = arg.options[F.choice(f, arg.key, arg.def)];
          else if (arg.kind === "code") {
            args[arg.key] = F.code(f, arg.key, arg.def);
            const stored = F.paramValues(f);
            if (Object.keys(stored).length)
              args.params = Object.fromEntries(
                Object.entries(stored).map(([key, value]) => [key, round(value)]));
          }
          else {
            const target = F.reference(f, arg.key);
            if (target) args[arg.key] = { ref: F.id(target) };
          }
        }
        return { id: F.id(f), type: spec.type, name: F.name(f), args };
      }),
    };
  }

  static fromModel(drivers, model) {
    if (!model || !Array.isArray(model.features)) throw new Error('no "features" array');
    const doc = new Doc(drivers, model.name || "Part1", model.units || "mm");
    for (const entry of model.features) doc.addFeature(entry.type, entry.id, entry.name);
    for (const entry of model.features) {
      const f = doc.find(entry.id);
      const spec = F.spec(f);
      for (const [key, value] of Object.entries(entry.args || {})) {
        if (key === "params" && value && typeof value === "object") {
          // Restored before the script runs; the driver reconciles them against
          // what the code declares once it compiles.
          for (const [name, stored] of Object.entries(value))
            if (typeof stored === "number") F.setParamValue(f, name, stored);
          continue;
        }
        const arg = spec.args.find(a => a.key === key);
        if (!arg) throw new Error(spec.type + ' has no argument "' + key + '"');
        if (arg.kind === "code") {
          if (typeof value !== "string") throw new Error(key + " of " + entry.id + " must be text");
          F.setCode(f, key, value);
          continue;
        }
        if (arg.kind === "real") {
          if (typeof value !== "number") throw new Error(key + " of " + entry.id + " must be a number");
          F.setReal(f, key, value);
        } else if (arg.kind === "choice") {
          // Written as the option's name, read back as either name or index.
          const index = typeof value === "number" ? value : arg.options.indexOf(value);
          if (index < 0 || index >= arg.options.length)
            throw new Error(key + " of " + entry.id + " must be one of " + arg.options.join(", "));
          F.setChoice(f, key, index);
        } else {
          const target = doc.find(typeof value === "string" ? value : value.ref);
          if (!target) throw new Error(entry.id + "." + key + " references an unknown feature");
          F.setReference(f, key, target);
        }
      }
    }
    return doc;
  }
}

export const round = v => Math.round(v * 1e6) / 1e6;

//! Keeps a value inside the range its declaration allows.
export function clampTo(spec, value) {
  if (!Number.isFinite(value)) return spec.def;
  const min = Number.isFinite(spec.min) ? spec.min : -Infinity;
  const max = Number.isFinite(spec.max) ? spec.max : Infinity;
  return Math.min(max, Math.max(min, value));
}

//! The catalogue in the shape the HTTP kernel publishes it, so the interface
//! reads one format whichever kernel it is talking to.
export function schemaJson() {
  return {
    format: "ocaf-feature-catalogue", version: 1,
    types: CATALOGUE.map(spec => ({
      type: spec.type, guid: spec.guid, category: spec.category, summary: spec.summary,
      args: spec.args.map((arg, index) => {
        const base = { key: arg.key, label: arg.label, tag: FIRST_ARG_TAG + index, kind: arg.kind };
        if (arg.showWhen) base.showWhen = arg.showWhen;
        if (arg.kind === "real")
          return { ...base, default: arg.def, min: arg.min, max: arg.max,
                   step: arg.step, unit: arg.unit };
        if (arg.kind === "choice")
          return { ...base, default: arg.def, options: arg.options };
        if (arg.kind === "code")
          return { ...base, default: arg.def };
        return { ...base, accepts: arg.accepts.join(","), consumes: arg.consumes };
      }),
    })),
  };
}
