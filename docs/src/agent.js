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
//! What packages there are. A loaded one's nodes are already in the catalogue,
//! so what is added here is why it exists and what its own API can do. The ones
//! NOT loaded get a line each, because "there is a Climate package that would
//! answer that, ask them to load it" is a far better answer than inventing a
//! node or saying it cannot be done.
export function packagesBrief(packages) {
  if (!packages) return "";
  const out = [];
  for (const p of packages.loaded || []) {
    out.push("LOADED  " + p.name + " (" + p.id + ") - " + p.summary);
    if (p.nodes.length) out.push("    nodes: " + p.nodes.join(", "));
    if (p.view) out.push("    adds the " + p.view + " mode to the interface");
    if (p.api && p.api.operations)
      for (const op of p.api.operations)
        out.push("    " + p.api.name + "." + op.name + "(" + op.takes + ") -> " + op.gives
               + "\n        " + op.summary);
  }
  for (const p of packages.available || []) {
    out.push("AVAILABLE, not loaded  " + p.name + " (" + p.id + ") - " + p.summary);
    if (p.nodes.length) out.push("    would add: " + p.nodes.join(", ")
      + (p.view ? ", and the " + p.view + " mode" : ""));
  }
  return out.join("\n");
}

//! What can be read and written, and the one rule about which. Said here
//! because a request to import something is a request the assistant can act
//! on - the import op takes the file's text - and because a format that is not
//! in this list is one to say no to rather than one to try.
export function exchangeBrief(formats) {
  if (!formats || !formats.length) return "No file exchange in this kernel.";
  const line = f => "  " + f.name + " (" + f.extensions.join(", ") + ") "
    + (f.read && f.write ? "in and out" : f.read ? "in only" : "out only")
    + (f.structure ? ", carries several parts" : "")
    + "\n      " + f.summary;
  return `The "import" edit reads a file into the document; the interface writes
files out, from the burger menu, which you cannot press. An import is stored as
the geometry itself, so it rebuilds without the reader that read it, and it has
no parameters to turn - it is dead geometry that anything downstream can still
move, cut, fillet and measure. A mesh keeps the faces it was authored with, so
a quad cage from Blender stays a quad cage and can be subdivided here.

Only a format that carries several parts can be broken up ("as":"parts");
everything else comes in as one object.

${formats.map(line).join("\n")}`;
}

