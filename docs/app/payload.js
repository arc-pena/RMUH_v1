// Where the big pieces come from.
//
// This program is published two ways and they want opposite things of it.
//
//   As an Artifact it is ONE file. A published page may not fetch anything at
//   run time, so the WebAssembly kernel, the showroom engine and a package's
//   data all travel inside the document - gzipped, base64'd, in script
//   elements the HTML tokenizer scans straight past - and are unpacked from
//   there on first use.
//
//   Served from a web server - GitHub Pages, or a native kernel serving the
//   page - fetching is exactly what a browser is good at. The same pieces sit
//   beside the page as files: streamed, compiled while they arrive, and cached
//   by the browser between visits rather than re-parsed out of the HTML on
//   every load.
//
// One function decides which, per resource, by looking: a payload element is
// there or it is not. Nothing above this file knows or cares which way the
// page was built.

//! The bytes of a packed payload element, or null when the page does not carry
//! one. base64 in, raw gzip out.
export function packedBytes(elementId) {
  const element = elementId ? document.getElementById(elementId) : null;
  if (!element) return null;
  const packed = atob(element.textContent.trim());
  const bytes = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) bytes[i] = packed.charCodeAt(i);
  return bytes;
}

//! Gzip in, a Response out - so an unpacked payload and a fetched file are the
//! same kind of thing to everything downstream, including the streaming
//! WebAssembly compiler, which is why the kernel can be compiled while it is
//! still being inflated.
export function inflate(bytes, type) {
  if (typeof DecompressionStream !== "function")
    throw new Error("this browser cannot unpack packed data (no DecompressionStream)");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, type ? { headers: { "Content-Type": type } } : undefined);
}

//! One resource, from wherever this page keeps it. \p url is relative to the
//! page, and is only reached for when the page carries no payload element -
//! which is the whole of the difference between the two builds.
export async function resource(elementId, url, what, type) {
  const bytes = packedBytes(elementId);
  if (bytes) return inflate(bytes, type);
  if (!url) throw new Error("this page is missing its " + what);
  let answer;
  try {
    answer = await fetch(url);
  } catch (err) {
    // Opened from the filesystem rather than served: fetch is refused before
    // it reaches the file, and saying so beats "failed to fetch".
    throw new Error("could not load " + what + " from " + url
      + (location.protocol === "file:"
        ? " - this page has to be served over http to load its own files. Run "
          + "`python3 -m http.server` in the folder holding it, or open the "
          + "single-file build instead."
        : " - " + (err && err.message ? err.message : "the request failed")));
  }
  if (!answer.ok)
    throw new Error("could not load " + what + " from " + url + " (" + answer.status + ")");
  return answer;
}
