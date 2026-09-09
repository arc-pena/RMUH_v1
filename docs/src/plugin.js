// Packages.
//
// The modeller is one page, and one page has a budget: the tools on the rail,
// the types in the catalogue, the words in the assistant's briefing. Everything
// that could be there costs something for everyone who does not want it, so
// what is not general goes in a package and a package is off until it is asked
// for.
//
// A package DECLARES itself before it does anything. That declaration is the
// whole contract, and it is deliberately the same shape as the ones the kernel
// already publishes - the catalogue of nodes, the manifest of factory
// operations - because there is then only one thing to read:
//
//     what it is        an id, a name, a sentence
//     what it adds      nodes, an API, a view, resources
//     what it needs     other packages, and what it will not run without
//     how to start it   one function, handed a kit
//
// Nothing in the declaration runs. It is data, it is cheap, and it is readable
// with the package switched off - which is what lets the settings menu list
// what is available, and lets the assistant be told "there is a Climate package
// you could ask for" without paying for it in every prompt.
//
// What loading actually saves. In a single-file page every byte is in the file
// whether a package is loaded or not, and it would be dishonest to pretend
// otherwise. What loading changes is real all the same:
//
//   - a package's DATA rides gzipped in its own script element and is unpacked
//     only on load, so a session that never opens it never pays the memory or
//     the time;
//   - its drivers, buffers and views are only built on load;
//   - its nodes are not in the catalogue, on the rail, or in the assistant's
//     briefing until then - so the interface and the prompt stay the size of
//     what you are actually using.

import { registerTypes, unregisterTypes } from "./ocaf.js";

/* ------------------------------------------------------------- declaring */

//! The shape of a package, checked when it is declared rather than when it is
//! switched on. A package that is wrong about itself should say so at the
//! moment it is written, not the first time somebody clicks it.
export function definePlugin(manifest) {
  const need = (key, what) => {
    if (!manifest[key]) throw new Error('a package needs "' + key + '" - ' + what);
  };
  need("id", "one word, the name it is stored and asked for by");
  need("name", "what a person sees in the packages menu");
  need("summary", "one sentence: what it is for");
  if (typeof manifest.start !== "function")
    throw new Error(manifest.id + ' must have a start(kit) - that is where it comes alive');
  if (manifest.nodes && !Array.isArray(manifest.nodes))
    throw new Error(manifest.id + ": nodes must be a list of catalogue entries");
  return {
    version: 1, needs: [], nodes: [], resources: [], api: null, view: null,
    ...manifest,
  };
}

/* ------------------------------------------------------------ the shelf

   Declared here, loaded on demand. A package puts itself on the shelf by
   calling this at the top level of its own module; nothing else happens until
   somebody asks for it.                                                     */

const shelf = new Map();

export function offerPlugin(manifest) {
  const plugin = definePlugin(manifest);
  if (shelf.has(plugin.id)) throw new Error("there are two packages called " + plugin.id);
  shelf.set(plugin.id, plugin);
  return plugin;
}

export const availablePlugins = () => [...shelf.values()];
export const findPlugin = id => shelf.get(id) || null;

/* --------------------------------------------------------------- running */

//! What is loaded, and what each loaded package brought with it - because
//! unloading is only honest if the list of what to take away is the list of
//! what was added, kept by the thing that added it.
export class PluginHost {
  //! \p kit is what a package is given to work with: the kernel, the document
  //! language, and whatever the interface chooses to hand over. The host does
  //! not decide what is in it - the page does - so a package can be given more
  //! without this file changing.
  constructor(kit, { onChange } = {}) {
    this.kit = kit;
    this.onChange = onChange || (() => {});
    this.running = new Map();               // id -> { plugin, live }
  }

  isLoaded(id) { return this.running.has(id); }
  loaded() { return [...this.running.values()].map(entry => entry.plugin); }
  live(id) { const entry = this.running.get(id); return entry ? entry.live : null; }

