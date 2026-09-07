// Compiles and runs the JavaScript Claude wrote, against the live scene.
//
// The generated source becomes the body of an async function with exactly four
// bindings in scope, so it can `await` and can only reach the world through the
// API it was given.

import * as THREE from 'three';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function execute(code, { world, ui, api }) {
  const source = code.trim();
  if (!source) throw new Error('the model returned no code');

  let fn;
  try {
    fn = new AsyncFunction('THREE', 'world', 'ui', 'api', source);
  } catch (err) {
    throw new Error(`syntax error: ${err.message}`);
  }

  const started = performance.now();
  await fn(THREE, world, ui, api);
  return { ms: performance.now() - started, lines: source.split('\n').length };
}
