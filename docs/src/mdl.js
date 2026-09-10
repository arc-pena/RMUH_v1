import { acceptsFrom, isElided } from "./ocaf.js";
import { SKETCH_CLICKS, nextSketchId, readSketch, sketchDirectionAt, sketchElement,
         sketchHandleAt, sketchMoveHandle, sketchRelation, sketchTangentArc,
         solveSketch } from "./sketch.js";

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
  // Several things shift-clicked are several things meant: that is the answer
  // to "which sections", and the only reason guessing one was ever wrong.
  const picked = ((ctx.picked ? ctx.picked() : []) || [])
    .map(id => features.find(f => f.id === id)).filter(Boolean);
  const refs = {};
  //! An argument only shown for one setting of a choice is only WIRED for that
  //! setting. A point by coordinates has no curve to sit on, so guessing one for
  //! it invents a dependency the driver never reads - and, in a document where
  //! that curve is downstream, a cycle out of nothing.
  const applies = arg => {
    if (!arg.showWhen) return true;
    const governs = (spec.args || []).find(a => a.key === arg.showWhen.key);
    return !governs || governs.default === arg.showWhen.equals;
  };
  for (const arg of (spec ? spec.args : [])) {
    if (!applies(arg)) continue;
    // An input that gathers bodies is left empty: one section is not a loft, and
    // guessing the second is worse than guessing nothing. An input that takes
    // several wires but consumes nothing - the points of a polyline - is wired
    // like any other, because the first one is the same guess a single-wire
    // input would already have made, and more are added by hand.
    if (arg.kind === "refs") {
      // Several things picked by hand are several things meant: the two
      // sections of a loft, the three points of a polyline. That is the answer
      // to "which ones", and the only reason guessing was ever wrong.
      const taking = picked.filter(f => acceptsFrom(arg.accepts, f)
        && !(arg.consumes && f.consumedBy));
      if (taking.length > 1) { refs[arg.key] = taking.map(f => f.id); continue; }
      // With nothing picked, an input that gathers bodies stays empty - one
      // section is not a loft. One that only names sources takes the same first
      // guess a single-wire input would, and more are added by hand.
      if (arg.consumes) continue;
    } else if (arg.kind !== "ref") continue;
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
  modelOp("add", ["type", "name?", "id?", "refs?"],
    "Add a feature of the named type. refs wires its reference arguments as it is born; "
    + "leave it out and each one is wired the way the toolbar would wire it. Give it an "
    + "id and that is what it is called, so the edits after it can wire to it without "
    + "having to be told what it was named.",
    { op: "add", type: "Cube", id: "BASE", name: "Cube.2", refs: { origin: "PT1", plane: "PL1" } },
    async (ctx, edit) => {
      const type = needText(edit, "type");
      const refs = edit.refs && typeof edit.refs === "object"
        ? edit.refs
        : await defaultRefs(ctx, type);
      const born = await ctx.kernel.addFeature(type, refs, edit.id ? String(edit.id) : null);
      if (!edit.name) return born;
      return { ...(await ctx.kernel.rename(born.id, String(edit.name))), id: born.id };
    }),

  modelOp("delete", ["id"],
    "Remove a feature. Refused while anything still reads from it.",
    { op: "delete", id: "SP1" },
    (ctx, edit) => ctx.kernel.deleteFeature(needText(edit, "id"))),

  modelOp("group", ["id", "into?"],
    "File a feature under a set - a GeometricalSet or a Body - or leave `into` out to "
    + "take it back to the top level. A set holds things; it never consumes them, so "
    + "what is in one stays as visible, as wired and as rebuildable as it was.",
    { op: "group", id: "CI1", into: "GS1" },
    (ctx, edit) => ctx.kernel.setParent(needText(edit, "id"),
                                        edit.into ? String(edit.into) : null)),

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

  modelOp("connect", ["id", "key", "from", "mode?"],
    "Wire one feature into another's input - a reference, a section of a loft, or a "
    + "slider being driven by a number. What an input takes is what a source produces, "
    + "not which feature type it is. An input that holds several wires gains one more; "
    + 'mode "only" makes this wire the only one on it, which is what dropping a wire '
    + "on it without holding shift does.",
    { op: "connect", id: "FI1", key: "body", from: "CB1" },
    (ctx, edit) => ctx.kernel.setReference(
      needText(edit, "id"), needText(edit, "key"), needText(edit, "from"),
      false, edit.mode === "only")),

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
      // A model that was shortened so a person could read it is not a model
      // that can be built. Rebuilding from it would throw away the geometry it
      // appears to describe, so it is refused by name instead.
      const short = (model.features || []).find(f =>
        Object.values(f.args || {}).some(isElided));
      if (short)
        throw new Error("this text has had its imported geometry shortened so it could be "
          + "read - " + short.name + " is only a note of its size. Rebuilding from it would "
          + "throw that geometry away. Edit the model in the tree, or open a model file you "
          + "exported.");
      // The layout block is the graph's, not the kernel's; it travels in the
      // same file so a model opens looking the way it was left.
      if (model.layout && typeof model.layout === "object") ctx.readLayout(model.layout);
      return await ctx.kernel.loadModel(model);
    }),

  modelOp("import", ["format", "data", "name?", "encoding?", "as?"],
    "Read a file into the document. `format` is one of the kernel's read formats - step, "
    + "brep, obj, stl - and `data` is the file itself, as text, or base64 with "
    + '`encoding` set to "base64" for a binary STL. `as` is "single" for one feature or '
    + '"parts" to break the file into the parts it names, which only a format that '
    + "carries several will do anything with. What comes in is stored as geometry, not as "
    + "the file, so it rebuilds without the reader that read it - and a mesh keeps the "
    + "faces it was authored with, quads included.",
    { op: "import", format: "step", name: "bracket.step", as: "parts", data: "ISO-10303-21;…" },
    (ctx, edit) => ctx.kernel.importFile({
      format: needText(edit, "format"),
      data: needText(edit, "data"),
      name: edit.name ? String(edit.name) : "",
      encoding: edit.encoding === "base64" ? "base64" : "text",
      as: edit.as === "parts" ? "parts" : "single",
    })),

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

  modelOp("draw", ["id", "type", "at", "from?", "as?"],
    "Draw one element on a sketch. at is the clicks that would have made it, in the "
    + "plane's own coordinates - a line takes two, an arc takes centre, start and how "
    + "far round. from names an end of another element, as \"e1.b\": the new element "
    + "starts there and leaves it smoothly, so an arc off the end of a line is tangent "
    + "to it and at needs only where the arc ends. This is what clicking in the "
    + "sketcher writes.",
    { op: "draw", id: "SK1", type: "arc", at: [[100, 0], [200, 100]], from: "e1.b" },
    async (ctx, edit) => {
      const type = needText(edit, "type");
      const clicks = Array.isArray(edit.at) ? edit.at : [];
      const wanted = SKETCH_CLICKS[type];
      if (wanted === undefined) throw new Error('there is no sketch element called "' + type + '"');
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      const id = typeof edit.as === "string" && edit.as ? edit.as : nextSketchId(drawing);

      // Leaving another element smoothly settles where this one starts and
      // which way it goes, so all it still needs is where it ends.
      const carried = typeof edit.from === "string" && edit.from
        ? sketchHandleAt(drawing, edit.from) : null;
      if (edit.from && !carried)
        throw new Error("there is no handle '" + edit.from + "' on that sketch");
      if (carried) {
        if (clicks.length < 1) throw new Error('"at" needs the point it ends at');
        const start = carried.p;
        const along = sketchDirectionAt(carried.el, carried.key);
        const end = clicks[clicks.length - 1];
        // Three points in a line have no arc through them. That is a line, and
        // drawing one is better than refusing the edit.
        const made = (type === "arc" && along)
          ? sketchTangentArc(start, along, end, id) : null;
        drawing.elements.push(made || sketchElement("line", id, [start, end]));
      } else {
        // A spline takes as many as it is given and wants at least two; every
        // other kind wants exactly what SKETCH_CLICKS says. Demanding two of
        // everything meant a point - which takes ONE click - could never be
        // drawn through this op at all.
        const least = wanted || 2;
        if (clicks.length < least)
          throw new Error(type + " needs " + (wanted ? wanted : "at least two")
            + (least === 1 ? " point" : " points") + ' in "at"');
        drawing.elements.push(sketchElement(type, id, clicks));
      }
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

  modelOp("unrelate", ["id", "at?", "type?", "of?"],
    "Take a relation off a sketch: at is its place in the constraints list, or name "
    + "it by type and what it governs. Removing what holds a corner together lets "
    + "the two ends move apart again.",
    { op: "unrelate", id: "SK1", at: 0 },
    async (ctx, edit) => {
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      const list = drawing.constraints;
      let gone = -1;
      if (Number.isInteger(edit.at)) {
        if (edit.at < 0 || edit.at >= list.length)
          throw new Error("that sketch has no relation " + edit.at);
        gone = edit.at;
      } else if (edit.type) {
        const of = Array.isArray(edit.of) ? edit.of : null;
        gone = list.findIndex(c => c.type === edit.type
          && (!of || JSON.stringify(c.of) === JSON.stringify(of)));
        if (gone < 0) throw new Error("that sketch has no such " + edit.type + " relation");
      } else throw new Error('name the relation with "at", or with "type" and "of"');
      list.splice(gone, 1);
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

  modelOp("drag", ["id", "handle", "to"],
    "Move one end of one element of a sketch, in the plane's own coordinates. An "
    + "arc's endpoint is an angle and a radius rather than a free point, so moving "
    + "it turns and resizes the arc instead of tearing it. This is what dragging a "
    + "handle in the sketcher writes.",
    { op: "drag", id: "SK1", handle: "e1.b", to: [120, 40] },
    async (ctx, edit) => {
      const at = String(edit.handle || "");
      if (!/^[^.]+\.[^.]+$/.test(at))
        throw new Error('"handle" names an element and one of its ends, as "e1.b"');
      const to = edit.to;
      if (!Array.isArray(to) || to.length !== 2 || !to.every(Number.isFinite))
        throw new Error('"to" must be two numbers');
      const drawing = await drawingOf(ctx, needText(edit, "id"));
      const found = sketchHandleAt(drawing, at);
      if (!found) throw new Error("there is no handle '" + at + "' on that sketch");
      sketchMoveHandle(found.el, found.key, to);
      // A drag is the one edit where the relations are settled and written down
      // rather than left to the build: the hand is on this handle, so it stays
      // exactly where it was put and everything held to it follows all the way.
      // Anywhere else the drawing keeps what was drawn and the relations are
      // what they come to - here, dragging a corner has to move the corner.
      const settled = solveSketch(drawing, 40, [at]);
      return ctx.kernel.setSketch(edit.id, null, settled.drawing);
    }),

  //! Undo and redo are edits like everything else, so they are recorded, they
  //! show in the console, and a driver on the other end of a socket can send
  //! them. What they restore is the whole model file, because that is what the
  //! model is; the stack they walk is kept by the channel below.
  modelOp("undo", [],
    "Put the document back the way it was before the last edit that changed it. "
    + "View edits - selecting, moving a node on the canvas - are not on the stack.",
    { op: "undo" },
    ctx => ctx.undo()),

  modelOp("redo", [],
    "Put back an edit that was undone. Anything else undoes the redo.",
    { op: "redo" },
    ctx => ctx.redo()),

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

//! How many documents back you can go. Each one is the model file, which for a
//! part of this size is a few tens of kilobytes of text - so the whole stack
//! costs about what one mesh does.
const UNDO_DEPTH = 60;

//! Edits that arrive in a stream - a slider being dragged, a handle being
//! pushed around - are one edit as far as a person is concerned, so
//! consecutive ones on the same thing collapse into a single step rather than
//! filling the stack with a hundred of them. What "the same thing" means is
//! this key; an op without one never collapses.
const coalesceKey = edit => {
  if (edit.op === "set") return "set:" + edit.id + ":" + edit.key;
  if (edit.op === "vertex") return "vertex:" + edit.id + ":" + edit.index;
  if (edit.op === "drag") return "drag:" + edit.id + ":" + edit.handle;
  return null;
};
const COALESCE_WINDOW = 900;   // ms

//! What goes into the record of the session. Everything, except the file
//! somebody imported: the console shows every edit that has run, and a
//! megabyte of B-Rep in the middle of it is not something anyone reads. The
//! edit itself ran with the whole file; only the copy kept for reading is
//! shortened, and it says so.
const forRecord = edit => (edit && typeof edit.data === "string" && edit.data.length > 400)
  ? { ...edit, data: "<" + edit.data.length + " characters of file, not kept in the log>" }
  : edit;

export class Mdl {
  constructor(ctx) {
    this.ctx = ctx;              // { kernel, apply, setNode, readLayout, select, selected }
    this.history = [];
    this.serial = 0;
    this.watchers = new Set();
    // The state manager. Two stacks of whole model files: one behind, one
    // ahead. Nothing here understands what an edit does - it only knows what
    // the document said before one, which is the only definition of undo that
    // cannot drift from what the edits actually did.
    this.past = [];
    this.future = [];
    this.restoring = false;
    this.ctx.undo = () => this.step(this.past, this.future);
    this.ctx.redo = () => this.step(this.future, this.past);
    // Told whenever the stacks move, which is not the same as an edit running:
    // a batch of twenty edits moves them once, at the end.
    this.onStack = ctx.onStack || (() => {});
  }

  //! The document as it stands, layout and all - one entry on the stack.
  async snapshot() {
    const model = await this.ctx.kernel.model();
    const layout = this.ctx.readLayout ? this.ctx.readLayout() : null;
    if (layout && Object.keys(layout).length) model.layout = layout;
    return model;
  }

  async restore(model) {
    if (model.layout && this.ctx.readLayout) this.ctx.readLayout(model.layout);
    return await this.ctx.kernel.loadModel(model);
  }

  //! One step along the stacks, either way round. What is current goes on the
  //! other stack on the way past, so undo and redo are the same walk.
  async step(from, to) {
    if (!from.length) throw new Error(from === this.past ? "nothing to undo" : "nothing to redo");
    const here = await this.snapshot();
    const there = from.pop();
    this.restoring = true;
    try {
      const payload = await this.restore(there.model);
      to.push({ model: here, label: there.label });
      this.onStack();
      return payload;
    } finally { this.restoring = false; }
  }

  //! What the buttons read to know whether they are live, and what to call the
  //! step they would take.
  get undoable() { return this.past.length ? this.past[this.past.length - 1].label : null; }
  get redoable() { return this.future.length ? this.future[this.future.length - 1].label : null; }

  //! Remembers the document as it was before an edit. Doing something new
  //! forgets the branch that was undone, which is what every undo stack does
  //! and what everyone expects.
  remember(model, edit) {
    const key = coalesceKey(edit);
    const top = this.past[this.past.length - 1];
    if (key && top && top.key === key && Date.now() - top.at < COALESCE_WINDOW) {
      // Still the same drag: keep the older document, move the clock on.
      top.at = Date.now();
    } else {
      this.past.push({ model, label: edit.op, key, at: Date.now() });
      if (this.past.length > UNDO_DEPTH) this.past.shift();
    }
    this.future.length = 0;
    this.onStack();
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
    const record = { n: ++this.serial, at: Date.now(), edit: forRecord(edit),
                     view: spec.view, ok: true, ms: 0 };
    const started = performance.now();
    // Taken before the edit runs, and kept only if it does: a refused edit
    // changed nothing, so it has nothing to undo.
    const walking = edit.op === "undo" || edit.op === "redo";
    const before = (spec.view || walking || this.restoring) ? null : await this.snapshot();
    try {
      const payload = await spec.run(this.ctx, edit);
      if (before) this.remember(before, edit);
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

  //! A list of edits applied in order, carrying on past any that are refused
  //! and reporting them - what an assistant working the channel needs, where a
  //! person would have stopped and looked. One step to undo, whatever happened
  //! inside it, and \p onEach is called as each one lands so it can be watched.
  async runBatch(edits, onEach, signal = null) {
    const before = this.restoring ? null : await this.snapshot();
    const failed = [];
    let applied = 0;
    this.restoring = true;
    try {
      for (const edit of edits) {
        // Stop means stop: what has been applied stays, and the rest is dropped
        // rather than hurried through.
        if (signal && signal.aborted) break;
        try {
          await this.run(edit);
          applied++;
          if (onEach) await onEach(null, edit);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          failed.push({ edit, message });
          if (onEach) await onEach(message, edit);
        }
      }
    } finally { this.restoring = !before; }
    if (before && applied) this.remember(before, { op: "build" });
    return { applied, failed };
  }

  //! A list of edits, in order, stopping at the first refusal. Returns the last
  //! answer, which is the one carrying the state everything else redraws from.
  //!
  //! Applied together, they are one step to undo. That is what a list means:
  //! drawing a line that also holds a corner together is one action, and so is
  //! pushing six vertices with one handle - the file still says exactly which
  //! six moved.
  async runAll(edits, hint) {
    if (!edits.length) return null;
    const before = this.restoring ? null : await this.snapshot();
    let payload = null;
    this.restoring = true;
    try {
      for (const edit of edits) payload = (await this.run(edit, hint)) || payload;
    } finally { this.restoring = !before; }
    // Kept only if something ran: a list that was refused on its first edit
    // changed nothing.
    if (before && payload) this.remember(before, { op: edits[0].op });
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
