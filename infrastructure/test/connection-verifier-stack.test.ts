import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {ApiServiceStack} from "../lib/api-service-stack.js";
import {ConnectionVerifierStack} from "../lib/connection-verifier-stack.js";
import {environmentConfig, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";

function verifierTemplateFor(stage: Stage): Template {
  const app = new App();
  const env = {account: "111111111111", region: "us-east-1"};
  const config = environmentConfig(
    stage,
    stage === "dev"
      ? "http://localhost:3000"
      : `https://${stage}.opengeo.example.com`
  );
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env
  });
  const verifier = new ConnectionVerifierStack(app, `Verifier-${stage}`, {
    config,
    foundation,
    imageDigest: `sha256:${"e".repeat(64)}`,
    env
  });
  return Template.fromStack(verifier);
}

describe("external connection verifier stack", () => {
  it("runs one bounded ARM64 identity-only SQS consumer from an exact image digest", () => {
    const template = verifierTemplateFor("dev");

    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 20,
      ReservedConcurrentExecutions: 2,
      PackageType: "Image",
      ImageConfig: {
        Command: ["opengeo_api.connection_verification_runtime.handler"]
      },
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_CONNECTION_VERIFIER_STAGE: "dev",
          OPEN_GEO_DATA_API_REGION: "us-east-1",
          OPEN_GEO_DB_NAME: "opengeo"
        })
      }
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: {MaximumConcurrency: 2},
      Enabled: true
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, new RegExp(`sha256:${"e".repeat(64)}`));
    assert.doesNotMatch(serialized, /VpcConfig/);
  });

  it("uses an isolated connector credential and bounded retry queues", () => {
    const template = verifierTemplateFor("dev");

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Description: "OpenGeo dev external connection verifier database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        PasswordLength: 32
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_connector/);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-connection-verification",
      MessageRetentionPeriod: 86400,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 120,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3})
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-connection-verification-dlq",
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("grants only fixed-function coordination, exact secret reads, scoped decrypt, and queue consumption", () => {
    const template = verifierTemplateFor("dev");
    const serialized = JSON.stringify(template.toJSON());

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "rds-data:ExecuteStatement",
            Effect: "Allow"
          }),
          Match.objectLike({
            Action: "secretsmanager:GetSecretValue",
            Effect: "Allow",
            Resource: Match.arrayWith([
              Match.objectLike({Ref: Match.anyValue()}),
              Match.objectLike({"Fn::Join": Match.anyValue()})
            ])
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
            Effect: "Allow",
            Condition: {
              StringEquals: {
                "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com"
              },
              StringLike: Match.objectLike({
                "kms:EncryptionContext:SecretARN": Match.anyValue()
              })
            }
          }),
          Match.objectLike({
            Action: Match.arrayWith([
              "sqs:ReceiveMessage",
              "sqs:ChangeMessageVisibility",
              "sqs:DeleteMessage"
            ]),
            Effect: "Allow"
          })
        ])
      }
    });
    assert.match(serialized, /opengeo\/dev\/connections\/\*/);
    assert.doesNotMatch(serialized, /secretsmanager:(?:CreateSecret|DeleteSecret|ListSecrets)/);
    assert.doesNotMatch(serialized, /rds-data:(?:BeginTransaction|CommitTransaction)/);
    assert.doesNotMatch(serialized, /s3:/);
    assert.doesNotMatch(serialized, /cognito-idp:/);
  });

  it("caps production invocation and poller concurrency together", () => {
    const template = verifierTemplateFor("production");
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 16
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      ScalingConfig: {MaximumConcurrency: 16}
    });
  });

  it("gives both API shapes send-only access and the exact queue URL", () => {
    const app = new App();
    const env = {account: "111111111111", region: "us-east-1"};
    const config = environmentConfig("dev", "http://localhost:3000");
    const foundation = new PlatformFoundationStack(app, "Foundation", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env
    });
    const verifier = new ConnectionVerifierStack(app, "Verifier", {
      config,
      foundation,
      imageDigest: `sha256:${"e".repeat(64)}`,
      env
    });
    const serverless = new ServerlessApiStack(app, "Serverless", {
      config,
      foundation,
      connectionVerificationQueue: verifier.queue,
      imageDigest: `sha256:${"d".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });
    const transitional = new ApiServiceStack(app, "Transitional", {
      config,
      foundation,
      connectionVerificationQueue: verifier.queue,
      imageDigest: `sha256:${"a".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });

    for (const template of [
      Template.fromStack(serverless),
      Template.fromStack(transitional)
    ]) {
      const serialized = JSON.stringify(template.toJSON());
      assert.match(serialized, /OPEN_GEO_CONNECTION_VERIFICATION_QUEUE_URL/);
      assert.match(serialized, /sqs:SendMessage/);
      assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
      assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
    }
  });
});
