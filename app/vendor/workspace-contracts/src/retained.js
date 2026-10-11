// @ts-nocheck -- Runtime contract behavior is enforced by the conformance suite.
import {assertResourceReference, resourceReferenceKey} from "./interoperability.js";
import {validatePortableData} from "./repository.js";

export const retainedEvidenceChunkBytes = 512 * 1024;
export const retainedEvidenceExtension = "archive:retained_evidence";

export function assertRetainedEvidenceLinks(value) {
  if (!Array.isArray(value) || value.length > 24) throw new TypeError("Use up to 24 retained evidence links");
  const links = value.map(assertRetainedEvidenceLink);
  if (new Set(links.map(retainedEvidenceKey)).size !== links.length) throw new TypeError("Duplicate retained evidence link");
  return Object.freeze(links);
}

export function assertRetainedEvidenceLink(value) {
  const allowed = new Set(["schema_version", "collection_id", "collection_reference", "reference", "sha256", "size_bytes", "media_type"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || validatePortableData(value).length ||
      Object.keys(value).some(key => !allowed.has(key)) || value.schema_version !== 1 ||
      typeof value.collection_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value.collection_id) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 ||
      value.size_bytes > 128 * 1024 * 1024 || value.media_type !== "application/json") {
    throw new TypeError("Invalid retained evidence link");
  }
  const collection = assertResourceReference(value.collection_reference);
  if (collection.resource_type !== "handoff_collection") throw new TypeError("Invalid retained evidence collection");
  const reference = assertResourceReference(value.reference, {immutable: true});
  return Object.freeze({...structuredClone(value), collection_reference: collection, reference});
}

export function retainedEvidenceKey(value) {
  const link = assertRetainedEvidenceLink(value);
  return JSON.stringify([resourceReferenceKey(link.collection_reference), link.collection_id, resourceReferenceKey(link.reference), link.sha256]);
}

export async function verifyRetainedEvidenceBytes(value, bytes) {
  const link = assertRetainedEvidenceLink(value);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== link.size_bytes) throw new TypeError("Retained evidence length mismatch");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== link.sha256) throw new TypeError("Retained evidence digest mismatch");
  return bytes;
}

// The application transport authorizes each chunk with the retaining authority.
// No cached grants, bearer tokens or authority endpoints belong in this module.
export async function readRetainedEvidence(value, {readChunk, signal} = {}) {
  const link = assertRetainedEvidenceLink(value);
  if (typeof readChunk !== "function") throw new TypeError("Retained evidence needs an authorized transport");
  const bytes = new Uint8Array(link.size_bytes);
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const chunk = await readChunk({link, offset, signal});
    signal?.throwIfAborted();
    if (!chunk || chunk.schema_version !== 1 || retainedEvidenceKey(chunk.link) !== retainedEvidenceKey(link) ||
        chunk.link.size_bytes !== link.size_bytes || chunk.offset !== offset || chunk.total_bytes !== bytes.length ||
        typeof chunk.base64 !== "string" || chunk.base64.length > Math.ceil(retainedEvidenceChunkBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.base64)) throw new TypeError("Invalid retained evidence chunk");
    const text = atob(chunk.base64);
    const length = Math.min(retainedEvidenceChunkBytes, bytes.length - offset);
    if (text.length !== length || chunk.next_offset !== (offset + length === bytes.length ? null : offset + length)) throw new TypeError("Retained evidence range mismatch");
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
    offset += length;
  }
  await verifyRetainedEvidenceBytes(link, bytes);
  return {link, bytes};
}
