import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {createHash} from "node:crypto";
import {prepareManagedSpatialFile, parseSpatialInterchange, serializeSpatialInterchange} from "../src/lib/spatialInterchange.js";

import {
  MANAGED_FILE_ACCEPT,
  createManagedUploadSession,
  resumeManagedUpload,
  inferManagedFormat,
  ingestManagedFile,
  normalizeManagedTags,
  validateManagedUpload
} from "../src/lib/managedUpload.js";

describe("governed local-file ingestion", () => {
  it("checkpoints the upload identity before bytes and reuses the ticket after a checkpoint failure", async () => {
    let requests=0,uploads=0,checkpointFails=true;
    const file=namedBlob('bytes','notes.pdf','application/pdf');
    const session=createManagedUploadSession({projectId:'project',file,adapter:{
      requestUpload:async()=>{requests++;return {uploadId:'upload',expiresAt:'2099-01-01T00:00:00Z',upload:{secret:'not checkpointed'}};},
      uploadFile:async()=>{uploads++;},completeUpload:async()=>({dataset:{name:'Notes'},versionNumber:1})
    },beforeRequest:async value=>{assert.deepEqual(Object.keys(value),['checksumSha256']);},
      onTicket:async value=>{assert.deepEqual(value,{uploadId:'upload'});if(checkpointFails)throw Error('Local storage unavailable');}});
    await assert.rejects(session.run(),/Local storage unavailable/);assert.equal(uploads,0);
    checkpointFails=false;await session.run();assert.equal(requests,1);assert.equal(uploads,1);
  });
  it("uses the existing checksum-bound request, direct upload, and completion contract", async () => {
    const calls = [];
    const file = namedBlob('{"type":"FeatureCollection","features":[]}', "roads.geojson", "application/geo+json");
    const adapter = {
      async requestUpload(projectId, metadata) {
        calls.push(["request", projectId, metadata]);
        return {
          uploadId: "81000000-0000-4000-8000-000000000001",
          expiresAt: "2099-08-20T12:00:00Z",
          upload: {method: "POST", url: "https://example.test/upload", fields: {}}
        };
      },
      async uploadFile(upload, source) {
        calls.push(["upload", upload, source]);
      },
      async completeUpload(projectId, uploadId) {
        calls.push(["complete", projectId, uploadId]);
        return {dataset: {name: "Roads"}, versionNumber: 1};
      }
    };
    const stages = [];

    const completion = await ingestManagedFile({
      adapter,
      projectId: "50000000-0000-4000-8000-000000000001",
      file,
      tags: ["Local", "local", "Planning"],
      onStage: (stage) => stages.push(stage)
    });

    assert.equal(completion.versionNumber, 1);
    assert.deepEqual(stages, ["hashing", "requesting", "uploading", "verifying", "queued"]);
    assert.equal(calls[0][0], "request");
    assert.equal(calls[0][2].format, "geojson");
    assert.equal(calls[0][2].contentType, "application/geo+json");
    assert.match(calls[0][2].checksumSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls[0][2].tags, ["local", "planning"]);
    assert.equal(calls[1][0], "upload");
    assert.equal(calls[2][0], "complete");
  });

  it("recognizes the complete managed format boundary and rejects mismatches", () => {
    assert.equal(inferManagedFormat("atlas.gpkg"), "geopackage");
    assert.equal(inferManagedFormat("notes.exe"), null);
    assert.match(MANAGED_FILE_ACCEPT, /\.geojson/);
    assert.match(MANAGED_FILE_ACCEPT, /\.pdf/);
    const file = namedBlob("bytes", "roads.csv", "text/csv");
    assert.equal(validateManagedUpload({file, name: "Roads", format: "csv"}).contentType, "text/csv");
    assert.throws(() => validateManagedUpload({file, name: "Roads", format: "geojson"}), /http_422/);
    assert.throws(() => normalizeManagedTags(Array.from({length: 13}, (_, index) => `tag-${index}`)), /http_422/);
  });

  it("fails before any upload when the signed ticket is expired", async () => {
    let uploaded = false;
    const adapter = {
      async requestUpload() {
        return {uploadId: "expired", expiresAt: "2000-01-01T00:00:00Z", upload: {}};
      },
      async uploadFile() { uploaded = true; },
      async completeUpload() { throw new Error("must not complete"); }
    };
    await assert.rejects(
      ingestManagedFile({adapter, projectId: "project", file: namedBlob("x", "a.csv", "text/csv"), name: "CSV"}),
      (error) => error.code === "upload_expired"
    );
    assert.equal(uploaded, false);
  });
});

