// The showroom.
//
// The modelling view answers "is this right?" and shows tangent edges, datums
// and a grid to help you decide. The showroom answers "how does it look?" and
// shows none of that: a lit stage, real materials, and the part.
//
// It is a second renderer - PlayCanvas - over the same triangles the kernel
// already sent. Nothing is re-meshed on the way in; the buffers are handed
// straight over. The engine is unpacked the first time the door is opened, so a
// session that never goes in never pays for it.
//
// Everything it needs is generated here. A published page may not fetch at
// runtime, so the environment is not an HDR file but six canvas faces run
// through PlayCanvas's own prefilter - which is all an image-based light is.

export const FINISHES = [
  { key: "steel",   label: "Brushed steel", color: [0.62, 0.65, 0.68], metalness: 1,    gloss: 0.62 },
  { key: "chrome",  label: "Chrome",        color: [0.88, 0.90, 0.93], metalness: 1,    gloss: 0.96 },
  { key: "brass",   label: "Brass",         color: [0.83, 0.66, 0.31], metalness: 1,    gloss: 0.80 },
  { key: "anodised",label: "Anodised black",color: [0.09, 0.10, 0.11], metalness: 0.85, gloss: 0.45 },
  { key: "paint",   label: "Gloss paint",   color: [0.16, 0.42, 0.66], metalness: 0.05, gloss: 0.92 },
  { key: "matte",   label: "Matte white",   color: [0.90, 0.90, 0.89], metalness: 0.02, gloss: 0.22 },
  { key: "oak",     label: "Oak",           color: [0.71, 0.53, 0.31], metalness: 0,    gloss: 0.35 },
  { key: "concrete",label: "Concrete",      color: [0.60, 0.59, 0.56], metalness: 0,    gloss: 0.12 },
];

// An environment is what a metal has to reflect, so these carry real light: a
// bright upper hemisphere, a darker floor, and light cards overhead for the
// highlight that reads as a lit stage.
export const ENVIRONMENTS = [
  // A black stage: no visible backdrop, hard light cards grazing the form, and
  // the floor reading only as a reflection. What the light does IS the picture,
  // so the environment is mostly black with a few bright strips in it.
  { key: "noir", label: "Noir", exposure: 1.15, sky: 0, backdrop: [0.016, 0.018, 0.021],
    faces: ["#000000", "#05060a", "#000000"], ground: [0.02, 0.02, 0.025],
    cards: 3, hard: true, reflect: 0.42, floor: false },
  { key: "studio", label: "Studio", exposure: 1.25, sky: 1.6, backdrop: [0.72, 0.75, 0.78],
    faces: ["#ffffff", "#e3eaf1", "#7d8a96"], ground: [0.50, 0.52, 0.54], cards: 2,
    reflect: 0.12, floor: true },
  { key: "warm",   label: "Warm",   exposure: 1.30, sky: 1.5, backdrop: [0.55, 0.45, 0.38],
    faces: ["#fff4e4", "#f0c69a", "#59433a"], ground: [0.44, 0.37, 0.31], cards: 1,
    reflect: 0.14, floor: true },
  { key: "dusk",   label: "Dusk",   exposure: 1.45, sky: 1.1, backdrop: [0.08, 0.08, 0.11],
    faces: ["#8e9ec4", "#6a5f7e", "#1a1620"], ground: [0.17, 0.17, 0.22], cards: 1,
    reflect: 0.30, floor: false },
];

export const findFinish = key => FINISHES.find(f => f.key === key) || FINISHES[0];
const findEnvironment = key => ENVIRONMENTS.find(e => e.key === key) || ENVIRONMENTS[0];

//! Runs the engine source in global scope. A published page may not fetch it,
//! so it travels inside the document, gzipped, and is unpacked on first use.
async function loadEngine(payloadId) {
  if (window.pc) return window.pc;

  const element = document.getElementById(payloadId);
  if (!element) throw new Error("this page is missing its showroom engine");
  const packed = atob(element.textContent.trim());
  const bytes = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) bytes[i] = packed.charCodeAt(i);

  if (typeof DecompressionStream !== "function")
    throw new Error("this browser cannot unpack the showroom engine");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const source = await new Response(stream).text();

  const script = document.createElement("script");
  script.textContent = source;
  document.head.appendChild(script);
  if (!window.pc) throw new Error("the showroom engine did not start");
  return window.pc;
}

