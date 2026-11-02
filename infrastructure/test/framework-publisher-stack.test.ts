import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {FrameworkPublisherStack, publicationWithdrawalPolicyStatements} from "../lib/framework-publisher-stack.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";

function multiHostTemplate(destinations: any[] | undefined, protectedHosts: string[] = [], resourceNamePrefix?: string,
    withdrawalTaggingEnabled?: boolean) {
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
    publicBucket: "opengeo.tools", distributionId: "EXAMPLE", destinations, protectedHosts, resourceNamePrefix,
    withdrawalTaggingEnabled
  }));
}

const targets = [
  {hostname: "opengeo.tools", bucket: "opengeo.tools", distribution_id: "EXAMPLE", origin_id: "opengeo.tools.s3.us-east-1.amazonaws.com-mnkd5ulkkgh"},
  {hostname: "pages.studio.opengeo.tools", bucket: "public-pages", distribution_id: "EPAGES", origin_id: "pages"}
];

test("multi-host configuration and permissions contain only explicitly paired targets", () => {
  const template = multiHostTemplate(targets);
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "opengeo-dev-framework-publisher",
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
  assert.doesNotMatch(JSON.stringify(statements), /s3:DeleteObject|sts:AssumeRole|iam:PassRole|s3:.*Tagging|s3:GetBucketPolicy|s3:GetBucketPublicAccessBlock|cloudfront:GetCachePolicy|cloudfront:GetOriginRequestPolicy/);
  assert.doesNotMatch(JSON.stringify(template.toJSON().Outputs), /Withdrawal/);
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
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: "opengeo-dev-framework-publications"});
  template.hasResourceProperties("AWS::Logs::LogGroup", {LogGroupName: "/opengeo/dev/framework-publisher"});
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

test("publisher physical names can belong to an independent installation without changing legacy names", () => {
  const prefix = `community-${"a".repeat(38)}`;
  assert.equal(prefix.length, 48);
  const template = multiHostTemplate(targets, [], prefix);
  template.hasResourceProperties("AWS::Lambda::Function", {FunctionName: `${prefix}-publisher`});
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: `${prefix}-framework-publications`});
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: `${prefix}-framework-publications-dlq`});
  template.hasResourceProperties("AWS::Logs::LogGroup", {LogGroupName: `/opengeo/${prefix}/framework-publisher`});
  for (const invalid of ["", "Uppercase", "9community", "community-", "community--one", "a".repeat(49)]) {
    assert.throws(() => multiHostTemplate(targets, [], invalid), /Publisher resource-name prefix/);
  }
});

const privateTargets = targets.map((target, index) => ({
  ...target, origin_access_control_id: index === 0 ? "EOACMAIN" : "EOACPAGES"
}));

test("withdrawal tagging requires explicit private OAC destinations and independent buckets", () => {
  for (const invalid of [undefined, targets, [privateTargets[0], targets[1]],
    [privateTargets[0], {...privateTargets[1], bucket: privateTargets[0]!.bucket}],
    [privateTargets[0], {...privateTargets[1], origin_access_control_id: ""}]]) {
    assert.throws(() => multiHostTemplate(invalid, [], undefined, true),
      /Withdrawal tagging requires explicit private OAC publication destinations with unique buckets/);
  }
});

