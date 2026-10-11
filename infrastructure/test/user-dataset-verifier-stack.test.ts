import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {UserDatasetVerifierStack} from "../lib/user-dataset-verifier-stack.js";

function verifierTemplate(): Template {
  const app = new App();
  const env = {account: "111111111111", region: "us-east-1"};
  const config = environmentConfig("dev", "http://localhost:3000");
  const foundation = new PlatformFoundationStack(app, "Foundation", {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env
  });
  const verifier = new UserDatasetVerifierStack(app, "Verifier", {
    config,
    foundation,
    imageDigest: `sha256:${"f".repeat(64)}`,
    executionRoleArn: (
      "arn:aws:iam::111111111111:role/opengeo/dev/"
      + "OpenGeoDevDatasetConnectionVerifierRole"
    ),
    env
  });
  return Template.fromStack(verifier);
}

describe("user dataset verifier stack", () => {
  it("runs one bounded ARM64 ID-only consumer under the exact imported role", () => {
    const template = verifierTemplate();
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "opengeo-dev-user-dataset-verifier",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 25,
      ReservedConcurrentExecutions: 2,
      PackageType: "Image",
      Role: "arn:aws:iam::111111111111:role/opengeo/dev/OpenGeoDevDatasetConnectionVerifierRole",
      ImageConfig: {
        Command: ["opengeo_api.user_dataset_verification_runtime.handler"]
      },
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_DATASET_VERIFIER_STAGE: "dev",
          OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX: "opengeo-deny-canary/",
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
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "opengeo-dev-user-dataset-repository-browser",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 15,
      ReservedConcurrentExecutions: 2,
      PackageType: "Image",
      Role: "arn:aws:iam::111111111111:role/opengeo/dev/OpenGeoDevDatasetConnectionVerifierRole",
      ImageConfig: {
        Command: ["opengeo_api.dataset_repository_browser_runtime.handler"]
      }
    });
  });

  it("creates a distinct function-only database credential and bounded queues", () => {
    const template = verifierTemplate();
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "opengeo/dev/dataset-verifier/database",
      Description: "OpenGeo dev user dataset verifier database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        PasswordLength: 32
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_dataset_verifier/);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-user-dataset-verification",
      MessageRetentionPeriod: 86400,
      VisibilityTimeout: 120,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3})
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-user-dataset-verification-dlq",
      MessageRetentionPeriod: 1209600
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("adds only fixed Data API, scoped connection-secret, KMS and queue authority", () => {
    const template = verifierTemplate();
    const serialized = JSON.stringify(template.toJSON());
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({Action: "rds-data:ExecuteStatement", Effect: "Allow"}),
          Match.objectLike({Action: "secretsmanager:GetSecretValue", Effect: "Allow"}),
          Match.objectLike({Action: "kms:Decrypt", Effect: "Allow"}),
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
    assert.doesNotMatch(serialized, /s3:/);
    assert.doesNotMatch(serialized, /rds-data:(?:BeginTransaction|CommitTransaction)/);
    assert.doesNotMatch(serialized, /secretsmanager:(?:CreateSecret|DeleteSecret|ListSecrets)/);
    assert.match(serialized, /opengeo\/dev\/user-connections/);
    assert.doesNotMatch(serialized, /VpcConfig/);
  });

  it("rejects any execution role other than the exact stage-scoped role", () => {
    const app = new App();
    const env = {account: "111111111111", region: "us-east-1"};
    const config = environmentConfig("dev", "http://localhost:3000");
    const foundation = new PlatformFoundationStack(app, "Foundation", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env
    });
    assert.throws(() => new UserDatasetVerifierStack(app, "Verifier", {
      config,
      foundation,
      imageDigest: `sha256:${"f".repeat(64)}`,
      executionRoleArn: "arn:aws:iam::111111111111:role/Admin",
      env
    }), /exact scoped pre-authorized execution role/);
  });
});
