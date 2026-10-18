import assert from "node:assert/strict";
import {test} from "node:test";
import {generateKeyPairSync} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {App, Fn} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {StudioWebStack} from "../lib/studio-web-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";
import {ApiServiceStack} from "../lib/api-service-stack.js";

const account = "333333333333";
const origin = "https://d123456789.cloudfront.net";
const config = {
  ...environmentConfig("dev", origin, {}, {
    application: "community-333333333333-us-east-1-app",
    data: "community-333333333333-us-east-1-data"
  }),
  allowedWebOrigins: [origin],
  deletionProtection: true
};

test("independent deployments create their own identity and retain durable data", () => {
  const foundation = new PlatformFoundationStack(new App(), "CommunityFoundation", {
    env: {account, region: "us-east-1"}, config,
    budgetAlertEmail: "maintainer@example.invalid",
    standaloneAuthDomainPrefix: `community-${account}`, retainData: true,
    availabilityZones: [Fn.select(0, Fn.getAzs("us-east-1")), Fn.select(1, Fn.getAzs("us-east-1"))]
  });
  const template = Template.fromStack(foundation);
  template.hasResource("AWS::Cognito::UserPool", {
    DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({AdminCreateUserConfig: {AllowAdminCreateUserOnly: true}})
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    GenerateSecret: false, CallbackURLs: [`${origin}/login`],
    AllowedOAuthFlows: ["code"], AllowedOAuthFlowsUserPoolClient: true
  });
  template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {Domain: `community-${account}`});
  template.hasResource("AWS::RDS::DBCluster", {
    DeletionPolicy: "Retain", Properties: Match.objectLike({
      DeletionProtection: true,
      ServerlessV2ScalingConfiguration: {MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 300}
    })
  });
  for (const kind of ["AWS::S3::Bucket", "AWS::KMS::Key", "AWS::SecretsManager::Secret", "AWS::ECR::Repository"]) {
    for (const resource of Object.values(template.findResources(kind))) {
      assert.equal(resource.DeletionPolicy, "Retain", kind);
      assert.equal(resource.UpdateReplacePolicy, "Retain", kind);
    }
  }
  template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
  template.resourceCountIs("AWS::ECR::Repository", 3);
  for (const subnet of Object.values(template.findResources("AWS::EC2::Subnet"))) {
    assert.deepEqual(subnet.Properties.AvailabilityZone["Fn::Select"][1], {"Fn::GetAZs": "us-east-1"});
  }
  assert.equal(foundation.identityProvisioningEnabled, true);
  const serialized = JSON.stringify(template.toJSON());
  assert.doesNotMatch(serialized, /auth\.categori\.se|us-east-1_KXUwaZnuQ|111111111111/);
});

test("community edge serves independent domains without managed preview authorities", () => {
  const web = new StudioWebStack(new App(), "CommunityWeb", {
    env: {account, region: "us-east-1"}, communityDeployment: true,
    domainName: "d123456789.cloudfront.net", dnsZone: "cloudfront.net",
    dnsRecordHost: "d123456789", bucketName: `community-${account}-studio`,
    resourceNamePrefix: "community-example",
    apiOriginDomain: "abcdefghij.execute-api.us-east-1.amazonaws.com"
  });
  const template = Template.fromStack(web);
  const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
  const shellPolicy = Object.entries(policies).find(([id]) => id.startsWith("StudioSecurityHeaders"))?.[1];
  assert.ok(shellPolicy);
  const csp = shellPolicy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.match(csp, /frame-src 'self';/);
  assert.doesNotMatch(csp, /preview\.studio\.opengeo\.tools/);
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0];
  assert.ok(distribution);
  const api = distribution.Properties.DistributionConfig.CacheBehaviors.find((behavior: {PathPattern: string}) => behavior.PathPattern === "api/*");
  assert.ok(api);
});

const previewOrigin = "https://preview.community.example.net";
const independentPreview = {
  previewDomainName: "preview.community.example.net", studioOrigin: origin,
  shellBucketName: `community-${account}-preview-shell`, resourceNamePrefix: "community-private-preview"
};
const previewKey = generateKeyPairSync("rsa", {modulusLength: 2048})
  .publicKey.export({type: "spki", format: "pem"}).toString();
const previewCertificate = `arn:aws:acm:us-east-1:${account}:certificate/11111111-2222-3333-4444-555555555555`;
const previewSecret = `arn:aws:secretsmanager:us-east-1:${account}:secret:community/preview-AbCd`;

