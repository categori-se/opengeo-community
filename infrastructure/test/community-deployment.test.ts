import assert from "node:assert/strict";
import {test} from "node:test";
import {App, Fn} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {StudioWebStack} from "../lib/studio-web-stack.js";

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
