// Claude, on the other side of the same door.
//
// Everything in this program that edits the model does it by writing one line
// of the model description language and sending it down one channel. The node
// graph does it, a slider does it, a click in the sketcher does it. So there is
// nothing left to build for an assistant to do it too: it is handed the same op
// table, the same catalogue and the same document, and its edits go through
// `mdl.run` exactly as a drag of a wire does.
//
// That is the whole design. No second path into the model, no special
// permission, nothing an assistant can do that a person could not have typed
// into the console themselves - which is also why watching it work is watching
// nodes appear and wire themselves up, rather than a part arriving from
// nowhere.
//
// The asking is the page's own `sample` capability: in a published Artifact the
// viewer's Claude answers, on their account, and the page never sees a key.
// Opened any other way there is nobody to ask, and the panel says so instead of
// pretending.

import { mdlSchema } from "./mdl.js";

//! The catalogue, small enough to send. One line a feature: what it makes, and
//! what each argument takes. The summaries carry the intent, and they are what
//! stops a request for a roof turning into a box.
export function catalogueBrief(schema) {
  return (schema.types || []).map(spec => {
    const args = (spec.args || []).map(arg => {
      if (arg.kind === "real") return arg.key + "=number";
      if (arg.kind === "choice") return arg.key + "=" + arg.options.map(o => JSON.stringify(o)).join("|");
      if (arg.kind === "ref") return arg.key + "=wire<" + arg.accepts + ">";
      if (arg.kind === "refs") return arg.key + "=wires<" + arg.accepts + ">";
      if (arg.kind === "sketch") return arg.key + "=drawing";
      if (arg.kind === "edits") return arg.key + "=vertex offsets";
      return arg.key + "=" + arg.kind;
    }).join(" ");
    return spec.type + " [" + spec.category + " -> " + spec.produces + "] " + args
         + "\n    " + spec.summary;
  }).join("\n");
}

//! The geometry API underneath the catalogue: the two factories and what each
//! of them can do. A node is a driver and a driver is one factory call, so
//! knowing the factories is knowing what the components are made of - which is
//! what tells the difference between a component that is missing and one that
//! is there under another name. It is also the honest answer to "can it do X":
//! if no factory does X, no node does either.
export function apiBrief(api) {
  if (!api || !api.factories) return "";
  return api.factories.map(factory =>
    factory.name + " - " + factory.makes + "\n"
    + factory.operations.map(op =>
        "  " + op.name + "(" + op.takes + ") -> " + op.gives
        + "\n      " + op.summary).join("\n")).join("\n\n");
}

//! What the assistant is told before it is asked anything. The rules are the
//! ones a person working here would be given, and the first of them is the one
//! this whole program is built on.
export function briefing(schema, model) {
  const ops = mdlSchema().ops.map(op =>
    "  " + op.op + "(" + op.fields.join(", ") + ")"
    + (op.rebuilds ? "" : "   [changes only the view]")
    + "\n      " + op.summary
    + "\n      e.g. " + JSON.stringify(op.example)).join("\n");

  return `You are working inside a parametric CAD modeller built on OpenCascade's
OCAF. You edit the model the same way every other part of the interface does:
by sending edits in its model description language. Nothing else reaches the
document, and each edit you send is applied live in front of the person asking,
so they watch the part being built.

HOW TO WORK
- Call run_edits with a list of edits. Send them in dependency order: a feature
  must exist before anything is wired to it.
- Give every feature an "id" of your own choosing when you add it, and a "name"
  a person would recognise ("Roof slab", not "Extrude.4"). The id is how every
  later edit refers to it, so choose it up front rather than waiting to be told
  one: {"op":"add","type":"Cube","id":"BASE","name":"Base block"} and then
  {"op":"set","id":"BASE","key":"dx","value":240}.
- Work in stages of a handful of edits rather than one huge list, and look at
  what run_edits reports back before the next stage. If something errors, fix
  it before building on it.
- Prefer nodes wired to nodes. A Script takes no inputs, so it is not part of
  the graph - reach for one only when the move is genuinely beyond the
  components, and say why.
- What an input accepts is what a source PRODUCES, not its type name. Any
  number input can be driven by anything producing numbers.
- Sizes are millimetres. Building-scale work is thousands of them.
- When you are finished, say in one or two sentences what you built and which
  numbers are worth turning.

THE EDITS
${ops}

THE COMPONENTS
${catalogueBrief(schema)}

THE GEOMETRY UNDERNEATH THEM
Every component above is a driver over one call into one of these two
factories, split the way CATIA splits them: everything that is not a solid is
hybrid, everything that is, is not. You cannot call these directly - you build
by wiring components - but they say what the kernel can actually do, so a
component you cannot find is either here under another name or genuinely not
there. Do not invent a component that is not in the list above.

${apiBrief(schema.api)}

THE DOCUMENT AS IT STANDS
${JSON.stringify(model)}`;
}

/* ==========================================================================
   The panel.
   ========================================================================== */

