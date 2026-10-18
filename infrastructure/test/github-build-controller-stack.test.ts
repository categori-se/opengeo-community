import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {GitHubBuildControllerStack} from "../lib/github-build-controller-stack.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";

test("GitHub controller defaults off and has no idle compute or publication authority", () => {
  const app = new App();
  const config = environmentConfig("dev", "http://localhost:3000");
  const env = {account: "111111111111", region: "us-east-1"};
  const foundation = new PlatformFoundationStack(app, "Foundation", {
    config, env, budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn"
  });
  const stack = new GitHubBuildControllerStack(app, "GitHub", {
    config, foundation, env, imageDigest: `sha256:${"a".repeat(64)}`,
    githubAppSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/github-App123"
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 900, MemorySize: 512, ReservedConcurrentExecutions: 2,
    VpcConfig: Match.absent(),
    ImageConfig: {Command: ["opengeo_api.github_build_controller.handler"]},
    Environment: {Variables: Match.objectLike({OPEN_GEO_OBSERVABLE_BUILD_PROVIDER: "github"})}
  });
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    Enabled: false, BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"]
  });
  template.hasResourceProperties("AWS::SQS::Queue", {
    VisibilityTimeout: 5400, RedrivePolicy: Match.objectLike({maxReceiveCount: 100})
  });
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: "opengeo-dev-github-builds"});
  template.hasResourceProperties("AWS::Lambda::Function", {FunctionName: "opengeo-dev-github-build-controller"});
  template.hasResourceProperties("AWS::Logs::LogGroup", {LogGroupName: "/opengeo/dev/github-build-controller"});
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway", "AWS::ECS::Service", "AWS::Lambda::Version"]) {
    template.resourceCountIs(type, 0);
  }
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  assert.doesNotMatch(policies, /s3:PutObject|s3:DeleteObject|cloudfront:|iam:PassRole|sts:AssumeRole/);
  assert.match(policies, /s3:GetObjectVersion/);
  assert.match(policies, /sqs:ChangeMessageVisibility/);
});

test("independent controller uses retained API image, installation names and exact local App secret authority", () => {
  const app = new App(), env = {account: "333333333333", region: "us-east-1"};
  const config = environmentConfig("dev", "https://d123456789.cloudfront.net", {}, {
    application: "independent-source", data: "independent-archive"
  });
  const foundation = new PlatformFoundationStack(app, "IndependentFoundation", {
    config, env, budgetAlertEmail: "maintainer@example.invalid", standaloneAuthDomainPrefix: "independent-controller"
  });
  const githubAppSecretArn = `arn:aws:secretsmanager:us-east-1:${env.account}:secret:independent/github-AbCd12`;
  const githubAppSecretKeyArn = `arn:aws:kms:us-east-1:${env.account}:key/11111111-2222-4333-8444-555555555555`;
  const stack = new GitHubBuildControllerStack(app, "IndependentController", {
    config, foundation, env, imageDigest: `sha256:${"a".repeat(64)}`, githubAppSecretArn, githubAppSecretKeyArn,
    resourceNamePrefix: "og-independent"
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: "og-independent-github-builds"});
  template.hasResourceProperties("AWS::SQS::Queue", {QueueName: "og-independent-github-builds-dlq"});
  template.hasResourceProperties("AWS::Logs::LogGroup", {LogGroupName: "/opengeo/og-independent/github-build-controller"});
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "og-independent-github-build-controller", VpcConfig: Match.absent(),
    Environment: {Variables: Match.objectLike({OPEN_GEO_GITHUB_APP_SECRET_ARN: githubAppSecretArn})}
  });
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {Enabled: false});
  const controller = Object.values(template.findResources("AWS::Lambda::Function"))[0]!;
  assert.match(JSON.stringify(controller.Properties.Code.ImageUri), new RegExp(`sha256:${"a".repeat(64)}`));
  template.hasResourceProperties("AWS::IAM::Policy", {PolicyDocument: {Statement: Match.arrayWith([
    Match.objectLike({Action: "kms:Decrypt", Resource: githubAppSecretKeyArn,
      Condition: {StringEquals: {"kms:ViaService": "secretsmanager.us-east-1.amazonaws.com", "kms:EncryptionContext:SecretARN": githubAppSecretArn}}})
  ])}});
  const document = JSON.stringify(template.toJSON());
  assert.doesNotMatch(document, /source\.opengeo\.tools|s3:PutObject|cloudfront:|iam:PassRole/);
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::ECS::Service", "AWS::ECR::Repository"]) {
    template.resourceCountIs(type, 0);
  }
});

test("independent controller rejects mutable credentials, foreign encryption keys and unsafe names", () => {
  const app = new App(), env = {account: "333333333333", region: "us-east-1"};
  const config = environmentConfig("dev", "https://d123456789.cloudfront.net", {}, {
    application: "independent-source", data: "independent-archive"
  });
  const foundation = new PlatformFoundationStack(app, "RejectedControllerFoundation", {
    config, env, budgetAlertEmail: "maintainer@example.invalid", standaloneAuthDomainPrefix: "rejected-controller"
  });
  const base = {config, foundation, env, imageDigest: `sha256:${"a".repeat(64)}`,
    githubAppSecretArn: `arn:aws:secretsmanager:us-east-1:${env.account}:secret:independent/github-AbCd12`,
    resourceNamePrefix: "og-independent"};
  for (const [index, change] of [
    {resourceNamePrefix: "og-independent\n"}, {resourceNamePrefix: "x".repeat(41)},
    {githubAppSecretArn: base.githubAppSecretArn.slice(0, -1)},
    {githubAppSecretArn: `${base.githubAppSecretArn}*`},
    {githubAppSecretKeyArn: "arn:aws:kms:us-east-1:444444444444:key/11111111-2222-4333-8444-555555555555"},
    {githubAppSecretKeyArn: `arn:aws:kms:us-west-2:${env.account}:key/11111111-2222-4333-8444-555555555555`},
    {githubAppSecretKeyArn: `arn:aws:kms:us-east-1:${env.account}:alias/github-app`}
  ].entries()) {
    assert.throws(() => new GitHubBuildControllerStack(app, `RejectedController${index}`, {...base, ...change}),
      /resource-name prefix|GitHub App (?:credential|encryption key|secret)/);
  }
});
