import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {environmentConfig, type Stage} from "../lib/config.js";
import {ObservableCoordinatorStack} from "../lib/observable-coordinator-stack.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {PrivateRuntimeEndpointsStack} from "../lib/private-runtime-endpoints-stack.js";
import {WorkerServiceStack} from "../lib/worker-service-stack.js";

const ENV = {account: "111111111111", region: "us-east-1"};
const WORKER_IMAGE = `sha256:${"c".repeat(64)}`;
const COMPILER_IMAGE = `sha256:${"d".repeat(64)}`;

function endpointTemplate({
  stage = "dev",
  worker,
  coordinator
}: {
  stage?: Stage;
  worker: boolean;
  coordinator: boolean;
}): Template {
  const app = new App();
  const config = environmentConfig(
    stage,
    stage === "dev" ? "http://localhost:3000" : `https://${stage}.opengeo.example.com`
  );
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env: ENV
  });
  const endpoints = new PrivateRuntimeEndpointsStack(app, `Endpoints-${stage}`, {
    config,
    foundation,
    enableWorker: worker,
    enableObservableCoordinator: coordinator,
    env: ENV
  });
  return Template.fromStack(endpoints);
}

describe("shared private runtime endpoint boundary", () => {
  it("uses only each standalone runtime's directly called interfaces plus one S3 gateway", () => {
    for (const [flags, interfaceCount] of [
      [{worker: true, coordinator: false}, 5],
      [{worker: false, coordinator: true}, 3]
    ] as const) {
      const template = endpointTemplate(flags);
      template.resourceCountIs("AWS::EC2::VPCEndpoint", interfaceCount + 1);
      template.resourceCountIs("AWS::EC2::SecurityGroup", 1);
      const endpoints = Object.values(template.toJSON().Resources as Record<
        string, {Type: string; Properties: {VpcEndpointType?: string; PrivateDnsEnabled?: boolean}}
      >).filter((resource) => resource.Type === "AWS::EC2::VPCEndpoint");
      assert.equal(endpoints.filter((resource) =>
        resource.Properties.VpcEndpointType === "Interface").length, interfaceCount);
      assert.equal(endpoints.filter((resource) =>
        resource.Properties.VpcEndpointType === "Gateway").length, 1);
      assert.ok(endpoints.filter((resource) =>
        resource.Properties.VpcEndpointType === "Interface").every((resource) =>
        resource.Properties.PrivateDnsEnabled === true));
    }
    const workerOnly = JSON.stringify(endpointTemplate({
      worker: true, coordinator: false
    }).toJSON());
    assert.doesNotMatch(workerOnly, /rds-data|\.kms/);
    const coordinatorOnly = JSON.stringify(endpointTemplate({
      worker: false, coordinator: true
    }).toJSON());
    assert.doesNotMatch(coordinatorOnly, /ecr\.api|ecr\.dkr|secretsmanager|\.kms/);
  });

  it("deduplicates the combined service union to six paid endpoints", () => {
    const template = endpointTemplate({worker: true, coordinator: true});
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 7);
    template.resourceCountIs("AWS::EC2::SecurityGroup", 2);
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /AWS::EC2::NatGateway/);
    for (const service of [
      "ecr.api", "ecr.dkr", "logs", "secretsmanager", "sqs", "rds-data"
    ]) assert.match(serialized, new RegExp(`${service.replace(".", "\\.")}`));
    const interfaces = Object.values(template.toJSON().Resources as Record<
      string, {Type: string; Properties: {
        VpcEndpointType?: string;
        ServiceName?: unknown;
        SecurityGroupIds?: unknown[];
      }}
    >).filter((resource) => resource.Type === "AWS::EC2::VPCEndpoint"
      && resource.Properties.VpcEndpointType === "Interface");
    for (const endpoint of interfaces) {
      const service = JSON.stringify(endpoint.Properties.ServiceName);
      const shared = service.includes("logs") || service.includes("sqs");
      assert.equal(endpoint.Properties.SecurityGroupIds?.length, shared ? 2 : 1);
    }
  });

  it("places production endpoint ENIs in both isolated availability zones", () => {
    const template = endpointTemplate({
      stage: "production", worker: true, coordinator: true
    });
    const interfaces = Object.values(template.toJSON().Resources as Record<
      string, {Type: string; Properties: {VpcEndpointType?: string; SubnetIds?: unknown[]}}
    >).filter((resource) => resource.Type === "AWS::EC2::VPCEndpoint"
      && resource.Properties.VpcEndpointType === "Interface");
    assert.equal(interfaces.length, 6);
    assert.ok(interfaces.every((resource) => resource.Properties.SubnetIds?.length === 2));
  });

  it("rejects an ownerless endpoint stack", () => {
    const app = new App();
    const config = environmentConfig("dev", "http://localhost:3000");
    const foundation = new PlatformFoundationStack(app, "Foundation-invalid", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env: ENV
    });
    assert.throws(() => new PrivateRuntimeEndpointsStack(app, "Endpoints-invalid", {
      config,
      foundation,
      enableWorker: false,
      enableObservableCoordinator: false,
      env: ENV
    }), /at least one enabled runtime/);
  });

  it("synthesizes worker and coordinator together without a cross-stack cycle", () => {
    const app = new App();
    const config = environmentConfig("dev", "http://localhost:3000");
    const foundation = new PlatformFoundationStack(app, "Foundation-combined", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env: ENV
    });
    const endpoints = new PrivateRuntimeEndpointsStack(app, "Endpoints-combined", {
      config,
      foundation,
      enableWorker: true,
      enableObservableCoordinator: true,
      env: ENV
    });
    new WorkerServiceStack(app, "Worker-combined", {
      config, foundation, runtimeEndpoints: endpoints, imageDigest: WORKER_IMAGE, env: ENV
    });
    new ObservableCoordinatorStack(app, "Coordinator-combined", {
      config,
      foundation,
      runtimeEndpoints: endpoints,
      runnerAmiId: "ami-aaaaaaaaaaaaaaaaa",
      runnerAmiEvidenceSha256: "e".repeat(64),
      compilerImageDigest: COMPILER_IMAGE,
      env: ENV
    });
    assert.doesNotThrow(() => app.synth());
  });
});
