"""ES module delivery of an already compiled portable Artifact; no builds or I/O.

The retained HTML is data in the importing realm and runs only in an opaque-origin
iframe. This representation needs no Studio client, external imports or refetch.
Downloaded copies remain copies: revocation governs subsequent endpoint reads.
"""

import json
from typing import Any


def project_module(
    html: bytes, metadata: dict[str, Any], *, public_origins: list[str] | None = None
) -> bytes:
    def literal(value: Any) -> str:
        return (
            json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("&", "\\u0026")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )

    # Metadata is an allowlisted public projection, never storage coordinates,
    # browser manifest contents, auth context, source URLs or credentials.
    origins = " ".join(public_origins or [])
    policy = (
        (
            "default-src 'none'; script-src 'unsafe-inline' blob:; "
            f"style-src 'unsafe-inline'; img-src data: blob: {origins}; font-src data: blob:; "
            f"worker-src blob:; connect-src blob: {origins}; frame-src 'none'; "
            "base-uri 'none'; form-action 'none'"
        )
        if origins
        else (
            "default-src 'none'; script-src 'unsafe-inline' blob:; "
            "style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; "
            "worker-src blob:; connect-src blob:; frame-src 'none'; "
            "base-uri 'none'; form-action 'none'"
        )
    )
    return (
        "// OpenGeo portable Project module v1. No external imports.\n"
        f"export const artifact = Object.freeze({literal(metadata)});\n"
        f"export const html = {literal(html.decode('utf-8', errors='strict'))};\n"
        f"const policy = {literal(policy)};\n"
        + r"""
export function createView({height = 600, width = "100%", invalidation, signal,
  document: ownerDocument = globalThis.document} = {}) {
  if (!ownerDocument?.createElement) {
    throw new Error("A browser document is required to show this Project.");
  }
  const root = ownerDocument.createElement("div");
  const frame = ownerDocument.createElement("iframe");
  frame.title = artifact.title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.width = typeof width === "number" ? `${width}px` : String(width);
  frame.style.height = typeof height === "number" ? `${height}px` : String(height);
  frame.style.border = "0";
  // A srcdoc loses the delivery endpoint's CSP. Restore it before any retained
  // content, in addition to the iframe sandbox; the import itself executes none.
  frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="'
    + policy + '">' + html;
  const credit = ownerDocument.createElement("small");
  credit.textContent = `${artifact.attribution} · ${artifact.license}`;
  root.append(frame, credit);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    frame.srcdoc = "";
    root.remove();
  };
  Object.defineProperty(root, "dispose", {value: dispose});
  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose, {once: true});
  if (invalidation) Promise.resolve(invalidation).then(dispose, dispose);
  return root;
}

// Compiled classic Observable notebook interface. Framework and Notebook Kit
// use the named createView export with their display/invalidation builtins.
export default function define(runtime, observer = () => undefined) {
  const main = runtime.module();
  main.variable(observer("artifact")).define("artifact", () => artifact);
  main.variable(observer("project")).define("project", ["invalidation"],
    invalidation => createView({invalidation}));
  return main;
}
"""
    ).encode("utf-8")
