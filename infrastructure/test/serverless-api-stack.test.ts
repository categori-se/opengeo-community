import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {describe, it} from "node:test";
import {App, aws_lambda as lambda, aws_sqs as sqs} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig, SHARED_AUTH_ACCOUNT_ID, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";

const PREVIEW_PUBLIC_KEY = generateKeyPairSync("rsa", {modulusLength: 2048})
  .publicKey.export({type: "spki", format: "pem"})
  .toString();
const PREVIEW_SECRET_ARN =
  `arn:aws:secretsmanager:us-east-1:${SHARED_AUTH_ACCOUNT_ID}:secret:opengeo/preview-AbCd`;

function serverlessApiTemplateFor(
  stage: Stage,
  preview = false,
  observableBuild = false,
  enableKmlNetworkLinkFetch = false,
  account = SHARED_AUTH_ACCOUNT_ID,
  userDatasetVerification = false,
  additionalCognitoClientIds?: string,
  repositoryBrowser = false,
  artifactOptions: {enablePortableArtifacts?: boolean; enablePublicationArtifactBuilds?: boolean; region?: string} = {},
  enablePublicMapsPreview = false
): Template {
  const app = new App();
  const {region = "us-east-1", ...artifactFlags} = artifactOptions;
  const env = {account, region};
  const config = environmentConfig(
    stage,
    stage === "dev"
      ? "http://localhost:3000"
      : stage === "production"
        ? "https://studio.opengeo.tools"
        : `https://${stage}.opengeo.example.com`
  );
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    ...(account === SHARED_AUTH_ACCOUNT_ID
      ? {}
      : {existingUserPoolClientId: "5l2abc123def456ghi789jklmn"}),
    ...(preview
      ? {
          observablePreview: {
            apiOriginDomain: "abcdefghij.execute-api.us-east-1.amazonaws.com",
            certificateArn: (
              `arn:aws:acm:us-east-1:${SHARED_AUTH_ACCOUNT_ID}:certificate/`
              + "11111111-2222-3333-4444-555555555555"
            ),
            publicKeyPem: PREVIEW_PUBLIC_KEY,
            enablePublicMapsPreview
          }
        }
      : {}),
    env
  });
  const api = new ServerlessApiStack(app, `ServerlessApi-${stage}`, {
    config,
    foundation,
    imageDigest: `sha256:${"d".repeat(64)}`,
    observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
    ...(additionalCognitoClientIds ? {additionalCognitoClientIds} : {}),
    enableKmlNetworkLinkFetch,
    ...artifactFlags,
    ...(observableBuild
      ? {observableBuildQueue: new sqs.Queue(foundation, "ObservableBuildQueue")}
      : {}),
    ...(userDatasetVerification
      ? {userDatasetVerificationQueue: new sqs.Queue(
          foundation,
          "UserDatasetVerificationQueue"
        )}
      : {}),
    ...(repositoryBrowser
      ? {
          userDatasetRepositoryBrowserFunction: lambda.Function.fromFunctionName(
            foundation,
            "UserDatasetRepositoryBrowser",
            "opengeo-dev-user-dataset-repository-browser"
          )
        }
      : {}),
    ...(preview ? {observablePreviewPrivateKeySecretArn: PREVIEW_SECRET_ARN} : {}),
    env
  });
  return Template.fromStack(api);
}

