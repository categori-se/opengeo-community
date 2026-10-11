// @ts-nocheck -- Runtime contracts are enforced by the package conformance suite.
import {assertResourceReference, resourceReferenceKey} from "./interoperability.js";
import {validatePortableData} from "./repository.js";

export const documentVersionChunkBytes = 512 * 1024;
export const documentVersionMaxBytes = 128 * 1024 * 1024;
const compositePartBytes = 8 * 1024 * 1024;
const fields = ["schema_version", "reference", "size_bytes", "media_type", "integrity"];
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quoted = '"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
const mediaType = new RegExp(`^${token}/${token}(?: *; *${token}=(?:${token}|${quoted}))*$(?![\\s\\S])`);
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$(?![\s\S])/;
const fullHash = /^[a-f0-9]{64}$(?![\s\S])/;
// Canonical padded base64 of exactly 32 bytes, then the fixed-size part count.
const compositeHash = /^([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)-([1-9][0-9]*)$(?![\s\S])/;

/** Descriptive immutable document edition; contains no transport or access grant. */
export function assertDocumentVersionLink(value) {
  if (!exact(value, fields) || validatePortableData(value).length || value.schema_version !== 1 ||
      !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0 || value.size_bytes > documentVersionMaxBytes ||
      typeof value.media_type !== "string" || value.media_type.length > 256 || !mediaType.test(value.media_type)) {
    throw new TypeError("Invalid document version link");
  }
  const reference = assertResourceReference(value.reference, {immutable: true});
  if (reference.resource_type !== "document" || !opaque.test(reference.resource_id) || !opaque.test(reference.workspace_id)) {
    throw new TypeError("Document version requires an immutable document reference");
  }
  const integrity = value.integrity;
  if (!plain(integrity) || integrity.algorithm !== "SHA256") throw new TypeError("Invalid document version integrity");
  if (integrity.type === "FULL_OBJECT") {
    if (!exact(integrity, ["algorithm", "type", "value"]) || typeof integrity.value !== "string" || !fullHash.test(integrity.value)) {
      throw new TypeError("Invalid document version full-object SHA256");
    }
  } else if (integrity.type === "COMPOSITE") {
    const match = typeof integrity.value === "string" && compositeHash.exec(integrity.value);
    if (!exact(integrity, ["algorithm", "type", "value", "part_size_bytes"]) || !match ||
        integrity.part_size_bytes !== compositePartBytes || value.size_bytes === 0 ||
        Number(match[2]) !== Math.ceil(value.size_bytes / compositePartBytes)) {
      throw new TypeError("Invalid document version composite SHA256");
    }
  } else throw new TypeError("Unsupported document version integrity type");
  return Object.freeze({...structuredClone(value), reference, integrity: Object.freeze({...integrity})});
}

/** Identity includes authority, security workspace, document and exact version only. */
export function documentVersionKey(value) {
  return resourceReferenceKey(assertDocumentVersionLink(value).reference);
}

/** Verify complete original bytes; current authorization remains application-owned. */
export async function verifyDocumentVersionBytes(value, bytes, {cryptoImpl = globalThis.crypto} = {}) {
  const link = assertDocumentVersionLink(value);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== link.size_bytes) throw new TypeError("Document version length mismatch");
  if (typeof cryptoImpl?.subtle?.digest !== "function") throw new TypeError("Document version verification requires WebCrypto");
  // Snapshot before the first await: a caller must not substitute bytes during digest.
  const verified = new Uint8Array(bytes);
  let actual;
  if (link.integrity.type === "FULL_OBJECT") {
    const hash = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", verified));
    actual = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  } else {
    const count = Math.ceil(verified.length / compositePartBytes);
    const parts = new Uint8Array(count * 32);
    for (let index = 0; index < count; index++) {
      const start = index * compositePartBytes;
      const part = verified.subarray(start, Math.min(start + compositePartBytes, verified.length));
      parts.set(new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", part)), index * 32);
    }
    const hash = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", parts));
    actual = `${btoa(String.fromCharCode(...hash))}-${count}`;
  }
  if (actual !== link.integrity.value) throw new TypeError("Document version digest mismatch");
  return verified;
}
