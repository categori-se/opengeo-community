import assert from "node:assert/strict";
import {it} from "node:test";
import {ApiContractError, OpenGeoApiClient} from "../src/lib/apiClient.js";

const project = "50000000-0000-4000-8000-000000000001";
const source = "b0000000-0000-4000-8000-000000000001";
const objectId = "c0000000-0000-4000-8000-000000000001";
const uploadId = "d0000000-0000-4000-8000-000000000001";
const blob = new Blob(["# Original"], {type: "text/markdown"});
const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

const revisionId = "e0000000-0000-4000-8000-000000000001";
const savedFile = {relativePath: "src/index.md", bucket: "source.opengeo.tools",
  objectKey: `organizations/${objectId}/projects/${project}/source-projects/${source}/uploads/${uploadId}/files/src/index.md`,
  s3VersionId: "immutable-version-1", contentType: "text/markdown", sizeBytes: blob.size,
  checksumSha256: checksum};

it("compatible saved source download propagates cancellation to the active HTTP request", async () => {
  const controller = new AbortController();
  let started, requestSignal, requests = 0;
  const dispatched = new Promise(resolve => { started = resolve; });
  const client = new OpenGeoApiClient({tokenProvider: () => "token",
    organizationProvider: () => objectId,
    fetchImplementation: async (_url, options) => {
      requests++;
      requestSignal = options.signal;
      started();
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), {once: true});
      });
    }});
  const download = client.readObservableSourceRevisionFile(
    project, source, revisionId, savedFile.relativePath, {signal: controller.signal}
  );
  await dispatched;
  controller.abort();
  await assert.rejects(download, {name: "AbortError"});
  assert.equal(requestSignal.aborted, true);
  assert.equal(requests, 1);
});

function sourceDownloadTicket() {
  const query = new URLSearchParams({"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "fixture", "X-Amz-Date": "20261007T150000Z", "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host", "X-Amz-Signature": "a".repeat(64),
    "response-content-disposition": 'attachment; filename="index.md"', versionId: savedFile.s3VersionId});
  return {url: `https://s3.us-east-1.amazonaws.com/${savedFile.bucket}/${savedFile.objectKey}?${query}`,
    method: "GET", expires_at: "2099-10-07T15:05:00Z", relative_path: savedFile.relativePath,
    content_type: savedFile.contentType, size_bytes: savedFile.sizeBytes, checksum_sha256: checksum,
    bucket: savedFile.bucket, object_key: savedFile.objectKey, s3_version_id: savedFile.s3VersionId};
}

for (const scenario of ["valid", "other-bucket", "other-version", "other-path", "other-checksum",
  "expired", "session-changed", "response-version", "oversized", "changed-body", "aborted"]) {
  it(`direct saved source download: ${scenario}`, async () => {
    const requests = [], controller = new AbortController();
    let account = objectId;
    const client = new OpenGeoApiClient({tokenProvider: () => "token",
      organizationProvider: () => account,
      fetchImplementation: async (url, options) => {
        requests.push({url, options});
        if (url.startsWith("/api/")) {
          assert.equal(options.method, "POST");
          assert.equal(options.headers.get("Authorization"), "Bearer token");
          assert.deepEqual(JSON.parse(options.body), {relative_path: "src/index.md"});
          const ticket = sourceDownloadTicket();
          if (scenario === "other-bucket") ticket.bucket = "other.opengeo.tools";
          if (scenario === "other-version") ticket.url = ticket.url.replace("immutable-version-1", "other-version");
          if (scenario === "other-path") ticket.url = ticket.url.replace("files/src/index.md", "files/src/other.md");
          if (scenario === "other-checksum") ticket.checksum_sha256 = "b".repeat(64);
          if (scenario === "expired") ticket.expires_at = "2000-01-01T00:00:00Z";
          if (scenario === "session-changed") account = project;
          if (scenario === "aborted") controller.abort();
          return new Response(JSON.stringify(ticket), {headers: {"Content-Type": "application/json"}});
        }
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.cache, "no-store");
        assert.equal(options.headers, undefined);
        const body = scenario === "oversized" ? "x".repeat(blob.size + 1)
          : scenario === "changed-body" ? "x".repeat(blob.size) : blob;
        return new Response(body, {headers: {"Content-Type": savedFile.contentType,
          "x-amz-version-id": scenario === "response-version" ? "other-version" : savedFile.s3VersionId}});
      }});
    const download = () => client.readObservableSourceRevisionFileDirect(
      project, source, revisionId, savedFile, {signal: controller.signal}
    );
    if (scenario === "valid") {
      const result = await download();
      assert.equal(await result.blob.text(), await blob.text());
      assert.equal(result.checksumSha256, checksum);
      assert.equal(result.relativePath, savedFile.relativePath);
      assert.equal("url" in result, false);
    } else if (scenario === "aborted") await assert.rejects(download(), {name: "AbortError"});
    else await assert.rejects(download(), ApiContractError);
    assert.equal(requests.length, ["valid", "response-version", "oversized", "changed-body"].includes(scenario) ? 2 : 1);
  });
}

