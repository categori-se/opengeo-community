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
  for (const type of ["AWS::EC2::Instance", "AWS::EC2::VPCEndpoint", "AWS::EC2::NatGateway", "AWS::ECS::Service", "AWS::Lambda::Version"]) {
    template.resourceCountIs(type, 0);
  }
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  assert.doesNotMatch(policies, /s3:PutObject|s3:DeleteObject|cloudfront:|iam:PassRole|sts:AssumeRole/);
  assert.match(policies, /s3:GetObjectVersion/);
  assert.match(policies, /sqs:ChangeMessageVisibility/);
});
