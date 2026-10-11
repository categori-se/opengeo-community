import {test} from "node:test";
import assert from "node:assert/strict";
import {archiveUploadApi, uploadArchiveBlob} from "../src/lib/archiveUploadApi.js";
const ID = "10000000-0000-4000-8000-000000000001";
const ticket = {url: "https://s3.us-east-1.amazonaws.com/private/object?X-Amz-Signature=fixture", method: "PUT", headers: {"x-amz-checksum-sha256": "fixture"}};

test("archive operations use authenticated scoped API routes with no bucket authority", async () => {
  const requests = [];
  const api = archiveUploadApi({request: async (...args) => requests.push(args)}, ID);
  await api.create(ID);
  await api.part(ID, 2, 3, "a".repeat(64));
  await api.manifest(ID, 24);
  assert.equal(requests[0][0], `/projects/${ID}/archive-uploads`);
  assert.deepEqual(requests[1][1].body, {number: 3, sha256: "a".repeat(64)});
  assert.ok(requests[2][0].endsWith("/manifest?after=24"));
  assert.throws(() => api.prepare(ID, -1));
  assert.throws(() => api.files(ID, "0&other=1"));
  assert.throws(() => archiveUploadApi({}, "../another-project"));
});

function fixture() {
  const xhr = {upload: {}, headers: {}, open(method, url) {this.method = method; this.url = url;},
    setRequestHeader(key, value) {this.headers[key] = value;}, send(blob) {this.blob = blob;},
    abort() {this.aborted = true; this.onabort();}};
  return xhr;
}

test("direct upload reports real progress and sends neither cookies nor API authorization", async () => {
  const xhr = fixture(), progress = [];
  const promise = uploadArchiveBlob(ticket, new Blob(["abc"]), {xhrFactory: () => xhr, onProgress: value => progress.push(value)});
  assert.equal(xhr.withCredentials, false);
  assert.equal(xhr.headers.Authorization, undefined);
  assert.equal(xhr.method, "PUT");
  xhr.upload.onprogress({lengthComputable: true, loaded: 2});
  assert.deepEqual(progress, [{uploadedBytes: 2, totalBytes: 3}]);
  xhr.status = 200; xhr.responseURL = ticket.url; xhr.onload();
  await promise;
});

test("abort stops current PUT and non-2xx does not mean verified", async () => {
  const xhr = fixture(), controller = new AbortController();
  const promise = uploadArchiveBlob(ticket, new Blob(), {xhrFactory: () => xhr, signal: controller.signal});
  controller.abort();
  await assert.rejects(promise, {name: "AbortError"});
  assert.equal(xhr.aborted, true);
  const rejected = fixture();
  const failure = uploadArchiveBlob(ticket, new Blob(["x"]), {xhrFactory: () => rejected});
  rejected.status = 412; rejected.onload();
  await assert.rejects(failure, /archive_signed_upload_failed/);
});

test("foreign destinations and application-auth headers are refused before sending", () => {
  assert.throws(() => uploadArchiveBlob({...ticket, url: "https://example.test/?X-Amz-Signature=fixture"}, new Blob()));
  assert.throws(() => uploadArchiveBlob({...ticket, headers: {Authorization: "secret"}}, new Blob()));
});
