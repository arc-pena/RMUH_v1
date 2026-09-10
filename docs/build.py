#!/usr/bin/env python3
"""Build the page, both ways.

    docs/parametric-cad.html   ONE file, for publishing as an Artifact
    docs/index.html + app/     a folder of files, for serving from GitHub Pages

They exist for opposite reasons. An Artifact may load scripts from a handful of
CDNs but may not fetch anything at run time, and OpenCascade's WebAssembly
module is a runtime fetch - so for that build the kernel travels inside the
page, gzipped and base64'd, 22 MB of wasm becoming about 9 MB of text.

A web server has no such rule, and fetching is what a browser is good at. So
the site build leaves the kernel, the showroom engine and the package data as
files beside the page: streamed, compiled while they arrive, and cached by the
browser between visits instead of re-parsed out of the HTML on every load. The
source modules go across as they are, imported natively - nothing is
concatenated, so what is served is what is in src/.

One switch decides which, at run time, per resource: a payload element is in
the page or it is not. Nothing in src/ knows which build it is in.

    python3 docs/build.py [--wasm-dir DIR] [--only artifact|site]
"""
import argparse
import base64
import gzip
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "parametric-cad.html"

# The served site lives in docs/ - this folder - because that is one of the two
# places GitHub Pages will serve from when it serves straight from a branch, and
# the other is the repository root. So the page, the modules and the kernel sit
# beside the source they are built from.
#
# Only these are generated, and only these are wiped and rewritten. Everything
# else in docs/ is source and is never touched.
SITE = ROOT
SITE_INDEX = "index.html"
SITE_MODULES = "app"
SITE_BINARIES = "kernel"

# OpenCascade for the browser: a trimmed OCCT build, 22 MB of WebAssembly.
KERNEL_PACKAGE = "replicad-opencascadejs"

# The showroom renderer. Packed the same way and unpacked only when someone
# opens the showroom, so a session that never does never pays for it.
STAGE_PACKAGE = "playcanvas"
STAGE_FILE = "build/playcanvas.min.js"

# Concatenated in this order into one module script for the single-file build.
# The site build copies the same files and lets the browser resolve the imports,
# so this order is only the order they are stapled together in.
MODULES = ["payload.js", "sketch.js", "factory.js", "exchange.js", "ocaf.js", "wasm-kernel.js",
           "http-kernel.js", "mdl.js", "graph.js",
           "agent.js", "showroom.js", "plugin.js", "climate.js", "climate-plugin.js",
           "crowd.js", "crowd-plugin.js", "app.js"]

# The one module the page loads; everything else is reached through its imports.
ENTRY = "app.js"

# The emscripten glue, copied beside the modules under this name. It is already
# a module - it ends in `export default Module` - so the site build needs to do
# nothing to it but put it where app.js says it is.
GLUE_MODULE = "occt-glue.js"

# A package's data rides the way the kernel and the showroom engine do: gzipped,
# base64'd, in a script element the HTML tokenizer scans straight past. Unpacked
# only when the package is loaded, so a session that never opens it never pays.
DATA = ROOT / "data"
PAYLOADS = [("climate-sites", "cities.json")]

# An import may wrap across lines; nothing but the statement itself may
# contain a semicolon before its end.
IMPORT = re.compile(r"^\s*import\s[^;]*;\s*$", re.M)
EXPORT = re.compile(r"^export\s+(?=(?:const|let|var|class|function|async)\b)", re.M)
DECLARE = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)", re.M)


def strip_modules(text):
    """Turn an ES module into plain statements for a shared scope."""
    return EXPORT.sub("", IMPORT.sub("", text))


