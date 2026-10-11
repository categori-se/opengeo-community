import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {ObservableCoordinatorStack} from "../lib/observable-coordinator-stack.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {PrivateRuntimeEndpointsStack} from "../lib/private-runtime-endpoints-stack.js";

const ENV = {account: "111111111111", region: "us-east-1"};
const IMAGE = `sha256:${"d".repeat(64)}`;
const AMI = "ami-aaaaaaaaaaaaaaaaa";
const AMI_EVIDENCE = "e".repeat(64);

function coordinatorTemplate(): Template {
  const app = new App();
  const config = environmentConfig("dev", "http://localhost:3000");
  const foundation = new PlatformFoundationStack(app, "Foundation", {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env: ENV
  });
  const runtimeEndpoints = new PrivateRuntimeEndpointsStack(app, "PrivateRuntimeEndpoints", {
    config,
    foundation,
    enableWorker: false,
    enableObservableCoordinator: true,
    env: ENV
  });
  const coordinator = new ObservableCoordinatorStack(app, "Coordinator", {
    config,
    foundation,
    runtimeEndpoints,
    runnerAmiId: AMI,
    runnerAmiEvidenceSha256: AMI_EVIDENCE,
    compilerImageDigest: IMAGE,
    env: ENV
  });
  return Template.fromStack(coordinator);
}

describe("scale-to-zero Observable coordinator stack", () => {
  it("uses a bounded encrypted queue and seals poison commands in a DLQ", () => {
    const template = coordinatorTemplate();
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-observable-builds",
      SqsManagedSseEnabled: true,
      ReceiveMessageWaitTimeSeconds: 20,
      VisibilityTimeout: 1200,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3})
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-observable-builds-dlq",
      SqsManagedSseEnabled: true
    });
  });

  it("runs only the operator-supplied ARM64 host image at exact zero-or-one capacity", () => {
    const template = coordinatorTemplate();
    template.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {
      MinSize: "0",
      DesiredCapacity: "0",
      MaxSize: "1"
    });
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        ImageId: AMI,
        InstanceType: "t4g.large",
        MetadataOptions: Match.objectLike({HttpTokens: "required"}),
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({Ebs: Match.objectLike({Encrypted: true, VolumeSize: 40})})
        ])
      })
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, /ExportsOutputRefVpcdataSubnet1Subnet/);
    assert.match(serialized, /opengeo-observable-coordinator\.service/);
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST/);
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_LOG_GROUP_NAME/);
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_RUNNER_AMI_EVIDENCE_SHA256/);
    assert.match(serialized, /amazon-cloudwatch-agent-ctl/);
    assert.match(serialized, /chown root:opengeo-coordinator/);
    assert.doesNotMatch(serialized, /AWS::ECS::TaskDefinition/);
  });

  it("keeps the trusted host in isolated subnets behind its shared private API boundary", () => {
    const template = coordinatorTemplate();
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      Description: "Observable coordinator to shared private AWS APIs",
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443
    });
    template.hasResourceProperties("AWS::EC2::SecurityGroupEgress", {
      Description: "Observable coordinator to shared private AWS APIs",
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /CidrIp":"0\.0\.0\.0\/0","FromPort":0/);
    assert.doesNotMatch(serialized, /AWS::EC2::NatGateway/);
  });

  it("grants only queue consume, fixed Data API functions, and exact source/output objects", () => {
    const template = coordinatorTemplate();
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, /rds-data:ExecuteStatement/);
    assert.match(serialized, /sqs:ReceiveMessage/);
    assert.match(serialized, /sqs:DeleteMessage/);
    assert.match(serialized, /source-projects\/\*\/uploads\/\*\/files\/\*/);
    assert.match(serialized, /source-projects\/\*\/builds\/\*\/output\/\*/);
    assert.match(serialized, /OPEN_GEO_ARCHIVE_BUCKET=/);
    const archiveStatements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Resource).includes("datasets/*/uploads/*/original/*"));
    assert.equal(archiveStatements.length, 1);
    assert.deepEqual([archiveStatements[0].Action].flat(), ["s3:GetObjectVersion"]);
    assert.match(JSON.stringify(archiveStatements[0].Resource), /datasets\/\*\/versions\/\*\/derivatives\/\*/);
    assert.doesNotMatch(serialized, /rds-data:BeginTransaction/);
    assert.doesNotMatch(serialized, /s3:DeleteObject/);
    assert.doesNotMatch(serialized, /s3:ListBucket/);
    assert.doesNotMatch(serialized, /cognito-idp:/);
    assert.doesNotMatch(serialized, /ecr:/);
  });

  it("rejects mutable compiler identities and unresolved runner images", () => {
    const config = environmentConfig("dev", "http://localhost:3000");
    const app = new App();
    const foundation = new PlatformFoundationStack(app, "Foundation-invalid", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env: ENV
    });
    const runtimeEndpoints = new PrivateRuntimeEndpointsStack(
      app,
      "PrivateRuntimeEndpoints-invalid",
      {
        config,
        foundation,
        enableWorker: false,
        enableObservableCoordinator: true,
        env: ENV
      }
    );
    assert.throws(() => new ObservableCoordinatorStack(app, "BadAmi", {
      config, foundation, runtimeEndpoints, runnerAmiId: "ami-latest", runnerAmiEvidenceSha256: AMI_EVIDENCE, compilerImageDigest: IMAGE, env: ENV
    }), /exact AMI id/);
    assert.throws(() => new ObservableCoordinatorStack(app, "BadImage", {
      config, foundation, runtimeEndpoints, runnerAmiId: AMI, runnerAmiEvidenceSha256: AMI_EVIDENCE, compilerImageDigest: "builder:latest", env: ENV
    }), /exact sha256 digest/);
    assert.throws(() => new ObservableCoordinatorStack(app, "BadEvidence", {
      config, foundation, runtimeEndpoints, runnerAmiId: AMI, runnerAmiEvidenceSha256: "pending", compilerImageDigest: IMAGE, env: ENV
    }), /evidence must be an exact SHA-256/);
  });
});
