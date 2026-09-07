import { acceptsFrom } from "./ocaf.js";
import { SKETCH_CLICKS, nextSketchId, readSketch, sketchElement,
         sketchRelation } from "./sketch.js";

// The model description language.
//
// One rule holds this program together: the JSON *is* the model. It is not a
// save format bolted onto a program that keeps the truth somewhere else - it is
// the truth, and every surface that appears to edit geometry is really editing
// this text.
//
//   a toolbar button   is a literal:  { "op": "add", "type": "Cube" }
//   a slider           is a literal:  { "op": "set", "id": "CB1", "key": "dx", "value": 92 }
//   a wire in the graph is a literal: { "op": "connect", "id": "CB1", "key": "plane", "from": "PL1" }
//
// Nothing reaches the document except through one of the edits below, so the
// tree, the definition panel, the node graph and anything driving the page from
// outside are the same program with different pictures on the buttons. Every
// edit that runs is kept, in order, with its JSON - which is what the console in
// the node editor shows, and what an external driver would send.


//! An edit that changes geometry; the kernel re-executes what it touched.
const modelOp = (op, fields, summary, example, run) =>
  ({ op, fields, summary, example, run, view: false });

//! An edit that changes only how the model is looked at. It goes through the
//! same channel and is recorded the same way, but no function re-executes.
const viewOp = (op, fields, summary, example, run) =>
  ({ op, fields, summary, example, run, view: true });

const needText = (edit, key) => {
  const value = edit[key];
  if (typeof value !== "string" || !value.length)
    throw new Error('"' + key + '" must be text');
  return value;
};
const needNumber = (edit, key) => {
  const value = edit[key];
  if (!Number.isFinite(value)) throw new Error('"' + key + '" must be a number');
  return value;
};

//! What a feature is wired to when nothing says otherwise: the selected body if
//! an operation can take it, and the first datum of the right type for the rest.
//! It is the toolbar's rule, written once, so `{"op":"add","type":"Fillet"}` from
//! a console or from a driver does what pressing the button does.
export async function defaultRefs(ctx, type) {
  const [schema, answer] = await Promise.all([ctx.kernel.schema(), ctx.kernel.tree()]);
  const spec = schema.types.find(t => t.type === type);
  const features = (answer.tree || answer).features || [];
  const chosen = ctx.selected ? ctx.selected() : null;
  const selected = features.find(f => f.id === chosen) || null;
  const refs = {};
  for (const arg of (spec ? spec.args : [])) {
    // An input that takes several wires is left empty: one section is not a
    // loft, and guessing the second is worse than guessing nothing.
    if (arg.kind !== "ref") continue;
    const accepts = arg.accepts;
    let target = (arg.consumes && selected && acceptsFrom(accepts, selected) && !selected.consumedBy)
      ? selected : null;
    // Never pick a body another operation has already swallowed.
    if (!target)
      target = features.find(f => acceptsFrom(accepts, f) && !(arg.consumes && f.consumedBy)) || null;
    if (target) refs[arg.key] = target.id;
  }
  return refs;
}

//! The drawing on a sketch, as it stands. The small sketch edits read it,
//! change one thing and write the whole of it back, because the drawing is one
//! string on one label - which is what makes the same edit arrive identically
//! from a click, from the console, or from outside the page.
async function drawingOf(ctx, id) {
  const answer = await ctx.kernel.tree();
  const entry = ((answer.tree || answer).features || []).find(f => f.id === id);
  if (!entry) throw new Error("there is no feature '" + id + "'");
  if (!entry.sketch) throw new Error(entry.name + " is not a sketch");
  return readSketch(entry.sketch.drawing);
}

