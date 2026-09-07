// Top-left engine readout — the Maya-style vertex counter plus a running log of
// what the engine is doing right now.

const $ = (id) => document.getElementById(id);

const el = {
  state: $('hud-state'),
  title: $('hud-title'),
  log: $('hud-log'),
  progress: $('hud-progress'),
  bar: $('hud-bar'),
  objects: $('s-objects'),
  verts: $('s-verts'),
  tris: $('s-tris'),
  draws: $('s-draws'),
  mem: $('s-mem'),
  fps: $('s-fps'),
};

const MAX_LINES = 14;

const fmt = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
};

export const hud = {
  setState(phase, note) {
    el.state.textContent = phase;
    el.state.className = `state ${phase}`;
    if (note) el.title.textContent = note;
    document.body.classList.toggle(
      'busy',
      phase === 'thinking' || phase === 'writing' || phase === 'building',
    );
  },

  setTitle(text) {
    el.title.textContent = text;
  },

  log(message, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    li.textContent = message;
    el.log.append(li);
    while (el.log.childElementCount > MAX_LINES) el.log.firstElementChild.remove();
    return li;
  },

  // Reasoning arrives as a token stream; fold it into one live line rather than
  // one line per token, and only commit a line once it reads as a sentence.
  reasoning: (() => {
    let line = null;
    let buffer = '';
    return {
      push(text) {
        buffer += text;
        const parts = buffer.split(/(?<=[.!?])\s+/);
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const clean = part.trim();
          if (clean.length > 2) hud.log(clean.slice(0, 150), 'think');
        }
        if (buffer.trim()) {
          if (!line || !line.isConnected) line = hud.log('', 'think');
          line.textContent = buffer.trim().slice(0, 150);
        }
      },
      flush() {
        if (line && line.isConnected && !line.textContent.trim()) line.remove();
        line = null;
        buffer = '';
      },
    };
  })(),

  clearLog() {
    el.log.replaceChildren();
    hud.reasoning.flush();
  },

  progress(fraction) {
    if (fraction === null) {
      el.progress.hidden = true;
      el.bar.style.width = '0';
      return;
    }
    el.progress.hidden = false;
    el.bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  },

  stats({ objects, vertices, triangles, calls, geometries, textures, fps }) {
    el.objects.textContent = fmt(objects);
    el.verts.textContent = fmt(vertices);
    el.tris.textContent = fmt(triangles);
    el.draws.textContent = fmt(calls);
    el.mem.textContent = `${fmt(geometries)} / ${fmt(textures)}`;
    el.fps.textContent = fps ? String(Math.round(fps)) : '—';
  },
};