function namedBlob(contents, name, type) {
  const blob = new Blob([contents], {type});
  Object.defineProperty(blob, "name", {value: name});
  return blob;
}


describe("managed conversion upload handoff", () => {
  it("binds normalized bytes and reopens provenance for WKT and whitespace-padded EWKB", async () => {
    const wkt = "POINT (85.324 27.7172)";
    const geometry = parseSpatialInterchange(wkt, {format: "wkt"}).geojson;
    const ewkb = serializeSpatialInterchange(geometry, {format: "wkb", wkbEncoding: "hex"}).content;
    const cases = [new File([wkt], "survey.wkt"), new File(["  ", ewkb, "\n"], "survey.ewkb")];
    for (const original of cases) {
      const prepared = await prepareManagedSpatialFile(original);
      let request, stored;
      const calls = [];
      const adapter = {
        async requestUpload(projectId, metadata) {
          assert.equal(projectId, "project");
          request = structuredClone(metadata); calls.push("request");
          return {uploadId: "upload", expiresAt: "2099-01-01T00:00:00Z", upload: {}};
        },
        async uploadFile(_ticket, file) {
          calls.push("upload"); stored = Buffer.from(await file.arrayBuffer());
          assert.equal(createHash("sha256").update(stored).digest("hex"), request.checksumSha256);
          assert.equal(stored.length, request.sizeBytes);
        },
        async completeUpload(projectId, uploadId) {
          assert.equal(projectId, "project"); assert.equal(uploadId, "upload"); calls.push("complete");
          return {dataset: {name: "Survey"}, versionNumber: 1};
        }
      };
      await ingestManagedFile({adapter, projectId: "project", file: prepared.file});
      assert.deepEqual(calls, ["request", "upload", "complete"]);
      assert.equal(request.format, "geojson");
      const reopened = parseSpatialInterchange(stored.toString("utf8"), {format: "geojson"}).geojson;
      const provenance = reopened["opengeo:conversion"];
      assert.equal(provenance.source.fileName, original.name);
      assert.equal(provenance.source.byteLength, original.size);
      assert.equal(provenance.source.checksumSha256, createHash("sha256").update(Buffer.from(await original.arrayBuffer())).digest("hex"));
      assert.equal(provenance.source.originalBytesArchived, false);
      assert.deepEqual(provenance.report, prepared.report.report);
      assert.deepEqual(reopened.features[0].geometry.coordinates, [85.324, 27.7172]);
    }
  });
});


describe("same-identity interrupted upload recovery", () => {
  it("completes an accepted object after renewal without sending bytes", async () => {
    let calls=0, renewals=0;
    const result=await resumeManagedUpload({projectId:'p',uploadId:'u',adapter:{
      completeUpload:async(p,id)=>{assert.equal(id,'u');if(++calls===1)throw Object.assign(Error(),{code:'upload_expired'});return 'complete';},
      renewUpload:async()=>{renewals++;return {uploadId:'u'};},
      uploadFile:async()=>{throw Error('must not transfer');}
    }});
    assert.equal(result,'complete');assert.equal(renewals,1);assert.equal(calls,2);
  });
  it("transfers missing bytes only after renewed completion confirms absence", async () => {
    const file=namedBlob('bytes','notes.pdf','application/pdf'), calls=[];
    const checksumSha256=createHash('sha256').update('bytes').digest('hex');
    const adapter={
      completeUpload:async()=>{calls.push('complete');if(calls.length<5)throw Object.assign(Error(),{code:'upload_object_missing'});return 'done';},
      renewUpload:async()=>{calls.push('renew');return {uploadId:'u',expiresAt:'2099-01-01',upload:{}};},
      uploadFile:async(_,bytes)=>{calls.push('transfer');assert.equal(bytes,file);}
    };
    assert.equal(await resumeManagedUpload({adapter,projectId:'p',uploadId:'u',file,checksumSha256}),'done');
    assert.deepEqual(calls,['complete','renew','complete','transfer','complete']);
  });
  it("does not renew after authorization refusal", async () => {
    await assert.rejects(resumeManagedUpload({projectId:'p',uploadId:'u',adapter:{
      completeUpload:async()=>{throw Object.assign(Error('denied'),{code:'action_forbidden'});},
      renewUpload:async()=>{throw Error('must not renew');}
    }}),/denied/);
  });
});
