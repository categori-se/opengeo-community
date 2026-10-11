import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {describe, it} from "node:test";
import {App, aws_sqs as sqs} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {ApiServiceStack} from "../lib/api-service-stack.js";
import {environmentConfig, SHARED_AUTH_ACCOUNT_ID, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";

const PREVIEW_PUBLIC_KEY = generateKeyPairSync("rsa", {modulusLength: 2048})
  .publicKey.export({type: "spki", format: "pem"})
  .toString();
const PREVIEW_SECRET_ARN =
  `arn:aws:secretsmanager:us-east-1:${SHARED_AUTH_ACCOUNT_ID}:secret:opengeo/preview-AbCd`;

function apiTemplateFor(
  stage: Stage,
  preview = false,
  observableBuild = false,
  userDatasetVerification = false,
  additionalCognitoClientIds?: string,
  enablePublicMapsPreview = false
): Template {
  const app = new App();
  const env = {account: SHARED_AUTH_ACCOUNT_ID, region: "us-east-1"};
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
  const api = new ApiServiceStack(app, `Api-${stage}`, {
    config,
    foundation,
    imageDigest: `sha256:${"a".repeat(64)}`,
    observableBuilderImageDigest: `sha256:${"c".repeat(64)}`,
    ...(additionalCognitoClientIds ? {additionalCognitoClientIds} : {}),
    ...(observableBuild
      ? {observableBuildQueue: new sqs.Queue(foundation, "ObservableBuildQueue")}
      : {}),
    ...(userDatasetVerification
      ? {userDatasetVerificationQueue: new sqs.Queue(
          foundation,
          "UserDatasetVerificationQueue"
        )}
      : {}),
    ...(preview ? {observablePreviewPrivateKeySecretArn: PREVIEW_SECRET_ARN} : {}),
    env
  });
  return Template.fromStack(api);
}

describe("API service stack", () => {
  it("injects an explicit additional browser-client allowlist only when configured", () => {
    const ordinary = JSON.stringify(apiTemplateFor("dev").toJSON());
    assert.doesNotMatch(ordinary, /OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS/);

    const configured = apiTemplateFor("dev", false, false, false, "client123");
    configured.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([{
          Name: "OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS",
          Value: "client123"
        }])
      })]
    });
  });

  it("reads only client-visible basemap keys from the browser-connection secret path", () => {
    const template = apiTemplateFor("dev");
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
    const template = apiTemplateFor("dev", false, false, true);
    const serialized = JSON.stringify(template.toJSON());

    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([Match.objectLike({
          Name: "OPEN_GEO_USER_DATASET_VERIFICATION_QUEUE_URL"
        })])
      })]
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

  it("loads only the matching private-preview signing secret at runtime", () => {
    const template = apiTemplateFor("production", true);
    const serialized = JSON.stringify(template.toJSON());

    assert.match(serialized, /OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN/);
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_PREVIEW_KEY_PAIR_ID/);
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN/);
    assert.doesNotMatch(serialized, /OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN/);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "secretsmanager:GetSecretValue",
            Resource: PREVIEW_SECRET_ARN
          }),
          Match.objectLike({
            Action: "kms:Decrypt",
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
    const template = apiTemplateFor("production", true, false, false, undefined, true);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({Environment: Match.arrayWith([{
        Name: "OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN",
        Value: "https://maps-preview.studio.opengeo.tools"
      }])})]
    });
  });

  it("runs an ARM64 non-interactive task with injected database secrets", () => {
    const template = apiTemplateFor("dev");

    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "512",
      Memory: "1024",
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX"
      },
      ContainerDefinitions: [
        Match.objectLike({
          Name: "opengeo-api",
          Essential: true,
          User: "10001:10001",
          ReadonlyRootFilesystem: true,
          LinuxParameters: Match.objectLike({
            Capabilities: {Drop: ["ALL"]},
            InitProcessEnabled: true
          }),
          Environment: Match.arrayWith([
            Match.objectLike({Name: "OPEN_GEO_COGNITO_CLIENT_ID"}),
            Match.objectLike({Name: "OPEN_GEO_COGNITO_REGION", Value: "us-east-1"}),
            Match.objectLike({Name: "OPEN_GEO_COGNITO_USER_POOL_ID"}),
            Match.objectLike({Name: "OPEN_GEO_AWS_REGION", Value: "us-east-1"}),
            Match.objectLike({Name: "OPEN_GEO_APPLICATION_BUCKET"}),
            Match.objectLike({
              Name: "OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST",
              Value: `sha256:${"c".repeat(64)}`
            }),
            Match.objectLike({Name: "OPEN_GEO_GEODATA_BUCKET"}),
            Match.objectLike({Name: "OPEN_GEO_GEODATA_KMS_KEY_ARN"}),
            Match.objectLike({Name: "OPEN_GEO_PROCESSING_QUEUE_URL"}),
            Match.objectLike({Name: "OPEN_GEO_DB_SSLMODE", Value: "verify-full"}),
            Match.objectLike({
              Name: "OPEN_GEO_DB_SSLROOTCERT",
              Value: "/etc/ssl/certs/aws-rds-global-bundle.pem"
            })
          ]),
          PortMappings: [Match.objectLike({ContainerPort: 8080})],
          Secrets: Match.arrayWith([
            Match.objectLike({Name: "OPEN_GEO_DB_HOST"}),
            Match.objectLike({Name: "OPEN_GEO_DB_PASSWORD"})
          ])
        })
      ]
    });
  });

  it("imports only the runtime database secret", () => {
    const serialized = JSON.stringify(apiTemplateFor("dev").toJSON());

    assert.match(serialized, /ExportsOutputRefRuntimeDatabaseSecret/);
    assert.doesNotMatch(serialized, /ExportsOutputRefDatabaseSecret/);
  });

  it("limits membership provisioning to two admin calls on this user pool", () => {
    const template = apiTemplateFor("dev");

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
            Effect: "Allow",
            Resource: Match.anyValue()
          })
        ])
      },
      Roles: Match.anyValue()
    });
    assert.match(JSON.stringify(template.toJSON()), /us-east-1_KXUwaZnuQ/);
  });

  it("advertises only send authority for the separate Observable build queue", () => {
    const serialized = JSON.stringify(apiTemplateFor("dev", false, true).toJSON());
    assert.match(serialized, /OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL/);
    assert.match(serialized, /sqs:SendMessage/);
    assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
    assert.doesNotMatch(serialized, /sqs:DeleteMessage/);
    assert.doesNotMatch(serialized, /sqs:ChangeMessageVisibility/);
  });

  it("limits upload signing and verification to exact geodata object and KMS paths", () => {
    const template = apiTemplateFor("dev");

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:GetObject", "s3:PutObject"],
            Effect: "Allow",
            Resource: Match.objectLike({"Fn::Join": Match.anyValue()})
          }),
          Match.objectLike({
            Action: "s3:GetObjectVersion",
            Effect: "Allow",
            Resource: Match.arrayWith([
              Match.objectLike({"Fn::Join": Match.anyValue()}),
              Match.objectLike({"Fn::Join": Match.anyValue()})
            ])
          }),
          Match.objectLike({
            Action: ["kms:Decrypt", "kms:GenerateDataKey"],
            Effect: "Allow",
            Condition: {
              StringEquals: Match.objectLike({
                "kms:ViaService": "s3.us-east-1.amazonaws.com",
                "kms:EncryptionContext:aws:s3:arn": Match.anyValue()
              })
            }
          })
        ])
      }
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, /organizations\/\*\/projects\/\*\/datasets\/\*\/uploads\/\*/);
    assert.match(serialized, /organizations\/\*\/projects\/\*\/pages\/\*\/versions\/\*\/uploads\/\*\/source\.md/);
    assert.match(serialized, /organizations\/\*\/projects\/\*\/source-projects\/\*\/uploads\/\*\/files\/\*/);
    assert.match(serialized, /organizations\/\*\/projects\/\*\/datasets\/\*\/versions\/\*\/derivatives\/\*/);
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
    assert.doesNotMatch(serialized, /s3:DeleteObject/);
    assert.doesNotMatch(serialized, /s3:ListBucket/);
    assert.doesNotMatch(serialized, /sqs:ReceiveMessage/);
    assert.doesNotMatch(
      serialized,
      /kms:EncryptionContext:aws:s3:arn[^}]+organizations\/\*/
    );
  });

  it("can only create and recoverably discard stage-scoped connection secrets", () => {
    const serialized = JSON.stringify(apiTemplateFor("dev").toJSON());

    assert.match(serialized, /secretsmanager:CreateSecret/);
    assert.match(serialized, /secretsmanager:TagResource/);
    assert.match(serialized, /secretsmanager:DeleteSecret/);
    assert.match(serialized, /secret:opengeo\/dev\/connections\/\*/);
    assert.doesNotMatch(serialized, /secretsmanager:GetRandomPassword/);
    assert.doesNotMatch(serialized, /secretsmanager:ListSecrets/);
  });

  it("keeps the load balancer internal and uses dependency readiness", () => {
    const template = apiTemplateFor("dev");

    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
      Type: "application"
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/health/ready",
      Matcher: {HttpCode: "200"},
      Port: 8080,
      Protocol: "HTTP"
    });
  });

  it("uses public task egress without a NAT gateway", () => {
    const template = apiTemplateFor("dev");

    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      EnableExecuteCommand: false,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({AssignPublicIp: "ENABLED"})
      }
    });
  });

  it("limits task egress to TLS and PostgreSQL", () => {
    const template = apiTemplateFor("dev");
    const serialized = JSON.stringify(template.toJSON());

    assert.match(serialized, /TLS-only egress for AWS APIs and Cognito JWKS/);
    assert.match(serialized, /API tasks to PostgreSQL/);
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "OpenGeo API tasks; ingress is limited to the internal ALB",
      SecurityGroupEgress: Match.arrayWith([
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
          Description: "TLS-only egress for AWS APIs and Cognito JWKS"
        },
        Match.objectLike({
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          Description: "API tasks to PostgreSQL"
        })
      ])
    });
  });

  it("runs at least two tasks and protects the production ALB", () => {
    const template = apiTemplateFor("production");

    template.hasResourceProperties("AWS::ECS::Service", {DesiredCount: 2});
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
      LoadBalancerAttributes: Match.arrayWith([
        {Key: "deletion_protection.enabled", Value: "true"}
      ])
    });
  });
});
