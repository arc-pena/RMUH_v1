# World Builder

A Three.js page with one control: a prompt bar at the centre bottom. Type
something, and Claude writes the JavaScript that builds it — you watch the scene
assemble object by object while a top-left readout narrates the work and counts
the vertices.

```
prompt  →  Claude (streaming)  →  JavaScript  →  the live scene
```

Nothing is pre-built. There is no scene file, no asset library, no catalogue of
shapes the model picks from. Every mesh on screen was written as source code a
second earlier.

## Run it

```bash
cd web
npm install
export ANTHROPIC_API_KEY=sk-ant-...     # or: ant auth login
npm start                               # → http://localhost:5173
```

The key stays on the server; the browser only ever talks to `/api/build`.

| env var | default | |
|---|---|---|
| `PORT` | `5173` | |
| `MODEL` | `claude-opus-5` | |
| `EFFORT` | `medium` | `low`…`max`. Higher builds better scenes and takes longer. |
| `MAX_TOKENS` | `32000` | ceiling for one build |

Try: `a floating island at dusk` · `a lighthouse on a black sea` ·
`now make it rain` · `taller buildings, and give them windows` ·
`remove the trees` · `slowly orbit the camera`. Shift+Enter cycles through
suggestions, `/` focuses the bar, drag to orbit.

## How a prompt becomes a world

**1. The prompt goes up with the scene attached.** Every request carries a digest
of what is currently on screen — names, types, positions, instance counts:

```
SCENE: 3 top-level object(s), 15865 vertices, 1 animation callback(s), fog on.
- city · Group(60) tag=buildings · pos(0.0, 0.0, 0.0) · 60 meshes
- beacon · Mesh · pos(0.0, 21.9, 0.0)
- trees · InstancedMesh×400 tag=nature · pos(0.0, 0.0, 0.0)
```

That digest is what makes the second prompt work. "Make the beacon pink" reaches
`world.get('beacon')` because the model was told the beacon exists and what it is
called. The scene persists across prompts; each one continues the last.

**2. Claude answers with raw JavaScript**, streamed. Adaptive thinking runs with
`display: "summarized"`, so the reasoning arrives as text too — that is what the
italic lines in the HUD are. Code deltas scroll through the panel above the
prompt bar as they are written.

**3. The code runs against the live scene.** It is compiled as the body of an
async function with exactly four bindings — `THREE`, `world`, `ui`, `api` — and
run immediately. No `import`, no `require`, no network; the only way to reach the
scene is through the API it was handed.

**4. Objects reveal progressively.** `world.add()` puts an object in the scene
hidden and queues it; the render loop reveals a share of the queue every frame,
paced so a build of any size finishes assembling in about 0.9 seconds. That is
why a city appears tower by tower instead of popping in whole.

## The API generated code gets

Documented in full in [`prompts/system.md`](prompts/system.md), which is the
system prompt — edit that file to change what the engine can do.

```js
world.add(object3D, { name, tag })   // the only way onto the stage
world.remove(target)                 // by name, tag, or object
world.clear()                        // undo every build; camera rig survives
world.get(name) / world.find(query) / world.all()
world.onFrame((dt, t) => {})         // motion; returns a dispose fn
world.setBackground / setFog / setLighting / ground / focus
world.log(message)                   // a line in the HUD
world.state                          // survives between prompts

ui.overlay(id, html, style)          // floating DOM panels
ui.remove / ui.clear / ui.setTitle

api.rng(seed) · lerp · clamp · range · pick · noise2D(x, y, seed)
```

`world`, `ui` and `api` are also on `window`, so anything a prompt can do you can
also do by hand from devtools.

The HUD reads live off the renderer: object and vertex counts are walked from the
tracked scene graph (instanced meshes counted per instance), triangles and draw
calls come from `renderer.info`.

## Test

```bash
npx playwright install chromium
npm test
```

No API key needed — the harness boots the real server, loads the real page, and
stubs `/api/build` with a canned SSE stream. It asserts the build reaches
`ready`, the counters move, every queued object finishes revealing, generated DOM
lands in the document, the scene digest names the live objects for the next turn,
a follow-up prompt mutates an existing object, and a deliberately broken build
fails without taking the scene with it.

## Layout

```
server.mjs          static host + /api/build SSE proxy to Claude
prompts/system.md   the system prompt — the engine's real behaviour lives here
public/
  main.js           prompt bar → SSE → HUD → executor
  world.js          renderer, render loop, world API, reveal queue, stats
  executor.js       compiles and runs the generated code
  hud.js            top-left readout
  ui.js             DOM overlays for generated code
test/e2e.mjs        browser smoke test, no API key required
```

three.js is served from `node_modules` rather than a CDN, so the page has no
external dependencies at runtime.

## Notes

- Generated code runs with the page's own privileges. It is written by Claude
  from your prompt, and the API it is handed is small on purpose, but this is not
  a sandbox — run the server locally, for yourself.
- A failed build leaves the partial scene on screen rather than resetting; the
  error shows in red in the HUD and the next prompt can repair it.
- `EFFORT=medium` is a latency choice, not a quality ceiling. Raise it for more
  elaborate scenes and expect longer waits.

## The artifact build

`web/` above is the local version — it needs a server because the API key has to
live somewhere. `artifact/` is the same engine with the server removed: one
self-contained HTML file that runs as a published Artifact on claude.ai and asks
Claude from inside the page, on the viewer's own account, through the `sample`
capability.

```bash
npm run build:artifact     # → artifact/viewport-zero.html
```

What changes, and why:

| | local (`public/`) | artifact (`artifact/`) |
|---|---|---|
| model call | `server.mjs` → Messages API | `claude.use('sample')` in the page |
| credentials | your key, server-side | the viewer's own Claude account |
| narration | streamed thinking summary | `world.log()` calls read out of the code as it is written |
| three.js | served from `node_modules` | compiled into the file by esbuild |
| opening state | empty grid | a seeded scene, so the first frame shows the product |

The `sample` capability returns no reasoning stream, so the HUD narrates from the
code instead: `engine.js` scans the incoming source for `world.log('…')` string
literals and surfaces each one the moment it is written, then drops those preview
lines when execution starts so the real calls replace them in true order. It is a
closer account of the build than a summary would have been.

`build.mjs` bundles `src/` and all of three.js into one IIFE and inlines it into
`template.html`. The published file is generated — build it, don't edit it.