def fetch_npm(package, cache_name, member_prefix, marker):
    """Pulls one package from npm and unpacks the files we need. Cached."""
    cache = ROOT / cache_name
    if (cache / marker).exists():
        return cache / pathlib.PurePosixPath(member_prefix).parent

    cache.mkdir(exist_ok=True)
    print("fetching %s from npm…" % package)
    subprocess.run(["npm", "pack", package], cwd=cache, check=True, stdout=subprocess.DEVNULL)
    tarballs = sorted(cache.glob("%s-*.tgz" % package))
    if not tarballs:
        sys.exit("npm pack produced no tarball for %s" % package)
    with tarfile.open(tarballs[-1]) as archive:
        wanted = [m for m in archive.getmembers() if m.name.startswith(member_prefix)]
        if not wanted:
            sys.exit("%s does not contain %s" % (package, member_prefix))
        archive.extractall(cache, members=wanted)
    return cache / pathlib.PurePosixPath(member_prefix).parent


def fetch_kernel():
    """OpenCascade for the browser, from npm. Cached in docs/.kernel."""
    return fetch_npm(KERNEL_PACKAGE, ".kernel", "package/dist/replicad_single.",
                     "package/dist/replicad_single.wasm")


def fetch_stage():
    """PlayCanvas, for the showroom. Cached in docs/.stage."""
    return fetch_npm(STAGE_PACKAGE, ".stage", "package/" + STAGE_FILE,
                     "package/" + STAGE_FILE)


