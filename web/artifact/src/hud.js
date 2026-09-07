// The instrument panel, top left. Reads live off the renderer while the scene
// runs, and off the build while one is in flight.

const $ = (id) => document.getElementById(id);

const el = {
  state: $('hud-state'),
  title: $('hud-title'),
  timer: $('hud-timer'),
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

const MAX_LINES = 12;

const fmt = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
};

let tick = null;

export const hud = {
  setState(phase, note) {
    el.state.textContent = phase;
    el.state.className = `state ${phase}`;
    if (note !== undefined) el.title.textContent = note;
    document.body.classList.toggle(
      'busy',
      phase === 'thinking' || phase === 'writing' || phase === 'building',
    );
  },

  setTitle(text) {
    el.title.textContent = text;
  },

  // A build waits 5-60s before the first token, so the panel counts out loud
  // rather than sitting still.
  startTimer() {
    const started = performance.now();
    clearInterval(tick);
    el.timer.hidden = false;
    const paint = () => {
      el.timer.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    };
    paint();
    tick = setInterval(paint, 100);
    return () => {
      clearInterval(tick);
      tick = null;
      return (performance.now() - started) / 1000;
    };
  },

  stopTimer() {
    clearInterval(tick);
    tick = null;
    el.timer.hidden = true;
  },

  log(message, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    li.textContent = message;
    el.log.append(li);
    while (el.log.childElementCount > MAX_LINES) el.log.firstElementChild.remove();
    return li;
  },

  clearLog() {
    el.log.replaceChildren();
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
