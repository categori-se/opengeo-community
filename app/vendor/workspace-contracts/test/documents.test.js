import assert from "node:assert/strict";
import {createHash, webcrypto} from "node:crypto";
import test from "node:test";
import {assertDocumentVersionLink, documentVersionKey, verifyDocumentVersionBytes,
  documentVersionChunkBytes, documentVersionMaxBytes} from "../src/documents.js";
import {createResourceReference} from "../src/interoperability.js";

const partSize = 8 * 1024 * 1024;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reference = createResourceReference({authority: "urn:categori:documents-fixture", workspaceId: "workspace_a",
  resourceType: "document", resourceId: "file_original", versionId: "opaque_revision_1"});
const full = (bytes, overrides = {}) => ({schema_version: 1, reference, size_bytes: bytes.length,
  media_type: "text/plain; charset=utf-8", integrity: {algorithm: "SHA256", type: "FULL_OBJECT", value: sha(bytes)}, ...overrides});
function composite(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    parts.push(createHash("sha256").update(bytes.subarray(offset, offset + partSize)).digest());
  }
  return {...full(bytes), integrity: {algorithm: "SHA256", type: "COMPOSITE", part_size_bytes: partSize,
    value: `${createHash("sha256").update(Buffer.concat(parts)).digest("base64")}-${parts.length}`}};
}

test("Document version link returns an independent frozen descriptive edition without grants", () => {
  const input = full(new TextEncoder().encode("original bytes"));
  const link = assertDocumentVersionLink(input);
  assert.deepEqual(link, input);
  for (const value of [link, link.reference, link.integrity]) assert.ok(Object.isFrozen(value));
  input.integrity.value = "0".repeat(64);
  assert.notEqual(link.integrity.value, input.integrity.value);
  assert.equal(link.permissions, undefined);
  assert.equal(documentVersionChunkBytes, 512 * 1024);
  assert.equal(documentVersionMaxBytes, 128 * 1024 * 1024);
});

test("Document edition key binds authority, workspace, resource and version, not observed byte manifest", () => {
  const bytes = new Uint8Array([1, 2, 3]), original = full(bytes);
  const key = documentVersionKey(original);
  for (const [field, value] of [["authority", "urn:categori:other"], ["workspace_id", "workspace_b"],
    ["resource_id", "other_file"], ["version_id", "opaque_revision_2"]]) {
    assert.notEqual(documentVersionKey({...original, reference: {...reference, [field]: value}}), key);
  }
  assert.equal(documentVersionKey({...original, size_bytes: 4, integrity: {...original.integrity, value: "0".repeat(64)}}), key);
});

test("Document link rejects extra fields, absent exact version and non-document references", () => {
  const value = full(new Uint8Array([1]));
  const {version_id, ...unversioned} = reference;
  for (const change of [{endpoint: "https://example.test"}, {schema_version: 2}, {reference: unversioned},
    {reference: {...reference, version_id: null}}, {reference: {...reference, resource_type: "asset"}},
    {reference: {...reference, workspace_id: "workspace_a\n"}}, {reference: {...reference, resource_id: "file_a\n"}},
    {reference: {...reference, authority: "https://user:password@example.test"}},
    {reference: {...reference, authority: "https://example.test/?token=value"}},
    {reference: {...reference, role: "owner"}}, {integrity: {...value.integrity, signed_url: "https://example.test"}}]) {
    assert.throws(() => assertDocumentVersionLink({...value, ...change}), TypeError);
  }
});