export class Agent {
  constructor(options) {
    this.mdl = options.mdl;
    this.read = options.read;                 // async () -> { schema, model, errors }
    this.onBusy = options.onBusy || (() => {});
    this.doc = options.doc || document;
    this.turns = [];                          // the conversation, kept by the page
    this.running = null;                      // the AbortController of the live call
    this.sample = undefined;                  // undefined = not asked yet, null = no
    this.pace = 90;                           // ms between edits, so it can be watched
  }

  //! Resolved once, lazily: asking for a capability that is not there is how
  //! you find out it is not there.
  async ready() {
    if (this.sample !== undefined) return this.sample;
    try {
      this.sample = (typeof claude !== "undefined" && claude.use)
        ? await claude.use("sample") : null;
    } catch (e) { this.sample = null; }
    return this.sample;
  }

  stop() {
    if (this.running) this.running.abort();
    this.running = null;
    this.onBusy(false);
  }

  get busy() { return !!this.running; }

  /* ------------------------------------------------------------ the tools */

  //! The page functions Claude may call. Both of them go through the same
  //! channel everything else does, so there is no way for one of these to do
  //! something a person could not have done by hand.
  tools(log) {
    const mdl = this.mdl;
    const pace = this.pace;
    return [
      {
        name: "run_edits",
        description: "Apply a list of edits to the model, in order, and report what "
          + "happened. Returns the id and name of every feature that now exists, and "
          + "the message from any edit that was refused. Edits are applied one at a "
          + "time and are visible as they go.",
        inputSchema: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              description: "The edits, in dependency order. Each is one object in the "
                + "model description language, e.g. {\"op\":\"add\",\"type\":\"Cube\","
                + "\"name\":\"Base\"}.",
              items: { type: "object" },
            },
          },
          required: ["edits"],
        },
        execute: async (input, context) => {
          const edits = Array.isArray(input.edits) ? input.edits : [];
          if (!edits.length) throw new Error('"edits" must be a list of edits');
          // One tool call is one thing done, so it is one step to undo however
          // many edits were inside it - what the person watching would expect
          // "undo what it just did" to mean.
          const { applied, failed } = await mdl.runBatch(edits, async (trouble, edit) => {
            log(trouble ? { kind: "refused", edit, message: trouble } : { kind: "edit", edit });
            // Slow enough to be watched. The person asked to see this happen.
            if (pace) await new Promise(go => setTimeout(go, pace));
          }, context.signal);
          const { model } = await this.read();
          return {
            applied,
            stopped: context.signal.aborted,
            failed: failed.slice(0, 12),
            features: (model.features || []).map(f => f.id + " " + f.type + ' "' + f.name + '"'),
          };
        },
      },
      {
        name: "look",
        description: "Read the model file as it stands now - every feature, its "
          + "arguments and its wires - and any errors on it. Use it to check what a "
          + "stage of edits actually produced before building on it.",
        execute: async () => {
          const { model, errors } = await this.read();
          return { model, errors };
        },
      },
    ];
  }

  /* -------------------------------------------------------------- the turn */

  //! One request. \p onEvent is how the panel shows what is happening: the
  //! answer as it is written, and a line for every edit that lands.
  async ask(prompt, onEvent) {
    const sample = await this.ready();
    if (!sample) throw new Error("no-sample");
    if (this.running) throw new Error("still working - stop it first");

    const { schema, model } = await this.read();
    // Memory-less: the whole conversation goes every time, and the briefing
    // rides on the first turn so the document it describes is the current one.
    const opening = briefing(schema, model);
    const turns = this.turns.length
      ? [...this.turns, { role: "user", content: prompt }]
      : [{ role: "user", content: opening + "\n\nWHAT TO BUILD\n" + prompt }];

    this.running = new AbortController();
    this.onBusy(true);
    const log = event => onEvent(event);
    try {
      const answer = await sample(turns, {
        signal: this.running.signal,
        tools: this.tools(log),
        modelTier: "complex",
        onText: ({ text }) => onEvent({ kind: "text", text }),
      });
      this.turns = [...turns, { role: "assistant", content: answer.text }];
      // The briefing is only ever sent once; from here the document is what the
      // tools report, which is cheaper and always current.
      onEvent({ kind: "done", text: answer.text });
      return answer.text;
    } finally {
      this.running = null;
      this.onBusy(false);
    }
  }

  //! Start again: the next request carries the briefing and the document as it
  //! stands, rather than everything said so far.
  forget() { this.turns = []; }
}

//! What went wrong, in words a person can act on. The capability reports a code
//! and the page has to say what it means here.
export function agentTrouble(err) {
  const code = err && err.code;
  if (code === "not_granted" || err.message === "no-sample")
    return "This needs the published Artifact - the page has to ask your Claude "
         + "account, and there is nobody to ask when it is opened from a file or "
         + "served by a local kernel.";
  if (code === "cancelled") return "Stopped.";
  if (code === "rate_limited") return "Too many requests just now. Give it a moment.";
  if (code === "tools_unavailable")
    return "This view cannot run the page's own tools, so there is no way to apply "
         + "the edits it would write.";
  if (code === "empty_completion") return "No answer came back. Try asking again.";
  return (err && err.message) || "Something went wrong.";
}
