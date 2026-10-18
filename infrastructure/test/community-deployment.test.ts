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
      templates = Object.fromEntries(["Web", "Foundation", "Api"].map(kind => {
        const artifact = Object.entries(manifest.artifacts).find(([artifactId, item]) =>
          item.type === "aws:cloudformation:stack" &&
          (item.properties?.stackName ?? artifactId) === `OpenGeoCommunity-community-entry-${kind}`)?.[1];
        assert.ok(artifact?.properties?.templateFile, `Missing ${kind} assembly artifact`);
        return [kind, Template.fromJSON(JSON.parse(readFileSync(join(output, artifact.properties.templateFile), "utf8")))];
      }));
    }
    return {status: result.status, stderr: result.stderr, templates};
  } finally { rmSync(output, {recursive: true, force: true}); }
}

const nativePreviewConfiguration = {
  domainName: "preview.community.example.net", certificateArn: previewCertificate,
  publicKeyPem: previewKey, privateKeySecretArn: `${previewSecret}12`,
  publicMapsDomainName: "maps-preview.community.example.net"
};

test("community entrypoint opts into native preview across Foundation, API and Web without adding execution", () => {
  const baseline = synthCommunityEntrypoint();
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
