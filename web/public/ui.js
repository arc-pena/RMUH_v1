// DOM overlays that generated code can create, so a prompt can change the page
// and not just the scene.

const layer = document.getElementById('overlays');
const nodes = new Map();

// Generated markup is written by the model, not by a third party, but it still
// has no business running script or loading remote resources.
const BANNED = /<\s*(script|iframe|object|embed|link|meta|style|form)\b/gi;
const EVENT_ATTR = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

function sanitize(html) {
  return String(html).replace(BANNED, '&lt;$1').replace(EVENT_ATTR, '');
}

export const ui = {
  overlay(id, html, style = {}) {
    const key = String(id);
    let node = nodes.get(key);
    if (!node) {
      node = document.createElement('div');
      node.dataset.overlay = key;
      nodes.set(key, node);
      layer.append(node);
    }
    node.innerHTML = sanitize(html);
    for (const [property, value] of Object.entries(style || {})) {
      node.style.setProperty(
        property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        String(value),
      );
    }
    return node;
  },

  remove(id) {
    const node = nodes.get(String(id));
    if (!node) return false;
    node.remove();
    nodes.delete(String(id));
    return true;
  },

  clear() {
    for (const node of nodes.values()) node.remove();
    nodes.clear();
  },

  setTitle(text) {
    const title = String(text).slice(0, 80);
    document.title = `${title} · World Builder`;
    document.getElementById('hud-title').textContent = title;
  },
};