test("independent private preview connects account-owned storage, API origin and frame policy", () => {
  const app = new App();
  const env = {account, region: "us-east-1"};
  const foundation = new PlatformFoundationStack(app, "IndependentPreviewFoundation", {
    env, config, budgetAlertEmail: "maintainer@example.invalid",
    standaloneAuthDomainPrefix: `community-${account}`, retainData: true,
    availabilityZones: [Fn.select(0, Fn.getAzs("us-east-1")), Fn.select(1, Fn.getAzs("us-east-1"))],
    observablePreview: {
      apiOriginDomain: "abcdefghij.execute-api.us-east-1.amazonaws.com",
      certificateArn: previewCertificate, publicKeyPem: previewKey, deployShell: false,
      independentDeployment: independentPreview
    }
  });
  // Build the complete cross-stack graph before Template.fromStack freezes the App.
  const apis = ([["Lambda", ServerlessApiStack], ["Container", ApiServiceStack]] as const).map(([id, ApiStack]) =>
    [id, new ApiStack(app, `IndependentPreview${id}`, {
      env, config, foundation, imageDigest: `sha256:${"a".repeat(64)}`,
      observableBuilderImageDigest: `sha256:${"b".repeat(64)}`,
      observablePreviewPrivateKeySecretArn: previewSecret
    })] as const);
  const web = new StudioWebStack(app, "IndependentPreviewWeb", {
    env, communityDeployment: true, domainName: "d123456789.cloudfront.net",
    dnsZone: "cloudfront.net", dnsRecordHost: "d123456789", bucketName: `community-${account}-studio`,
    resourceNamePrefix: "community-preview-web", independentPreviewOrigins: [previewOrigin]
  });
  assert.equal(foundation.observablePreviewEdge?.previewOrigin, previewOrigin);
  const foundationTemplate = Template.fromStack(foundation);
  const foundationDocument = JSON.stringify(foundationTemplate.toJSON());
  assert.doesNotMatch(foundationDocument, /source\.opengeo\.tools|preview\.studio\.opengeo\.tools|auth\.categori\.se/);
  assert.match(foundationDocument, /community-333333333333-us-east-1-app/);
  foundationTemplate.resourceCountIs("AWS::CloudFront::Distribution", 1);
  foundationTemplate.resourceCountIs("Custom::CDKBucketDeployment", 0);
  for (const [id, api] of apis) {
    const template = Template.fromStack(api);
    const document = JSON.stringify(template.toJSON());
    assert.doesNotMatch(document, /preview\.studio\.opengeo\.tools/);
    if (id === "Lambda") {
      template.hasResourceProperties("AWS::Lambda::Function", {Environment: {Variables: Match.objectLike({
        OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN: previewOrigin,
        OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN: previewSecret
      })}});
    } else {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([
          {Name: "OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN", Value: previewOrigin},
          {Name: "OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN", Value: previewSecret}
        ])
      })]});
    }
    template.hasResourceProperties("AWS::IAM::Policy", {PolicyDocument: {Statement: Match.arrayWith([
      Match.objectLike({Action: "secretsmanager:GetSecretValue", Resource: previewSecret}),
      Match.objectLike({Action: "kms:Decrypt", Condition: {StringEquals: {
        "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
        "kms:EncryptionContext:SecretARN": previewSecret
      }}})
    ])}});
  }
  const policies = Template.fromStack(web).findResources("AWS::CloudFront::ResponseHeadersPolicy");
  const policy = Object.entries(policies).find(([id]) => id.startsWith("StudioSecurityHeaders"))![1];
  const csp = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.match(csp, /frame-src 'self' https:\/\/preview\.community\.example\.net;/);
  assert.doesNotMatch(csp, /preview\.studio\.opengeo\.tools/);
  const authPolicy = Object.entries(policies).find(([id]) => id.startsWith("StudioAuthConfigHeaders"))![1];
  assert.match(authPolicy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy,
    /frame-src 'none';/);
});

test("community frame origins fail closed for broad, shared or same-origin configuration", () => {
  const base = {
    env: {account, region: "us-east-1"}, communityDeployment: true,
    domainName: "d123456789.cloudfront.net", dnsZone: "cloudfront.net", dnsRecordHost: "d123456789",
    bucketName: `community-${account}-studio`, resourceNamePrefix: "community-frame-test"
  };
  for (const origins of [[], [previewOrigin, previewOrigin], [previewOrigin, "https://maps.example.net", "https://third.example.net"],
    ["http://preview.example.net"], ["https://*.example.net"], [origin], ["https://preview.example.net/"],
    ["https://user@preview.example.net"], ["https://preview.example.net:444"], ["https://preview.studio.opengeo.tools"]]) {
    assert.throws(() => new StudioWebStack(new App(), "InvalidFrame", {...base, independentPreviewOrigins: origins}),
      /Independent preview origins/);
  }
  assert.throws(() => new StudioWebStack(new App(), "ManagedFrame", {
    ...base, communityDeployment: false, domainName: "studio.opengeo.tools", dnsZone: "opengeo.tools", dnsRecordHost: "studio",
    independentPreviewOrigins: [previewOrigin]
  }), /Independent preview origins/);
});

