import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createResourceReference} from "../src/interoperability.js";
import {assertRetainedEvidenceLink, readRetainedEvidence, retainedEvidenceChunkBytes, retainedEvidenceKey, verifyRetainedEvidenceBytes} from "../src/retained.js";

const bytes = new TextEncoder().encode('{"original":{"date":null}}\n');
const link = {schema_version: 1, collection_id: "opengeo", collection_reference: createResourceReference({authority: "urn:example:archive",
  workspaceId: "archive_a", resourceId: "knowledge", resourceType: "handoff_collection"}),
  reference: createResourceReference({authority: "urn:example:opengeo", workspaceId: "source_a", resourceId: "layer_1", resourceType: "layer_knowledge", versionId: "knowledge:1"}),
  sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, media_type: "application/json"};

test("retained references preserve source identity and verify exact retained bytes", async () => {
  const record = assertRetainedEvidenceLink(JSON.parse(JSON.stringify(link)));
  assert.ok(Object.isFrozen(record.reference));
  assert.equal(await verifyRetainedEvidenceBytes(record, bytes), bytes);
  assert.equal(record.reference.resource_id, "layer_1");
  assert.notEqual(retainedEvidenceKey(record), retainedEvidenceKey({...record, collection_id: "other"}));
  await assert.rejects(verifyRetainedEvidenceBytes(record, new Uint8Array(bytes.length)), /digest/);
  await assert.rejects(verifyRetainedEvidenceBytes(record, bytes.slice(1)), /length/);
});

function chunk(value, content, offset) {
  const end = Math.min(offset + retainedEvidenceChunkBytes, content.length);
  return {schema_version: 1, link: value, offset, total_bytes: content.length,
    next_offset: end === content.length ? null : end, base64: Buffer.from(content.slice(offset, end)).toString("base64")};
}

test("authorized transport reads bounded chunks and verifies the entire immutable version", async () => {
  const content = new Uint8Array(retainedEvidenceChunkBytes + 31).fill(91);
  const largeLink = {...link, size_bytes: content.length, sha256: createHash("sha256").update(content).digest("hex")};
  const offsets = [];
  const result = await readRetainedEvidence(largeLink, {readChunk: async ({link: value, offset}) => {offsets.push(offset); return chunk(value, content, offset);}});
  assert.deepEqual(offsets, [0, retainedEvidenceChunkBytes]);
  assert.deepEqual(result.bytes, content);
  await assert.rejects(readRetainedEvidence(largeLink, {readChunk: async ({link: value, offset}) => {
    if (offset) throw Error("Access revoked");
    return chunk(value, content, offset);
  }}), /revoked/);
});

test("replayed or mismatched ranges, changed version bytes and aborted opens never return evidence", async () => {
  for (const patch of [{offset: 1}, {next_offset: 1}, {total_bytes: 1}, {base64: "invalid!"},
    {link: {...link, reference: {...link.reference, version_id: "knowledge:2"}}},
    {base64: Buffer.from(new Uint8Array(bytes.length)).toString("base64")}]) {
    await assert.rejects(readRetainedEvidence(link, {readChunk: async () => ({...chunk(link, bytes, 0), ...patch})}));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readRetainedEvidence(link, {signal: controller.signal, readChunk: async () => assert.fail("Aborted read must not request bytes")}));
});

test("unversioned, credential-bearing and extra authority fields cannot enter retained links", () => {
  const {version_id, ...unversioned} = link.reference;
  for (const patch of [{reference: unversioned}, {credentials: "synthetic"}, {collection_id: "../escape"},
    {size_bytes: 0}, {sha256: "a"}, {sha256: ["a".repeat(64)]}, {media_type: "text/html"}]) {
    assert.throws(() => assertRetainedEvidenceLink({...link, ...patch}));
  }
});
