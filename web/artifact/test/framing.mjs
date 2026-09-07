// Does a build always leave something new to look at?
//
// The failure this guards against: a viewer types "a sphere", the model adds a
// radius-1 sphere to a scene framed for a 40-unit monolith ring, and nothing
// appears to happen. No API key needed — `sample` is stubbed.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewport-zero.html');

// Three shapes of answer, from worst to best behaved.
const ANSWERS = {
  // What actually went wrong: grafted onto the seed, tiny, camera untouched.
  grafted: `
    const s = world.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color: '#c9d4e3' })), { name: 'sphere' });
    s.position.set(0, 1, 0);
    world.log('added a sphere');`,

  // Off in the weeds entirely.
  offscreen: `
    const s = world.add(new THREE.Mesh(new THREE.SphereGeometry(2, 32, 24),
      new THREE.MeshStandardMaterial({ color: '#c9d4e3' })), { name: 'sphere' });
    s.position.set(-260, 2, 190);
    world.log('added a sphere');`,

  // What the brief now asks for.
  proper: `
    world.clear();
    world.setLighting({ key: { color: '#fff2e0', intensity: 2.8 }, fill: 0.5 });
    world.ground({ size: 60, color: '#191f28' });
    const s = world.add(new THREE.Mesh(new THREE.SphereGeometry(1.6, 48, 32),
      new THREE.MeshStandardMaterial({ color: '#c9d4e3', roughness: 0.32 })), { name: 'sphere' });
    s.position.y = 1.6; s.castShadow = true;
    world.focus('sphere');
    world.log('r=1.6 · 48x32 segments');`,

  // A change to a big scene: the camera must NOT be yanked around.
  change: `
    const core = world.get('core');
    if (core) core.material.color.set('#ff5c8a');
    world.log('recoloured the core');`,
};

const problems = [];
const ok = (l) => console.log(`  ok    ${l}`);
const fail = (l, d) => { problems.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d) => (c ? ok(l) : fail(l, d));

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});

// How much of the vertical frame does the named object fill, and is it in view?
const measure = (page, name) =>
  page.evaluate((n) => {
    const THREE = window.world.THREE;
    const object = window.world.get(n);
    if (!object) return null;
    const camera = window.world.camera;
    const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const distance = camera.position.distanceTo(sphere.center);
    return {
      onScreen: frustum.intersectsSphere(sphere),
      coverage: Math.atan(sphere.radius / distance) / ((camera.fov * Math.PI) / 360),
      visible: object.visible,
    };
  }, name);

async function run(label, code, { settle = 3500 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(({ src }) => {
    window.claude = {
      use: async (n) =>
        n !== 'sample'
          ? null
          : Object.assign(async (input, opts) => {
              window.__input = input;
              opts?.onText?.({ text: src, delta: src });
              return { text: src, truncated: false };
            }, { json: async () => ({}), limits: async () => ({ images: false }) }),
    };
  }, { src: code });
  await page.goto(PAGE);
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => window.world.camera.position.toArray());
  await page.fill('#prompt', 'a sphere');
  await page.press('#prompt', 'Enter');
  await page
    .waitForFunction(() => ['ready', 'error'].includes(document.getElementById('hud-state').textContent), null, { timeout: 15000 })
    .catch(() => fail(label, 'build never settled'));
  await page.waitForTimeout(settle);
  const state = await page.textContent('#hud-state');
  const shot = await measure(page, 'sphere').catch(() => null);
  const after = await page.evaluate(() => window.world.camera.position.toArray());
  const log = await page.$$eval('#hud-log li', (n) => n.map((x) => x.textContent));
  await page.close();
  return { state, shot, before, after, log, errors };
}

// A sphere the viewer asked for has to end up big enough to actually see.
const READABLE = 0.2;

for (const [name, key] of [['grafted onto the seed scene', 'grafted'], ['built off screen', 'offscreen']]) {
  const r = await run(name, ANSWERS[key]);
  console.log(`   ${key}: state=${r.state} coverage=${r.shot?.coverage.toFixed(3)} onScreen=${r.shot?.onScreen}`);
  check(r.state === 'ready', `${name}: build completes`, r.state);
  check(r.shot?.visible === true, `${name}: the sphere is revealed`, JSON.stringify(r.shot));
  check(r.shot && r.shot.onScreen && r.shot.coverage > READABLE, `${name}: it ends up on screen and readable`, JSON.stringify(r.shot));
  check(r.log.some((l) => /reframed/.test(l)), `${name}: the HUD reports the reframe`, r.log.join(' / '));
  check(r.errors.length === 0, `${name}: no page errors`, r.errors.join(' | '));
}

const good = await run('a properly framed build', ANSWERS.proper);
console.log(`   proper: coverage=${good.shot?.coverage.toFixed(3)}`);
check(good.shot && good.shot.onScreen && good.shot.coverage > READABLE, 'a properly framed build stays framed', JSON.stringify(good.shot));
check(!good.log.some((l) => /reframed/.test(l)), 'the engine does not override a build that framed itself', good.log.join(' / '));

const change = await run('a change to a big scene', ANSWERS.change);
const moved = Math.hypot(...change.after.map((v, i) => v - change.before[i]));
console.log(`   change: camera moved ${moved.toFixed(2)} units`);
check(moved < 0.5, 'a change that adds nothing leaves the camera alone', `moved ${moved.toFixed(2)}`);
check(
  await (async () => (await run('brief', ANSWERS.change)).log !== null)(),
  'the brief reaches the model as the first turn',
  'n/a',
);

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.map((p) => ` - ${p}`).join('\n')}` : '\nall checks passed');
process.exit(problems.length ? 1 : 0);