test("independent preview cannot name a different Studio installation", () => {
  assert.throws(() => new PlatformFoundationStack(new App(), "MismatchedPreviewStudio", {
    env: {account, region: "us-east-1"}, config, budgetAlertEmail: "maintainer@example.invalid",
    standaloneAuthDomainPrefix: `community-${account}`,
    observablePreview: {apiOriginDomain: "abcdefghij.execute-api.us-east-1.amazonaws.com",
      certificateArn: previewCertificate, publicKeyPem: previewKey, deployShell: false,
      independentDeployment: {...independentPreview, studioOrigin: "https://another.example.net"}}
  }), /Independent preview must use this installation's Studio origin/);
});

function synthCommunityEntrypoint(overrides: NodeJS.ProcessEnv = {}) {
  const output = mkdtempSync(join(tmpdir(), "opengeo-community-preview-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OPEN_GEO_|CDK_|AWS_)/.test(key))),
      CDK_OUTDIR: output, AWS_EC2_METADATA_DISABLED: "true",
      OPEN_GEO_COMMUNITY_ACCOUNT: account, OPEN_GEO_COMMUNITY_REGION: "us-east-1",
      OPEN_GEO_COMMUNITY_NAME: "community-entry", OPEN_GEO_COMMUNITY_WEB_ORIGIN: origin,
      OPEN_GEO_COMMUNITY_WEB_DISTRIBUTION_ID: "ESTUDIOCOMMUNITY",
      OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN: "abcdefghij.execute-api.us-east-1.amazonaws.com",
      OPEN_GEO_BUDGET_ALERT_EMAIL: "maintainer@example.invalid",
      OPEN_GEO_API_IMAGE: `sha256:${"a".repeat(64)}`,
      OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
      ...overrides
    };
    const result = spawnSync(process.execPath, ["--import", "tsx", "bin/opengeo-community.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8",
      timeout: 10_000, maxBuffer: 2_000_000
    });
    if (result.error) throw result.error;
    let templates: Record<string, Template> | undefined;
    if (result.status === 0) {
      const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as {
        artifacts: Record<string, {type: string; properties?: {stackName?: string; templateFile?: string}}>
      };
      const prefix = "OpenGeoCommunity-community-entry-";
      templates = Object.fromEntries(Object.entries(manifest.artifacts)
        .filter(([artifactId, item]) => item.type === "aws:cloudformation:stack" &&
          (item.properties?.stackName ?? artifactId).startsWith(prefix))
        .map(([artifactId, artifact]) => {
          assert.ok(artifact.properties?.templateFile);
          return [(artifact.properties.stackName ?? artifactId).slice(prefix.length),
            Template.fromJSON(JSON.parse(readFileSync(join(output, artifact.properties.templateFile), "utf8")))];
        }));
      for (const kind of ["Web", "Foundation", "Api"]) assert.ok(templates[kind], `Missing ${kind} assembly artifact`);
    }
    return {status: result.status, stderr: result.stderr, templates};
  } finally { rmSync(output, {recursive: true, force: true}); }
}

let baselineEntrypoint: ReturnType<typeof synthCommunityEntrypoint> | undefined;
function communityBaseline() {
  return baselineEntrypoint ??= synthCommunityEntrypoint();
}

const nativePreviewConfiguration = {
  domainName: "preview.community.example.net", certificateArn: previewCertificate,
  publicKeyPem: previewKey, privateKeySecretArn: `${previewSecret}12`,
  publicMapsDomainName: "maps-preview.community.example.net"
};

test("community entrypoint opts into native preview across Foundation, API and Web without adding execution", () => {
  const baseline = communityBaseline();
  assert.equal(baseline.status, 0, baseline.stderr);
  const enabled = synthCommunityEntrypoint({OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify(nativePreviewConfiguration)});
  assert.equal(enabled.status, 0, enabled.stderr);
  const templates = enabled.templates!;
  const foundation = templates.Foundation!;
  baseline.templates!.Foundation!.resourceCountIs("AWS::CloudFront::Distribution", 0);
  foundation.resourceCountIs("AWS::CloudFront::Distribution", 1);
  const distribution = Object.values(foundation.findResources("AWS::CloudFront::Distribution"))[0]!;
  assert.deepEqual(distribution.Properties.DistributionConfig.Aliases,
    [nativePreviewConfiguration.domainName, nativePreviewConfiguration.publicMapsDomainName]);
  const shell = Object.entries(foundation.findResources("AWS::S3::Bucket"))
    .find(([, resource]) => resource.Properties.BucketName === `community-entry-${account}-preview-shell`);
  assert.ok(shell);
  assert.deepEqual(foundation.toJSON().Outputs.CommunityPreviewShellBucketName.Value, {Ref: shell[0]});
  assert.equal(foundation.toJSON().Outputs.CommunityPreviewOrigin.Value, previewOrigin);
  const api = Object.values(templates.Api!.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.Environment?.Variables?.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST);
  assert.ok(api);
  const variables = api.Properties.Environment.Variables;
  assert.equal(variables.OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN, previewOrigin);
  assert.equal(variables.OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN,
    `https://${nativePreviewConfiguration.publicMapsDomainName}`);
  assert.equal(variables.OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN, nativePreviewConfiguration.privateKeySecretArn);
  assert.equal("OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL" in variables, false);
  assert.equal("OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL" in variables, false);
  const webPolicies = templates.Web!.findResources("AWS::CloudFront::ResponseHeadersPolicy");
  const studio = Object.entries(webPolicies).find(([id]) => id.startsWith("StudioSecurityHeaders"))![1];
  const csp = studio.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.ok(csp.includes(`frame-src 'self' ${previewOrigin} https://${nativePreviewConfiguration.publicMapsDomainName};`));
  assert.doesNotMatch(JSON.stringify(Object.values(templates).map(template => template.toJSON())),
    /source\.opengeo\.tools|storage\.opengeo\.tools|preview\.studio\.opengeo\.tools/);
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::ECS::Service",
    "AWS::Lambda::Function", "Custom::CDKBucketDeployment"]) {
    const count = (values: Record<string, Template>) => Object.values(values)
      .reduce((total, template) => total + Object.keys(template.findResources(type)).length, 0);
    assert.equal(count(templates), count(baseline.templates!), `${type} must not expand for preview`);
  }
});