test("withdrawal tagging grants only exact private metadata reads and reserved monotonic tag writes", () => {
  const template = multiHostTemplate(privateTargets, [], undefined, true);
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
  const matching = (action: string) => statements.filter(statement =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(action));
  const render = (resource: any) => resource["Fn::Join"][1].join("").replace("[object Object]", "aws");
  const objectResources = [
    "arn:aws:s3:::opengeo.tools/releases/framework-*/*",
    "arn:aws:s3:::public-pages/releases/framework-*/*"
  ];
  for (const action of ["s3:GetObjectTagging", "s3:GetObjectVersionTagging",
    "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]) {
    assert.equal(matching(action).length, 1);
    assert.deepEqual(matching(action)[0].Resource.map(render), objectResources);
  }
  assert.deepEqual(matching("s3:PutObjectTagging")[0].Condition, {
    StringEquals: {"s3:RequestObjectTag/opengeo-withdrawn": "true"},
    "ForAllValues:StringEquals": {"s3:RequestObjectTagKeys": ["opengeo-withdrawn"]}
  });
  for (const action of ["s3:GetBucketPolicy", "s3:GetBucketPublicAccessBlock"]) {
    assert.equal(matching(action).length, 1);
    assert.deepEqual(matching(action)[0].Resource.map(render), [
      "arn:aws:s3:::opengeo.tools", "arn:aws:s3:::public-pages"
    ]);
  }
  for (const action of ["cloudfront:GetCachePolicy", "cloudfront:GetOriginRequestPolicy"]) {
    assert.equal(matching(action).length, 1);
    assert.equal(matching(action)[0].Resource, "*");
  }
  assert.doesNotMatch(JSON.stringify(statements), /s3:DeleteObject|s3:PutBucketPolicy|s3:PutBucketPublicAccessBlock/);
  assert.doesNotMatch(JSON.stringify(statements), /cloudfront:(Create|Update|Delete)(CachePolicy|OriginRequestPolicy)/);

  const baseline = multiHostTemplate(privateTargets);
  const resourceTypes = (input: Template) => Object.values(input.toJSON().Resources)
    .map((resource: any) => resource.Type).sort();
  assert.deepEqual(resourceTypes(template), resourceTypes(baseline));
  for (const type of ["AWS::S3::Bucket", "AWS::S3::BucketPolicy", "AWS::CloudFront::Distribution",
    "AWS::CloudFront::Function", "AWS::Lambda::Version", "AWS::EC2::Instance"]) {
    template.resourceCountIs(type, 0);
  }
  template.resourceCountIs("AWS::Lambda::Function", 1);
  const enabledFunction = Object.values(template.findResources("AWS::Lambda::Function"))[0] as any;
  const baselineFunction = Object.values(baseline.findResources("AWS::Lambda::Function"))[0] as any;
  assert.deepEqual(enabledFunction.Properties.Environment, baselineFunction.Properties.Environment);
  assert.doesNotMatch(JSON.stringify(enabledFunction.Properties.Environment), /WITHDRAWAL/);

  const outputs = template.toJSON().Outputs;
  const role = Object.keys(template.findResources("AWS::IAM::Role"))[0];
  assert.ok(role);
  for (const [index, target] of privateTargets.entries()) {
    assert.deepEqual(outputs[`WithdrawalPublisherRoleArn${index + 1}`].Value, {"Fn::GetAtt": [role, "Arn"]});
    const fragment = JSON.stringify(outputs[`WithdrawalPolicyFragment${index + 1}`].Value);
    assert.ok(fragment.includes(target.bucket));
    assert.ok(fragment.includes(`:distribution/${target.distribution_id}`));
    assert.ok(fragment.includes(role));
    assert.ok(fragment.includes("DenyFrameworkPublicationTagDeletion"));
  }
});

test("withdrawal policy fragment binds one distribution and sole writer while denying reversal", () => {
  const identity = Object.freeze({
    bucketArn: "arn:aws:s3:::public-pages",
    distributionArn: "arn:aws:cloudfront::111111111111:distribution/EPAGES",
    publisherRoleArn: "arn:aws:iam::111111111111:role/exact-publisher"
  });
  const resource = `${identity.bucketArn}/releases/framework-*/*`;
  assert.deepEqual(publicationWithdrawalPolicyStatements(identity), [
    {
      Sid: "DenyWithdrawnFrameworkPublicationDelivery", Effect: "Deny",
      Principal: {Service: "cloudfront.amazonaws.com"},
      Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: resource,
      Condition: {StringEquals: {"AWS:SourceArn": identity.distributionArn,
        "s3:ExistingObjectTag/opengeo-withdrawn": "true"}}
    },
    {
      Sid: "DenyFrameworkPublicationTaggingOutsidePublisher", Effect: "Deny", Principal: "*",
      Action: ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"], Resource: resource,
      Condition: {ArnNotEquals: {"aws:PrincipalArn": identity.publisherRoleArn}}
    },
    {
      Sid: "DenyFrameworkPublicationTaggingWithoutWithdrawal", Effect: "Deny", Principal: "*",
      Action: ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"], Resource: resource,
      Condition: {StringNotEquals: {"s3:RequestObjectTag/opengeo-withdrawn": "true"}}
    },
    {
      Sid: "DenyFrameworkPublicationTagDeletion", Effect: "Deny", Principal: "*",
      Action: ["s3:DeleteObjectTagging", "s3:DeleteObjectVersionTagging"], Resource: resource
    }
  ]);
});