export class Showroom {
  constructor({ canvas, payloadId }) {
    this.canvas = canvas;
    this.payloadId = payloadId;
    this.app = null;
    this.pc = null;
    this.parts = new Map();          // feature id -> { entity, material, aabb }
    this.environment = "noir";
    this.exposure = 1;
    this.turntable = false;
    this.selected = null;
    this.reflection = 0.42;
    this.onPick = () => {};
    this.orbit = { yaw: -35, pitch: 22, distance: 900, target: [0, 0, 0] };
  }

  get ready() { return !!this.app; }

  async start() {
    if (this.app) return;
    const pc = this.pc = await loadEngine(this.payloadId);

    const device = await pc.createGraphicsDevice(this.canvas, {
      deviceTypes: ["webgl2", "webgl1"], antialias: true, alpha: false,
    });
    const app = this.app = new pc.AppBase(this.canvas);
    const options = new pc.AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem,
                                pc.LightComponentSystem];
    options.resourceHandlers = [];
    app.init(options);
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.toneMapping = pc.TONEMAP_ACES;

    this.camera = new pc.Entity("camera");
    this.camera.addComponent("camera", {
      fov: 32, nearClip: 1, farClip: 100000,
      clearColor: new pc.Color(0.05, 0.06, 0.07),
    });
    app.root.addChild(this.camera);

    // A key light for the crisp highlight an environment alone cannot give.
    this.key = new pc.Entity("key");
    this.key.addComponent("light", {
      type: "directional", intensity: 1.6, castShadows: true,
      shadowBias: 0.15, normalOffsetBias: 0.06, shadowDistance: 6000,
      shadowResolution: 2048, shadowType: pc.SHADOW_PCF3,
    });
    this.key.setEulerAngles(52, 38, 0);
    app.root.addChild(this.key);

    // A cool fill from the other side, so the shadow side is modelled rather
    // than black.
    this.fill = new pc.Entity("fill");
    this.fill.addComponent("light", {
      type: "directional", intensity: 0.45, castShadows: false,
      color: new pc.Color(0.82, 0.88, 1),
    });
    this.fill.setEulerAngles(24, -128, 0);
    app.root.addChild(this.fill);

    // OpenCascade is Z-up and PlayCanvas is Y-up, so every part hangs under one
    // entity that carries the change of frame. The triangles themselves are
    // never touched.
    this.model = new pc.Entity("model");
    this.model.setEulerAngles(-90, 0, 0);
    app.root.addChild(this.model);

    // A reflection, done the way product shots have always done it: the part
    // again, mirrored in the floor plane and held back to a fraction of its
    // brightness. Cheaper than a render target and, over black, indistinguishable.
    this.mirror = new pc.Entity("mirror");
    this.mirror.setLocalScale(1, 1, -1);
    this.model.addChild(this.mirror);