const nativePublicationConfiguration = {
  publisherDatabaseSecretArn: `arn:aws:secretsmanager:us-east-1:${account}:secret:community/publisher-AbCd12`,
  destinations: [{
    hostname: "research.community.example.net", bucket: "community-publications", distribution_id: "EPUBLICATIONS",
    origin_id: "community-publications", origin_access_control_id: "ECOMMUNITYOAC"
  }, {
    hostname: "studies.community.example.net", bucket: "community-studies", distribution_id: "ESTUDIES",
    origin_id: "community-studies"
  }]
};

let disabledPublicationEntrypoint: ReturnType<typeof synthCommunityEntrypoint> | undefined;
function communityDisabledPublication() {
  return disabledPublicationEntrypoint ??= synthCommunityEntrypoint({
    OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify(nativePublicationConfiguration)
  });
}

const runtimeSha = "9".repeat(40);
const nativeGitHubBuildConfiguration = {
  githubAppSecretArn: `arn:aws:secretsmanager:us-east-1:${account}:secret:community/github-app-AbCd12`,
  githubAppSecretKeyArn: `arn:aws:kms:us-east-1:${account}:key/11111111-2222-4333-8444-555555555555`,
  coordinatorDatabaseSecretArn: `arn:aws:secretsmanager:us-east-1:${account}:secret:community/compiler-database-AbCd12`,
  databaseClusterArn: `arn:aws:rds:us-east-1:${account}:cluster:community-entry-core`,
  kmsKeyArn: `arn:aws:kms:us-east-1:${account}:key/22222222-3333-4444-8555-666666666666`,
  compilerRepositoryArn: `arn:aws:ecr:us-east-1:${account}:repository/opengeo/dev/observable-builder`,
  repository: {fullName: "independent-owner/runtime", id: 12345, ownerId: 67890, private: false}, runtimeSha
};
const githubBuildEvidence = {
  repository: {id: 12345, owner: {id: 67890}, full_name: "independent-owner/runtime", private: false, archived: false, disabled: false},
  oidc: {use_default: true, use_immutable_subject: true, sub_claim_prefix: "repo:independent-owner@67890/runtime@12345"},
  environment: {name: "studio-framework-build", deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}},
  policies: {total_count: 1, branch_policies: [{type: "branch", name: `studio-runtime-${runtimeSha}`}]},
  ref: {ref: `refs/heads/studio-runtime-${runtimeSha}`, object: {type: "commit", sha: runtimeSha}}
};
let disabledGitHubBuildEntrypoint: ReturnType<typeof synthCommunityEntrypoint> | undefined;
function communityDisabledGitHubBuild() {
  return disabledGitHubBuildEntrypoint ??= synthCommunityEntrypoint({
    OPEN_GEO_COMMUNITY_GITHUB_BUILD_CONFIG: JSON.stringify(nativeGitHubBuildConfiguration)
  });
}