export const MDL_OPS = [
  modelOp("add", ["type", "name?", "refs?"],
    "Add a feature of the named type. refs wires its reference arguments as it is born; "
    + "leave it out and each one is wired the way the toolbar would wire it.",
    { op: "add", type: "Cube", name: "Cube.2", refs: { origin: "PT1", plane: "PL1" } },
    async (ctx, edit) => {
      const type = needText(edit, "type");
      const refs = edit.refs && typeof edit.refs === "object"
        ? edit.refs
        : await defaultRefs(ctx, type);
      const born = await ctx.kernel.addFeature(type, refs);
      if (!edit.name) return born;
      return { ...(await ctx.kernel.rename(born.id, String(edit.name))), id: born.id };
    }),

  modelOp("delete", ["id"],
    "Remove a feature. Refused while anything still reads from it.",
    { op: "delete", id: "SP1" },
    (ctx, edit) => ctx.kernel.deleteFeature(needText(edit, "id"))),

  modelOp("rename", ["id", "name"],
    "Rename a feature. The id is what references point at; the name is for people.",
    { op: "rename", id: "CB1", name: "Base block" },
    (ctx, edit) => ctx.kernel.rename(needText(edit, "id"), needText(edit, "name"))),

  modelOp("set", ["id", "key", "value"],
    "Set one number: a catalogue argument, or a parameter a script declared for itself. "
    + "A choice takes the index of the option.",
    { op: "set", id: "CB1", key: "dx", value: 92 },
    (ctx, edit) => ctx.kernel.setParameter(
      needText(edit, "id"), needText(edit, "key"), needNumber(edit, "value"))),

  modelOp("connect", ["id", "key", "from"],
    "Wire one feature into another's input - a reference, a section of a loft, or a "
    + "slider being driven by a number. What an input takes is what a source produces, "
    + "not which feature type it is.",
    { op: "connect", id: "FI1", key: "body", from: "CB1" },
    (ctx, edit) => ctx.kernel.setReference(
      needText(edit, "id"), needText(edit, "key"), needText(edit, "from"))),

  modelOp("disconnect", ["id", "key", "from?"],
    "Pull a wire off an input. An input that takes several wires loses the one named "
    + "in from, or all of them when it is left out.",
    { op: "disconnect", id: "FI1", key: "body" },
    (ctx, edit) => ctx.kernel.setReference(needText(edit, "id"), needText(edit, "key"),
      edit.from ? String(edit.from) : null, true)),

  modelOp("code", ["id", "key", "text"],
    "Replace the source of a written feature. The parameters it declares are reconciled "
    + "against the ones already stored.",
    { op: "code", id: "SC1", key: "source", text: "({ params: [], build(p, k) { … } })" },
    (ctx, edit) => ctx.kernel.setCode(
      needText(edit, "id"), needText(edit, "key"), String(edit.text ?? ""))),

  modelOp("appearance", ["id", "appearance"],
    "Give a feature a finish. Geometry does not rebuild - only the way it is drawn changes.",
    { op: "appearance", id: "CB1", appearance: { finish: "brass" } },
    (ctx, edit) => ctx.kernel.setAppearance(needText(edit, "id"), edit.appearance || null)),

  modelOp("model", ["model"],
    "Replace the whole document with a model file. Everything else above is a small "
    + "edit of the text this one writes wholesale.",
    { op: "model", model: { format: "ocaf-parametric-model", version: 1, features: [] } },
    async (ctx, edit) => {
      const model = typeof edit.model === "string" ? JSON.parse(edit.model) : edit.model;
      if (!model || typeof model !== "object") throw new Error('"model" must be a model file');
      // The layout block is the graph's, not the kernel's; it travels in the
      // same file so a model opens looking the way it was left.
      if (model.layout && typeof model.layout === "object") ctx.readLayout(model.layout);
      return await ctx.kernel.loadModel(model);
    }),

  modelOp("vertex", ["id", "index", "x", "y", "z"],
    "Move one vertex of a mesh, by an offset from where the mesh upstream put it. "
    + "This is what dragging a handle in the viewport writes; an offset of zero puts "
    + "the vertex back and forgets the edit.",
    { op: "vertex", id: "ED1", index: 12, x: 4, y: 0, z: -2 },
    (ctx, edit) => {
      if (!Number.isInteger(edit.index) || edit.index < 0)
        throw new Error('"index" must be a vertex number');
      return ctx.kernel.moveVertex(needText(edit, "id"), edit.index,
        [needNumber(edit, "x"), needNumber(edit, "y"), needNumber(edit, "z")]);
    }),

  modelOp("sketch", ["id", "drawing"],
    "Replace the whole drawing on a sketch. The three below are small edits of the "
    + "same text; this one writes it wholesale.",
    { op: "sketch", id: "SK1",
      drawing: { elements: [{ id: "e1", type: "circle", c: [0, 0], r: 60 }], constraints: [] } },
    (ctx, edit) => ctx.kernel.setSketch(needText(edit, "id"), null, edit.drawing)),

  modelOp("draw", ["id", "type", "at", "as?"],
    "Draw one element on a sketch. at is the clicks that would have made it, in the "
    + "plane's own coordinates - a line takes two, an arc takes centre, start and how "
    + "far round. This is what clicking in the sketcher writes.",
    { op: "draw", id: "SK1", type: "line", at: [[0, 0], [120, 0]] },
    async (ctx, edit) => {
      const type = needText(edit, "type");
      const clicks = Array.isArray(edit.at) ? edit.at : [];
      const wanted = SKETCH_CLICKS[type];
      if (wanted === undefined) throw new Error('there is no sketch element called "' + type + '"');
      if (clicks.length < Math.max(2, wanted))
        throw new Error(type + " needs " + (wanted || "at least two") + " points in \"at\"");
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      const id = typeof edit.as === "string" && edit.as ? edit.as : nextSketchId(drawing);
      drawing.elements.push(sketchElement(type, id, clicks));
      return ctx.kernel.setSketch(edit.id, null, drawing);
    }),

  modelOp("erase", ["id", "element"],
    "Take one element off a sketch, and any relation that named it.",
    { op: "erase", id: "SK1", element: "e3" },
    async (ctx, edit) => {
      const gone = needText(edit, "element");
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      drawing.elements = drawing.elements.filter(el => el.id !== gone);
      drawing.constraints = drawing.constraints.filter(
        c => !c.of.some(name => String(name).split(".")[0] === gone));
      return ctx.kernel.setSketch(edit.id, null, drawing);
    }),

  modelOp("relate", ["id", "type", "of"],
    "Put a relation on a sketch: horizontal, vertical, parallel, perpendicular, tangent "
    + "or coincident. of names the elements it governs, or their ends as \"e1.b\".",
    { op: "relate", id: "SK1", type: "perpendicular", of: ["e1", "e2"] },
    async (ctx, edit) => {
      const relation = sketchRelation(needText(edit, "type"),
        Array.isArray(edit.of) ? edit.of : [edit.of]);
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      const already = JSON.stringify(relation);
      if (!drawing.constraints.some(c => JSON.stringify(c) === already))
        drawing.constraints.push(relation);
      return ctx.kernel.setSketch(edit.id, null, drawing);
    }),

  viewOp("move", ["id", "x", "y"],
    "Put a node somewhere on the graph canvas. Layout is view state, so no function "
    + "re-executes - but it is written into the same file, under \"layout\".",
    { op: "move", id: "CB1", x: 420, y: 160 },
    (ctx, edit) => {
      ctx.setNode(needText(edit, "id"), needNumber(edit, "x"), needNumber(edit, "y"));
      return { ok: true };
    }),

  viewOp("select", ["id"],
    "Select a feature, in every window at once.",
    { op: "select", id: "CB1" },
    (ctx, edit) => { ctx.select(edit.id ? String(edit.id) : null); return { ok: true }; }),
];

