# Working on this repository

## Publishing — both places, every time

A change to the modeller is not delivered until it is in **both** places. One
build command makes both; publishing is two steps after it.

```sh
python3 docs/build.py          # writes docs/parametric-cad.html AND the site in docs/
```

1. **The Artifact** — `docs/parametric-cad.html`, published with the Artifact
   tool to the existing URL so the link never changes:
   `https://claude.ai/code/artifact/2bf933ac-1530-4343-80bc-b533de0c2b7b`
   Pass that URL as `url`; publishing without it makes a second artifact.
2. **GitHub Pages** — `docs/index.html` with `docs/app/`, `docs/kernel/` and
   `docs/data/`. Pages serves what is committed, from this branch with the
   folder set to `/docs`, so **commit and push** is what publishes it:
   `https://arc-pena.github.io/RMUH_v1/`

Never publish one without the other. The Artifact is the private working copy;
Pages is what anybody else can open.

## What the two builds are

Same source, two shapes, because they are allowed different things.

| | |
|---|---|
| `docs/parametric-cad.html` | ONE file. An Artifact may not fetch at run time, so the 22 MB kernel, the showroom engine and every package's data travel inside the page, gzipped and base64'd. |
| `docs/index.html` + `app/` + `kernel/` | Files. A web server may be fetched from, so those three are served as files and the source modules go across as they are, imported natively. |

`src/payload.js` is what lets one source tree do both: every big piece is asked
for by name, unpacked from a payload element when the page carries one and
fetched from beside the page when it does not.

**Every module must stand on its own imports.** In the single file they share
one scope, so a missing import goes unnoticed; served as modules it is a
`ReferenceError` before the first frame. That has happened once already.

## Before publishing

```sh
node --test docs/test/*.test.mjs        # all suites, against a real kernel
```

And drive the built page in a browser rather than trusting it. Screenshots are
authoritative; a `readPixels` after present reads a cleared buffer and proves
nothing.
