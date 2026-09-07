// The live stage. Owns the renderer, the render loop, and the small API that
// generated code is allowed to touch.
//
// Two ideas carry the whole thing:
//   1. Everything the engine adds is tracked, so `world.clear()` can undo an
//      entire build without disturbing the camera rig or the lighting rig.
//   2. Added objects arrive *hidden* and are revealed a few per frame, so a
//      thousand-object build visibly assembles instead of popping into place.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const REVEAL_SECONDS = 0.9; // a build of any size finishes assembling in about this long
const REVEAL_MS = 260; // per-object pop-in

// ------------------------------------------------------------------- utilities

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (x, y, seed) => {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
};
const smooth = (t) => t * t * (3 - 2 * t);

export const api = {
  rng: mulberry32,
  lerp: (a, b, t) => a + (b - a) * t,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  range: (n) => Array.from({ length: Math.max(0, n | 0) }, (_, i) => i),
  pick: (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length) % arr.length],
  noise2D(x, y, seed = 0) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smooth(x - xi);
    const v = smooth(y - yi);
    const a = hash2(xi, yi, seed);
    const b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed);
    const d = hash2(xi + 1, yi + 1, seed);
    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    return (top + (bottom - top) * v) * 2 - 1;
  },
};

function skyTexture(top = '#121a26', bottom = '#05070a') {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(0.52, '#0a0f16');
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function disposeDeep(root) {
  root.traverse((node) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) {
        if (value && value.isTexture) value.dispose();
      }
      m.dispose?.();
    }
  });
}

// ----------------------------------------------------------------- the world

