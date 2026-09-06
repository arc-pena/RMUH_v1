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

# Concatenated in this order into one module script.
MODULES = ["ocaf.js", "wasm-kernel.js", "http-kernel.js", "app.js"]

IMPORT = re.compile(r"^\s*import\s.*?;\s*$", re.M)
EXPORT = re.compile(r"^export\s+(?=(?:const|let|var|class|function|async)\b)", re.M)
DECLARE = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)", re.M)


def strip_modules(text):
    """Turn an ES module into plain statements for a shared scope."""
    return EXPORT.sub("", IMPORT.sub("", text))


def fetch_kernel():
    """OpenCascade for the browser, from npm. Cached in docs/.kernel."""
    cache = ROOT / ".kernel"
    dist = cache / "package" / "dist"
    if (dist / "replicad_single.wasm").exists():
        return dist

    cache.mkdir(exist_ok=True)
    print("fetching %s from npm…" % KERNEL_PACKAGE)
    subprocess.run(["npm", "pack", KERNEL_PACKAGE], cwd=cache, check=True,
                   stdout=subprocess.DEVNULL)
    tarballs = sorted(cache.glob("replicad-opencascadejs-*.tgz"))
    if not tarballs:
        sys.exit("npm pack produced no tarball")
    with tarfile.open(tarballs[-1]) as archive:
        wanted = [m for m in archive.getmembers()
                  if m.name.startswith("package/dist/replicad_single.")]
        archive.extractall(cache, members=wanted)
    return dist


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
    payload = ("<script type=\"application/octet-stream\" id=\"kernel-payload\">"
               + packed + "</script>")

    script = "\n".join([
        "<script type=\"module\">",
        "/* OpenCascade, compiled to WebAssembly (replicad-opencascadejs). */",
        glue,
        *bodies,
        "</script>",
    ])

    OUT.write_text(shell.rstrip() + "\n\n" + payload + "\n\n" + script + "\n")
    size = OUT.stat().st_size
    print("wrote %s  %.1f MB  (wasm %.1f MB raw -> %.1f MB packed)" % (
        OUT.relative_to(ROOT.parent), size / 1048576,
        wasm_path.stat().st_size / 1048576, len(packed) / 1048576))
    if size > 16 * 1048576:
        sys.exit("over the 16 MB artifact limit")


if __name__ == "__main__":
    main()