def build_site(shell, glue_path, wasm_path, stage_path):
    """The served build: the page, the modules, and the big pieces as files.

    Nothing is bundled and nothing is inlined. The browser resolves the imports
    itself, which means the file it fetches is the file in src/ - so what is
    served can be read, and a stack trace from it points at a real line."""
    # The two generated folders go completely, so a module that has been
    # deleted from src/ stops being served. Nothing else here is touched:
    # src/, test/, data/ and the READMEs are source, and data/ is served as it
    # stands - a package's table is already a file in the right place.
    for folder in (SITE_MODULES, SITE_BINARIES):
        if (SITE / folder).exists():
            shutil.rmtree(SITE / folder)
    (SITE / SITE_MODULES).mkdir(parents=True)
    (SITE / SITE_BINARIES).mkdir()

    for name in MODULES:
        shutil.copyfile(SRC / name, SITE / SITE_MODULES / name)
    shutil.copyfile(glue_path, SITE / SITE_MODULES / GLUE_MODULE)
    shutil.copyfile(wasm_path, SITE / SITE_BINARIES / wasm_path.name)
    shutil.copyfile(stage_path, SITE / SITE_BINARIES / stage_path.name)
    for _, name in PAYLOADS:
        if not (DATA / name).exists():
            sys.exit("missing %s" % (DATA / name))

    # The shell is written as a fragment because an Artifact supplies the
    # document around it. A served page has no such wrapper, and a page with no
    # doctype is a page in quirks mode - so this build supplies one. The icon
    # is drawn here rather than fetched: a favicon request that 404s is the
    # only broken link a site like this would otherwise have.
    (SITE / SITE_INDEX).write_text("\n".join([
        "<!doctype html>",
        '<html lang="en">',
        '<link rel="icon" href="data:image/svg+xml,'
        "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E"
        "%3Cpath d='M8 1.6l5.6 3v6.8L8 14.4l-5.6-3V4.6z' fill='none' stroke='%232f6feb' "
        "stroke-width='1.3' stroke-linejoin='round'/%3E%3C/svg%3E\">",
        shell.rstrip(),
        "",
        # One script element, and it is the entry module. Everything else
        # arrives because something imported it.
        '<script type="module" src="app/%s"></script>' % ENTRY,
        "</html>",
        "",
    ]))

    # Pages runs Jekyll over what it serves unless told not to, and Jekyll
    # eats folders beginning with an underscore and rewrites what it feels
    # like. This file is how it is told not to.
    (SITE / ".nojekyll").write_text("")

    served = [SITE / SITE_INDEX, *(SITE / SITE_MODULES).rglob("*"),
              *(SITE / SITE_BINARIES).rglob("*"), *(DATA).rglob("*")]
    total = sum(f.stat().st_size for f in served if f.is_file())
    print("wrote the site into %s/  %.1f MB  (%d modules, kernel served as a file)" % (
        SITE.name, total / 1048576, len(MODULES) + 1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wasm-dir", default=None,
                        help="directory holding replicad_single.js and .wasm "
                             "(default: fetch replicad-opencascadejs from npm into docs/.kernel)")
    parser.add_argument("--only", choices=["artifact", "site"], default=None,
                        help="build just one of the two (default: both)")
    args = parser.parse_args()

    wasm_dir = pathlib.Path(args.wasm_dir) if args.wasm_dir else fetch_kernel()
    glue_path = wasm_dir / "replicad_single.js"
    wasm_path = wasm_dir / "replicad_single.wasm"
    for path in (glue_path, wasm_path):
        if not path.exists():
            sys.exit("missing %s" % path)

    shell = (SRC / "index.html").read_text()
    stage_path = fetch_stage() / pathlib.PurePosixPath(STAGE_FILE).name
    if not stage_path.exists():
        sys.exit("missing %s" % stage_path)

    if args.only != "artifact":
        build_site(shell, glue_path, wasm_path, stage_path)
    if args.only == "site":
        return

    # The emscripten glue is a module whose default export is the factory.
    glue = glue_path.read_text()
    if "export default Module;" not in glue:
        sys.exit("the glue no longer ends in `export default Module;` - check the package version")
    glue = glue.replace("export default Module;", "const replicadInit = Module;")

    packed = base64.b64encode(gzip.compress(wasm_path.read_bytes(), 9)).decode("ascii")

    stage_packed = base64.b64encode(
        gzip.compress(stage_path.read_bytes(), 9)).decode("ascii")

    bodies, seen = [], {}
    for name in MODULES:
        text = strip_modules((SRC / name).read_text())
        for declared in DECLARE.findall(text):
            if declared in seen:
                sys.exit("%s redeclares `%s`, already declared in %s" % (name, declared, seen[declared]))
            seen[declared] = name
        bodies.append("/* ---- src/%s ---- */\n%s" % (name, text))

    # The payload rides in a non-JavaScript <script> element on purpose. As a
    # string literal inside the module it costs the browser ~13 s to parse; as
    # opaque element text the HTML tokenizer just scans past it, and the module
    # reads it at run time.
    parts = ["<script type=\"application/octet-stream\" id=\"kernel-payload\">"
             + packed + "</script>",
             "<script type=\"application/octet-stream\" id=\"showroom-payload\">"
             + stage_packed + "</script>"]
    for element_id, name in PAYLOADS:
        source = DATA / name
        if not source.exists():
            sys.exit("missing %s" % source)
        # Minified first: a package's table is JSON written to be read, and the
        # whitespace that makes it readable is not what should travel.
        compact = json.dumps(json.loads(source.read_text()), separators=(",", ":"))
        rolled = base64.b64encode(gzip.compress(compact.encode("utf-8"), 9)).decode("ascii")
        parts.append("<script type=\"application/octet-stream\" id=\"%s\">%s</script>"
                     % (element_id, rolled))
        print("packed %s  %.1f -> %.1f kB" % (name, source.stat().st_size / 1024, len(rolled) / 1024))
    payload = "\n".join(parts)

    script = "\n".join([
        "<script type=\"module\">",
        "/* OpenCascade, compiled to WebAssembly (replicad-opencascadejs). */",
        glue,
        *bodies,
        "</script>",
    ])

    OUT.write_text(shell.rstrip() + "\n\n" + payload + "\n\n" + script + "\n")
    size = OUT.stat().st_size
    print("wrote %s  %.1f MB  (kernel %.1f -> %.1f MB, showroom %.1f -> %.1f MB)" % (
        OUT.relative_to(ROOT.parent), size / 1048576,
        wasm_path.stat().st_size / 1048576, len(packed) / 1048576,
        stage_path.stat().st_size / 1048576, len(stage_packed) / 1048576))
    if size > 16 * 1048576:
        sys.exit("over the 16 MB artifact limit")


if __name__ == "__main__":
    main()
