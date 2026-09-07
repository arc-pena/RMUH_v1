// Bundles the artifact into one self-contained HTML file.
//
// three.js is compiled in rather than pulled from a CDN, so the published page
// has no runtime dependency on anything but the Google Fonts stylesheet — and
// no chance of a version or CSP surprise in someone else's browser.
//
//   node artifact/build.mjs   →   artifact/viewport-zero.html

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'viewport-zero.html');

const result = await build({
  entryPoints: [path.join(HERE, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  legalComments: 'none',
  loader: { '.md': 'text' },
  write: false,
});

const bundle = result.outputFiles[0].text;
const template = await fs.readFile(path.join(HERE, 'template.html'), 'utf8');

// A literal </script> anywhere in the bundle would close the tag early.
const html = template.replace('/*BUNDLE*/', () => bundle.replaceAll('</script', '<\\/script'));

await fs.writeFile(OUT, html);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`${path.relative(process.cwd(), OUT)}  ${kb(html.length)}  (bundle ${kb(bundle.length)})`);