export function createWorld({ canvas, onLog, onSceneChange }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const defaultSky = skyTexture();
  scene.background = defaultSky;
  scene.environment = defaultSky;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
  camera.position.set(14, 10, 18);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.6;
  controls.maxDistance = 1200;
  controls.target.set(0, 1, 0);

  const clock = new THREE.Clock();

  // Everything below is engine-owned and survives world.clear().
  const rig = new THREE.Group();
  rig.name = '__rig';
  scene.add(rig);

  const registry = new Map(); // name -> Object3D
  const tracked = new Set(); // every object added through world.add
  const frameCallbacks = new Set();
  const revealQueue = [];
  let revealRate = 0; // objects per second, set from the size of the pending batch
  let revealDebt = 0;
  const tweens = new Set();
  let groundObject = null;
  let statsDirty = true;

  const log = (message, kind) => onLog?.(String(message), kind);
  const touch = () => {
    statsDirty = true;
    onSceneChange?.();
  };

  // ---- lighting rig -------------------------------------------------------

  function setLighting(options = {}) {
    const norm = (v, fallbackColor, fallbackIntensity) => {
      if (v === null || v === false) return null;
      if (v === undefined) return { color: fallbackColor, intensity: fallbackIntensity };
      if (typeof v === 'number') return { color: fallbackColor, intensity: v };
      return { color: v.color ?? fallbackColor, intensity: v.intensity ?? fallbackIntensity };
    };

    for (const child of [...rig.children]) {
      if (child.isLight) {
        child.dispose?.();
        rig.remove(child);
      }
    }

    const hemi = norm(options.hemi, 0x9fb6d4, 0.55);
    if (hemi) rig.add(new THREE.HemisphereLight(hemi.color, 0x2a2118, hemi.intensity));

    const ambient = norm(options.ambient, 0xffffff, 0.22);
    if (ambient) rig.add(new THREE.AmbientLight(ambient.color, ambient.intensity));

    const key = norm(options.key, 0xfff4e0, 2.1);
    if (key) {
      const light = new THREE.DirectionalLight(key.color, key.intensity);
      light.position.set(26, 38, 18);
      light.castShadow = options.shadows !== false;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.near = 1;
      light.shadow.camera.far = 220;
      light.shadow.camera.left = -70;
      light.shadow.camera.right = 70;
      light.shadow.camera.top = 70;
      light.shadow.camera.bottom = -70;
      light.shadow.bias = -0.0006;
      light.shadow.normalBias = 0.02;
      rig.add(light);
    }

    const fill = norm(options.fill, 0x8fb4ff, 0.5);
    if (fill) {
      const light = new THREE.DirectionalLight(fill.color, fill.intensity);
      light.position.set(-22, 14, -20);
      rig.add(light);
    }
  }
  setLighting();

  // ---- reveal + tweens ----------------------------------------------------

  function enqueueReveal(object) {
    // Groups reveal child-by-child; leaves reveal whole.
    const targets = object.isGroup && object.children.length > 1 ? object.children : [object];
    for (const target of targets) {
      if (target.isLight || target.isCamera) continue;
      target.visible = false;
      revealQueue.push({ object: target, scale: target.scale.clone() });
    }
    // Pace off the size of the batch, not off what is left — otherwise the tail
    // of a build reveals one object per frame and takes seconds to finish.
    revealRate = Math.max(revealRate, revealQueue.length / REVEAL_SECONDS);
  }

  function reveal(entry) {
    const { object, scale } = entry;
    object.visible = true;
    const start = performance.now();
    const tween = (now) => {
      const k = Math.min(1, (now - start) / REVEAL_MS);
      // ease-out so each piece lands into place instead of fading in
      const e = 1 - Math.pow(1 - k, 3);
      const s = 0.001 + (1.06 * e - 0.06 * e * e * e) * 0.999;
      object.scale.set(scale.x * s, scale.y * s, scale.z * s);
      if (k >= 1) {
        object.scale.copy(scale);
        return true;
      }
      return false;
    };
    tweens.add(tween);
  }

  function pumpReveal(dt) {
    if (!revealQueue.length) {
      revealRate = 0;
      revealDebt = 0;
      return;
    }
    revealDebt += revealRate * dt;
    const budget = Math.max(1, Math.floor(revealDebt));
    revealDebt -= budget;
    for (let i = 0; i < budget && revealQueue.length; i++) reveal(revealQueue.shift());
    if (!revealQueue.length) {
      revealRate = 0;
      revealDebt = 0;
      touch();
    }
  }

  // ---- camera framing -----------------------------------------------------

  function focus(target, { distance } = {}) {
    const box = new THREE.Box3();
    const objects = target === null || target === undefined ? [...tracked] : resolve(target);
    if (!objects.length) {
      if (!tracked.size) return;
      for (const object of tracked) box.expandByObject(object);
    } else {
      for (const object of objects) box.expandByObject(object);
    }
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.8, box.getBoundingSphere(new THREE.Sphere()).radius);
    const dist = distance ?? (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.95;

    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.75, 1);
    dir.normalize();
    const endPos = center.clone().add(dir.multiplyScalar(dist));

    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const start = performance.now();
    tweens.add((now) => {
      const k = Math.min(1, (now - start) / 900);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(fromPos, endPos, e);
      controls.target.lerpVectors(fromTarget, center, e);
      return k >= 1;
    });
  }

  // ---- lookup -------------------------------------------------------------

  function resolve(query) {
    if (query === null || query === undefined) return [];
    if (query.isObject3D) return tracked.has(query) ? [query] : [query];
    if (typeof query === 'function') return [...tracked].filter((o) => safeTest(query, o));
    if (Array.isArray(query)) return query.flatMap(resolve);
    const needle = String(query).toLowerCase();
    const exact = registry.get(needle);
    if (exact) return [exact];
    return [...tracked].filter(
      (o) =>
        (o.name && o.name.toLowerCase().includes(needle)) ||
        (o.userData?.tag && String(o.userData.tag).toLowerCase() === needle),
    );
  }

  function safeTest(fn, object) {
    try {
      return Boolean(fn(object));
    } catch {
      return false;
    }
  }

  // ---- the API surface handed to generated code ---------------------------

  const world = {
    scene,
    camera,
    renderer,
    controls,
    clock,
    THREE,
    state: {},

    add(object, options = {}) {
      if (!object || !object.isObject3D) {
        throw new TypeError('world.add expects a THREE.Object3D');
      }
      const name = String(options.name || object.name || `object-${tracked.size + 1}`).toLowerCase();
      object.name = name;
      if (options.tag) object.userData.tag = String(options.tag);
      registry.set(name, object);
      tracked.add(object);
      scene.add(object);
      enqueueReveal(object);
      touch();
      return object;
    },

    remove(target) {
      const objects = resolve(target);
      for (const object of objects) {
        object.removeFromParent();
        disposeDeep(object);
        tracked.delete(object);
        if (registry.get(object.name) === object) registry.delete(object.name);
      }
      for (let i = revealQueue.length - 1; i >= 0; i--) {
        if (!revealQueue[i].object.parent) revealQueue.splice(i, 1);
      }
      if (objects.length) touch();
      return objects.length;
    },

    clear() {
      for (const object of tracked) {
        object.removeFromParent();
        disposeDeep(object);
      }
      tracked.clear();
      registry.clear();
      revealQueue.length = 0;
      revealRate = 0;
      revealDebt = 0;
      frameCallbacks.clear();
      world.ground(null);
      world.setFog(null);
      world.setBackground(null);
      setLighting();
      touch();
    },

    get: (name) => registry.get(String(name).toLowerCase()) || resolve(name)[0] || null,
    find: (query) => resolve(query),
    all: () => [...tracked],

    onFrame(fn) {
      if (typeof fn !== 'function') throw new TypeError('world.onFrame expects a function');
      frameCallbacks.add(fn);
      return () => frameCallbacks.delete(fn);
    },

    setBackground(color) {
      if (color === null || color === undefined) {
        scene.background = defaultSky;
        scene.environment = defaultSky;
        return;
      }
      if (color.isTexture) {
        scene.background = color;
        return;
      }
      scene.background = new THREE.Color(color);
    },

    setFog(color, near = 20, far = 220) {
      scene.fog = color === null || color === undefined ? null : new THREE.Fog(color, near, far);
    },

    setLighting,

    ground(options = {}) {
      if (groundObject) {
        groundObject.removeFromParent();
        disposeDeep(groundObject);
        groundObject = null;
        touch();
      }
      if (options === null) return null;

      const size = options.size ?? 400;
      const group = new THREE.Group();
      group.name = '__ground';

      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({
          color: options.color ?? 0x1b2029,
          roughness: options.roughness ?? 0.95,
          metalness: options.metalness ?? 0,
        }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = options.y ?? 0;
      plane.receiveShadow = options.receiveShadow !== false;
      group.add(plane);

      if (options.grid) {
        const grid = new THREE.GridHelper(
          size,
          Math.max(2, Math.round(size / (options.gridStep ?? 4))),
          options.gridColor ?? 0x3a4657,
          options.gridColor ?? 0x252d3a,
        );
        grid.position.y = (options.y ?? 0) + 0.01;
        grid.material.transparent = true;
        grid.material.opacity = options.gridOpacity ?? 0.35;
        group.add(grid);
      }

      rig.add(group);
      groundObject = group;
      touch();
      return group;
    },

    focus,
    log,
    rng: mulberry32,
  };

  // ---- stats --------------------------------------------------------------

  const stats = {
    objects: 0,
    vertices: 0,
    triangles: 0,
    calls: 0,
    geometries: 0,
    textures: 0,
    fps: 0,
  };

  function recountVertices() {
    let vertices = 0;
    let objects = 0;
    for (const root of tracked) {
      root.traverse((node) => {
        if (!node.isMesh && !node.isPoints && !node.isLine) return;
        objects++;
        const position = node.geometry?.attributes?.position;
        if (!position) return;
        vertices += position.count * (node.isInstancedMesh ? node.count : 1);
      });
    }
    stats.objects = objects;
    stats.vertices = vertices;
  }

  // ---- render loop --------------------------------------------------------

  function resize() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let fpsAccum = 0;
  let fpsFrames = 0;
  let statsClock = 0;
  let statsListener = null;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.elapsedTime;
    const now = performance.now();

    for (const tween of [...tweens]) {
      if (tween(now)) tweens.delete(tween);
    }
    pumpReveal(dt);

    for (const fn of [...frameCallbacks]) {
      try {
        fn(dt, elapsed);
      } catch (err) {
        frameCallbacks.delete(fn);
        log(`frame callback removed: ${err.message}`, 'bad');
      }
    }

    controls.update();
    renderer.render(scene, camera);

    fpsAccum += dt;
    fpsFrames++;
    statsClock += dt;
    if (statsClock >= 0.25) {
      if (fpsAccum > 0) stats.fps = fpsFrames / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
      statsClock = 0;
      if (statsDirty) {
        recountVertices();
        statsDirty = false;
      }
      stats.triangles = renderer.info.render.triangles;
      stats.calls = renderer.info.render.calls;
      stats.geometries = renderer.info.memory.geometries;
      stats.textures = renderer.info.memory.textures;
      statsListener?.(stats);
    }
  });

  return {
    world,
    api,
    onStats(fn) {
      statsListener = fn;
    },
    // A build's own description of the scene, sent back to Claude next turn.
    summary() {
      if (!tracked.size) return 'SCENE: empty.';
      const lines = [];
      for (const object of tracked) {
        let meshes = 0;
        object.traverse((n) => {
          if (n.isMesh || n.isPoints || n.isLine) meshes++;
        });
        const tag = object.userData?.tag ? ` tag=${object.userData.tag}` : '';
        const kind = object.isInstancedMesh
          ? `InstancedMesh×${object.count}`
          : object.isGroup
            ? `Group(${object.children.length})`
            : object.type;
        const p = object.position;
        lines.push(
          `- ${object.name} · ${kind}${tag} · pos(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` +
            (meshes > 1 ? ` · ${meshes} meshes` : ''),
        );
      }
      const head = `SCENE: ${tracked.size} top-level object(s), ${stats.vertices} vertices${
        frameCallbacks.size ? `, ${frameCallbacks.size} animation callback(s)` : ''
      }${groundObject ? ', ground plane present' : ''}${scene.fog ? ', fog on' : ''}.`;
      // Keep the digest bounded — a 4000-object city must not swamp the prompt.
      const shown = lines.slice(0, 60);
      if (lines.length > shown.length) shown.push(`- … ${lines.length - shown.length} more`);
      return [head, ...shown].join('\n');
    },
  };
}
