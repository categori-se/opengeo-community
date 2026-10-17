"""Native DOM gallery over the existing anonymous Collection projection.

Delivery rechecks visibility and member release eligibility. Imported public text
is a snapshot; explicit refresh replaces it through the same anonymous endpoint.
No member content, image, map, provider or authoring request is made here.
"""

import json
from typing import Any

MAX_COLLECTION_BYTES = 1024 * 1024
MAX_MODULE_BYTES = 2 * MAX_COLLECTION_BYTES
MAX_COLLECTION_MEMBERS = 200
PUBLIC_COLLECTION_HEADERS = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "X-Robots-Tag": "noindex",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def public_collection_projection(
    record: dict[str, Any], *, enforce_limits: bool = True
) -> dict[str, Any]:
    """Retain only the existing public schema, never authoring/storage fields."""
    members = record.get("members", [])
    if not isinstance(members, list) or (
        enforce_limits and len(members) > MAX_COLLECTION_MEMBERS
    ):
        raise ValueError("collection_projection_too_large")
    result = {
        key: record[key] for key in ("id", "title", "description", "visibility") if key in record
    }
    result["members"] = [
        {
            key: member[key]
            for key in (
                "kind",
                "title",
                "description",
                "href",
                "license",
                "attribution",
                "preview_href",
            )
            if key in member
        }
        for member in members
    ]
    if (
        enforce_limits
        and len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_COLLECTION_BYTES
    ):
        raise ValueError("collection_projection_too_large")
    return result


