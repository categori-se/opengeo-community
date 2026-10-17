import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {environmentConfig} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {AnalysisResourcesStack, AnalysisRuntimeStack, analysisProfilesSha256, type AnalysisProfiles} from "../lib/analysis-runtime-stack.js";
import {WorkerControllerStack} from "../lib/worker-controller-stack.js";
import {analysisLifecyclePolicy} from "../lib/worker-lifecycle-policy.js";

const env = {account: "111111111111", region: "us-east-1"};
const profiles: AnalysisProfiles = {schemaVersion: 1, architecture: "arm64", profiles: {
  python: {image: `sha256:${"a".repeat(64)}`, interpreter: "/usr/local/bin/python3"},
  javascript: {image: `sha256:${"b".repeat(64)}`, interpreter: "/usr/local/bin/node"},
  bash: {image: `sha256:${"b".repeat(64)}`, interpreter: "/bin/bash"}}};
function templates(active = false) {
  const app = new App(), config = environmentConfig("dev", "http://localhost:3000");
  const foundation = new PlatformFoundationStack(app, "Foundation", {config, env,
    budgetAlertEmail: "opengeo-ci@example.invalid", existingUserPoolClientId: "5l2abc123def456ghi789jklmn"});
  const secret = "arn:aws:secretsmanager:us-east-1:111111111111:secret:analysis-runtime-abc123";
  const resources = new AnalysisResourcesStack(app, "AnalysisResources", {config, foundation, runtimeSecretArn: secret, env});
  const host = new AnalysisRuntimeStack(app, "AnalysisRuntime", {config, foundation, resources, env, runtimeSecretArn: secret,
    endpointSecurityGroupId: "sg-0123456789abcdef0", runnerAmiId: "ami-aaaaaaaaaaaaaaaaa", runnerAmiEvidenceSha256: "e".repeat(64),
    runnerAmiManifestSha256: "f".repeat(64),
    profiles, profilesSha256: analysisProfilesSha256(profiles), activateForWindow: active});
  return {resources: Template.fromStack(resources), host: Template.fromStack(host)};
}

test("analysis keeps durable queue and roles outside its deletable default-zero host", () => {
  const {resources, host} = templates();
  resources.resourceCountIs("AWS::SQS::Queue", 2);resources.resourceCountIs("AWS::SecretsManager::Secret", 0);
  host.resourceCountIs("AWS::SQS::Queue", 0);host.resourceCountIs("AWS::IAM::Role", 0);
  host.resourceCountIs("AWS::IAM::InstanceProfile", 0);host.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
  host.resourceCountIs("AWS::EC2::NatGateway", 0);
  host.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {MinSize: "0", MaxSize: "1", DesiredCapacity: "0"});
  const policy = JSON.stringify(resources.findResources("AWS::IAM::Policy"));
  assert.match(policy, /analysis\/\*\/snapshot\.json/);assert.match(policy, /analysis\/\*\/result\.json/);
  assert.doesNotMatch(policy, /source-projects|opengeo_worker|ecs:|ecr:/);
});

test("admitted analysis host wakes one cached-image daemon with immutable window binding", () => {
  const {host} = templates(true);
  host.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {MinSize: "0", MaxSize: "1", DesiredCapacity: "1"});
  const json = JSON.stringify(host.toJSON());assert.match(json, /ActivationWindowId/);
  assert.match(json, /OPEN_GEO_ANALYSIS_WINDOW_ID/);assert.match(json, /OPEN_GEO_ANALYSIS_PROFILES_SHA256/);
  assert.match(json, /OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256/);
  assert.match(json, /OPEN_GEO_ANALYSIS_RUNNER_AMI_EVIDENCE_SHA256/);
  assert.match(json, /opengeo-analysis-coordinator\.service/);assert.match(json, /opengeo:analysis-stack/);
  assert.doesNotMatch(json, /apt-get|docker pull|podman pull|observable-coordinator\.service/);
  assert.throws(() => analysisProfilesSha256({...profiles, profiles: {...profiles.profiles, python: {...profiles.profiles.python, image: "latest"}}}));
  assert.throws(() => analysisProfilesSha256({...profiles, profiles: {...profiles.profiles,
    javascript: {...profiles.profiles.javascript, interpreter: "/nodejs/bin/node"}}}));
});

test("analysis controller starts dormant and cannot mutate endpoints or invoke ECS", () => {
  const baseline = {Resources: {Existing: {Type: "AWS::EC2::VPCEndpoint"}}};
  const host = {Parameters: {ActivationWindowId: {Type: "String"}}, Resources: {Group: {
    Type: "AWS::AutoScaling::AutoScalingGroup", Properties: {AutoScalingGroupName: "opengeo-dev-analysis", MinSize: "0", MaxSize: "1", DesiredCapacity: "1"}}}};
  const controller = new WorkerControllerStack(new App(), "AnalysisController", {env,
    workerSecretKeyArn: "arn:aws:kms:us-east-1:111111111111:key/reviewed", alarmTopicArn: "arn:aws:sns:us-east-1:111111111111:alerts",
    configuration: {runtime: {...env, stage: "dev", execution_role_arn: "arn:aws:iam::111111111111:role/reviewed",
      workload: "analysis", worker_template: host, endpoint_template: baseline, shared_endpoint_template: baseline},
      queueArn: "arn:aws:sqs:us-east-1:111111111111:analysis", queueUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/analysis",
      deadLetterArn: "arn:aws:sqs:us-east-1:111111111111:analysis-dead", deadLetterUrl: "https://sqs.us-east-1.amazonaws.com/111111111111/analysis-dead",
      databaseClusterArn: "arn:aws:rds:us-east-1:111111111111:cluster:existing",
      workerSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:analysis-controller-abc123"}});
  const template = Template.fromStack(controller);
  const rules = Object.values(template.findResources("AWS::Events::Rule"));
  assert.ok(rules.every(r => r.Properties.State === "DISABLED"));
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(p => p.Properties.PolicyDocument.Statement);
  const mutation = policies.find(p => [p.Action].flat().includes("cloudformation:DeleteStack"));
  assert.deepEqual([mutation.Resource].flat(), ["arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-dev-AnalysisRuntime/*"]);
  assert.doesNotMatch(JSON.stringify(policies), /ecs:|sqs:ReceiveMessage|s3:GetObject/);
  assert.match(JSON.stringify(policies), /analysis-controller-tick/);
  template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 1);
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0});
});

test("analysis lifecycle role has no endpoint lifecycle, data, IAM writes or unrelated host authority", () => {
  const policy = analysisLifecyclePolicy(env.account, env.region, "dev", {vpcId: "vpc-abc123", subnetIds: ["subnet-abc123"],
    endpointSecurityGroupId: "sg-0123456789abcdef0", hostRoleArn: "arn:aws:iam::111111111111:role/opengeo-dev-analysis-host",
    instanceProfileArn: "arn:aws:iam::111111111111:instance-profile/opengeo-dev-analysis-host"}).toJSON();
  const json = JSON.stringify(policy);assert.doesNotMatch(json, /CreateVpcEndpoint|DeleteVpcEndpoint|s3:|rds-data:|secretsmanager:|ecs:|CreateRole/);
  assert.match(json, /autoScalingGroupName\/opengeo-dev-analysis/);
});
