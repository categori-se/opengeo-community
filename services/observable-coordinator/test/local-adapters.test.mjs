import assert from "node:assert/strict";
import {test} from "node:test";
import {LocalExactVersionStorage, localDependencies, localPublicationBridge, processLocalBuildQueue}
  from "../src/local-adapters.mjs";
import {RdsDataBuildRepository} from "../src/production-adapters.mjs";
import {sha256,verifyRead,verifyWrite} from "../src/contracts.mjs";

const pin = `sha256:${"a".repeat(64)}`;
const id = "10000000-0000-4000-8000-000000000001";
const command = JSON.stringify({schema: "opengeo.observable-build.command.1.0.0", build_job_id: id});

test("local configuration keeps SQL lease repository and refuses mutable compiler identities", () => {
  assert.throws(() => localDependencies({bridge: async () => {}, compilerImageDigest: "latest"}));
  assert.throws(() => localPublicationBridge("production-api"));
  const dependencies = localDependencies({bridge: async () => {}, compilerImageDigest: pin});
  assert.ok(dependencies.repository instanceof RdsDataBuildRepository);
  assert.equal(dependencies.expectedCompilerImageDigest, pin);
});

test("source staging verifies exact identity, returned size, bytes and checksum", async () => {
  const bytes = Buffer.from("# Saved edition\n");
  const source = {bucket: "local-pilot.invalid", key: "source/index.md", version_id: id,
    etag: "exact-etag", content_type: "text/markdown", size_bytes: bytes.length,
    checksum_sha256: sha256(bytes), body: bytes.toString("base64")};
  const request = {bucket: source.bucket, objectKey: source.key, s3VersionId: id, maximumBytes: bytes.length};
  const storage = new LocalExactVersionStorage(async () => source);
  const stored = await storage.readExact(request);
  assert.deepEqual(verifyRead({...request,etag:source.etag,contentType:source.content_type,
    sizeBytes:source.size_bytes,checksumSha256:source.checksum_sha256},stored),bytes);
  for (const mutation of [{version_id: "other"}, {key: "other"}, {checksum_sha256: "b".repeat(64)},
    {size_bytes: bytes.length + 1}, {body: Buffer.from("changed").toString("base64")}]) {
    await assert.rejects(new LocalExactVersionStorage(async () => ({...source, ...mutation})).readExact(request));
  }
  await assert.rejects(storage.writeExact({bytes, checksumSha256: "b".repeat(64)}));
});

test("queue retry reads completed SQL state and acknowledges without executing compiler", async () => {
  const calls = [];
  const bridge = async request => {
    calls.push(request.operation);
    if (request.operation === "receive") return calls.filter(call => call === "receive").length === 1 ? {id, body: command} : null;
    if (request.operation === "sql") {
      assert.match(request.sql, /app\.claim_observable_build_runtime/);
      assert.equal(request.parameters[0].value.stringValue, id);
      return [["already_succeeded", id, ...Array(12).fill(null)]];
    }
    if (request.operation === "acknowledge") return true;
    throw new Error("Unexpected transport operation");
  };
  const result = await processLocalBuildQueue({bridge, compilerImageDigest: pin,
    runner: {run() { throw new Error("Completed output must not compile again"); }}});
  assert.equal(result[0].status, "already_succeeded");
  assert.deepEqual(calls, ["receive", "sql", "acknowledge", "receive"]);
});

test("retained local writes satisfy the production completion manifest contract", async () => {
  const bytes=Buffer.from('<!doctype html><h1>Saved edition</h1>');
  const outputPrefix='organizations/example/builds/edition/output/';
  const file={path:'dist/index.html',contentType:'text/html',sizeBytes:bytes.length,checksumSha256:sha256(bytes)};
  const storage=new LocalExactVersionStorage(async request=>({bucket:request.bucket,key:request.objectKey,
    version_id:id,etag:'exact-etag',content_type:request.contentType,
    size_bytes:bytes.length,checksum_sha256:request.checksumSha256}));
  const written=await storage.writeExact({bucket:'local-pilot.invalid',objectKey:outputPrefix+'index.html',
    contentType:file.contentType,checksumSha256:file.checksumSha256,bytes});
  const pinned=verifyWrite(file,outputPrefix,written);
  assert.equal(pinned.sizeBytes,bytes.length);assert.equal(pinned.s3VersionId,id);
  assert.equal(Object.hasOwn(written,'bytes'),false);
});

test("busy SQL lease stops the batch and preserves queued work", async () => {
  const calls = [];
  const bridge = async request => {
    calls.push(request.operation);
    if (request.operation === "receive") return {id, body: command};
    if (request.operation === "sql") return [["busy", id, ...Array(12).fill(null)]];
    throw new Error("Busy work must not be acknowledged");
  };
  const result = await processLocalBuildQueue({bridge, compilerImageDigest: pin});
  assert.equal(result[0].status, "busy");
  assert.deepEqual(calls, ["receive", "sql"]);
});
