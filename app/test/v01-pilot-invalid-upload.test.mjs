import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";
import {verifyInvalidPilotUpload} from "../scripts/run-v01-pilot-acceptance.mjs";

function setup(mutate = () => {}) {
  const calls = [];
  let checksum;
  const dataset = {id: "dataset", projectId: "project", currentVersionId: "version", status: "failed",
    currentVersionState: "failed", processingJobState: "failed", processingErrorCode: "dataset_magic_mismatch", qualityResults: {valid: false}};
  const version = {id: "version", state: "failed", current: true, objects: [{role: "original"}]};
  const behavior = {dataset, version, versions: [version], completion: {processingJobId: "job", datasetVersionId: "version"}, rejectDerivative: true};
  mutate(behavior);
  let completions = 0;
  const args = {
    projectId: "project", suffix: "test-only", timeoutMs: 1000,
    client: {
      requestUpload: async (project, request) => {
        calls.push("request"); assert.equal(project, "project");
        assert.equal(request.classification, "internal"); assert.equal(request.format, "geojson");
        checksum = request.checksumSha256;
        if (!Object.hasOwn(version.objects[0], "checksumSha256")) version.objects[0].checksumSha256 = checksum;
        return {uploadId: "upload", dataset: {id: "dataset"}, upload: {opaque: "ticket"}};
      },
      uploadFile: async (ticket, blob) => {
        calls.push("upload"); assert.deepEqual(ticket, {opaque: "ticket"});
        const bytes = Buffer.from(await blob.arrayBuffer());
        assert.equal(bytes.toString(), "OpenGeo invalid GeoJSON acceptance fixture\n");
        assert.ok(bytes.length < 100);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), checksum);
      },
      completeUpload: async (project, uploadId) => {
        calls.push("complete"); assert.equal(project, "project"); assert.equal(uploadId, "upload");
        completions++;
        return completions > 1 && behavior.replay ? behavior.replay : behavior.completion;
      },
      getDataset: async (project, id) => {calls.push("dataset"); assert.equal(project,"project"); assert.equal(id,"dataset"); return dataset;},
      listDatasetVersions: async () => {calls.push("versions"); return behavior.versions;},
      createPmtilesDerivative: async (project, id, versionId) => {
        calls.push("derive"); assert.deepEqual([project,id,versionId],["project","dataset","version"]);
        if (behavior.rejectDerivative) throw Object.assign(new Error("ineligible"), {code: "pmtiles_derivative_source_ineligible"});
        return {jobId: "unexpected-job"};
      }
    },
    poll: async ({load, done, failed}) => {
      const value = await load();
      assert.ok(done(value));
      if (failed(value)) throw new Error("unexpected terminal state");
      return value;
    },
    inspectFailure: async (id, code) => {
      calls.push("browser"); assert.equal(id,"dataset"); assert.equal(code,"dataset_magic_mismatch");
      if (behavior.browserFails) throw new Error("no visible diagnosis");
    }
  };
  return {args, calls};
}

describe("invalid-upload pilot acceptance", () => {
  it("retains a bounded invalid original and requires diagnosis after exact derivative denial", async () => {
    const {args, calls} = setup();
    const evidence = await verifyInvalidPilotUpload(args);
    assert.deepEqual(calls, ["request", "upload", "complete", "complete", "dataset", "versions", "derive", "browser"]);
    assert.equal(evidence.inputSha256, evidence.originalSha256);
    assert.deepEqual(Object.keys(evidence).sort(), ["inputSha256", "originalSha256"]);
  });

  it("rejects false success, wrong failure, wrong identities, duplicate versions and unexpected artifacts", async () => {
    for (const mutate of [
      (s) => {s.dataset.status = "active";},
      (s) => {s.dataset.processingErrorCode = "malware_scanner_unavailable";},
      (s) => {s.dataset.currentVersionId = "other-version";},
      (s) => {s.dataset.projectId = "another-project";},
      (s) => {s.dataset.processingJobState = "running";},
      (s) => {s.dataset.qualityResults.valid = true;},
      (s) => {s.versions.push({...s.version});},
      (s) => {s.version.current = false;},
      (s) => {s.version.objects.push({role: "preview"});},
      (s) => {s.version.objects[0].checksumSha256 = "0".repeat(64);},
      (s) => {s.replay = {processingJobId: "duplicate", datasetVersionId: "version"};}
    ]) {
      const {args, calls} = setup(mutate);
      await assert.rejects(verifyInvalidPilotUpload(args));
      assert.ok(!calls.includes("browser"));
    }
  });

  it("cannot pass without browser diagnosis or when failed data enters processing", async () => {
    const missing = setup();
    await assert.rejects(verifyInvalidPilotUpload({...missing.args, inspectFailure: null}), /Browser diagnosis is required/);
    assert.deepEqual(missing.calls, []);
    for (const mutate of [(s) => {s.rejectDerivative = false;}, (s) => {s.browserFails = true;}]) {
      await assert.rejects(verifyInvalidPilotUpload(setup(mutate).args));
    }
  });
});