export function briefing(schema, model, packages) {
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
- Past about a dozen nodes, file them into sets as you go: a GeometricalSet for
  wireframe and surfaces, a Body for solids, and "group" to put a node in one.
  A set is a folder - it holds nothing, builds nothing and consumes nothing, so
  it can never change the part - but it lets the person read forty nodes as
  four groups, and it can say what feeds it from outside.
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

PACKAGES
Components that are not general live in packages, and a package is off until
somebody loads it. You cannot load one yourself - it is a switch in the
interface, under the packages button in the toolbar - but you can see what is
on the shelf, and asking for one is the right answer when a request needs it.
Never use a node from a package that is not loaded: it is not in the catalogue
above, so it does not exist yet.

${packagesBrief(packages)}

FILES
${exchangeBrief(schema.exchange)}

THE DOCUMENT AS IT STANDS
${JSON.stringify(model)}`;
}

/* ==========================================================================
   Who answers.

   Two of them, and the difference is whose account pays. Published as an
   Artifact, the page asks the person reading it - their Claude account, no key,
   nothing to set up, and the runtime runs the tool loop. Served as an ordinary
   web page there is nobody to ask, so the person brings a key of their own and
   this file runs the same loop against the Messages API itself.

   Both are the same function to everything above: turns in, tools available,
   text out. So `ask` below does not know which one it got, and neither does the
   panel.
   ========================================================================== */

//! Where a key comes from and what it is worth saying about it. Named here
//! rather than in the interface because the interface should not be the place
//! that knows what an API key is.
export const KEY_HOME = "https://console.anthropic.com/settings/keys";
export const MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "quick, and enough for most parts" },
  { id: "claude-opus-5", label: "Opus 5", note: "slower and dearer; better at long builds" },
];
export const DEFAULT_MODEL = MODELS[0].id;

//! The key lives in this browser and nowhere else: not in the model file, not
//! in the briefing, not on any server of ours - there is no server of ours.
//! That also means anything that can run script on this origin can read it,
//! which is why the interface says so and offers to forget it.
const KEY_STORE = "ocafcad/anthropic-key";
const MODEL_STORE = "ocafcad/anthropic-model";

const storedKey = () => {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
};
const storedModel = () => {
  try { return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL; }
  catch (e) { return DEFAULT_MODEL; }
};
const keep = (key, model) => {
  try {
    if (key) { localStorage.setItem(KEY_STORE, key); localStorage.setItem(MODEL_STORE, model); }
    else { localStorage.removeItem(KEY_STORE); localStorage.removeItem(MODEL_STORE); }
  } catch (e) { /* a private window keeps nothing, and the key still works today */ }
};

//! Enough of the key to recognise it by, and not enough to use.
export const maskKey = key => {
  const text = String(key || "");
  return text.length > 12 ? text.slice(0, 7) + "…" + text.slice(-4) : "a key";
};

const API = "https://api.anthropic.com/v1/messages";
const MAX_TURNS = 24;          // tool round trips before it is a runaway, not a build

//! The Messages API, spoken directly from the browser, with the same signature
//! the Artifact runtime's sampler has. Anthropic allows this from a page only
//! with the header below, which is also the header that says out loud what it
//! means: the key is in the browser, and a browser is not a secret place.
export function directSample({ key, model }) {
  return async function sample(turns, options = {}) {
    const tools = (options.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      // The runtime spells it inputSchema; the API spells it input_schema. A
      // tool that takes nothing still has to say so.
      input_schema: tool.inputSchema || { type: "object", properties: {} },
    }));
    const byName = new Map((options.tools || []).map(tool => [tool.name, tool]));
    const messages = turns.map(turn => ({ role: turn.role, content: turn.content }));
    let text = "";

    for (let round = 0; round < MAX_TURNS; round++) {
      const answer = await stream({
        key, model: model || DEFAULT_MODEL, messages, tools,
        signal: options.signal,
        onText: piece => {
          text += piece;
          if (options.onText) options.onText({ text });
        },
      });

      if (answer.stop_reason !== "tool_use") return { text: text.trim() };

      // What it said and what it asked for go back as one assistant turn, and
      // the results come back as one user turn. That is the shape the API
      // wants, and it is why the whole conversation stays in `messages`.
      messages.push({ role: "assistant", content: answer.content });
      const results = [];
      for (const block of answer.content) {
        if (block.type !== "tool_use") continue;
        const tool = byName.get(block.name);
        let output, failed = false;
        try {
          if (!tool) throw new Error("there is no tool called " + block.name);
          output = await tool.execute(block.input || {}, { signal: options.signal });
        } catch (err) {
          failed = true;
          output = { error: (err && err.message) || String(err) };
        }
        results.push({
          type: "tool_result", tool_use_id: block.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
          ...(failed ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
      if (options.signal && options.signal.aborted) return { text: text.trim() };
    }
    return { text: text.trim() };
  };
}

//! One request, streamed. Text arrives a piece at a time so the answer can be
//! watched being written; a tool call arrives as JSON in pieces and is only
//! worth anything once it is whole.
async function stream({ key, model, messages, tools, signal, onText }) {
  let response;
  try {
    response = await fetch(API, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 8000, stream: true, messages,
                             ...(tools.length ? { tools } : {}) }),
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw Object.assign(new Error("stopped"), { code: "cancelled" });
    throw Object.assign(new Error("could not reach Anthropic - " +
      ((err && err.message) || "the request failed")), { code: "unreachable" });
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = (body && body.error && body.error.message) || "";
    } catch (e) { /* not every failure is JSON */ }
    throw Object.assign(new Error(detail || response.statusText),
                        { code: "http_" + response.status, status: response.status });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const content = [];
  let open = null, buffer = "", stop_reason = null;

  const handle = event => {
    if (event.type === "content_block_start") {
      open = event.content_block.type === "tool_use"
        ? { type: "tool_use", id: event.content_block.id, name: event.content_block.name, json: "" }
        : { type: "text", text: "" };
    } else if (event.type === "content_block_delta" && open) {
      if (event.delta.type === "text_delta") { open.text += event.delta.text; onText(event.delta.text); }
      else if (event.delta.type === "input_json_delta") open.json += event.delta.partial_json;
    } else if (event.type === "content_block_stop" && open) {
      if (open.type === "tool_use") {
        let input = {};
        try { input = open.json ? JSON.parse(open.json) : {}; } catch (e) { input = {}; }
        content.push({ type: "tool_use", id: open.id, name: open.name, input });
      } else if (open.text) content.push({ type: "text", text: open.text });
      open = null;
    } else if (event.type === "message_delta" && event.delta) {
      stop_reason = event.delta.stop_reason || stop_reason;
    } else if (event.type === "error") {
      throw Object.assign(new Error((event.error && event.error.message) || "the stream failed"),
                          { code: "stream" });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Server-sent events: blank line ends a message, and only the data lines
    // carry anything worth reading.
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { handle(JSON.parse(payload)); }
        catch (err) { if (err && err.code) throw err; }
      }
    }
  }
  return { content, stop_reason };
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
    this.through = null;                      // "page", "key", or nobody
    this.pace = 90;                           // ms between edits, so it can be watched
  }

  //! Who is going to answer, worked out once and lazily: asking for a
  //! capability that is not there is how you find out it is not there.
  //!
  //! The page's own Claude comes first and costs the reader nothing to set up.
  //! Failing that, a key the person connected themselves. Failing that, nobody,
  //! and the panel says how to fix it.
  async ready() {
    if (this.sample !== undefined) return this.sample;
    try {
      this.sample = (typeof claude !== "undefined" && claude.use)
        ? await claude.use("sample") : null;
    } catch (e) { this.sample = null; }
    if (this.sample) { this.through = "page"; return this.sample; }

    const key = storedKey();
    if (key) {
      this.sample = directSample({ key, model: storedModel() });
      this.through = "key";
    }
    return this.sample;
  }

  //! How it is connected, for the interface to say out loud. Asked before
  //! `ready` has run it answers "unknown", which is the truth.
  get connection() {
    if (this.through === "page") return { how: "page", label: "your Claude account" };
    if (this.through === "key")
      return { how: "key", label: "your API key", key: maskKey(storedKey()),
               model: storedModel() };
    return { how: this.sample === undefined ? "unknown" : "none", label: "not connected" };
  }

  //! A key, kept in this browser and nowhere else. Checked before it is kept:
  //! a key that is refused should be refused now, in front of the person who
  //! pasted it, and not in the middle of building something.
  async connect(key, model) {
    const trimmed = String(key || "").trim();
    if (!trimmed) throw Object.assign(new Error("no key"), { code: "empty_key" });
    const chosen = MODELS.some(m => m.id === model) ? model : DEFAULT_MODEL;
    const sample = directSample({ key: trimmed, model: chosen });
    // One word to one model. It proves the key, the model name and that the
    // browser is allowed to talk to Anthropic at all, for a few tokens.
    await sample([{ role: "user", content: "Reply with the single word: ready" }], {});
    keep(trimmed, chosen);
    this.sample = sample;
    this.through = "key";
    this.turns = [];
    return this.connection;
  }

  //! Forgotten, here and in the browser. The next request has nobody to ask
  //! again, which is what being disconnected means.
  disconnect() {
    keep(null, null);
    if (this.through === "key") {
      // null, not undefined: the answer to "who can answer" is now known and it
      // is nobody. Undefined would mean "not asked yet", and the interface
      // would go back to saying nothing rather than offering the way in.
      this.sample = null;
      this.through = null;
    }
    this.turns = [];
    return this.connection;
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

    const { schema, model, packages } = await this.read();
    // Memory-less: the whole conversation goes every time, and the briefing
    // rides on the first turn so the document it describes is the current one.
    const opening = briefing(schema, model, packages);
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
  if (code === "not_granted" || (err && err.message === "no-sample"))
    return "Nobody is connected to answer. Press Connect and paste an Anthropic API "
         + "key - it stays in this browser, and the work is billed to your own "
         + "account. In the published Artifact this page asks your Claude account "
         + "instead and there is nothing to connect.";
  if (code === "http_401" || code === "http_403")
    return "Anthropic refused that key. Check it at console.anthropic.com, or press "
         + "Connect and paste a new one.";
  if (code === "http_400")
    return "Anthropic refused the request" + (err.message ? " - " + err.message : "")
         + ". If it names the model, connect again and pick the other one.";
  if (code === "http_429")
    return "Your account is rate limited just now, or out of credit. Give it a moment, "
         + "or check the balance at console.anthropic.com.";
  if (code && code.startsWith("http_5"))
    return "Anthropic had trouble at their end (" + code.slice(5) + "). Try again.";
  if (code === "unreachable")
    return "Could not reach Anthropic from this page. Check the connection, and that "
         + "no extension is blocking api.anthropic.com.";
  if (code === "empty_key") return "Paste a key first.";
  if (code === "cancelled") return "Stopped.";
  if (code === "rate_limited") return "Too many requests just now. Give it a moment.";
  if (code === "tools_unavailable")
    return "This view cannot run the page's own tools, so there is no way to apply "
         + "the edits it would write.";
  if (code === "empty_completion") return "No answer came back. Try asking again.";
  return (err && err.message) || "Something went wrong.";
}
