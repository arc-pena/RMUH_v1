---
name: plugin-making
description: Build a package (plugin) for the OCAF parametric modeller in docs/ - a self-contained bundle of nodes, an API, an interface mode and data that is off until somebody loads it. Use whenever the user asks to add a package, a plugin, an analysis suite, a new domain of tools (structural, acoustic, cost, fabrication, daylight, CFD, code-compliance...), or says "make this a package" / "as a plugin". Also use when EXTENDING or fixing an existing package.
---

# Making a package

The modeller is one page and one page has a budget: the tools on the rail, the
types in the catalogue, the words in the assistant's briefing. Everything that
*could* be there costs something for everyone who does not want it. So anything
that is not general goes in a package, and a package is off until it is asked
for.

`docs/src/climate-plugin.js` is the worked example. Read it before writing a new
one — not to copy it, but because every decision below was made once there.

## The contract

A package **declares itself before it does anything**. The declaration is data,
it is cheap, and it is readable with the package switched off — which is what
lets the packages menu list it, and lets the assistant be told "there is a
Climate package you could ask for" without paying for it in every prompt.

```js
export const THING = offerPlugin({
  id: "thing",                  // one word: how it is stored and asked for
  name: "Thing & Other",        // what a person sees in the menu
  version: 1,
  summary: "One sentence. What it is FOR, not what it contains.",
  needs: [],                    // other package ids, loaded first

  nodes: THING_NODES,           // catalogue entries, declared but not registered
  api: { name: "ThingFactory", summary: "...", operations: [...] },
  view: { key: "thing", label: "Thing", title: "..." },
  resources: [{ key: "table", payload: "thing-table", summary: "..." }],

  async start(kit) {            // the ONLY thing that runs on load
    const data = await unpackResource("thing-table", "the Thing package's table");
    const view = kit.THREE ? new ThingView(kit, data) : null;
    return { drivers: thingDrivers(kit), view, dispose: () => view && view.dispose() };
  },
});
```

`start(kit)` is the only thing that runs on load. Everything above it is inert.

## What loading actually saves — say this honestly

In a single-file page every byte is in the file whether a package is loaded or
not. Do not write comments pretending otherwise. What loading really changes:

- the package's **data** is unpacked only on load (memory, and the time to parse);
- its **drivers, buffers and views** are only built on load;
- its **nodes** are not in the catalogue, on the rail, or in the assistant's
  briefing until then — so the interface and the prompt stay the size of what is
  actually being used.

## Nodes

Declared in exactly the form `CATALOGUE` uses, with `ARG` from `ocaf.js`:

```js
import { ARG } from "./ocaf.js";

export const THING_NODES = [
  { type: "Thing", guid: "9a1b2c30-00e0-4c00-9e00-caf0000000e0",
    category: "analysis", produces: "number",
    summary: "What it is for, in the voice of the rest of the catalogue.",
    args: [ARG.ref("body", "Body", ["solid"]), ARG.real("size", "Size", 10, 0, 100, 1)] },
];
```

- **Pick guids from an unused block** and check: `grep -o "9a1b2c30-[0-9a-f]\{4\}" docs/src/*.js | sort -u`.
  A repeated guid does not fail — it makes one type quietly answer as another.
  `registerTypes` catches it now, but pick a free block anyway.
- A driver is a driver. It reads its arguments off the labels and calls the
  factories through `kit.toolkit()`. **A driver that reaches past the factories
  into OpenCascade is a driver doing two jobs** — that rule does not stop
  applying because the driver arrived in a package. If the geometry it needs is
  not in HSF/SF, add it there, not here.
- Every node needs a driver, or loading is refused by name.

## The kit

`start(kit)` is handed the real things, not smaller copies:

| | |
|---|---|
| `kit.toolkit()` | `oc`, `F`, `hybrid` (HSF), `shape` (SF), and the kernel's helpers |
| `kit.kernel`, `kit.mdl` | the document, and the language every edit goes through |
| `kit.THREE`, `kit.world`, `kit.scene` | the viewport — absent outside a browser, so guard |
| `kit.streams()` | feature id → the triangles the kernel last sent |
| `kit.tree()`, `kit.hidden()` | what exists, and what is switched off |
| `kit.setModelVisible(on)` | hide the model under an overlay — **not** `world.visible`, your own drawing is in there too |
| `kit.draw()`, `kit.fitView()` | redraw, reframe |

## A view

`view: { key, label, title }` puts a button in the chip beside Showroom. The
live object returned from `start` must carry `view` with `enter()`, `leave()`,
`dispose()`, and — if it computes anything about the model — `invalidate()`,
which `applyState` calls on every rebuild. **A stale analysis is worse than
none, because it looks exactly like a fresh one.**

Build your own DOM in `start`; `index.html` must not know your package exists.
CSS goes in `index.html` under a heading, prefixed (`.an-*` for Analyse).

## Resources

A table rides gzipped in its own `<script type="application/octet-stream">`,
unpacked by `unpackResource(id)` on load. Wire it up in `docs/build.py`:

```python
PAYLOADS = [("climate-sites", "cities.json")]   # element id, file under docs/data/
```

Put the source JSON in `docs/data/`, readable, with a `note` field saying what
it does and does not claim. build.py minifies before packing.

## Honesty

This is the rule that matters most, because it is the easy one to get wrong and
the hard one to notice afterwards. **Say which of the three each number is:**

- **computed** — geometry, thermodynamics, an exact algorithm. Say so and cite
  it (`the NOAA solar position algorithm`, `Møller–Trumbore`).
- **modelled** — a published correlation with named coefficients. Name the
  model and its range (`the ASHRAE clear-day model`, `Magnus, fitted -40..+50`).
  A model outside its range is a wrong number with a plausible shape.
- **measured** — data. **If the package has none, it must not invent any.** Say
  what to load and what will start working when it is there. A chart of invented
  weather is a lie with axes on it.

Write this in the module header, in the node summaries, and on screen.

## Wiring a new package in

1. `docs/src/<name>-plugin.js` — the manifest, nodes, drivers, view.
2. `docs/src/<name>.js` — the arithmetic, pure: no DOM, no OCCT. This is what
   the tests drive and what makes the numbers checkable.
3. `docs/build.py` — add both to `MODULES` **before `app.js`**, and any payload
   to `PAYLOADS`.
4. `docs/src/app.js` — nothing, if it only adds nodes. `PluginHost` and the
   packages menu already exist.
5. `docs/test/<name>.test.mjs` — see below.

build.py refuses duplicate top-level declarations across modules, which is how
you find out you have called something `svg` twice.

## Testing

Two different things, and both are needed:

**That it is a package.** Declared before it runs; its nodes absent from
`typeSpec()` until loaded and present after; a node that actually builds in the
real kernel; refusal to unload while one of its nodes is in the model; loading
again cleanly afterwards. `docs/test/packages.test.mjs` does all of this — copy
its section 6 and 7 shape.

**That its arithmetic is right.** Against numbers a reader can look up, not
against itself. Solar noon altitude is `90 - |latitude - declination|`. Water's
saturation pressure at 20 °C is 2339 Pa. If there is no external number to check
against, check an invariant that would break if the code were wrong in the way
it is most likely to be wrong.

Run everything: `for t in docs/test/*.test.mjs; do node $t; done`.

## Telling the assistant

Automatic. `packagesBrief` in `agent.js` sends loaded packages in full — nodes,
API, operations — and one line each for the ones on the shelf, so the assistant
can answer "load the Climate package" instead of inventing a node. Nothing to do
beyond writing good `summary` text: **that text is the prompt.**
