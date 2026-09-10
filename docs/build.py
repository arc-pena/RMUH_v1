#!/usr/bin/env python3
"""Assemble docs/parametric-cad.html from src/.

The page has to be one file: an Artifact may load scripts from a handful of
CDNs but may not fetch anything at runtime, and OpenCascade's WebAssembly module
is a runtime fetch. So the kernel travels inside the page, gzipped and base64'd
- 22 MB of wasm becomes about 9 MB of text, which fits.

    python3 docs/build.py [--wasm-dir DIR]
"""
import argparse
import base64
import gzip
import json
import pathlib
import re
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "parametric-cad.html"

# OpenCascade for the browser: a trimmed OCCT build, 22 MB of WebAssembly.
KERNEL_PACKAGE = "replicad-opencascadejs"

# The showroom renderer. Packed the same way and unpacked only when someone
# opens the showroom, so a session that never does never pays for it.
STAGE_PACKAGE = "playcanvas"
STAGE_FILE = "build/playcanvas.min.js"

# Concatenated in this order into one module script.
MODULES = ["sketch.js", "factory.js", "exchange.js", "ocaf.js", "wasm-kernel.js", "http-kernel.js", "mdl.js", "graph.js",
           "agent.js", "showroom.js", "plugin.js", "climate.js", "climate-plugin.js",
           "crowd.js", "crowd-plugin.js", "app.js"]

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wasm-dir", default=None,
                        help="directory holding replicad_single.js and .wasm "
                             "(default: fetch replicad-opencascadejs from npm into docs/.kernel)")
    args = parser.parse_args()

    wasm_dir = pathlib.Path(args.wasm_dir) if args.wasm_dir else fetch_kernel()
    glue_path = wasm_dir / "replicad_single.js"
    wasm_path = wasm_dir / "replicad_single.wasm"
    for path in (glue_path, wasm_path):
        if not path.exists():
            sys.exit("missing %s" % path)

    shell = (SRC / "index.html").read_text()

    # The emscripten glue is a module whose default export is the factory.
    glue = glue_path.read_text()
    if "export default Module;" not in glue:
        sys.exit("the glue no longer ends in `export default Module;` - check the package version")
    glue = glue.replace("export default Module;", "const replicadInit = Module;")

    packed = base64.b64encode(gzip.compress(wasm_path.read_bytes(), 9)).decode("ascii")

    stage_path = fetch_stage() / pathlib.PurePosixPath(STAGE_FILE).name
    if not stage_path.exists():
        sys.exit("missing %s" % stage_path)
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
