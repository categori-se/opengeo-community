import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";
import {webcrypto} from "node:crypto";
import {JSDOM} from "jsdom";
import {SourceArchivePanel} from "../src/components/SourceArchivePanel.js";
import {hasSourceArchiveWorkflow, sourceArchivePlanRequest, validateSourceArchivePlan,
  sourceArchiveStartRequest, sourceArchiveControls} from "../src/lib/sourceArchival.js";

const context = {organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001", sourceDatasetId: "30000000-0000-4000-8000-000000000001",
  sourceRevisionNumber: 2};
const id = "40000000-0000-4000-8000-000000000001";
const request = sourceArchivePlanRequest(context, "metadata");
const plan = {...request, id, sha256: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z",
  fileCount: 10, totalBytes: 1000, inventoryComplete: true, estimatedExecutionCostUsd: 0.1,
  estimatedMonthlyStorageUsd: 0.01, maximumExecutionCostUsd: 5,
  destination: {connectionId: id, label: "Archive / regional", access: "public"}};
let dom, oldDocument, oldCrypto;
afterEach(() => {
  if (dom) { dom.window.close(); globalThis.document = oldDocument; Object.defineProperty(globalThis, "crypto", {value: oldCrypto, configurable: true}); dom = null; }
});

describe("source archival workflow", () => {
  it("requires the complete adapter instead of exposing a dead-end action", () => {
    assert.equal(hasSourceArchiveWorkflow({}), false);
    assert.equal(hasSourceArchiveWorkflow({createSourceArchivePlan() {}}), false);
  });
  it("requests metadata independently without making an imagery capture request", () => {
    assert.equal(request.capture, "metadata");
    assert.deepEqual(request.scope, {kind: "full_source"});
    assert.doesNotMatch(JSON.stringify(request), /s3:|https:|password|token/);
  });
  it("rejects incomplete inventories, substituted extents, unknown sizes, stale costs and other projects", () => {
    for (const change of [{inventoryComplete: false}, {scope: {kind: "bounds"}},
      {totalBytes: null}, {estimatedExecutionCostUsd: 6}, {projectId: id},
      {expiresAt: "2020-01-01T00:00:00Z"}, {sourceRevisionNumber: 1}]) {
      assert.throws(() => validateSourceArchivePlan({...plan, ...change}, request));
    }
  });
  it("requires explicit cost and rights acceptance and submits only the sealed identity", () => {
    const consent = {capture: "metadata", accepted: true, rightsConfirmed: true, idempotencyKey: id};
    assert.throws(() => sourceArchiveStartRequest(context, plan, {...consent, accepted: false}));
    const result = sourceArchiveStartRequest(context, plan, consent);
    assert.equal(result.planSha256, plan.sha256);
    assert.equal(result.acceptedMaximumExecutionCostUsd, 5);
    assert.doesNotMatch(JSON.stringify(result), /regional|https:|s3:/);
  });
  it("intersects job state with server-permitted actions", () => {
    assert.deepEqual(sourceArchiveControls({state: "running", allowedActions: ["pause"]}), ["pause"]);
    assert.deepEqual(sourceArchiveControls({state: "complete", allowedActions: ["resume"]}), []);
  });
  it("reviews before starting, retains an idempotency key after failure, and resumes a durable job", async () => {
    dom = new JSDOM("<!doctype html><body></body>");
    oldDocument = globalThis.document; oldCrypto = globalThis.crypto;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, "crypto", {value: webcrypto, configurable: true});
    const starts = [], controls = [];
    let currentJob = {id, revision: 1, state: "running", verifiedFiles: 2, totalFiles: 10,
      verifiedBytes: 200, totalBytes: 1000, allowedActions: ["pause", "cancel"]};
    const adapter = {
      async listSourceArchiveJobs() { return []; },
      async createSourceArchivePlan(actual) { assert.deepEqual(actual, request); return plan; },
      async startSourceArchiveCapture(actual) { starts.push(actual); if (starts.length === 1) throw new Error("lost response"); return currentJob; },
      async getSourceArchiveJob() { return currentJob; },
      async controlSourceArchiveJob(actual) {
        controls.push(actual); currentJob = {...currentJob, state: "paused", revision: 2, allowedActions: ["resume"]};
        return currentJob;
      }
    };
    const root = SourceArchivePanel({adapter, context});
    document.body.append(root);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const click = (label) => {
      const target = [...root.querySelectorAll("button")].find((node) => node.textContent === label);
      assert.ok(target, label); target.click();
    };
    await settle();
    assert.equal(starts.length, 0);
    click("Review size and cost"); await settle();
    assert.match(root.textContent, /Estimated monthly storage/);
    click("Start capture"); await settle();
    assert.equal(starts.length, 0);
    root.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = true; });
    click("Start capture"); await settle(); click("Start capture"); await settle();
    assert.equal(starts[0].idempotencyKey, starts[1].idempotencyKey);
    assert.match(root.textContent, /2 of 10 files verified/);
    click("Pause"); await settle();
    assert.equal(controls[0].expectedRevision, 1);
    assert.equal(controls[0].action, "pause");
    assert.match(root.textContent, /Resume/);
    root.remove();
    assert.equal(controls.length, 1, "closing a panel must not cancel capture");
  });
});
