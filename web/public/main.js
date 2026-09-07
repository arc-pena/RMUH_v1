// Prompt bar → Claude → live scene.

import { REVISION } from 'three';
import { createWorld } from './world.js';
import { execute } from './executor.js';
import { hud } from './hud.js';
import { ui } from './ui.js';

const form = document.getElementById('bar');
const input = document.getElementById('prompt');
const button = document.getElementById('go');
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
const HISTORY_LIMIT = 12;
let busy = false;

// --------------------------------------------------------------- opening state

world.ground({ size: 240, color: 0x141922, grid: true, gridStep: 6 });
world.focus(null);
hud.setState('idle', 'awaiting a prompt');
hud.log('renderer online · webgl2', 'good');
hud.log(`three.js r${REVISION}`);

fetch('/api/health')
  .then((r) => r.json())
  .then((health) => {
    hud.log(`engine · ${health.model} · effort ${health.effort}`);
    if (!health.credentials) {
      hud.log('no ANTHROPIC_API_KEY — set it and restart the server', 'warn');
    }
  })
  .catch(() => hud.log('server unreachable', 'bad'));

const IDEAS = [
  'a floating island at dusk',
  'a neon city block in the rain',
  'a lighthouse on a black sea',
  'a forest of glass trees',
  'a solar system, to scale-ish',
  'a brutalist plaza with long shadows',
  'a canyon at golden hour',
  'now make everything slowly rotate',
];
let ideaIndex = 0;

// ------------------------------------------------------------------- streaming

async function build(prompt) {
  if (busy) return;
  busy = true;
  input.disabled = true;
  button.disabled = true;

  hud.clearLog();
  hud.setState('thinking', prompt.slice(0, 60));
  hud.progress(0);
  codeBody.textContent = '';

  let code = '';
  let received = 0;

  try {
    const response = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        history: history.slice(-HISTORY_LIMIT),
        scene: stage.summary(),
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `server responded ${response.status}`);
    }

    for await (const { event, data } of readEvents(response.body)) {
      switch (event) {
        case 'status':
          hud.setState(data.phase, data.message);
          break;

        case 'reasoning':
          hud.reasoning.push(data.text);
          break;

        case 'code': {
          hud.reasoning.flush();
          codeStream.hidden = false; // only once there is something to show
          code += data.text;
          received += data.text.length;
          // A build is typically 2–6k characters; the bar is a feel, not a promise.
          hud.progress(Math.min(0.95, received / 5000));
          codeBody.textContent = code.slice(-1400);
          break;
        }

        case 'usage':
          hud.log(
            `${data.output} tok · ${(data.ms / 1000).toFixed(1)}s` +
              (data.cacheRead ? ` · ${data.cacheRead} cached` : ''),
          );
          break;

        case 'warn':
          hud.log(data.message, 'warn');
          break;

        case 'error':
          throw new Error(data.message);

        case 'done':
          code = data.code;
          break;
      }
    }

    hud.reasoning.flush();
    hud.progress(1);
    hud.setState('building', `${code.split('\n').length} lines`);

    const result = await execute(code, { world, ui, api });

    history.push({ prompt, code });
    hud.setState('ready', prompt.slice(0, 60));
    hud.log(`built in ${result.ms.toFixed(0)}ms`, 'good');
  } catch (err) {
    hud.reasoning.flush();
    hud.setState('error', 'build failed');
    hud.log(err.message || String(err), 'bad');
    // The partial scene stays on screen — half a world beats a black screen,
    // and the next prompt can repair it.
    if (code) history.push({ prompt, code });
  } finally {
    hud.progress(null);
    busy = false;
    input.disabled = false;
    button.disabled = false;
    input.focus();
    setTimeout(() => {
      codeStream.hidden = true;
    }, 1400);
  }
}

// Parse an SSE byte stream into {event, data} records.
async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        /* ignore a partial or malformed record */
      }
    }
  }
}

// ---------------------------------------------------------------------- input

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || busy) return;
  input.value = '';
  hint.textContent = prompt;
  build(prompt);
});

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
});

input.focus();

// Console escape hatch: these are the same objects generated code receives, so
// anything a prompt can do can also be done by hand from devtools.
Object.assign(window, { world, ui, api, stage });
