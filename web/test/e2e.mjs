// End-to-end smoke test — no API key required.
//
// Boots the real server, loads the real page in Chromium, stubs /api/build with
// a canned SSE stream, and asserts that the world actually assembles: HUD
// counters move, generated DOM lands, the scene digest describes the result for
// the next turn, and a broken build fails without taking the scene with it.
//
//   node test/e2e.mjs
//
// Needs a Chromium: `npx playwright install chromium`, or point
// PLAYWRIGHT_CHROMIUM_PATH at one you already have.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 5199);
const BASE = `http://127.0.0.1:${PORT}`;

// Stands in for what Claude would return: exercises every part of the API.
const GENERATED = `
world.clear();
world.setBackground('#0b0f16');
world.setFog('#0b0f16', 30, 260);
world.setLighting({ key: { color: '#ffd9a0', intensity: 2.6 }, fill: 0.4, hemi: 0.6 });
world.ground({ size: 300, color: '#1a2029' });

const rnd = api.rng(7);
const geo = new THREE.BoxGeometry(1, 1, 1);
const mat = new THREE.MeshStandardMaterial({ color: '#8fa9c8', roughness: 0.7 });
const city = new THREE.Group();
for (let i = 0; i < 60; i++) {
  const h = 2 + rnd() * 14;
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(1.6 + rnd(), h, 1.6 + rnd());
  m.position.set((rnd() - 0.5) * 90, h / 2, (rnd() - 0.5) * 90);
  m.castShadow = true;
  m.receiveShadow = true;
  city.add(m);
}
world.add(city, { name: 'city', tag: 'buildings' });

const beacon = world.add(
  new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 24, 16),
    new THREE.MeshStandardMaterial({ color: '#6ee7c8', emissive: '#6ee7c8', emissiveIntensity: 2 }),
  ),
  { name: 'beacon' },
);
beacon.position.set(0, 22, 0);

const trees = new THREE.InstancedMesh(
  new THREE.ConeGeometry(0.8, 3, 8),
  new THREE.MeshStandardMaterial({ color: '#2f6b44' }),
  400,
);
const m4 = new THREE.Matrix4();
for (let i = 0; i < 400; i++) {
  m4.makeTranslation((rnd() - 0.5) * 220, 1.5, (rnd() - 0.5) * 220);
  trees.setMatrixAt(i, m4);
}
world.add(trees, { name: 'trees', tag: 'nature' });

const axis = new THREE.Vector3(0, 1, 0);
world.onFrame((dt, t) => {
  beacon.position.y = 22 + Math.sin(t * 2) * 1.5;
  city.rotateOnAxis(axis, dt * 0.05);
});

ui.setTitle('test city');
ui.overlay('legend', '<b>test city</b><br>60 towers · 400 trees', {
  bottom: '110px', left: '24px', top: 'auto', right: 'auto',
});
world.focus('city');
world.log('60 towers · 400 instanced trees');
`;

const RECOLOUR = "const b = world.get('beacon'); if (b) b.material.color.set('#ff5c8a');";

const sse = (events) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

const stub = (events) => async (route) => {
  await route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: sse(events),
  });
};

