import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {FrameworkPublisherStack} from "../lib/framework-publisher-stack.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";

function multiHostTemplate(destinations: any[], protectedHosts: string[] = []) {
  const app = new App();
  const config = environmentConfig("dev", "http://localhost:3000");
  const env = {account: "111111111111", region: "us-east-1"};
  const foundation = new PlatformFoundationStack(app, "Foundation", {
    config, env, budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn"
  });
  return Template.fromStack(new FrameworkPublisherStack(app, "Publisher", {
    config, foundation, env, imageDigest: `sha256:${"a".repeat(64)}`,
    publisherDatabaseSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/publisher-Abc123",
    publicBucket: "opengeo.tools", distributionId: "EXAMPLE", destinations, protectedHosts
  }));
}

const targets = [
  {hostname: "opengeo.tools", bucket: "opengeo.tools", distribution_id: "EXAMPLE", origin_id: "opengeo.tools.s3.us-east-1.amazonaws.com-mnkd5ulkkgh"},
  {hostname: "pages.studio.opengeo.tools", bucket: "public-pages", distribution_id: "EPAGES", origin_id: "pages"}
];

test("multi-host configuration and permissions contain only explicitly paired targets", () => {
  const template = multiHostTemplate(targets);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {Variables: {
      OPEN_GEO_FRAMEWORK_PUBLICATION_DESTINATIONS: JSON.stringify(targets),
      OPEN_GEO_FRAMEWORK_PUBLICATION_PROTECTED_HOSTS: "[]"
    }}
  });
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
  const matching = (action: string) => statements.filter(statement =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(action));
  const writes = matching("s3:PutObject");
  assert.equal(writes.length, 1);
  const render = (resource: any) => resource["Fn::Join"][1].join("").replace("[object Object]", "aws");
  assert.deepEqual(writes[0].Resource.map(render), [
    "arn:aws:s3:::opengeo.tools/releases/framework-*/*",
    "arn:aws:s3:::public-pages/releases/framework-*/*"
  ]);
  assert.deepEqual(writes[0].Condition, {StringEquals: {"s3:if-none-match": "*"}});
  assert.deepEqual(matching("cloudfront:UpdateDistribution")[0].Resource.map(render), [
    "arn:aws:cloudfront::111111111111:distribution/EXAMPLE",
    "arn:aws:cloudfront::111111111111:distribution/EPAGES"
  ]);
  assert.doesNotMatch(JSON.stringify(statements), /s3:DeleteObject|sts:AssumeRole|iam:PassRole/);
  template.resourceCountIs("AWS::S3::Bucket", 0);
  template.resourceCountIs("AWS::CloudFront::Distribution", 0);
});

test("invalid and protected multi-host configurations fail before synthesis", () => {
  for (const invalid of [[], [targets[1]], [...targets, targets[0]],
    [targets[0], {...targets[1], hostname: "studio.opengeo.tools"}],
    [targets[0], {...targets[1], distribution_id: "*"}],
    [targets[0], {...targets[1], origin_id: "../pages"}]]) {
    assert.throws(() => multiHostTemplate(invalid), /Invalid publication destinations/);
  }
  assert.throws(() => multiHostTemplate(targets, ["pages.studio.opengeo.tools"]), /Invalid publication destinations/);
});

test("publisher is on-demand, defaults off and cannot overwrite existing releases or source", () => {
  const app = new App();
  const config = environmentConfig("dev", "http://localhost:3000");
  const env = {account: "111111111111", region: "us-east-1"};
  const foundation = new PlatformFoundationStack(app, "Foundation", {
    config, env, budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn"
  });
  const stack = new FrameworkPublisherStack(app, "Publisher", {
    config, foundation, env, imageDigest: `sha256:${"a".repeat(64)}`,
    publisherDatabaseSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/publisher-Abc123",
    publicBucket: "opengeo.tools", distributionId: "EXAMPLE"
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 900, MemorySize: 512, ReservedConcurrentExecutions: 2,
    VpcConfig: Match.absent(), ImageConfig: {Command: ["opengeo_api.framework_publication_controller.handler"]}
  });
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    Enabled: false, BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"]
  });
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway", "AWS::ECS::Service", "AWS::Lambda::Version"]) {
    template.resourceCountIs(type, 0);
  }
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
  const actions = (statement: {Action: string | string[]}): string[] => Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  const writes = statements.filter(statement => actions(statement).includes("s3:PutObject"));
  assert.equal(writes.length, 1);
  assert.match(JSON.stringify(writes[0].Resource), /opengeo.tools\/releases\/framework-\*\/\*/);
  assert.deepEqual(writes[0].Condition, {StringEquals: {"s3:if-none-match": "*"}});
  assert.doesNotMatch(JSON.stringify(statements), /s3:DeleteObject|iam:PassRole|sts:AssumeRole|github-App/);
  const edge = statements.filter(statement => actions(statement).includes("cloudfront:UpdateDistribution"));
  assert.equal(edge.length, 1);
  assert.match(JSON.stringify(edge[0].Resource), /distribution\/EXAMPLE/);
});
