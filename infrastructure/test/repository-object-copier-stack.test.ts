import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {ApiServiceStack} from "../lib/api-service-stack.js";
import {environmentConfig, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {RepositoryObjectCopierStack} from "../lib/repository-object-copier-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";

const account = "111111111111";
const region = "us-east-1";

function fixture(stage: Stage): {
  app: App;
  config: ReturnType<typeof environmentConfig>;
  foundation: PlatformFoundationStack;
  copier: RepositoryObjectCopierStack;
} {
  const app = new App();
  const config = environmentConfig(
    stage,
    stage === "dev" ? "http://localhost:3000" : `https://${stage}.opengeo.example.com`
  );
  const env = {account, region};
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env
  });
  const title = stage.charAt(0).toUpperCase() + stage.slice(1);
  const copier = new RepositoryObjectCopierStack(app, `Copier-${stage}`, {
    config,
    foundation,
    imageDigest: `sha256:${"f".repeat(64)}`,
    executionRoleArn:
      `arn:aws:iam::${account}:role/opengeo/${stage}/`
      + `OpenGeo${title}RepositoryObjectCopierRole`,
    env
  });
  return {app, config, foundation, copier};
}

describe("exact repository object copier stack", () => {
  it("runs a bounded ARM64 identity-only consumer outside a VPC", () => {
    const template = Template.fromStack(fixture("dev").copier);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      MemorySize: 1024,
      EphemeralStorage: {Size: 3072},
      Timeout: 900,
      ReservedConcurrentExecutions: 2,
      PackageType: "Image",
      ImageConfig: {Command: ["opengeo_api.repository_object_copier_runtime.handler"]},
      Environment: {Variables: Match.objectLike({
        OPEN_GEO_DATASET_VERIFIER_STAGE: "dev",
        OPEN_GEO_DB_NAME: "opengeo",
        OPEN_GEO_PROCESSING_QUEUE_URL: Match.anyValue()
      })}
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: {MaximumConcurrency: 2},
      Enabled: true
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, new RegExp(`sha256:${"f".repeat(64)}`));
    assert.doesNotMatch(serialized, /VpcConfig/);
  });

  it("uses a dedicated function-only database identity and bounded queues", () => {
    const template = Template.fromStack(fixture("dev").copier);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "opengeo/dev/repository-copier/database",
      Description: "OpenGeo dev repository copier database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        PasswordLength: 32
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_repository_copier/);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-repository-copy",
      MessageRetentionPeriod: 86400,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 960,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3})
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("has exact destination authority and no direct broad source access", () => {
    const serialized = JSON.stringify(
      Template.fromStack(fixture("dev").copier).toJSON()
    );
    assert.match(serialized, /organizations\/\*\/projects\/\*\/datasets\/\*\/uploads\/\*\/original\/\*/);
    assert.match(serialized, /opengeo\/dev\/user-connections\/\*/);
    assert.match(serialized, /rds-data:ExecuteStatement/);
    assert.match(serialized, /sqs:SendMessage/);
    assert.match(serialized, /sqs:ReceiveMessage/);
    assert.doesNotMatch(serialized, /s3:ListBucket/);
    assert.doesNotMatch(serialized, /s3:DeleteObject/);
    assert.doesNotMatch(serialized, /secretsmanager:(?:CreateSecret|DeleteSecret|ListSecrets)/);
    assert.doesNotMatch(serialized, /cognito-idp:/);
    assert.doesNotMatch(serialized, /sqs:PurgeQueue/);
  });

  it("rejects any execution role outside the exact stage and account", () => {
    const {app, config, foundation} = fixture("dev");
    assert.throws(
      () => new RepositoryObjectCopierStack(app, "WrongCopier", {
        config,
        foundation,
        imageDigest: `sha256:${"f".repeat(64)}`,
        executionRoleArn:
          `arn:aws:iam::${account}:role/opengeo/dev/OpenGeoDevOperatorRole`,
        env: {account, region}
      }),
      /exact scoped pre-authorized execution role/
    );
  });

  it("gives both API runtimes send-only authority and the exact queue URL", () => {
    const {app, config, foundation, copier} = fixture("dev");
    const env = {account, region};
    const serverless = new ServerlessApiStack(app, "Serverless", {
      config,
      foundation,
      repositoryObjectCopyQueue: copier.queue,
      imageDigest: `sha256:${"d".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });
    const transitional = new ApiServiceStack(app, "Transitional", {
      config,
      foundation,
      repositoryObjectCopyQueue: copier.queue,
      imageDigest: `sha256:${"a".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });

    for (const template of [
      Template.fromStack(serverless),
      Template.fromStack(transitional)
    ]) {
      const serialized = JSON.stringify(template.toJSON());
      assert.match(serialized, /OPEN_GEO_REPOSITORY_OBJECT_COPY_QUEUE_URL/);
      assert.match(serialized, /sqs:SendMessage/);
      assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
      assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
    }
  });
});