test("Document byte length is a bounded safe integer and zero requires full-object integrity", () => {
  const value = full(new Uint8Array());
  assert.equal(assertDocumentVersionLink(value).size_bytes, 0);
  assert.equal(assertDocumentVersionLink({...value, size_bytes: documentVersionMaxBytes}).size_bytes, documentVersionMaxBytes);
  for (const size_bytes of [-1, 1.5, NaN, Infinity, documentVersionMaxBytes + 1, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    assert.throws(() => assertDocumentVersionLink({...value, size_bytes}), TypeError);
  }
  assert.throws(() => assertDocumentVersionLink({...value, integrity: {algorithm: "SHA256", type: "COMPOSITE",
    value: `${Buffer.alloc(32).toString("base64")}-1`, part_size_bytes: partSize}}), TypeError);
});

test("Document media type accepts bounded MIME tokens and charset parameters without controls", () => {
  const value = full(new Uint8Array([1]));
  for (const media_type of ["application/pdf", "application/vnd.example+json", "TEXT/PLAIN; charset=UTF-8",
    "text/plain;charset=\"utf-8\"", "multipart/related; boundary=\"a b\""]) {
    assert.equal(assertDocumentVersionLink({...value, media_type}).media_type, media_type);
  }
  for (const media_type of ["", "text", "text/plain\n", "text/plain\r\nx: y", " text/plain", "text/plain; charset=",
    "text/plain; charset=\"unterminated", "text/plain\u0000", `application/${"x".repeat(256)}`]) {
    assert.throws(() => assertDocumentVersionLink({...value, media_type}), TypeError);
  }
});

test("Full object integrity rejects unsupported algorithms and noncanonical hash values", () => {
  const value = full(new Uint8Array([1]));
  for (const integrity of [{...value.integrity, algorithm: "MD5"}, {...value.integrity, type: "UNKNOWN"},
    {...value.integrity, value: value.integrity.value.toUpperCase()}, {...value.integrity, value: "f".repeat(63)},
    {...value.integrity, value: `${value.integrity.value}\n`}, {...value.integrity, part_size_bytes: partSize}]) {
    assert.throws(() => assertDocumentVersionLink({...value, integrity}), TypeError);
  }
});

test("Composite manifest requires canonical base64, fixed 8 MiB parts and exact calculated count", () => {
  const bytes = new Uint8Array(partSize + 1), value = composite(bytes);
  assert.equal(assertDocumentVersionLink(value).integrity.value, value.integrity.value);
  for (const change of [{part_size_bytes: partSize - 1}, {value: value.integrity.value.replace(/-2$/, "-1")},
    {value: value.integrity.value.replace(/-2$/, "-02")}, {value: value.integrity.value.replace("=", "")},
    {value: `A${"A".repeat(41)}B=-2`}, {value: `${value.integrity.value}\n`}]) {
    assert.throws(() => assertDocumentVersionLink({...value, integrity: {...value.integrity, ...change}}), TypeError);
  }
});

test("Full object verification reads complete original bytes, including empty documents", async () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("immutable original bytes"), new Uint8Array([0, 255])]) {
    const actual = await verifyDocumentVersionBytes(full(bytes), bytes, {cryptoImpl: webcrypto});
    assert.deepEqual(actual, bytes);
    assert.notEqual(actual, bytes);
  }
});

test("Byte verification rejects wrong length, changed bytes and incomplete transports", async () => {
  const bytes = new Uint8Array([1, 2, 3]), link = full(bytes);
  await assert.rejects(verifyDocumentVersionBytes(link, new Uint8Array([1, 2]), {cryptoImpl: webcrypto}), /length mismatch/);
  await assert.rejects(verifyDocumentVersionBytes(link, new Uint8Array([1, 2, 4]), {cryptoImpl: webcrypto}), /digest mismatch/);
  await assert.rejects(verifyDocumentVersionBytes(link, [1, 2, 3], {cryptoImpl: webcrypto}), /length mismatch/);
  await assert.rejects(verifyDocumentVersionBytes(link, bytes, {cryptoImpl: {}}), /WebCrypto/);
});

test("Composite verification matches hash-of-part-hashes for one exact and two partial parts", async () => {
  for (const length of [1, partSize, partSize + 7]) {
    const bytes = new Uint8Array(length);
    bytes[0] = 23; bytes[bytes.length - 1] = 251;
    const link = composite(bytes);
    assert.deepEqual(await verifyDocumentVersionBytes(link, bytes, {cryptoImpl: webcrypto}), bytes);
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(verifyDocumentVersionBytes(link, bytes, {cryptoImpl: webcrypto}), /digest mismatch/);
  }
});

test("Digest cannot return subsequently mutated caller bytes as verified content", async () => {
  const bytes = new Uint8Array([1, 2, 3]), original = new Uint8Array(bytes), link = full(bytes);
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const verification = verifyDocumentVersionBytes(link, bytes, {cryptoImpl: {subtle: {digest: async (algorithm, captured) => {
    await gate; return webcrypto.subtle.digest(algorithm, captured);
  }}}});
  bytes[0] = 9; release();
  assert.deepEqual(await verification, original);
});

test("Portable document manifest rejects getters, cycles and unsupported non-JSON properties", () => {
  const value = full(new Uint8Array([1]));
  const getter = {...value}; Object.defineProperty(getter, "media_type", {get: () => "application/pdf", enumerable: true});
  assert.throws(() => assertDocumentVersionLink(getter), TypeError);
  assert.throws(() => assertDocumentVersionLink({...value, size_bytes: 1n}), TypeError);
  const cyclic = {...value}; cyclic.reference = cyclic;
  assert.throws(() => assertDocumentVersionLink(cyclic), TypeError);
});