    this.buildGround();
    this.applyEnvironment(this.environment);
    app.start();
    this.bindPointer();
  }

  /* ------------------------------------------------------------ the stage */

  buildGround() {
    const pc = this.pc;
    const size = 100000;
    const mesh = new pc.Mesh(this.app.graphicsDevice);
    mesh.setPositions([-size, 0, -size, size, 0, -size, -size, 0, size, size, 0, size]);
    mesh.setNormals([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    mesh.setIndices([0, 2, 1, 1, 2, 3]);
    mesh.update(pc.PRIMITIVE_TRIANGLES);

    this.groundMaterial = new pc.StandardMaterial();
    this.groundMaterial.useMetalness = true;
    this.groundMaterial.metalness = 0;
    this.groundMaterial.gloss = 0.35;
    this.groundMaterial.update();

    this.ground = new pc.Entity("ground");
    this.ground.addComponent("render", {
      meshInstances: [new pc.MeshInstance(mesh, this.groundMaterial)],
      castShadows: false, receiveShadows: true,
    });
    this.app.root.addChild(this.ground);
  }

  //! Six canvas faces, prefiltered by PlayCanvas into a lighting atlas. That is
  //! what an HDR environment is; this one is simply drawn rather than loaded.
  applyEnvironment(key) {
    const pc = this.pc;
    const preset = findEnvironment(key);
    this.environment = preset.key;

    const size = 256;
    const faces = [];
    for (let face = 0; face < 6; face++) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");

      if (face === 2) {                          // up: the light cards overhead
        ctx.fillStyle = preset.faces[0];
        ctx.fillRect(0, 0, size, size);
        for (let i = 0; i < preset.cards; i++) {
          const x = size * (0.5 + (i - (preset.cards - 1) / 2) * 0.3);
          if (preset.hard) {
            // Narrow, hard-edged strips: the streak highlights that read as
            // an edge catching the light.
            const w = size * 0.07;
            const glow = ctx.createLinearGradient(x - w, 0, x + w, 0);
            glow.addColorStop(0, "rgba(255,255,255,0)");
            glow.addColorStop(0.5, "rgba(255,255,255,1)");
            glow.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = glow;
            ctx.fillRect(x - w, size * 0.04, w * 2, size * 0.92);
          } else {
            const glow = ctx.createRadialGradient(x, size * 0.5, 4, x, size * 0.5, size * 0.34);
            glow.addColorStop(0, "rgba(255,255,255,1)");
            glow.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = glow;
            ctx.fillRect(x - size * 0.17, size * 0.12, size * 0.34, size * 0.76);
          }
        }
      } else if (face === 3) {                   // down: the floor bounce
        const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size * 0.7);
        g.addColorStop(0, preset.faces[1]);
        g.addColorStop(1, preset.faces[2]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      } else {                                   // the walls: horizon gradient
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, preset.faces[0]);
        g.addColorStop(0.42, preset.faces[1]);
        g.addColorStop(1, preset.faces[2]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        if (preset.hard) {
          // A grazing band just above the horizon, for the long highlight down
          // the side of a form.
          const band = ctx.createLinearGradient(0, size * 0.2, 0, size * 0.46);
          band.addColorStop(0, "rgba(255,255,255,0)");
          band.addColorStop(0.5, "rgba(255,255,255,0.85)");
          band.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = band;
          ctx.fillRect(0, size * 0.2, size, size * 0.26);
        }
      }
      faces.push(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer));
    }

    const cubemap = new pc.Texture(this.app.graphicsDevice, {
      cubemap: true, width: size, height: size,
      format: pc.PIXELFORMAT_RGBA8, mipmaps: true, levels: [faces],
    });
    cubemap.upload();

    if (this.envAtlas) this.envAtlas.destroy();
    const source = pc.EnvLighting.generateLightingSource(cubemap);
    this.envAtlas = pc.EnvLighting.generateAtlas(source);
    source.destroy();

    this.app.scene.envAtlas = this.envAtlas;
    // With no skybox the camera's own clear colour is the backdrop, which is
    // how a black stage stays black while the lighting stays bright.
    this.app.scene.skybox = preset.sky > 0 ? cubemap : null;
    this.app.scene.skyboxMip = 2;                 // a blurred backdrop, not a photo
    this.app.scene.skyboxIntensity = preset.sky || 1;
    this.app.scene.exposure = this.exposure * preset.exposure;
    this.camera.camera.clearColor = new pc.Color(...preset.backdrop);

    this.groundMaterial.diffuse = new pc.Color(...preset.ground);
    this.groundMaterial.gloss = preset.hard ? 0.9 : 0.35;
    this.groundMaterial.update();
    this.presetExposure = preset.exposure;
    this.setGroundVisible(preset.floor !== false);
    this.setReflection(preset.reflect === undefined ? 0.2 : preset.reflect);
    this.key.light.intensity = preset.hard ? 2.2 : 1.6;
    this.fill.light.intensity = preset.hard ? 0.18 : 0.45;
  }

  setExposure(value) {
    this.exposure = value;
    if (this.app) this.app.scene.exposure = value * (this.presetExposure || 1);
  }

  setGroundVisible(visible) { if (this.ground) this.ground.enabled = visible; }

  /* ------------------------------------------------------------ the parts */

  //! Takes the triangles the kernel already streamed. Datums are modelling aids
  //! and have no place on a stage, so only solids come through.
  setScene(features, meshes) {
    const pc = this.pc;
    for (const [, part] of this.parts) part.entity.destroy();
    this.parts.clear();

    const bounds = new pc.BoundingBox();
    const instances = [];
    let first = true;

    for (const entry of features) {
      if (!entry.visible || entry.category === "datum") continue;
      const mesh = meshes.get(entry.id);
      if (!mesh || !mesh.positions || !mesh.index) continue;

      const geometry = new pc.Mesh(this.app.graphicsDevice);
      geometry.setPositions(mesh.positions);
      if (mesh.normals) geometry.setNormals(mesh.normals);
      geometry.setIndices(mesh.index);
      geometry.update(pc.PRIMITIVE_TRIANGLES);

      const material = new pc.StandardMaterial();
      const entity = new pc.Entity(entry.name);
      const instance = new pc.MeshInstance(geometry, material);
      entity.addComponent("render", {
        meshInstances: [instance], castShadows: true, receiveShadows: true,
      });
      this.model.addChild(entity);

      const mirrorMaterial = new pc.StandardMaterial();
      // Mirroring flips the winding, so the back faces are the ones facing out.
      mirrorMaterial.cull = pc.CULLFACE_FRONT;
      mirrorMaterial.blendType = pc.BLEND_NORMAL;
      mirrorMaterial.depthWrite = false;
      const reflected = new pc.Entity(entry.name + " (reflected)");
      reflected.addComponent("render", {
        meshInstances: [new pc.MeshInstance(geometry, mirrorMaterial)],
        castShadows: false, receiveShadows: false,
      });
      this.mirror.addChild(reflected);

      this.parts.set(entry.id, { entity, material, instance, name: entry.name,
                                 reflected, mirrorMaterial });
      this.paint(entry.id, entry.appearance);

      instances.push(instance);
    }

    // World-space bounds only mean anything once the frame change is applied.
    this.app.root.syncHierarchy();
    for (const instance of instances) {
      if (first) { bounds.copy(instance.aabb); first = false; }
      else bounds.add(instance.aabb);
    }

    if (!first) {
      // Stand the part on the floor rather than through it, and put the mirror
      // plane there too: reflecting about z = min gives z' = 2*min - z.
      const min = bounds.getMin();
      this.ground.setPosition(0, min.y, 0);
      this.mirror.setLocalPosition(0, 0, 2 * min.y);
      const size = bounds.halfExtents.length() * 2;
      const centre = bounds.center;
      this.orbit.target = [centre.x, centre.y, centre.z];
      this.orbit.distance = Math.max(300, size * 1.7);
      this.key.setPosition(centre.x, centre.y + size, centre.z);
    }
    this.bounds = first ? null : bounds;
    this.place();
  }

  paint(id, appearance) {
    const part = this.parts.get(id);
    if (!part) return;
    const pc = this.pc;
    const finish = findFinish(appearance && appearance.finish);
    const rgb = (appearance && appearance.color) || finish.color;

    part.material.useMetalness = true;
    part.material.diffuse = new pc.Color(rgb[0], rgb[1], rgb[2]);
    part.material.metalness = finish.metalness;
    part.material.gloss = finish.gloss;
    part.material.update();

    if (part.mirrorMaterial) {
      part.mirrorMaterial.useMetalness = true;
      part.mirrorMaterial.diffuse = new pc.Color(rgb[0], rgb[1], rgb[2]);
      part.mirrorMaterial.metalness = finish.metalness;
      part.mirrorMaterial.gloss = finish.gloss;
      part.mirrorMaterial.opacity = this.reflection;
      part.mirrorMaterial.update();
    }
  }

  setReflection(strength) {
    this.reflection = strength;
    if (this.mirror) this.mirror.enabled = strength > 0.01;
    for (const [, part] of this.parts) {
      if (!part.mirrorMaterial) continue;
      part.mirrorMaterial.opacity = strength;
      part.mirrorMaterial.update();
    }
  }

  /* -------------------------------------------------------------- viewing */

  place() {
    const yaw = this.orbit.yaw * Math.PI / 180;
    const pitch = this.orbit.pitch * Math.PI / 180;
    const [tx, ty, tz] = this.orbit.target;
    const cp = Math.cos(pitch);
    this.camera.setPosition(
      tx + this.orbit.distance * cp * Math.sin(yaw),
      ty + this.orbit.distance * Math.sin(pitch),
      tz + this.orbit.distance * cp * Math.cos(yaw));
    this.camera.lookAt(tx, ty, tz);
  }

  //! Eases the view to a hero framing, so arriving in the showroom is a move
  //! rather than a cut.
  frame(fromOrbit, duration = 900) {
    if (!this.bounds) return;
    const start = { ...this.orbit, target: [...this.orbit.target] };
    if (fromOrbit) Object.assign(start, fromOrbit, { target: [...this.orbit.target] });
    const end = {
      yaw: -35, pitch: 18,
      distance: this.bounds.halfExtents.length() * 2 * 1.75,
      target: [...this.orbit.target],
    };
    const began = performance.now();
    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const tick = () => {
      const t = Math.min(1, (performance.now() - began) / duration);
      const k = ease(t);
      this.orbit.yaw = start.yaw + (end.yaw - start.yaw) * k;
      this.orbit.pitch = start.pitch + (end.pitch - start.pitch) * k;
      this.orbit.distance = start.distance + (end.distance - start.distance) * k;
      this.place();
      if (t < 1) requestAnimationFrame(tick);
    };
    Object.assign(this.orbit, start);
    this.place();
    requestAnimationFrame(tick);
  }

  spin(dt) {
    if (!this.turntable) return;
    this.orbit.yaw += dt * 9;
    this.place();
  }

  resize(width, height) {
    if (!this.app) return;
    this.app.setCanvasFillMode(this.pc.FILLMODE_NONE);
    this.app.resizeCanvas(width, height);
  }

  /* ------------------------------------------------------------- picking */

  bindPointer() {
    const el = this.canvas;
    let mode = null, lastX = 0, lastY = 0, moved = 0;

    el.addEventListener("pointerdown", event => {
      mode = (event.shiftKey || event.button === 1 || event.button === 2) ? "pan" : "orbit";
      lastX = event.clientX; lastY = event.clientY; moved = 0;
      el.setPointerCapture(event.pointerId);
    });
    el.addEventListener("pointermove", event => {
      if (!mode) return;
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      lastX = event.clientX; lastY = event.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (mode === "orbit") {
        this.orbit.yaw -= dx * 0.4;
        this.orbit.pitch = Math.max(-8, Math.min(80, this.orbit.pitch + dy * 0.3));
      } else {
        const scale = this.orbit.distance * 0.0016;
        this.orbit.target[0] -= dx * scale * Math.cos(this.orbit.yaw * Math.PI / 180);
        this.orbit.target[2] += dx * scale * Math.sin(this.orbit.yaw * Math.PI / 180);
        this.orbit.target[1] += dy * scale;
      }
      this.place();
    });
    el.addEventListener("pointerup", event => {
      if (mode === "orbit" && moved < 4) this.pick(event);
      mode = null;
    });
    el.addEventListener("pointercancel", () => { mode = null; });
    el.addEventListener("contextmenu", event => event.preventDefault());
    el.addEventListener("wheel", event => {
      event.preventDefault();
      this.orbit.distance = Math.max(50, Math.min(40000,
        this.orbit.distance * (1 + Math.sign(event.deltaY) * 0.12)));
      this.place();
    }, { passive: false });
  }

  //! Nearest bounding box along the ray under the pointer. Enough to choose a
  //! part to re-finish, and it costs no extra geometry.
  pick(event) {
    const pc = this.pc;
    const rect = this.canvas.getBoundingClientRect();
    const from = this.camera.getPosition();
    const to = this.camera.camera.screenToWorld(
      event.clientX - rect.left, event.clientY - rect.top, this.camera.camera.farClip);
    const ray = new pc.Ray(from, to.clone().sub(from).normalize());

    let closest = null, nearest = Infinity;
    for (const [id, part] of this.parts) {
      const aabb = part.instance.aabb;
      if (!aabb.intersectsRay(ray)) continue;
      const distance = aabb.center.distance(from);
      if (distance < nearest) { nearest = distance; closest = id; }
    }
    this.onPick(closest);
  }

  highlight(id) {
    this.selected = id;
    // A showroom does not draw selection handles; the part simply lifts a
    // little out of the ground plane.
    // Under the Z-up model entity, local +Z is world up.
    for (const [key, part] of this.parts) {
      const position = part.entity.getLocalPosition();
      part.entity.setLocalPosition(position.x, position.y, key === id ? 12 : 0);
    }
  }
}