const OP_INDEX = new Map(MDL_OPS.map(spec => [spec.op, spec]));
export const mdlOp = op => OP_INDEX.get(op) || null;

//! The language, in the shape the catalogue is published in - so a driver on the
//! other end of a socket can read what it is allowed to say.
export function mdlSchema() {
  return {
    format: "ocaf-mdl", version: 1,
    summary: "Every edit the document accepts. One object, or an array of them, "
           + "applied in order.",
    ops: MDL_OPS.map(spec => ({
      op: spec.op, fields: spec.fields, summary: spec.summary,
      rebuilds: !spec.view, example: spec.example,
    })),
  };
}

//! Reads one edit, or a list of them, out of text. Trailing commas and a bare
//! object without brackets are both accepted, because people type these.
export function parseEdits(text) {
  const trimmed = String(text || "").trim().replace(/,\s*$/, "");
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed[0] === "[" ? trimmed : "[" + trimmed + "]");
  return parsed.map(edit => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit))
      throw new Error("each edit must be an object");
    if (!OP_INDEX.has(edit.op))
      throw new Error('unknown op "' + edit.op + '" - try ' +
        MDL_OPS.map(s => s.op).join(", "));
    return edit;
  });
}

/* ==========================================================================
   The channel.

   One of these exists per page. Everything that edits the model goes through
   run(); nothing else may touch the kernel. The record it keeps is the whole
   session in the language above, which is why the console can show it and why
   an external driver replaying it lands in the same place.
   ========================================================================== */

