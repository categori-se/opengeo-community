import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {ApiServiceStack} from "../lib/api-service-stack.js";
import {environmentConfig, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";
import {SourceArchiverStack} from "../lib/source-archiver-stack.js";

function templateFor(stage: Stage): Template {
  const app = new App();
  const env = {account: "111111111111", region: "us-east-1"};
  const config = environmentConfig(
    stage,
    stage === "dev" ? "http://localhost:3000" : `https://${stage}.opengeo.example.com`
  );
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env
  });
  const stack = new SourceArchiverStack(app, `Archiver-${stage}`, {
    config,
    foundation,
    imageDigest: `sha256:${"f".repeat(64)}`,
    env
  });
  return Template.fromStack(stack);
}

describe("anonymous source archiver stack", () => {
  it("runs an ARM64 identity-only consumer with bounded concurrency and no VPC", () => {
    const template = templateFor("dev");
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      MemorySize: 1024,
      Timeout: 900,
      ReservedConcurrentExecutions: 2,
      PackageType: "Image",
      ImageConfig: {Command: ["opengeo_api.source_archiver_runtime.handler"]},
      Environment: {Variables: Match.objectLike({
        OPEN_GEO_SOURCE_ARCHIVER_STAGE: "dev",
        OPEN_GEO_AWS_REGION: "us-east-1",
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
    const template = templateFor("dev");
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Description: "OpenGeo dev source archiver database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        PasswordLength: 32
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_source_archiver/);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-source-archive",
      MessageRetentionPeriod: 86400,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 960,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3})
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opengeo-dev-source-archive-dlq",
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("has exact upload-prefix S3 authority and no connection-secret access", () => {
    const template = templateFor("dev");
    const serialized = JSON.stringify(template.toJSON());
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {Statement: Match.arrayWith([
        Match.objectLike({Action: "rds-data:ExecuteStatement", Effect: "Allow"}),
        Match.objectLike({
          Action: Match.arrayWith(["s3:PutObject", "s3:GetObjectVersion"]),
          Effect: "Allow",
          Resource: Match.objectLike({"Fn::Join": Match.anyValue()})
        }),
        Match.objectLike({
          Action: Match.arrayWith(["kms:Decrypt", "kms:GenerateDataKey"]),
          Condition: Match.objectLike({
            StringEquals: Match.objectLike({
              "kms:ViaService": "s3.us-east-1.amazonaws.com",
              "kms:EncryptionContext:aws:s3:arn": Match.objectLike({
                "Fn::ImportValue": Match.anyValue()
              })
            })
          }),
          Effect: "Allow"
        }),
        Match.objectLike({
          Action: "sqs:SendMessage",
          Effect: "Allow",
          Resource: Match.objectLike({"Fn::ImportValue": Match.anyValue()})
        }),
        Match.objectLike({
          Action: Match.arrayWith([
            "sqs:ReceiveMessage", "sqs:ChangeMessageVisibility", "sqs:DeleteMessage"
          ]),
          Effect: "Allow"
        })
      ])}
    });
    assert.match(serialized, /organizations\/\*\/projects\/\*\/datasets\/\*\/uploads\/\*\/original\/\*/);
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const metadataStatements = statements
      .filter((statement) => JSON.stringify(statement.Resource).includes("discovery-metadata"));
    assert.equal(metadataStatements.length, 1);
    assert.equal(metadataStatements[0].Effect, "Allow");
    assert.deepEqual([...metadataStatements[0].Action].sort(), [
      "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"
    ]);
    assert.match(JSON.stringify(metadataStatements[0].Resource),
      /"\/discovery-metadata\/organizations\/\*\/projects\/\*\/jobs\/\*\/response\.bin"/);
    const listingStatements = statements.filter((statement) =>
      [statement.Action].flat().some((action) => action.startsWith("s3:ListBucket")));
    assert.equal(listingStatements.length, 1);
    assert.equal(listingStatements[0].Action, "s3:ListBucket");
    assert.equal(listingStatements[0].Effect, "Allow");
    assert.deepEqual(listingStatements[0].Condition, {
      StringLike: {
        "s3:prefix": "discovery-metadata/organizations/*/projects/*/jobs/*/response.bin"
      },
      NumericLessThanEquals: {"s3:max-keys": 1}
    });
    const storageKeyStatement = statements.find((statement) =>
      statement.Condition?.StringEquals?.["kms:ViaService"] === "s3.us-east-1.amazonaws.com");
    assert.deepEqual(listingStatements[0].Resource,
      storageKeyStatement.Condition.StringEquals["kms:EncryptionContext:aws:s3:arn"]);
    assert.doesNotMatch(serialized, /opengeo\/dev\/(?:connections|user-connections)\/\*/);
    assert.doesNotMatch(serialized, /secretsmanager:(?:CreateSecret|DeleteSecret|ListSecrets)/);
    assert.doesNotMatch(serialized, /s3:DeleteObject/);
    assert.doesNotMatch(serialized, /cognito-idp:/);
    assert.doesNotMatch(serialized, /sqs:PurgeQueue/);
  });

  it("caps production poller and function concurrency together", () => {
    const template = templateFor("production");
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 8
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      ScalingConfig: {MaximumConcurrency: 8}
    });
  });

  it("gives both API runtimes send-only authority and the exact queue URL", () => {
    const app = new App();
    const env = {account: "111111111111", region: "us-east-1"};
    const config = environmentConfig("dev", "http://localhost:3000");
    const foundation = new PlatformFoundationStack(app, "Foundation", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env
    });
    const archiver = new SourceArchiverStack(app, "Archiver", {
      config,
      foundation,
      imageDigest: `sha256:${"f".repeat(64)}`,
      env
    });
    const serverless = new ServerlessApiStack(app, "Serverless", {
      config,
      foundation,
      sourceArchiverQueue: archiver.queue,
      imageDigest: `sha256:${"d".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });
    const transitional = new ApiServiceStack(app, "Transitional", {
      config,
      foundation,
      sourceArchiverQueue: archiver.queue,
      imageDigest: `sha256:${"a".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
      env
    });

    for (const template of [
      Template.fromStack(serverless),
      Template.fromStack(transitional)
    ]) {
      const serialized = JSON.stringify(template.toJSON());
      assert.match(serialized, /OPEN_GEO_EXTERNAL_SOURCE_SNAPSHOT_QUEUE_URL/);
      assert.match(serialized, /sqs:SendMessage/);
      assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
      assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
    }
  });
});