test("community entrypoint creates the existing GitHub controller and independent build role with admission off", () => {
  const baseline = communityBaseline(), result = communityDisabledGitHubBuild();
  assert.equal(result.status, 0, result.stderr);
  const templates = result.templates!, access = templates.GitHubBuildAccess!, controller = templates.GitHubBuildController!;
  assert.ok(access); assert.ok(controller);
  assert.ok(templates.Foundation!.toJSON().Outputs.CommunityApplicationKmsKeyArn);
  controller.hasResourceProperties("AWS::SQS::Queue", {QueueName: "og-community-entry-github-builds"});
  controller.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "og-community-entry-github-build-controller", VpcConfig: Match.absent(),
    Environment: {Variables: Match.objectLike({OPEN_GEO_GITHUB_APP_SECRET_ARN: nativeGitHubBuildConfiguration.githubAppSecretArn})}
  });
  controller.hasResourceProperties("AWS::Lambda::EventSourceMapping", {Enabled: false});
  const fn = Object.values(controller.findResources("AWS::Lambda::Function"))[0]!;
  assert.match(JSON.stringify(fn.Properties.Code.ImageUri), new RegExp(`sha256:${"a".repeat(64)}`));
  const role = Object.values(access.findResources("AWS::IAM::Role"))[0]!;
  assert.equal(role.Properties.RoleName, "og-community-entry-github-framework-build");
  assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Effect, "Deny");
  assert.match(JSON.stringify(role.Properties.Policies), /community-entry-333333333333-us-east-1-app/);
  assert.match(JSON.stringify(role.Properties.Policies), /community-entry-333333333333-us-east-1-data/);
  assert.ok(JSON.stringify(role.Properties.Policies).includes(nativeGitHubBuildConfiguration.coordinatorDatabaseSecretArn));
  assert.equal(JSON.stringify(role.Properties.Policies).includes(nativeGitHubBuildConfiguration.githubAppSecretArn), false);
  assert.equal(role.Properties.Policies.some((policy: {PolicyName: string}) => policy.PolicyName === "AccountArtifactInputs"), false);
  const api = Object.values(templates.Api!.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.Environment?.Variables?.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST)!;
  const variables = api.Properties.Environment.Variables;
  assert.equal("OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL" in variables, false);
  assert.equal(variables.OPEN_GEO_OBSERVABLE_BUILD_PROVIDER, "private_worker");
  assert.equal("OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED" in variables, false);
  assert.equal("OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED" in variables, false);
  assert.doesNotMatch(JSON.stringify([access.toJSON(), controller.toJSON()]),
    /source\.opengeo\.tools|storage\.opengeo\.tools|111111111111|cloudfront:|iam:PassRole|s3:DeleteObject/);
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway", "AWS::ECS::Service", "AWS::ECR::Repository"]) {
    const count = (values: Record<string, Template>) => Object.values(values)
      .reduce((total, template) => total + Object.keys(template.findResources(type)).length, 0);
    assert.equal(count(templates), count(baseline.templates!), `${type} must not expand for GitHub builds`);
  }
});

