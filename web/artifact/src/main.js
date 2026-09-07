// prompt bar → Claude → the live scene, with no server in between.

import { REVISION } from 'three';
import { createWorld } from './world.js';
import { execute } from './executor.js';
import { hud } from './hud.js';
import { ui } from './ui.js';
import { seed } from './seed.js';
import { BRIEF, buildInput, stripFences, makeLogScanner, describe, isTerminal } from './engine.js';

const form = document.getElementById('bar');
const input = document.getElementById('prompt');
const button = document.getElementById('go');
const stop = document.getElementById('stop');
const codeStream = document.getElementById('codestream');
const codeBody = document.getElementById('codestream-body');
const hint = document.getElementById('hint');

const stage = createWorld({
  canvas: document.getElementById('stage'),
  onLog: (message, kind) => hud.log(message, kind),
});

const { world, api } = stage;
stage.onStats((stats) => hud.stats(stats));

// world.clear() is the engine's undo; overlays are part of what it undoes.
const clearScene = world.clear.bind(world);
world.clear = () => {
  clearScene();
  ui.clear();
};

const history = [];
let sample = null;
let busy = false;
let control = null;

// ---------------------------------------------------------------- opening state

hud.setState('idle', 'opening scene');
hud.log(`three.js r${REVISION} · webgl`, 'good');
seed(world, api);
hud.log('monolith ring · 14 slabs, 1 core');
hud.log('1400 motes · 1 draw call');
hud.log('type below to build another world');

const IDEAS = [
  'a floating island at dusk',
  'a neon city block in the rain',
  'a lighthouse on a black sea',
  'a forest of glass trees',
  'a canyon at golden hour',
  'a brutalist plaza with long shadows',
  'now make everything drift slowly upward',
];
let ideaIndex = 0;

// The capability resolves after the first script run, never during it — and
// window.claude is absent entirely outside a viewer, so this must not assume it.
const NO_CLAUDE = 'prompting is unavailable here — the scene is still yours to orbit';
Promise.resolve(window.claude?.use('sample'))
  .then((resolved) => {
    sample = resolved ?? null;
    if (!sample) disable(NO_CLAUDE);
  })
  .catch(() => disable(NO_CLAUDE));

function disable(reason) {
  sample = null;
  input.disabled = true;
  button.disabled = true;
  input.placeholder = 'prompting unavailable';
  hint.textContent = reason;
  hud.log(reason, 'warn');
}

// ---------------------------------------------------------------------- build

async function build(prompt) {
  if (busy || !sample) return;
  busy = true;
  document.body.classList.add('busy');
  input.disabled = true;
  button.disabled = true;
  stop.hidden = false;

  hud.clearLog();
  hud.setState('thinking', prompt.slice(0, 58));
  const elapsed = hud.startTimer();
  hud.progress(0);
  codeBody.textContent = '';

  control = new AbortController();
  // Preview lines are a read-ahead of the narration; the real world.log()
  // calls replace them, in true execution order, once the code runs.
  const preview = [];
  const scanLogs = makeLogScanner((line) => preview.push(hud.log(line, 'ahead')));
  const dropPreview = () => { for (const li of preview.splice(0)) li.remove(); };
  let raw = '';
  let writing = false;

  try {
    const { text } = await sample(
      buildInput({ prompt, scene: stage.summary(), history }),
      {
        modelTier: 'default',
        // Every build should be a fresh one; "make it taller" twice in a row
        // must not replay the first answer.
        cache: false,
        signal: control.signal,
        onText: ({ text }) => {
          raw = text;
          if (!writing) {
            writing = true;
            hud.setState('writing', 'generating scene code');
            codeStream.hidden = false;
          }
          // A build is typically 2–6k characters; the bar is a feel, not a promise.
          hud.progress(Math.min(0.95, text.length / 5000));
          codeBody.textContent = text.slice(-1500);
          scanLogs(text);
        },
      },
    );

    raw = text;
    const code = stripFences(text);
    hud.progress(1);
    hud.setState('building', `${code.split('\n').length} lines`);
    dropPreview();

    const result = await execute(code, { world, ui, api });
    history.push({ prompt, code });

    hud.setState('ready', prompt.slice(0, 58));
    hud.log(`${elapsed().toFixed(1)}s to write · ${result.ms.toFixed(0)}ms to build`, 'good');
  } catch (error) {
    elapsed();
    dropPreview();
    const code = stripFences(error?.text ?? raw);
    hud.setState('error', error?.code === 'cancelled' ? 'stopped' : 'build failed');
    hud.log(describe(error), error?.code === 'cancelled' ? 'warn' : 'bad');
    // The partial scene stays on screen — half a world beats a black screen,
    // and the next prompt can repair it.
    if (code) history.push({ prompt, code });
    if (isTerminal(error?.code)) disable(describe(error));
  } finally {
    hud.stopTimer();
    hud.progress(null);
    busy = false;
    control = null;
    document.body.classList.remove('busy');
    stop.hidden = true;
    if (sample) {
      input.disabled = false;
      button.disabled = false;
      input.focus();
    }
    setTimeout(() => {
      codeStream.hidden = true;
    }, 1600);
  }
}

// ---------------------------------------------------------------------- input

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || busy || !sample) return;
  input.value = '';
  hint.textContent = prompt;
  build(prompt);
});

stop.addEventListener('click', () => control?.abort());

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    input.value = IDEAS[ideaIndex++ % IDEAS.length];
    input.select();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
  }
  if (event.key === 'Escape' && busy) control?.abort();
});

input.focus();

// Console escape hatch: these are the same objects generated code receives, so
// anything a prompt can do can also be done by hand from devtools.
Object.assign(window, { world, ui, api, stage, BRIEF });