it("direct saved source download stops a stalled transfer after 20 seconds", async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let reachedStorage;
  const storageStarted = new Promise(resolve => { reachedStorage = resolve; });
  const client = new OpenGeoApiClient({tokenProvider: () => "token",
    organizationProvider: () => objectId,
    fetchImplementation: async (url, options) => {
      if (url.startsWith("/api/")) return new Response(JSON.stringify(sourceDownloadTicket()),
        {headers: {"Content-Type": "application/json"}});
      reachedStorage();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true});
      });
    }});
  const download = client.readObservableSourceRevisionFileDirect(project, source, revisionId, savedFile);
  const rejected = assert.rejects(download, {name: "TimeoutError"});
  await storageStarted;
  t.mock.timers.tick(20_000);
  await rejected;
});

for (const mode of ["reuse", "old-api", "other-source", "stale", "changed", "type-changed"]) {
  it(`incremental source save: ${mode}`, async () => {
    const client = new OpenGeoApiClient({tokenProvider: () => "token"});
    const uploaded = [], requested = [];
    let committed;
    client.requestObservableSourceFileUpload = async (_p, _s, file) => {
      requested.push(file);
      return {uploadId, expiresAt: new Date(Date.now() + 60000).toISOString(), upload: {}};
    };
    client.uploadFile = async (_ticket, file) => uploaded.push(file);
    client.createObservableSourceRevision = async (_p, _s, draft) => { committed = draft; return draft; };
    await client.saveObservableSourceRevision(project, source, {
      expectedRevision: 1, title: "Source", entryPath: "src/index.md", changeSummary: "Edit",
      files: [
        {relativePath: "src/index.md", contentType: "text/markdown", blob: mode === "changed" ? new Blob(["# Changed"]) : blob},
        {relativePath: "src/new.md", contentType: "text/markdown", blob: new Blob(["# Added"])},
      ],
      reuseRevision: {
        supportsFileReuse: mode !== "old-api",
        sourceProjectId: mode === "other-source" ? project : source,
        revisionNumber: mode === "stale" ? 2 : 1,
        files: [{relativePath: "src/index.md", sourceObjectId: objectId, checksumSha256: checksum,
          sizeBytes: blob.size, contentType: mode === "type-changed" ? "text/plain" : "text/markdown"},
          {relativePath: "src/deleted.md", sourceObjectId: project}],
      },
    });
    assert.equal(uploaded.length, mode === "reuse" ? 1 : 2);
    assert.equal(requested.length, uploaded.length);
    assert.deepEqual(committed.files.map(file => file.relativePath), ["src/index.md", "src/new.md"]);
    assert.deepEqual(committed.files[0], mode === "reuse"
      ? {sourceObjectId: objectId, relativePath: "src/index.md"}
      : {uploadId, relativePath: "src/index.md"});
  });
}