def collection_module(record: dict[str, Any]) -> bytes:
    # Embed the one already-authorized projection; mounting does not repeat SQL.
    # A module import executes no renderer or fetch. Links recheck their own access.
    public = public_collection_projection(record)
    literal = (
        json.dumps(public, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    body = (
        "// OpenGeo public Collection gallery. No external imports or automatic member reads.\n"
        f"const initial = {literal};\n"
        f"const MAX_BYTES = {MAX_COLLECTION_BYTES}, MAX_MEMBERS = {MAX_COLLECTION_MEMBERS};\n"
        + r"""
export const collection = Object.freeze({id: initial.id, title: initial.title,
  description: initial.description, visibility: initial.visibility});
export const selectionEvent = "opengeo:collection-select";

function endpointURL() {
  const url = new URL(import.meta.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Import this Collection from its public HTTP endpoint.");
  }
  url.pathname = url.pathname.replace(/\/module\.mjs$/, "");
  url.search = ""; url.hash = "";
  return url;
}

function safeURL(value, base) {
  if (typeof value !== "string" || !value || value.length > 4096) return null;
  // Public projection paths omit the API mount prefix. Preserve that prefix
  // when this module is delivered under /api or another gateway root path.
  const marker = "/public/organizations/", at = base.pathname.lastIndexOf(marker);
  if (value.startsWith(marker) && at >= 0) value = base.pathname.slice(0, at) + value;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function projectMember(value, base) {
  if (!value || !["project", "publication"].includes(value.kind)
    || typeof value.title !== "string" || value.title.length > 10000
    || (value.description != null && (typeof value.description !== "string"
      || value.description.length > 10000))) throw new Error("Invalid public Collection member.");
  const href = safeURL(value.href, base);
  if (!href) throw new Error("Invalid public Collection link.");
  const member = {kind: value.kind, title: value.title, description: value.description ?? "", href};
  for (const key of ["license", "attribution"]) {
    if (value[key] != null) {
      if (typeof value[key] !== "string" || value[key].length > 10000) {
        throw new Error("Invalid public Collection terms.");
      }
      member[key] = value[key];
    }
  }
  return Object.freeze(member);
}

function projection(value, base) {
  if (!value || value.id !== initial.id || value.visibility !== "public"
    || typeof value.title !== "string" || value.title.length > 200
    || typeof value.description !== "string" || value.description.length > 10000
    || !Array.isArray(value.members) || value.members.length > MAX_MEMBERS) {
    throw new Error("Invalid public Collection response.");
  }
  return {id: value.id, title: value.title, description: value.description,
    visibility: "public", members: value.members.map(member => projectMember(member, base))};
}

async function readProjection(base, fetchImpl, signal) {
  const response = await fetchImpl(base.href, {method: "GET", mode: "cors", credentials: "omit",
    cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal});
  if (!response.ok) throw new Error(response.status === 404
    ? "This Collection is unavailable." : "Could not load this Collection.");
  const length = response.headers.get("Content-Length");
  if ((length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
    await response.body?.cancel(); throw new Error("Invalid public Collection response.");
  }
  if (!response.body?.getReader) throw new Error("A bounded response stream is required.");
  const reader = response.body.getReader(), parts = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Public Collection response is too large.");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  signal.throwIfAborted();
  const body = new Uint8Array(bytes); let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return projection(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(body)), base);
}

export function createGallery({onSelect, signal, invalidation,
  document: ownerDocument = globalThis.document, fetch: fetchImpl = globalThis.fetch} = {}) {
  if (!ownerDocument?.createElement) throw new Error("A browser document is required.");
  if (onSelect != null && typeof onSelect !== "function") {
    throw new TypeError("onSelect must be a function.");
  }
  const base = endpointURL(), root = ownerDocument.createElement("section");
  root.className = "opengeo-collection-gallery";
  const title = ownerDocument.createElement("h2"), description = ownerDocument.createElement("p");
  const status = ownerDocument.createElement("p"), list = ownerDocument.createElement("ol");
  status.setAttribute("role", "status");
  const refreshButton = ownerDocument.createElement("button"); refreshButton.type = "button";
  refreshButton.textContent = "Refresh Collection";
  root.append(title, description, status, list, refreshButton);
  let disposed = false, generation = 0, request = null;
  const show = value => {
    title.textContent = value.title; description.textContent = value.description;
    list.replaceChildren(); const renderedGeneration = generation;
    for (const member of value.members) {
      const card = ownerDocument.createElement("li"), kind = ownerDocument.createElement("small");
      kind.textContent = member.kind === "project" ? "Project" : "Publication";
      const heading = ownerDocument.createElement("h3"), link = ownerDocument.createElement("a");
      link.textContent = member.title; link.href = member.href; link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.addEventListener("click", event => {
        if (disposed || renderedGeneration !== generation) {event.preventDefault(); return;}
        const EventType = ownerDocument.defaultView?.CustomEvent ?? globalThis.CustomEvent;
        const selected = new EventType(selectionEvent,
          {detail: member, bubbles: true, cancelable: true});
        if (onSelect) event.preventDefault();
        if (!root.dispatchEvent(selected)) event.preventDefault();
        if (onSelect) {
          try { Promise.resolve(onSelect(member)).catch(() => {
            if (!disposed && renderedGeneration === generation) {
              status.textContent = "Could not open this member.";
            }
          }); } catch { status.textContent = "Could not open this member."; }
        }
      });
      heading.append(link); const summary = ownerDocument.createElement("p");
      summary.textContent = member.description;
      card.append(kind, heading, summary);
      const terms = [member.attribution, member.license].filter(Boolean);
      if (terms.length) {
        const credit = ownerDocument.createElement("small");
        credit.textContent = terms.join(" · "); card.append(credit);
      }
      list.append(card);
    }
    status.textContent = value.members.length ? "" : "No public members to display.";
  };
  const dispose = () => {
    if (disposed) return; disposed = true; generation++; request?.abort();
    signal?.removeEventListener("abort", dispose); root.remove();
  };
  const refresh = async () => {
    if (disposed) throw new DOMException("Collection gallery disposed.", "AbortError");
    request?.abort(); const active = request = new AbortController(), current = ++generation;
    list.replaceChildren(); title.textContent = ""; description.textContent = "";
    status.textContent = "Loading Collection…"; refreshButton.disabled = true;
    const deadline = setTimeout(() => active.abort(), 20000);
    try {
      const value = await readProjection(base, fetchImpl, active.signal);
      if (!disposed && current === generation) show(value);
      return value;
    } catch (error) {
      if (!disposed && current === generation) status.textContent = active.signal.aborted
        ? "Collection request stopped. Refresh to try again." : error.message;
      throw error;
    } finally {
      clearTimeout(deadline);
      if (!disposed && current === generation) refreshButton.disabled = false;
    }
  };
  Object.defineProperties(root, {refresh: {value: refresh}, dispose: {value: dispose}});
  refreshButton.addEventListener("click", () => {void refresh().catch(() => {});});
  if (signal?.aborted) dispose();
  else {
    signal?.addEventListener("abort", dispose, {once: true}); show(projection(initial, base));
  }
  if (invalidation) Promise.resolve(invalidation).then(dispose, dispose);
  return root;
}

export const createView = createGallery;
"""
    ).encode("utf-8")
    if len(body) > MAX_MODULE_BYTES:
        raise ValueError("collection_projection_too_large")
    return body