describe("request-driven API stack", () => {
  it("activates Artifact storage and builds explicitly with only the portable object prefix", () => {
    const ordinary = JSON.stringify(serverlessApiTemplateFor("production").toJSON());
    assert.doesNotMatch(ordinary, /OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED|OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED|artifacts\/\*/);
    const configured = serverlessApiTemplateFor("production", false, true, false,
      SHARED_AUTH_ACCOUNT_ID, false, undefined, false,
      {enablePortableArtifacts: true, enablePublicationArtifactBuilds: true});
    configured.hasResourceProperties("AWS::Lambda::Function", {Environment: {Variables: Match.objectLike({
      OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED: "true",
      OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED: "true"
    })}});
    const statements = Object.values(configured.findResources("AWS::IAM::Policy"))
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
    const objects = statements.filter((s: any) => JSON.stringify(s.Resource).includes("artifacts/*"));
    assert.equal(objects.length, 1);
    assert.deepEqual(objects[0].Action, ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObjectVersion"]);
    assert.match(JSON.stringify(objects[0].Resource), /source\.opengeo\.tools\/organizations\/\*\/projects\/\*\/artifacts\/\*\/uploads\/\*\/map\.html/);
    const listing = statements.find((s: any) => s.Action === "s3:ListBucketVersions");
    assert.deepEqual(listing.Condition, {StringLike: {"s3:prefix": "organizations/*/projects/*/artifacts/*/uploads/*/map.html"}});
    assert.match(JSON.stringify(listing.Resource), /source\.opengeo\.tools/);
    configured.resourceCountIs("AWS::Lambda::Function", 1);
  });

  it("rejects Artifact activation without its storage, build queue or cleanup region", () => {
    const make = (options: Parameters<typeof serverlessApiTemplateFor>[8], queue = true) =>
      serverlessApiTemplateFor("production", false, queue, false,
        SHARED_AUTH_ACCOUNT_ID, false, undefined, false, options);
    assert.throws(() => make({enablePublicationArtifactBuilds: true}), /require portable storage/);
    assert.throws(() => make({enablePortableArtifacts: true, enablePublicationArtifactBuilds: true}, false), /configured build queue/);
    assert.throws(() => make({enablePortableArtifacts: true, region: "us-west-2"}), /us-east-1/);
  });

  it("injects an explicit additional browser-client allowlist only when configured", () => {
    const ordinary = JSON.stringify(serverlessApiTemplateFor("dev").toJSON());
    assert.doesNotMatch(ordinary, /OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS/);

    const configured = serverlessApiTemplateFor(
      "dev", false, false, false, SHARED_AUTH_ACCOUNT_ID, false, "client123"
    );
    configured.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS: "client123"
        })
      }
    });
  });

  it("reads only client-visible basemap keys from the browser-connection secret path", () => {
    const template = serverlessApiTemplateFor("dev");
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
    const reads = statements.filter((statement: any) => (
      statement.Action === "secretsmanager:GetSecretValue"
    ));

    assert.ok(reads.some((statement: any) => (
      JSON.stringify(statement.Resource).includes("browser-connections")
    )));
    assert.ok(reads
      .filter((statement: any) => JSON.stringify(statement.Resource).includes("browser-connections"))
      .every((statement: any) => !JSON.stringify(statement.Resource).includes("user-connections")));
  });
  it("advertises the isolated user dataset verifier with send-only queue authority", () => {
    const template = serverlessApiTemplateFor(
      "dev",
      false,
      false,
      false,
      SHARED_AUTH_ACCOUNT_ID,
      true
    );
    const serialized = JSON.stringify(template.toJSON());

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_USER_DATASET_VERIFICATION_QUEUE_URL: Match.anyValue()
        })
      }
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({Action: "sqs:SendMessage", Effect: "Allow"})
        ])
      }
    });
    assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
    assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
  });

  it("invokes only the explicitly advertised isolated repository browser", () => {
    const template = serverlessApiTemplateFor(
      "dev", false, false, false, SHARED_AUTH_ACCOUNT_ID, false, undefined, true
    );
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_USER_DATASET_REPOSITORY_BROWSER_FUNCTION_NAME:
            Match.anyValue()
        })
      }
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({Action: "lambda:InvokeFunction", Effect: "Allow"})
        ])
      }
    });
    assert.match(
      JSON.stringify(template.toJSON()),
      /opengeo-dev-user-dataset-repository-browser/
    );
  });

  it("loads only the matching preview signing secret when the private edge exists", () => {
    const template = serverlessApiTemplateFor("production", true);
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN/);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN:
            "https://preview.studio.opengeo.tools",
          OPEN_GEO_OBSERVABLE_PREVIEW_KEY_PAIR_ID: Match.anyValue(),
          OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN: PREVIEW_SECRET_ARN
        })
      }
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "secretsmanager:GetSecretValue",
            Resource: PREVIEW_SECRET_ARN
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
            Resource: Match.anyValue(),
            Condition: {
              StringEquals: {
                "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
                "kms:EncryptionContext:SecretARN": PREVIEW_SECRET_ARN
              }
            }
          })
        ])
      }
    });
  });

  it("advertises public map preview only when the separate edge alias is enabled", () => {
    const template = serverlessApiTemplateFor("production", true, false, false,
      SHARED_AUTH_ACCOUNT_ID, false, undefined, false, {}, true);
    template.hasResourceProperties("AWS::Lambda::Function", {Environment: {Variables: Match.objectLike({
      OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN: "https://maps-preview.studio.opengeo.tools"
    })}});
  });

  it("runs a bounded ARM64 image function with Data API configuration", () => {
    const template = serverlessApiTemplateFor("dev");

    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      Description: "OpenGeo request-driven API; no provisioned compute or VPC attachment",
      MemorySize: 1024,
      PackageType: "Image",
      ReservedConcurrentExecutions: 4,
      Timeout: 29,
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_DATA_API_REGION: "us-east-1",
          OPEN_GEO_DATA_API_CLUSTER_ARN: Match.anyValue(),
          OPEN_GEO_DATA_API_SECRET_ARN: Match.anyValue(),
          OPEN_GEO_DB_NAME: "opengeo",
          OPEN_GEO_ENV: "dev",
          OPEN_GEO_APPLICATION_BUCKET: Match.anyValue(),
          OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED: "false",
          OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
          OPEN_GEO_PROCESSING_QUEUE_URL: Match.anyValue(),
          OPEN_GEO_WMS_SYNC_WAIT_SECONDS: "8",
          OPEN_GEO_WMS_SYNC_POLL_SECONDS: "0.25"
        })
      },
      VpcConfig: Match.absent()
    });
  });

  it("runs the managed demo with production API validation and bounded capacity", () => {
    const template = serverlessApiTemplateFor("demo");

    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      ReservedConcurrentExecutions: 4,
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_ENV: "production"
        })
      }
    });
  });

  it("enables the bounded NetworkLink route only with explicit non-production opt-in", () => {
    const template = serverlessApiTemplateFor("dev", false, false, true);
    const resources = template.toJSON().Resources as Record<
      string,
      {Type: string; DependsOn?: string | string[]; Properties?: Record<string, unknown>}
    >;

    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 4,
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED: "true"
        })
      }
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /projects/{project_id}/kml-network-links/refresh"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      RouteSettings: {
        "POST /projects/{project_id}/kml-network-links/refresh": {
          ThrottlingBurstLimit: 4,
          ThrottlingRateLimit: 1
        }
      }
    });
    const routeId = Object.entries(resources).find(([, resource]) =>
      resource.Type === "AWS::ApiGatewayV2::Route"
      && resource.Properties?.RouteKey
        === "POST /projects/{project_id}/kml-network-links/refresh"
    )?.[0];
    const stage = Object.values(resources).find((resource) =>
      resource.Type === "AWS::ApiGatewayV2::Stage"
    );
    assert.ok(routeId, "the enabled NetworkLink route has no logical id");
    assert.ok(stage, "the API has no default stage");
    const dependencies = Array.isArray(stage.DependsOn)
      ? stage.DependsOn
      : stage.DependsOn === undefined
        ? []
        : [stage.DependsOn];
    assert.ok(
      dependencies.includes(routeId),
      "the stage must wait for its route before applying route settings"
    );
  });

  it("keeps production NetworkLink transport explicit and route-throttled", () => {
    const template = serverlessApiTemplateFor("production", false, false, true);

    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 64,
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_ENV: "production",
          OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED: "true"
        })
      }
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /projects/{project_id}/kml-network-links/refresh"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      RouteSettings: {
        "POST /projects/{project_id}/kml-network-links/refresh": {
          ThrottlingBurstLimit: 4,
          ThrottlingRateLimit: 1
        }
      }
    });
  });

  it("grants only the four used Data API transaction operations", () => {
    const template = serverlessApiTemplateFor("dev");

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "rds-data:BeginTransaction",
              "rds-data:ExecuteStatement",
              "rds-data:CommitTransaction",
              "rds-data:RollbackTransaction"
            ],
            Effect: "Allow",
            Resource: Match.anyValue()
          }),
          Match.objectLike({
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            Effect: "Allow",
            Resource: Match.anyValue()
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
            Effect: "Allow",
            Resource: Match.anyValue(),
            Condition: {
              StringEquals: {
                "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
                "kms:EncryptionContext:SecretARN": Match.anyValue()
              }
            }
          })
        ])
      }
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /rds-data:BatchExecuteStatement/);
    assert.doesNotMatch(serialized, /rds-data:ExecuteSql/);
  });

  it("preserves the existing Cognito, S3, and KMS least-privilege surface", () => {
    const template = serverlessApiTemplateFor("dev");
    const serialized = JSON.stringify(template.toJSON());

    assert.match(serialized, /cognito-idp:AdminCreateUser/);
    assert.match(serialized, /cognito-idp:AdminGetUser/);
    assert.match(serialized, /s3:GetObjectVersion/);
    assert.match(serialized, /s3:PutObject/);
    assert.match(serialized, /organizations\/\*\/projects\/\*\/pages\/\*\/versions\/\*\/uploads\/\*\/source\.md/);
    assert.match(serialized, /organizations\/\*\/projects\/\*\/source-projects\/\*\/uploads\/\*\/files\/\*/);
    const metadataStatements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Resource).includes("discovery-metadata"));
    assert.equal(metadataStatements.length, 1);
    assert.equal(metadataStatements[0].Effect, "Allow");
    assert.equal(metadataStatements[0].Action, "s3:GetObjectVersion");
    const metadataResources = metadataStatements[0].Resource.filter(
      (resource: unknown) => JSON.stringify(resource).includes("discovery-metadata")
    );
    assert.equal(metadataResources.length, 1);
    assert.match(JSON.stringify(metadataResources[0]),
      /"\/discovery-metadata\/organizations\/\*\/projects\/\*\/jobs\/\*\/response\.bin"/);
    assert.match(serialized, /sqs:SendMessage/);
    assert.match(serialized, /kms:EncryptionContext:aws:s3:arn/);
    assert.match(serialized, /kms:EncryptionContext:SecretARN/);
    assert.doesNotMatch(
      serialized,
      /kms:EncryptionContext:aws:s3:arn[^}]+organizations\/\*/
    );
    assert.doesNotMatch(serialized, /s3:DeleteObject/);
    assert.doesNotMatch(serialized, /s3:ListBucket/);
    assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
  });

  it("validates external shared-auth tokens without cross-account provisioning authority", () => {
    const template = serverlessApiTemplateFor(
      "dev",
      false,
      false,
      false,
      "222222222222"
    );
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPEN_GEO_COGNITO_USER_POOL_ID: "us-east-1_KXUwaZnuQ",
          OPEN_GEO_COGNITO_PROVISIONING_ENABLED: "false"
        })
      }
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /cognito-idp:AdminCreateUser/);
    assert.doesNotMatch(serialized, /cognito-idp:AdminGetUser/);
  });

  it("advertises only send authority for the separate Observable build queue", () => {
    const serialized = JSON.stringify(serverlessApiTemplateFor("dev", false, true).toJSON());
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL/);
    assert.match(serialized, /sqs:SendMessage/);
    assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
    assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
    assert.doesNotMatch(serialized, /sqs:ChangeMessageVisibility/);
  });

  it("can only create and recoverably discard stage-scoped connection secrets", () => {
    const template = serverlessApiTemplateFor("dev");
    const serialized = JSON.stringify(template.toJSON());

    assert.match(serialized, /secretsmanager:CreateSecret/);
    assert.match(serialized, /secretsmanager:TagResource/);
    assert.match(serialized, /secretsmanager:DeleteSecret/);
    assert.match(serialized, /secret:opengeo\/dev\/connections\/\*/);
    assert.match(serialized, /secret:opengeo\/dev\/user-connections\/\*/);
    assert.doesNotMatch(serialized, /secretsmanager:PutSecretValue/);
    assert.doesNotMatch(serialized, /secretsmanager:GetRandomPassword/);
    assert.doesNotMatch(serialized, /secretsmanager:ListSecrets/);
  });

  it("uses HTTP API payload v2 with anonymous public CORS and no hourly network resources", () => {
    const template = serverlessApiTemplateFor("production");

    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: {
        AllowHeaders: [
          "Authorization",
          "Content-Type",
          "X-OpenGeo-Organization",
          "X-Request-ID"
        ],
        AllowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        AllowOrigins: ["*"],
        AllowCredentials: Match.absent(),
        ExposeHeaders: [
          "X-Request-ID",
          "X-OpenGeo-Source-Sha256",
          "X-OpenGeo-Discovery-Job-Id"
        ],
        MaxAge: 3600
      },
      Name: "opengeo-production-api",
      ProtocolType: "HTTP"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      PayloadFormatVersion: "2.0"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 50,
        ThrottlingRateLimit: 25
      }
    });
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    template.resourceCountIs("AWS::ECS::Service", 0);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
  });

  it("bounds production concurrency without adding provisioned concurrency", () => {
    const template = serverlessApiTemplateFor("production");

    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 64
    });
    template.resourceCountIs("AWS::Lambda::Version", 0);
    template.resourceCountIs("AWS::Lambda::Alias", 0);
  });
});