test("community GitHub activation binds trust evidence and explicit Artifact authority while preserving disabled queue exports", () => {
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const result = synthCommunityEntrypoint({OPEN_GEO_COMMUNITY_GITHUB_BUILD_CONFIG: JSON.stringify({
    ...nativeGitHubBuildConfiguration, enabled: true, freeExecutionVerified: true, githubEvidence: githubBuildEvidence,
    artifactInputOrganizations: [organizationId]
  })});
  assert.equal(result.status, 0, result.stderr);
  const templates = result.templates!, controller = templates.GitHubBuildController!, access = templates.GitHubBuildAccess!;
  controller.hasResourceProperties("AWS::Lambda::EventSourceMapping", {Enabled: true});
  const role = Object.values(access.findResources("AWS::IAM::Role"))[0]!;
  const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(trust.Effect, "Allow");
  assert.equal(trust.Condition.StringEquals["token.actions.githubusercontent.com:sub"],
    "repo:independent-owner@67890/runtime@12345:environment:studio-framework-build");
  const artifacts = role.Properties.Policies.find((policy: {PolicyName: string}) => policy.PolicyName === "AccountArtifactInputs");
  assert.deepEqual(artifacts.PolicyDocument.Statement[0].Action, ["s3:GetObjectVersion"]);
  assert.deepEqual(artifacts.PolicyDocument.Statement[0].Resource,
    [`arn:aws:s3:::community-entry-${account}-us-east-1-app/organizations/${organizationId}/projects/*/artifacts/*/uploads/*/map.html`]);
  const api = Object.values(templates.Api!.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.Environment?.Variables?.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST)!;
  assert.match(JSON.stringify(api.Properties.Environment.Variables.OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL), /GitHubBuildController/);
  assert.equal(api.Properties.Environment.Variables.OPEN_GEO_OBSERVABLE_BUILD_PROVIDER, "github");
  assert.equal(api.Properties.Environment.Variables.OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED, "true");
  assert.equal(api.Properties.Environment.Variables.OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED, "true");
  const exports = (template: Template) => new Map(Object.values(template.toJSON().Outputs as
    Record<string, {Value: unknown; Export?: {Name: string}}>)
    .filter(output => output.Export !== undefined).map(output => [output.Export!.Name, output.Value] as const));
  const enabledExports = exports(controller), disabledExports = exports(communityDisabledGitHubBuild().templates!.GitHubBuildController!);
  const imports = new Set([...JSON.stringify(templates.Api!.toJSON())
    .matchAll(/"Fn::ImportValue":"([^"]*GitHubBuildController[^"]*)"/g)].map(match => match[1]!));
  assert.equal(imports.size, 2);
  for (const name of imports) {
    assert.ok(enabledExports.has(name)); assert.ok(disabledExports.has(name));
    assert.deepEqual(disabledExports.get(name), enabledExports.get(name));
  }
});