it("serializes both reference kinds and rejects ambiguous or duplicate references", async () => {
  const requests = [];
  const client = new OpenGeoApiClient({tokenProvider: () => "token"});
  client.request = async (_path, options) => { requests.push(options.body); throw new Error("captured"); };
  const draft = {expectedRevision: 1, title: "Source", entryPath: "src/index.md", changeSummary: "Edit"};
  await assert.rejects(client.createObservableSourceRevision(project, source, {...draft, files: [
    {relativePath: "src/index.md", sourceObjectId: objectId},
    {relativePath: "src/new.md", uploadId},
  ]}), /captured/);
  assert.deepEqual(requests[0].files, [
    {relative_path: "src/index.md", source_object_id: objectId},
    {relative_path: "src/new.md", upload_id: uploadId},
  ]);
  for (const files of [
    [{relativePath: "src/index.md", sourceObjectId: objectId, uploadId}],
    [{relativePath: "src/index.md"}],
    [{relativePath: "src/index.md", sourceObjectId: objectId}, {relativePath: "src/other.md", sourceObjectId: objectId}],
  ]) await assert.rejects(client.createObservableSourceRevision(project, source, {...draft, files}), TypeError);
  assert.equal(requests.length, 1);
});

it("commits an exact unread companion by parent reference while hashing and uploading the edited body", async () => {
  const client = new OpenGeoApiClient({tokenProvider: () => "token"});
  const edited = new Blob(["# Modified"], {type: "text/markdown"});
  const companion = {relativePath: "src/plot.png", sourceObjectId: objectId,
    contentType: "image/png", sizeBytes: 4, checksumSha256: "a".repeat(64), blob: null};
  const uploads = [];
  client.requestObservableSourceFileUpload = async (_p, _s, file) => {
    uploads.push(file);
    return {uploadId, expiresAt: new Date(Date.now() + 60000).toISOString(), upload: {}};
  };
  client.uploadFile = async (_ticket, body) => assert.equal(body, edited);
  client.createObservableSourceRevision = async (_p, _s, draft) => draft;
  const result = await client.saveObservableSourceRevision(project, source, {
    expectedRevision: 1, title: "Source", entryPath: "src/index.md", changeSummary: "Edit",
    files: [{relativePath: "src/index.md", contentType: "text/markdown", blob: edited,
      sourceObjectId: uploadId, sizeBytes: blob.size, checksumSha256: checksum}, companion],
    reuseRevision: {sourceProjectId: source, revisionNumber: 1, supportsFileReuse: true,
      files: [{relativePath: "src/index.md", sourceObjectId: uploadId, contentType: "text/markdown",
        sizeBytes: blob.size, checksumSha256: checksum}, companion]}
  });
  assert.deepEqual(uploads.map(file => file.relativePath), ["src/index.md"]);
  assert.equal(uploads[0].checksumSha256,
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", await edited.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, "0")).join(""));
  assert.deepEqual(result.files, [{relativePath: "src/index.md", uploadId},
    {relativePath: "src/plot.png", sourceObjectId: objectId}]);
});

it("saves a static map revision through the normal client without a release-only flag override", async () => {
  const client = new OpenGeoApiClient({tokenProvider: () => "token"});
  const uploads = [];
  client.requestObservableSourceFileUpload = async (_p, _s, file) => {
    uploads.push(file.relativePath);
    return {uploadId, expiresAt: new Date(Date.now() + 60000).toISOString(), upload: {}};
  };
  client.uploadFile = async () => {};
  client.createObservableSourceRevision = async (_p, _s, draft) => draft;
  const saved = await client.saveObservableSourceRevision(project, source, {
    expectedRevision: 2, title: "Map", entryPath: "index.html", lockfilePath: null,
    changeSummary: "Update map caption", rightsStatus: "approved",
    files: [{relativePath: "index.html", blob: new Blob(["<h1>Updated map</h1>"], {type: "text/html"})}]
  });
  assert.deepEqual(uploads, ["index.html"]);
  assert.deepEqual(saved.files, [{uploadId, relativePath: "index.html"}]);
  assert.equal(saved.expectedRevision, 2);
});