const problems = [];
const ok = (label) => console.log(`  ok    ${label}`);
const fail = (label, detail) => {
  problems.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
};
const check = (cond, label, detail) => (cond ? ok(label) : fail(label, detail));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up on ${BASE}`);
}

const untilState = (page, want, timeout = 20000) =>
  page
    .waitForFunction(
      (state) => document.getElementById('hud-state').textContent === state,
      want,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);

const server = spawn('node', ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let browser;
try {
  const health = await waitForServer();
  check(health.ok && health.model, 'server boots and reports health', JSON.stringify(health));

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ---- boot ---------------------------------------------------------------

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const bootLog = await page.$$eval('#hud-log li', (n) => n.map((x) => x.textContent));
  check(
    bootLog.some((l) => /three\.js r\d+/.test(l)),
    'three.js boots and reports its revision',
    bootLog.join(' | '),
  );
  check(
    await page.evaluate(() => {
      const c = document.getElementById('stage');
      return c.width > 0 && c.height > 0;
    }),
    'canvas is sized to the viewport',
    'zero dimensions',
  );

  // ---- a build ------------------------------------------------------------

  let firstDigest = '';
  await page.route('**/api/build', async (route) => {
    firstDigest = JSON.parse(route.request().postData() || '{}').scene || '';
    await stub([
      ['status', { phase: 'thinking', message: 'claude-opus-5 · effort medium' }],
      ['reasoning', { text: 'Planning a dense skyline. ' }],
      ['reasoning', { text: 'Instancing the trees so it holds 60fps. ' }],
      ['status', { phase: 'writing', message: 'generating scene code' }],
      ['code', { text: GENERATED.slice(0, 400) }],
      ['code', { text: GENERATED.slice(400) }],
      ['usage', { model: 'claude-opus-5', input: 2100, output: 900, cacheRead: 1800, ms: 6400 }],
      ['done', { code: GENERATED }],
    ])(route);
  });

  await page.fill('#prompt', 'a small city at dusk');
  await page.press('#prompt', 'Enter');
  check(await untilState(page, 'ready'), 'build reaches "ready"', await page.textContent('#hud-state'));
  check(/SCENE:/.test(firstDigest), 'a scene digest is sent with the prompt', firstDigest.slice(0, 80));

  const log = await page.$$eval('#hud-log li', (n) =>
    n.map((x) => `${x.className}|${x.textContent}`),
  );
  check(log.some((l) => l.startsWith('think|')), 'reasoning summary reaches the HUD', log.join(' / '));
  check(log.some((l) => /60 towers/.test(l)), 'world.log() reaches the HUD', log.join(' / '));

  // the reveal queue paces itself over ~1s; give it room on a software renderer
  await page.waitForTimeout(3000);

  const stats = await page.evaluate(() =>
    Object.fromEntries(
      ['s-objects', 's-verts', 's-tris', 's-draws', 's-fps'].map((id) => [
        id,
        document.getElementById(id).textContent,
      ]),
    ),
  );
  console.log(`        stats ${JSON.stringify(stats)}`);
  check(stats['s-verts'] !== '0', 'vertex counter is live', JSON.stringify(stats));
  check(stats['s-tris'] !== '0', 'triangle counter is live', JSON.stringify(stats));
  check(stats['s-fps'] !== '—', 'fps counter is live', stats['s-fps']);

  const revealed = await page.evaluate(() => {
    const city = window.world.get('city');
    const trees = window.world.get('trees');
    return { hidden: city ? city.children.filter((c) => !c.visible).length : -1, trees: trees?.visible };
  });
  check(revealed.hidden === 0 && revealed.trees, 'every object finishes revealing', JSON.stringify(revealed));

  check(
    Boolean(await page.$('#overlays [data-overlay="legend"]')),
    'generated DOM overlay is in the document',
    'not found',
  );
  check(/test city/.test(await page.title()), 'ui.setTitle rewrote document.title', await page.title());

  // ---- a follow-up prompt sees the scene it is continuing -----------------

  let secondDigest = '';
  await page.unroute('**/api/build');
  await page.route('**/api/build', async (route) => {
    secondDigest = JSON.parse(route.request().postData() || '{}').scene || '';
    await stub([
      ['status', { phase: 'writing', message: 'generating scene code' }],
      ['code', { text: RECOLOUR }],
      ['done', { code: RECOLOUR }],
    ])(route);
  });

  await page.fill('#prompt', 'make the beacon pink');
  await page.press('#prompt', 'Enter');
  check(await untilState(page, 'ready', 15000), 'follow-up build reaches "ready"', 'timed out');
  console.log(secondDigest.split('\n').map((l) => `        ${l}`).join('\n'));
  check(
    /beacon/.test(secondDigest) && /trees · InstancedMesh×400/.test(secondDigest),
    'scene digest names the live objects for the next turn',
    secondDigest.slice(0, 160),
  );
  check(
    await page.evaluate(() => window.world.get('beacon')?.material.color.getHexString()) === 'ff5c8a',
    'a follow-up prompt mutates the existing object',
    'colour unchanged',
  );

  // ---- a broken build ----------------------------------------------------

  await page.unroute('**/api/build');
  await page.route('**/api/build', stub([
    ['status', { phase: 'writing', message: 'generating scene code' }],
    ['done', { code: 'world.add(nope.missing);' }],
  ]));

  await page.fill('#prompt', 'break it');
  await page.press('#prompt', 'Enter');
  check(await untilState(page, 'error', 15000), 'a broken build surfaces as an error', 'no error state');
  check(
    (await page.textContent('#s-verts')) !== '0',
    'the scene survives a failed build',
    'scene was lost',
  );
  check(await page.isEnabled('#prompt'), 'prompt bar re-enables after a failure', 'still disabled');

  check(consoleErrors.length === 0, 'no console errors', JSON.stringify(consoleErrors.slice(0, 4)));
} catch (err) {
  fail('harness', err.message);
} finally {
  await browser?.close();
  server.kill();
}

console.log(
  problems.length
    ? `\n${problems.length} problem(s):\n${problems.map((p) => ` - ${p}`).join('\n')}`
    : '\nall checks passed',
);
process.exit(problems.length ? 1 : 0);