test("community GitHub declarations reject unknown settings, credential conflation and unverified admission", () => {
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{OPEN_GEO_COMMUNITY_GITHUB_BUILD_CONFIG: JSON.stringify(nativeGitHubBuildConfiguration), OPEN_GEO_COMMUNITY_WEB_ORIGIN: undefined}, /existing concrete Studio\/API origins/],
    ...[
      {password: "forbidden"}, {enabled: "true"}, {githubAppSecretArn: nativeGitHubBuildConfiguration.coordinatorDatabaseSecretArn},
      {coordinatorDatabaseSecretArn: nativeGitHubBuildConfiguration.coordinatorDatabaseSecretArn.replace(account, "444444444444")},
      {compilerRepositoryArn: `${nativeGitHubBuildConfiguration.compilerRepositoryArn}:latest`},
      {githubAppSecretKeyArn: nativeGitHubBuildConfiguration.githubAppSecretKeyArn.replace(account, "444444444444")},
      {artifactInputOrganizations: ["*"]}, {enabled: true},
      {enabled: true, freeExecutionVerified: true},
      {enabled: true, freeExecutionVerified: true, githubEvidence: {...githubBuildEvidence,
        repository: {...githubBuildEvidence.repository, id: 99999}}}
    ].map(change => [{OPEN_GEO_COMMUNITY_GITHUB_BUILD_CONFIG: JSON.stringify({...nativeGitHubBuildConfiguration, ...change})},
      /closed JSON object|separate complete same-account secrets|Artifact input account grants|verified free execution capacity|Live GitHub trust evidence required|GitHub build trust/] as [NodeJS.ProcessEnv, RegExp])
  ];
  for (const [env, expected] of cases) {
    const result = synthCommunityEntrypoint(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test("community entrypoint installs the existing publisher disabled without creating hosting or compiler execution", () => {
  const baseline = communityBaseline();
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.templates!.FrameworkPublisher, undefined);
  const result = communityDisabledPublication();
  assert.equal(result.status, 0, result.stderr);
  const templates = result.templates!;
  const publisher = templates.FrameworkPublisher!;
  assert.ok(publisher);
  publisher.hasResourceProperties("AWS::Lambda::EventSourceMapping", {Enabled: false, BatchSize: 1});
  publisher.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "og-community-entry-publisher", VpcConfig: Match.absent(),
    ImageConfig: {Command: ["opengeo_api.framework_publication_controller.handler"]},
    Environment: {Variables: Match.objectLike({
      OPEN_GEO_DATA_API_SECRET_ARN: nativePublicationConfiguration.publisherDatabaseSecretArn,
      OPEN_GEO_FRAMEWORK_PUBLICATION_PUBLIC_BUCKET: "community-publications",
      OPEN_GEO_FRAMEWORK_PUBLICATION_DISTRIBUTION_ID: "EPUBLICATIONS",
      OPEN_GEO_FRAMEWORK_PUBLICATION_DESTINATIONS: JSON.stringify(nativePublicationConfiguration.destinations),
      OPEN_GEO_FRAMEWORK_PUBLICATION_PROTECTED_HOSTS: JSON.stringify([
        "d123456789.cloudfront.net", "abcdefghij.execute-api.us-east-1.amazonaws.com"
      ])
    })}
  });
  const functions = Object.values(publisher.findResources("AWS::Lambda::Function"));
  assert.ok(JSON.stringify(functions[0]!.Properties.Code.ImageUri).includes(`sha256:${"a".repeat(64)}`));
  publisher.hasResourceProperties("AWS::SQS::Queue", {QueueName: "og-community-entry-framework-publications"});
  const api = Object.values(templates.Api!.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.Environment?.Variables?.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST)!;
  assert.equal("OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL" in api.Properties.Environment.Variables, false);
  assert.equal("OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL" in api.Properties.Environment.Variables, false);
  assert.doesNotMatch(JSON.stringify(templates.Api!.findResources("AWS::IAM::Policy")), /FrameworkPublisher/);
  const statements = Object.values(publisher.findResources("AWS::IAM::Policy"))
    .flatMap(resource => resource.Properties.PolicyDocument.Statement);
  const matching = (action: string) => statements.filter(statement =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(action));
  assert.deepEqual(matching("secretsmanager:GetSecretValue").map(statement => statement.Resource),
    [nativePublicationConfiguration.publisherDatabaseSecretArn]);
  const writes = matching("s3:PutObject");
  assert.equal(writes.length, 1);
  assert.match(JSON.stringify(writes[0].Resource), /community-publications\/releases\/framework-\*\/\*/);
  assert.match(JSON.stringify(writes[0].Resource), /community-studies\/releases\/framework-\*\/\*/);
  assert.deepEqual(writes[0].Condition, {StringEquals: {"s3:if-none-match": "*"}});
  assert.match(JSON.stringify(matching("cloudfront:UpdateDistribution")[0].Resource), /EPUBLICATIONS/);
  assert.match(JSON.stringify(matching("cloudfront:UpdateDistribution")[0].Resource), /ESTUDIES/);
  assert.doesNotMatch(JSON.stringify(statements), /s3:DeleteObject|sts:AssumeRole|iam:PassRole/);
  for (const type of ["AWS::S3::Bucket", "AWS::CloudFront::Distribution", "AWS::EC2::Instance",
    "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway", "AWS::ECS::Service"]) {
    const count = (values: Record<string, Template>) => Object.values(values)
      .reduce((total, template) => total + Object.keys(template.findResources(type)).length, 0);
    assert.equal(count(templates), count(baseline.templates!), `${type} must not expand for publishing`);
  }
});

test("community entrypoint enables publication dispatch only with explicit true and protects configured preview hosts", () => {
  const result = synthCommunityEntrypoint({
    OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify(nativePreviewConfiguration),
    OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration, enabled: true})
  });
  assert.equal(result.status, 0, result.stderr);
  const publisher = result.templates!.FrameworkPublisher!;
  publisher.hasResourceProperties("AWS::Lambda::EventSourceMapping", {Enabled: true});
  publisher.hasResourceProperties("AWS::Lambda::Function", {Environment: {Variables: Match.objectLike({
    OPEN_GEO_FRAMEWORK_PUBLICATION_PROTECTED_HOSTS: JSON.stringify([
      "d123456789.cloudfront.net", "abcdefghij.execute-api.us-east-1.amazonaws.com",
      nativePreviewConfiguration.domainName, nativePreviewConfiguration.publicMapsDomainName
    ])
  })}});
  const api = Object.values(result.templates!.Api!.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.Environment?.Variables?.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST)!;
  assert.match(JSON.stringify(api.Properties.Environment.Variables.OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL), /FrameworkPublisher/);
  assert.equal("OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL" in api.Properties.Environment.Variables, false);
  result.templates!.Api!.hasResourceProperties("AWS::IAM::Policy", {PolicyDocument: {Statement: Match.arrayWith([
    Match.objectLike({Action: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
      Resource: Match.objectLike({"Fn::ImportValue": Match.stringLikeRegexp("FrameworkPublisher")})})
  ])}});
  const disabled = communityDisabledPublication();
  assert.equal(disabled.status, 0, disabled.stderr);
  const exports = (template: Template) => new Map(Object.values(template.toJSON().Outputs as
    Record<string, {Value: unknown; Export?: {Name: string}}>)
    .filter(output => output.Export !== undefined).map(output => [output.Export!.Name, output.Value] as const));
  const enabledExports = exports(publisher);
  const disabledExports = exports(disabled.templates!.FrameworkPublisher!);
  const currentImports = new Set([...JSON.stringify(result.templates!.Api!.toJSON())
    .matchAll(/"Fn::ImportValue":"([^"]*FrameworkPublisher[^"]*)"/g)].map(match => match[1]!));
  assert.equal(currentImports.size, 2, "The enabled API imports the queue ARN and URL");
  for (const name of currentImports) {
    assert.ok(enabledExports.has(name), `Missing enabled export ${name}`);
    assert.ok(disabledExports.has(name), `Disabling must retain the imported export ${name}`);
    assert.deepEqual(disabledExports.get(name), enabledExports.get(name));
  }
});