  //! Switch a package on. Its nodes join the catalogue, its drivers join the
  //! kernel, and whatever it hands back is kept so it can be taken away again.
  async load(id) {
    if (this.running.has(id)) return this.running.get(id).live;
    const plugin = shelf.get(id);
    if (!plugin) throw new Error("there is no package called '" + id + "'");
    for (const needed of plugin.needs)
      if (!this.running.has(needed)) await this.load(needed);

    const live = (await plugin.start(this.kit)) || {};
    // The nodes are the declaration's, not the live object's: what a package
    // adds to the catalogue is readable with it switched off, which is the
    // point of declaring it.
    if (plugin.nodes.length) {
      registerTypes(plugin.nodes, "the " + plugin.name + " package");
      if (this.kit.installDrivers) this.kit.installDrivers(plugin.nodes, live.drivers || {});
    }
    this.running.set(id, { plugin, live });
    this.onChange(this);
    return live;
  }

  //! And off. A package whose nodes are in the document stays: taking the type
  //! away would leave features nothing can rebuild, and a silent unload that
  //! breaks the model is worse than a message saying which node is in the way.
  async unload(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    const { plugin, live } = entry;

    for (const [other, running] of this.running)
      if (other !== id && running.plugin.needs.includes(id))
        throw new Error(running.plugin.name + " is using " + plugin.name
          + " - put that away first");

    const inUse = this.kit.typesInUse ? this.kit.typesInUse(plugin.nodes.map(n => n.type)) : [];
    if (inUse.length)
      throw new Error(plugin.name + " is still in the model - "
        + inUse.slice(0, 3).join(", ") + (inUse.length > 3 ? " and others" : "")
        + (inUse.length === 1 ? " is a" : " are") + " node" + (inUse.length === 1 ? "" : "s")
        + " it brought. Delete " + (inUse.length === 1 ? "it" : "them") + " first.");

    if (typeof live.dispose === "function") await live.dispose();
    if (plugin.nodes.length) {
      if (this.kit.removeDrivers) this.kit.removeDrivers(plugin.nodes);
      unregisterTypes(plugin.nodes);
    }
    this.running.delete(id);
    this.onChange(this);
  }

  async toggle(id) {
    if (this.running.has(id)) await this.unload(id);
    else await this.load(id);
  }

  //! Every view a loaded package offers - the modes that appear beside
  //! Showroom, in the order the packages were loaded.
  views() {
    return this.loaded().filter(p => p.view)
      .map(p => ({ ...p.view, plugin: p.id, live: this.live(p.id) }));
  }

  /* ------------------------------------------------------------ telling */

  //! What the assistant is told. Loaded packages are described in full - their
  //! nodes are in the catalogue anyway, so what is added here is the API and
  //! the intent. The ones that are NOT loaded get a line each, because "there
  //! is a Climate package that would answer that, ask for it" is a far better
  //! answer than inventing a node that does not exist.
  schema() {
    const say = plugin => ({
      id: plugin.id, name: plugin.name, version: plugin.version,
      summary: plugin.summary,
      nodes: plugin.nodes.map(n => n.type),
      api: plugin.api || null,
      view: plugin.view ? plugin.view.label : null,
      resources: plugin.resources.map(r => ({ key: r.key, summary: r.summary })),
    });
    return {
      format: "ocaf-packages", version: 1,
      loaded: this.loaded().map(say),
      available: availablePlugins().filter(p => !this.running.has(p.id))
        .map(p => ({ id: p.id, name: p.name, summary: p.summary,
                     nodes: p.nodes.map(n => n.type),
                     view: p.view ? p.view.label : null })),
    };
  }
}

/* ------------------------------------------------------------ resources

   A package's data - a table of cities, a set of coefficients - rides in the
   page the way the kernel and the showroom engine do: gzipped, base64'd, in a
   script element the HTML tokenizer scans straight past. Unpacked on load and
   not before, so it costs nothing until it is wanted.                       */

export async function unpackResource(elementId, what = "package data") {
  const element = document.getElementById(elementId);
  if (!element) throw new Error("this page is missing its " + what);
  const packed = atob(element.textContent.trim());
  const bytes = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) bytes[i] = packed.charCodeAt(i);
  if (typeof DecompressionStream !== "function")
    throw new Error("this browser cannot unpack " + what);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
