import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {AwsDependencyError} from "../src/aws-sigv4.mjs";
import {
  AwsSqsBuildQueue,
  handleSqsEvent,
  parseBuildCommand,
  productionDependencies,
  runHostQueue
} from "../src/runtime.mjs";

const BUILD = "f0000000-0000-4000-8000-000000000451";
const BODY = JSON.stringify({
  schema: "opengeo.observable-build.command.1.0.0",
  build_job_id: BUILD
});

it("enables public reference transport only for an explicitly admitted canonical-source GitHub host", () => {
  const environment = {
    OPEN_GEO_OBSERVABLE_COORDINATOR_STAGE: "production", OPEN_GEO_AWS_REGION: "us-east-1",
    OPEN_GEO_DATA_API_CLUSTER_ARN: "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production",
    OPEN_GEO_DATA_API_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/production/coordinator-AbCd12",
    OPEN_GEO_APPLICATION_BUCKET: "source.opengeo.tools",
    OPEN_GEO_APPLICATION_KMS_KEY_ARN: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000001",
    OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`
  };
  assert.equal(productionDependencies(environment).storage.readPublicExact, undefined);
  assert.equal(productionDependencies({...environment, OPEN_GEO_PUBLIC_FILE_STAGING: "true"}).storage.readPublicExact, undefined);
  assert.throws(() => productionDependencies(environment, {enablePublicFileStaging: true}), /github_execution_identity_invalid/);
  const workflowSha = "a".repeat(40);
  Object.assign(environment, {OPEN_GEO_BUILD_SOURCE_MODE: "opengeo", OPEN_GEO_BUILD_JOB_ID: BUILD,
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", OPEN_GEO_EXPECTED_WORKFLOW_SHA: workflowSha,
    GITHUB_SHA: workflowSha, GITHUB_WORKFLOW_SHA: workflowSha, GITHUB_REF: `refs/heads/studio-runtime-${workflowSha}`,
    GITHUB_REPOSITORY: "owner/opengeo", GITHUB_REPOSITORY_ID: "123", GITHUB_RUN_ID: "456"});
  assert.equal(productionDependencies(environment).storage.readPublicExact, undefined);
  assert.equal(typeof productionDependencies(environment, {enablePublicFileStaging: true}).storage.readPublicExact, "function");
  assert.throws(() => productionDependencies({...environment, OPEN_GEO_BUILD_SOURCE_MODE: "github",
    OPEN_GEO_GITHUB_SOURCE_COMMIT: "b".repeat(40)}, {enablePublicFileStaging: true}), /public_file_staging_configuration_invalid/);
  assert.throws(() => productionDependencies(environment, {enablePublicFileStaging: "true"}), /production_configuration_invalid/);
});

function dependencies(repository) {
  return {
    expectedBucket: "source.opengeo.tools",
    repository,
    storage: {async readExact() { throw new Error("must not read"); }},
    runner: {async run() { throw new Error("must not run"); }}
  };
}

function response(status, body = {}) {
  const serialized = JSON.stringify(body);
  return new Response(serialized, {
    status,
    headers: {"content-length": String(Buffer.byteLength(serialized))}
  });
}

describe("bounded Observable coordinator host runtime", () => {
  it("accepts only the exact ID-only command schema", () => {
    assert.deepEqual(parseBuildCommand(BODY), {buildJobId: BUILD});
    for (const invalid of [
      "not-json",
      JSON.stringify({schema: "opengeo.observable-build.command.1.0.0"}),
      JSON.stringify({schema: "opengeo.observable-build.command.1.0.0", build_job_id: BUILD, bucket: "other"}),
      "x".repeat(513)
    ]) assert.throws(() => parseBuildCommand(invalid), /build_command_invalid/);
  });

  it("retries busy/dependency/command outcomes and consumes only terminal work", async () => {
    const busy = dependencies({async claim(buildJobId) {
      return {claimStatus: "busy", buildJobId};
    }});
    assert.deepEqual(
      await handleSqsEvent({Records: [{messageId: "m1", body: BODY}]}, busy),
      {batchItemFailures: [{itemIdentifier: "m1"}]}
    );
    const unavailable = dependencies({async claim() {
      throw new AwsDependencyError("data_api_unavailable");
    }});
    assert.deepEqual(
      await handleSqsEvent({Records: [
        {messageId: "m2", body: BODY},
        {messageId: "m3", body: "invalid"}
      ]}, unavailable),
      {batchItemFailures: [{itemIdentifier: "m2"}, {itemIdentifier: "m3"}]}
    );
  });

  it("uses long polling, a visibility timeout longer than the lease, and exact receipt deletion", async () => {
    const calls = [];
    const queue = new AwsSqsBuildQueue({
      region: "us-east-1",
      queueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-production-observable-builds",
      client: {async request(call) {
        calls.push(call);
        const operation = call.headers["x-amz-target"];
        if (operation.endsWith("ReceiveMessage")) {
          return response(200, {Messages: [{MessageId: "m1", ReceiptHandle: "receipt-1", Body: BODY}]});
        }
        return response(200);
      }}
    });
    const message = await queue.receive();
    assert.deepEqual(message, {messageId: "m1", receiptHandle: "receipt-1", body: BODY});
    const receivePayload = JSON.parse(calls[0].body);
    assert.equal(receivePayload.WaitTimeSeconds, 20);
    assert.equal(receivePayload.VisibilityTimeout, 1200);
    assert.equal(receivePayload.MaxNumberOfMessages, 1);
    await queue.delete(message.receiptHandle);
    assert.deepEqual(JSON.parse(calls[1].body), {
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-production-observable-builds",
      ReceiptHandle: "receipt-1"
    });
    await queue.changeVisibility(message.receiptHandle, 1200);
    assert.deepEqual(JSON.parse(calls[2].body), {
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-production-observable-builds",
      ReceiptHandle: "receipt-1",
      VisibilityTimeout: 1200
    });
  });

  it("deletes only consumed messages and exits after bounded idle receives", async () => {
    const calls = {receive: 0, delete: []};
    const queue = {
      async receive() {
        calls.receive += 1;
        return calls.receive === 1
          ? {messageId: "m1", receiptHandle: "receipt-1", body: BODY}
          : null;
      },
      async delete(receipt) { calls.delete.push(receipt); },
      async changeVisibility() {}
    };
    const result = await runHostQueue({
      queue,
      dependencies: dependencies({async claim(buildJobId) {
        return {claimStatus: "already_succeeded", buildJobId};
      }}),
      maximumIdleReceives: 1
    });
    assert.deepEqual(result, {processed: 1, stopped: "idle"});
    assert.deepEqual(calls.delete, ["receipt-1"]);
    assert.equal(calls.receive, 2);
  });
});