test("community publication declarations reject incomplete credentials, execution inputs and protected destinations", () => {
  const valid = JSON.stringify(nativePublicationConfiguration);
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: valid, OPEN_GEO_COMMUNITY_WEB_ORIGIN: undefined}, /existing concrete Studio\/API origins/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: valid, OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: undefined}, /both immutable runtime images/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: valid, OPEN_GEO_COMMUNITY_WEB_DISTRIBUTION_ID: undefined}, /concrete Studio distribution ID/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration, enabled: "true"})}, /closed JSON object/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration, password: "forbidden"})}, /closed JSON object/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration,
      publisherDatabaseSecretArn: nativePublicationConfiguration.publisherDatabaseSecretArn.replace(account, "444444444444")})}, /same-account us-east-1 secret ARN/],
    [{OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration,
      publisherDatabaseSecretArn: nativePublicationConfiguration.publisherDatabaseSecretArn.slice(0, -1)})}, /complete secret suffix/]
  ];
  const target = nativePublicationConfiguration.destinations[0]!;
  const invalidTargets = [
    {...target, hostname: "opengeo.tools"}, {...target, hostname: "pages.studio.opengeo.tools"},
    {...target, hostname: "d123456789.cloudfront.net"},
    {...target, hostname: "abcdefghij.execute-api.us-east-1.amazonaws.com"},
    {...target, hostname: nativePreviewConfiguration.domainName},
    {...target, hostname: nativePreviewConfiguration.publicMapsDomainName},
    {...target, distribution_id: "ESTUDIOCOMMUNITY"},
    ...["app", "data", "studio"].map(suffix => ({...target, bucket: `community-entry-${account}-us-east-1-${suffix}`})),
    {...target, bucket: `community-entry-${account}-preview-shell`},
    {...target, origin_access_control_id: "*"}
  ];
  for (const destination of invalidTargets) cases.push([{
    OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify(nativePreviewConfiguration),
    OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG: JSON.stringify({...nativePublicationConfiguration, destinations: [destination]})
  }, /distinct independent hosting targets/]);
  for (const [env, expected] of cases) {
    const result = synthCommunityEntrypoint(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test("community entrypoint refuses incomplete runtime prerequisites and credential-bearing preview declarations", () => {
  const valid = JSON.stringify(nativePreviewConfiguration);
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: valid, OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN: undefined}, /existing concrete Studio\/API origins/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: valid, OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: undefined}, /both immutable runtime images/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: valid, OPEN_GEO_API_IMAGE: "latest"}, /immutable sha256 digest/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: "{"}, /closed JSON object/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify({...nativePreviewConfiguration, privateKeyPem: "forbidden"})}, /closed JSON object/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify({...nativePreviewConfiguration,
      privateKeySecretArn: nativePreviewConfiguration.privateKeySecretArn.replace(account, "444444444444")})}, /same-account us-east-1 ARNs/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify({...nativePreviewConfiguration,
      privateKeySecretArn: previewSecret})}, /complete secret suffix/],
    [{OPEN_GEO_COMMUNITY_PREVIEW_CONFIG: JSON.stringify({...nativePreviewConfiguration,
      publicKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-private-key\n-----END PRIVATE KEY-----\n"})}, /only a public-key PEM/]
  ];
  for (const [env, expected] of cases) {
    const result = synthCommunityEntrypoint(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