export class Mdl {
  constructor(ctx) {
    this.ctx = ctx;              // { kernel, apply, setNode, readLayout, select, selected }
    this.history = [];
    this.serial = 0;
    this.watchers = new Set();
  }

  watch(fn) { this.watchers.add(fn); return () => this.watchers.delete(fn); }

  announce(record) {
    this.history.push(record);
    if (this.history.length > 500) this.history.shift();
    for (const watcher of this.watchers) { try { watcher(record); } catch (e) { /* a watcher is not the model */ } }
  }

  //! Runs one edit, and hands the answer to whatever draws the document - so a
  //! slider dragged in the node graph redraws the tree, the panel and the 3D
  //! view without the graph knowing any of them exist. Returns what the kernel
  //! answered; throws what it threw, after the failure has been recorded, because
  //! a refused edit is part of the session too.
  //!
  //! \p hint is not part of the language: it is a delivery note for the
  //! redraw ("the panel is mid-drag, leave it alone"), never stored, never sent.
  async run(edit, hint) {
    const spec = OP_INDEX.get(edit && edit.op);
    if (!spec) throw new Error('unknown op "' + (edit && edit.op) + '"');
    const record = { n: ++this.serial, at: Date.now(), edit, view: spec.view, ok: true, ms: 0 };
    const started = performance.now();
    try {
      const payload = await spec.run(this.ctx, edit);
      record.ms = Math.round(performance.now() - started);
      this.announce(record);
      if (payload && payload.tree && this.ctx.apply) this.ctx.apply(payload, hint || {});
      return payload;
    } catch (err) {
      record.ok = false;
      record.error = err && err.message ? err.message : String(err);
      record.ms = Math.round(performance.now() - started);
      this.announce(record);
      throw err;
    }
  }

  //! A list of edits, in order, stopping at the first refusal. Returns the last
  //! answer, which is the one carrying the state everything else redraws from.
  async runAll(edits, hint) {
    let payload = null;
    for (const edit of edits) payload = (await this.run(edit, hint)) || payload;
    return payload;
  }

  //! The document as text, with the graph's layout folded in. This is the file:
  //! what the sliders write, what the graph writes, what rebuilds the part.
  async modelText(space = 2) {
    const model = await this.ctx.kernel.model();
    const layout = this.ctx.readLayout();
    if (layout && Object.keys(layout).length) model.layout = layout;
    return JSON.stringify(model, null, space);
  }
}
