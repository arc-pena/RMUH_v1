// The opening scene.
//
// The page must show what it does in its first frame, so it boots with a world
// already standing rather than an empty grid. This is authored locally — it
// costs no sampling — and it is written against exactly the API the model gets,
// so it doubles as the reference implementation of house style.

import * as THREE from 'three';

export function seed(world, api) {
  world.setBackground('#0a0e14');
  world.setFog('#0a0e14', 34, 190);
  world.setLighting({
    key: { color: '#ffd7a8', intensity: 2.4 },
    fill: { color: '#5d8ac9', intensity: 0.55 },
    hemi: { color: '#8ea6c6', intensity: 0.5 },
    ambient: 0.16,
  });
  world.ground({ size: 300, color: '#151a22', roughness: 0.96 });

  const rnd = api.rng(20260907);
  const stone = new THREE.MeshStandardMaterial({ color: '#8b94a4', roughness: 0.82, metalness: 0.04 });
  const dark = new THREE.MeshStandardMaterial({ color: '#4a5464', roughness: 0.9 });

  // A ring of monoliths, each a different slab, tilted off true.
  const ring = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + rnd() * 0.12;
    const radius = 15 + rnd() * 3.5;
    const height = 5 + rnd() * 11;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.1 + rnd() * 1.4, height, 1.1 + rnd() * 0.7), i % 5 === 0 ? dark : stone);
    slab.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
    slab.rotation.set((rnd() - 0.5) * 0.08, angle + (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.07);
    slab.castShadow = true;
    slab.receiveShadow = true;
    ring.add(slab);
  }
  world.add(ring, { name: 'monoliths', tag: 'stone' });

  // The thing they are standing around.
  const core = world.add(
    new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.4, 2),
      new THREE.MeshStandardMaterial({
        color: '#5be9c0',
        emissive: '#2fbf9a',
        emissiveIntensity: 1.5,
        roughness: 0.35,
        metalness: 0.1,
        flatShading: true,
      }),
    ),
    { name: 'core' },
  );
  core.position.y = 4.2;
  core.castShadow = true;

  const glow = new THREE.PointLight('#5be9c0', 55, 60, 2);
  glow.position.set(0, 4.2, 0);
  world.add(glow, { name: 'core-light' });

  // Motes — one draw call for fourteen hundred of them.
  const motes = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.16),
    new THREE.MeshBasicMaterial({ color: '#8fd9c4' }),
    1400,
  );
  const seat = new THREE.Matrix4();
  const drift = [];
  for (let i = 0; i < 1400; i++) {
    const angle = rnd() * Math.PI * 2;
    const radius = 4 + rnd() * 24;
    drift.push({ angle, radius, y: 0.4 + rnd() * 17, speed: 0.02 + rnd() * 0.07 });
    seat.makeTranslation(Math.cos(angle) * radius, drift[i].y, Math.sin(angle) * radius);
    motes.setMatrixAt(i, seat);
  }
  world.add(motes, { name: 'motes', tag: 'atmosphere' });

  const scratch = new THREE.Matrix4();
  world.onFrame((dt, t) => {
    core.rotation.y += dt * 0.28;
    core.rotation.x += dt * 0.11;
    core.position.y = 4.2 + Math.sin(t * 0.9) * 0.4;
    glow.position.y = core.position.y;
    glow.intensity = 46 + Math.sin(t * 2.3) * 12;
    for (let i = 0; i < drift.length; i++) {
      const m = drift[i];
      m.angle += dt * m.speed * 0.35;
      scratch.makeTranslation(
        Math.cos(m.angle) * m.radius,
        m.y + Math.sin(t * m.speed * 6 + i) * 0.5,
        Math.sin(m.angle) * m.radius,
      );
      motes.setMatrixAt(i, scratch);
    }
    motes.instanceMatrix.needsUpdate = true;
  });

  // Frame it low and close, the way you would set up this shot by hand — the
  // default rig sits too high and leaves the ring swimming in empty sky.
  world.camera.position.set(30, 11, 34);
  world.controls.target.set(0, 5, 0);
  world.focus('monoliths', { distance: 44 });
}
