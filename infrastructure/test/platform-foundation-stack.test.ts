import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {
  environmentConfig,
  SHARED_AUTH_ACCOUNT_ID,
  type FederationConfig,
  type Stage
} from "../lib/config.js";
import {
  FOUNDATION_DEFINITION_VERSION,
  PlatformFoundationStack
} from "../lib/platform-foundation-stack.js";

function templateFor(
  stage: Stage,
  federation: FederationConfig = {},
  existingUserPoolClientId?: string
): Template {
  const app = new App();
  const stack = new PlatformFoundationStack(app, `Test-${stage}`, {
    config: environmentConfig(
      stage,
      stage === "dev" ? "http://localhost:3000" : `https://${stage}.opengeo.example.com`,
      federation
    ),
    budgetAlertEmail: "opengeo-ci@example.invalid",
    ...(existingUserPoolClientId ? {existingUserPoolClientId} : {}),
    env: {account: SHARED_AUTH_ACCOUNT_ID, region: "us-east-1"}
  });

  return Template.fromStack(stack);
}

describe("platform foundation stack", () => {
  it("allows the production reader to pause independently while retaining failover", () => {
    const template = templateFor("production");
    const instances = template.findResources("AWS::RDS::DBInstance");
    const reader = Object.entries(instances).find(([id]) => id.startsWith("DatabaseReader"))?.[1];
    assert.ok(reader);
    assert.equal(reader.Properties.PromotionTier, 2);
    assert.equal(reader.Properties.DBInstanceClass, "db.serverless");
    template.resourceCountIs("AWS::RDS::DBInstance", 2);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      ServerlessV2ScalingConfiguration: {MinCapacity: 0, MaxCapacity: 16, SecondsUntilAutoPause: 300}
    });
  });

  it("expires only disposable compiler caches without changing archive retention", () => {
    const template = templateFor("production");
    const buckets = template.findResources("AWS::S3::Bucket");
    const application = Object.entries(buckets).find(([id]) => id.startsWith("ApplicationBucket"))?.[1];
    const geodata = Object.entries(buckets).find(([id]) => id.startsWith("GeodataBucket"))?.[1];
    assert.ok(application && geodata);
    const rules = application.Properties.LifecycleConfiguration.Rules;
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.find((r: {Id?: string}) => r.Id === "CompilerPageCacheExpiration"), {
      Id: "CompilerPageCacheExpiration", Status: "Enabled", Prefix: "compiler-cache/pages/v1/",
      ExpirationInDays: 7, NoncurrentVersionExpiration: {NoncurrentDays: 1}
    });
    assert.deepEqual(rules.find((r: {Id?: string}) => r.Id === "CompilerPageCacheDeleteMarkers"), {
      Id: "CompilerPageCacheDeleteMarkers", Status: "Enabled", Prefix: "compiler-cache/pages/v1/",
      ExpiredObjectDeleteMarker: true
    });
    assert.deepEqual(geodata.Properties.LifecycleConfiguration.Rules, [rules[0]]);
    assert.equal(rules[0].NoncurrentVersionExpiration.NoncurrentDays, 365);
    assert.equal(rules[0].ExpirationInDays, undefined);
  });

  it("imports shared auth cross-account only with an existing public client", () => {
    const app = new App();
    const config = environmentConfig("dev", "http://localhost:3000");
    assert.throws(
      () => new PlatformFoundationStack(app, "CrossAccountMissingClient", {
        config,
        budgetAlertEmail: "opengeo-ci@example.invalid",
        env: {account: "222222222222", region: "us-east-1"}
      }),
      /different AWS account/
    );

    const imported = new PlatformFoundationStack(app, "CrossAccountImportedClient", {
      config,
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env: {account: "222222222222", region: "us-east-1"}
    });
    const template = Template.fromStack(imported);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    assert.equal(imported.identityProvisioningEnabled, false);
    assert.match(
      imported.userPool.userPoolArn,
      /cognito-idp:us-east-1:111111111111:userpool\/us-east-1_KXUwaZnuQ$/
    );
  });

  it("creates private encrypted versioned object storage", () => {
    const template = templateFor("dev");

    template.resourceCountIs("AWS::S3::Bucket", 2);
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "dev.source.opengeo.tools"
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "dev.storage.opengeo.tools"
    });
    template.allResourcesProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "aws:kms"
            })
          })
        ]
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      VersioningConfiguration: {Status: "Enabled"}
    });
  });

  it("marks the managed source bucket with its Foundation definition", () => {
    const template = templateFor("dev");
    const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
    const source = buckets.find(
      (resource) => resource.Properties.BucketName === "dev.source.opengeo.tools"
    );
    const data = buckets.find(
      (resource) => resource.Properties.BucketName === "dev.storage.opengeo.tools"
    );

    assert.ok(source);
    assert.ok(data);
    assert.ok(source.Properties.Tags.some(
      (tag: {Key: string; Value: string}) =>
        tag.Key === "OpenGeoFoundationDefinition"
        && tag.Value === FOUNDATION_DEFINITION_VERSION
    ));
    assert.equal(data.Properties.Tags.some(
      (tag: {Key: string}) => tag.Key === "OpenGeoFoundationDefinition"
    ), false);
  });

  it("uses stable readable production storage names", () => {
    const template = templateFor("production");

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "source.opengeo.tools"
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "storage.opengeo.tools"
    });
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /(?:source|storage)\.opengeo\.tools[.-][0-9]{4,}/);
  });

  it("allows the production Studio origin to post managed uploads", () => {
    const app = new App();
    const template = Template.fromStack(new PlatformFoundationStack(app, "Test-production-cors", {
      config: environmentConfig("production", "https://studio.opengeo.tools"),
      budgetAlertEmail: "opengeo-ci@example.invalid",
      env: {account: SHARED_AUTH_ACCOUNT_ID, region: "us-east-1"}
    }));

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "storage.opengeo.tools",
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(["POST"]),
            AllowedOrigins: ["https://studio.opengeo.tools"],
            ExposedHeaders: ["ETag", "x-amz-version-id", "Content-Range"]
          })
        ])
      }
    });
    const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
    const geodata = buckets.find(
      (resource) => resource.Properties.BucketName === "storage.opengeo.tools"
    );
    assert.deepEqual(
      geodata?.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins,
      ["https://studio.opengeo.tools"]
    );
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: ["https://studio.opengeo.tools/login"],
      LogoutURLs: ["https://studio.opengeo.tools/login"],
      DefaultRedirectURI: "https://studio.opengeo.tools/login"
    });
  });

  it("keeps the initial VPC free of NAT gateways", () => {
    const template = templateFor("dev");

    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    template.resourceCountIs("AWS::EC2::Subnet", 4);
  });

  it("sets an account budget with actual and forecast notifications", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetLimit: {Amount: 125, Unit: "USD"},
        BudgetName: "opengeo-dev-monthly-account",
        BudgetType: "COST",
        TimeUnit: "MONTHLY"
      },
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "FORECASTED",
            Threshold: 80
          })
        }),
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "ACTUAL",
            Threshold: 100
          })
        })
      ])
    });

    const productionTemplate = templateFor("production");
    productionTemplate.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetLimit: {Amount: 100, Unit: "USD"},
        BudgetName: "opengeo-production-monthly-account",
        BudgetType: "COST",
        TimeUnit: "MONTHLY"
      }
    });
  });

  it("reuses only the exact pre-existing account budget", () => {
    const app = new App();
    const stack = new PlatformFoundationStack(app, "ExistingDevBudget", {
      config: environmentConfig("dev", "http://localhost:3000"),
      budgetAlertEmail: "opengeo-ci@example.invalid",
      existingBudgetName: "opengeo-dev-monthly-account",
      existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
      env: {account: "222222222222", region: "us-east-1"}
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.hasOutput("BudgetName", {Value: "opengeo-dev-monthly-account"});

    assert.throws(
      () => new PlatformFoundationStack(app, "WrongExistingDevBudget", {
        config: environmentConfig("dev", "http://localhost:3000"),
        budgetAlertEmail: "opengeo-ci@example.invalid",
        existingBudgetName: "some-other-budget",
        existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
        env: {account: "222222222222", region: "us-east-1"}
      }),
      /existing budget must be named opengeo-dev-monthly-account/
    );
  });

  it("uses immutable repositories and disables paid container insights in dev", () => {
    const template = templateFor("dev");

    template.allResourcesProperties("AWS::ECR::Repository", {
      ImageTagMutability: "IMMUTABLE"
    });
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterSettings: [{Name: "containerInsights", Value: "disabled"}]
    });
  });

  it("lets only the regional Logs service use the data key for OpenGeo log groups", () => {
    const template = templateFor("production");

    template.hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowBoundedCloudWatchLogsEncryption",
            Effect: "Allow",
            Principal: {Service: "logs.us-east-1.amazonaws.com"},
            Action: Match.arrayWith([
              "kms:Encrypt*",
              "kms:Decrypt*",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:Describe*"
            ]),
            Resource: "*",
            Condition: {
              ArnLike: {
                "kms:EncryptionContext:aws:logs:arn":
                  Match.objectLike({"Fn::Join": Match.anyValue()})
              }
            }
          })
        ])
      }
    });
    assert.match(
      JSON.stringify(template.toJSON()),
      /arn:.*:logs:us-east-1:111111111111:log-group:\/opengeo\/production\/\*/
    );
  });

  it("creates encrypted processing and dead-letter queues", () => {
    const template = templateFor("dev");

    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.hasResourceProperties("AWS::SQS::Queue", {
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.objectLike({maxReceiveCount: 3}),
      VisibilityTimeout: 900
    });
  });

  it("routes tenant upload object-created events to the encrypted processing queue", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({AllowedMethods: Match.arrayWith(["POST"])})
        ])
      }
    });
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        QueueConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: {
                FilterRules: [{Name: "prefix", Value: "organizations/"}]
              }
            }
          })
        ])
      }
    });
    template.hasResourceProperties("AWS::SQS::QueuePolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {Service: "s3.amazonaws.com"},
            Action: Match.arrayWith(["sqs:SendMessage"])
          })
        ])
      }
    });
    assert.match(JSON.stringify(template.toJSON()), /s3.amazonaws.com/);
  });

  it("creates a dedicated public PKCE client in the shared auth.categori.se pool", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ["openid", "email", "profile"],
      CallbackURLs: ["http://localhost:3000/login"],
      LogoutURLs: ["http://localhost:3000/login"],
      PreventUserExistenceErrors: "ENABLED",
      SupportedIdentityProviders: ["COGNITO"],
      UserPoolId: "us-east-1_KXUwaZnuQ"
    });
    template.resourceCountIs("AWS::Cognito::UserPool", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    template.hasOutput("BrowserAuthConfigJson", {Value: Match.anyValue()});
    template.hasOutput("CognitoHostedUiBaseUrl", {Value: "https://auth.categori.se"});
    const clients = Object.values(template.toJSON().Resources as Record<string, {Type: string; Properties: Record<string, unknown>}>)
      .filter((resource) => resource.Type === "AWS::Cognito::UserPoolClient");
    assert.equal(clients.length, 1);
    assert.notEqual(clients[0]?.Properties.GenerateSecret, true);
    const explicitFlows = (clients[0]?.Properties.ExplicitAuthFlows ?? []) as string[];
    assert.equal(explicitFlows.some((flow) => flow.includes("PASSWORD") || flow.includes("SRP")), false);
  });

  it("does not let an application stack mutate shared federation providers", () => {
    assert.throws(
      () => templateFor("dev", {
        google: {
          clientId: "123456789-abc123.apps.googleusercontent.com",
          clientSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/google-AbCd"
        }
      }),
      /managed by the shared auth\.categori\.se pool/
    );
  });

  it("reuses the separately deployed browser client as the future API token audience", () => {
    const clientId = "5l2abc123def456ghi789jklmn";
    const template = templateFor("production", {}, clientId);

    template.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    template.hasOutput("UserPoolClientId", {Value: clientId});
    assert.match(JSON.stringify(template.toJSON()), new RegExp(clientId));
  });

  it("creates a separate least-privilege API database credential", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Description: "OpenGeo dev API runtime database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        SecretStringTemplate: Match.objectLike({"Fn::Join": Match.anyValue()})
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_runtime/);
  });

  it("creates a distinct function-only GIS worker database credential", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Description: "OpenGeo dev GIS worker database credential",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
        SecretStringTemplate: Match.objectLike({"Fn::Join": Match.anyValue()})
      })
    });
    assert.match(JSON.stringify(template.toJSON()), /opengeo_worker/);
    template.hasOutput("WorkerDatabaseSecretArn", {Value: Match.anyValue()});
  });

  it("retains and protects the production database", () => {
    const template = templateFor("production");

    template.hasResource("AWS::RDS::DBCluster", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BackupRetentionPeriod: 30,
        DeletionProtection: true,
        EnableHttpEndpoint: true,
        Engine: "aurora-postgresql",
        EngineVersion: "16.13",
        ServerlessV2ScalingConfiguration: {
          MinCapacity: 0,
          MaxCapacity: 16,
          SecondsUntilAutoPause: 300
        },
        StorageEncrypted: true
      })
    });
    template.resourceCountIs("AWS::RDS::DBInstance", 2);
    template.allResourcesProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.serverless",
      PubliclyAccessible: false
    });
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterSettings: [{Name: "containerInsights", Value: "enabled"}]
    });
  });

  it("uses a Data API cluster that can automatically pause at zero ACUs", () => {
    const template = templateFor("dev");

    template.hasResourceProperties("AWS::RDS::DBCluster", {
      DatabaseName: "opengeo",
      EnableHttpEndpoint: true,
      Engine: "aurora-postgresql",
      EngineVersion: "16.13",
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0,
        MaxCapacity: 2,
        SecondsUntilAutoPause: 300
      },
      StorageEncrypted: true
    });
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.serverless",
      PubliclyAccessible: false
    });
    template.resourceCountIs("AWS::RDS::DBProxy", 0);
  });

  it("limits private source upload and download CORS to the exact Studio origin", () => {
    const template = templateFor("production");
    const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
    const source = buckets.find(
      (resource) => resource.Properties.BucketName === "source.opengeo.tools"
    );
    assert.ok(source);
    assert.deepEqual(source.Properties.CorsConfiguration.CorsRules, [{
      AllowedHeaders: ["*"],
      AllowedMethods: ["GET", "POST"],
      AllowedOrigins: ["https://production.opengeo.example.com"],
      ExposedHeaders: ["ETag", "x-amz-version-id"],
      MaxAge: 300
    }]);
    assert.deepEqual(source.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    });
    assert.deepEqual(source.Properties.VersioningConfiguration, {Status: "Enabled"});
    assert.deepEqual(source.Properties.OwnershipControls, {
      Rules: [{ObjectOwnership: "BucketOwnerEnforced"}]
    });
    const encryption = source.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0];
    assert.equal(encryption.ServerSideEncryptionByDefault.SSEAlgorithm, "aws:kms");
    assert.equal(encryption.BucketKeyEnabled, true);
  });

  it("never synthesizes a public database", () => {
    for (const stage of ["dev", "staging", "demo", "production"] as const) {
      const template = templateFor(stage).toJSON();
      const resources = template.Resources as Record<
        string,
        Record<string, unknown>
      >;
      const databases = Object.values(resources).filter(
        (resource) => resource.Type === "AWS::RDS::DBInstance"
      );

      assert.equal(databases.length, stage === "production" ? 2 : 1);
      assert.ok(
        databases.every(
          (database) =>
            (database.Properties as Record<string, unknown>).PubliclyAccessible === false
        )
      );
    }
  });
});
