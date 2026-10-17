import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {WorkerControllerStack, type WorkerControllerStackProps} from "../lib/worker-controller-stack.js";

function props(): WorkerControllerStackProps {
  const account = "111111111111", region = "us-east-1";
  const prefix = (service: string) => `arn:aws:${service}:${region}:${account}:`;
  return {env: {account, region}, workerSecretKeyArn: `${prefix("kms")}key/reviewed`,
    alarmTopicArn: `${prefix("sns")}existing-alerts`, configuration: {
      runtime: {account, region, stage: "dev", execution_role_arn: `arn:aws:iam::${account}:role/reviewed`,
        worker_template: {Resources: {Example: {Type: "AWS::ECS::Service"}}},
        endpoint_template: {Resources: {Example: {Type: "AWS::EC2::VPCEndpoint"}}}},
      queueArn: `${prefix("sqs")}jobs`, queueUrl: `https://sqs.${region}.amazonaws.com/${account}/jobs`,
      deadLetterArn: `${prefix("sqs")}dead`, deadLetterUrl: `https://sqs.${region}.amazonaws.com/${account}/dead`,
      databaseClusterArn: `${prefix("rds")}cluster:existing`, workerSecretArn: `${prefix("secretsmanager")}secret:worker-abc123`,
      ecsClusterArn: `${prefix("ecs")}cluster/existing`
    }};
}

test("worker controller is dormant, bounded, and cannot consume jobs or mutate Foundation", () => {
  const template = Template.fromStack(new WorkerControllerStack(new App(), "Controller", props()));
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 60, ReservedConcurrentExecutions: 1, Runtime: "python3.13", VpcConfig: Match.absent()
  });
  const rules = Object.values(template.findResources("AWS::Events::Rule"));
  assert.equal(rules.length, 2);
  for (const rule of rules) assert.equal(rule.Properties.State, "DISABLED");
  template.resourceCountIs("AWS::SQS::Queue", 0);
  template.resourceCountIs("AWS::DynamoDB::Table", 0);
  template.resourceCountIs("AWS::ECS::Service", 0);
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(p => p.Properties.PolicyDocument.Statement);
  const cfn = policies.filter(p => JSON.stringify(p.Action).includes("cloudformation:CreateStack"));
  assert.equal(cfn.length, 1);
  assert.deepEqual(cfn[0].Resource, [
    "arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-dev-Worker/*",
    "arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-dev-PrivateRuntimeEndpoints/*"
  ]);
  const all = JSON.stringify(policies);
  assert.doesNotMatch(all, /sqs:(ReceiveMessage|DeleteMessage)|ecs:(RunTask|UpdateService)|s3:|cloudfront:|Foundation/);
});

test("worker controller rejects foreign resources and mismatched queue URLs", () => {
  for (const change of [
    (p: WorkerControllerStackProps) => {p.configuration.databaseClusterArn = "arn:aws:rds:us-east-1:222222222222:cluster:foreign";},
    (p: WorkerControllerStackProps) => {p.configuration.queueUrl += "-other";}
  ]) {
    const input = props(); change(input);
    assert.throws(() => new WorkerControllerStack(new App(), "Rejected", input));
  }
});

test("dedicated processing alerts use the operations contact and only the controller alarm", () => {
  const input = props();
  const template = Template.fromStack(new WorkerControllerStack(new App(), "OwnAlerts", {
    ...input, alarmTopicArn: undefined, alertEmail: "operations@example.invalid"
  }));
  template.hasResourceProperties("AWS::SNS::Topic", {TopicName: "opengeo-dev-processing-alerts"});
  template.hasResourceProperties("AWS::SNS::Subscription", {Protocol: "email", Endpoint: "operations@example.invalid"});
  const policies = Object.values(template.findResources("AWS::SNS::TopicPolicy"));
  const statements = policies.flatMap(p => p.Properties.PolicyDocument.Statement);
  const publish = statements.filter(p => p.Effect === "Allow" && [p.Action].flat().includes("sns:Publish"));
  assert.equal(publish.length, 1);
  assert.deepEqual(publish[0].Principal, {Service: "cloudwatch.amazonaws.com"});
  assert.deepEqual(publish[0].Condition, {
    StringEquals: {"aws:SourceAccount": "111111111111"},
    ArnEquals: {"aws:SourceArn": "arn:aws:cloudwatch:us-east-1:111111111111:alarm:opengeo-dev-worker-controller-errors"}
  });
  assert.throws(() => new WorkerControllerStack(new App(), "AmbiguousAlerts", {...input, alertEmail: "operations@example.invalid"}));
});

test("operator-managed worker roles expose exports without changing reviewed grants", () => {
  const input = props();
  input.configuration.runtime.worker_template = {Resources: {
    TaskRole: {Type: "AWS::IAM::Role", Properties: {AssumeRolePolicyDocument: {Statement: [{Effect: "Allow", Action: "sts:AssumeRole", Principal: {Service: "ecs-tasks.amazonaws.com"}}]}}},
    ExecutionRole: {Type: "AWS::IAM::Role", Properties: {AssumeRolePolicyDocument: {Statement: [{Effect: "Allow", Action: "sts:AssumeRole", Principal: {Service: "ecs-tasks.amazonaws.com"}}]}}},
    TaskPolicy: {Type: "AWS::IAM::Policy", Properties: {PolicyName: "TaskPolicy", Roles: [{Ref: "TaskRole"}], PolicyDocument: {Statement: [{Effect: "Allow", Action: "sqs:GetQueueAttributes", Resource: input.configuration.queueArn}]}}},
    ExecutionPolicy: {Type: "AWS::IAM::Policy", Properties: {PolicyName: "ExecutionPolicy", Roles: [{Ref: "ExecutionRole"}], PolicyDocument: {Statement: [{Effect: "Allow", Action: "logs:PutLogEvents", Resource: "arn:aws:logs:us-east-1:111111111111:log-group:worker:*"}]}}},
    Service: {Type: "AWS::ECS::Service", Properties: {ServiceName: "opengeo-dev-gis-worker"}},
    Task: {Type: "AWS::ECS::TaskDefinition", Properties: {Family: "ReviewedWorker", TaskRoleArn: {"Fn::GetAtt": ["TaskRole", "Arn"]}, ExecutionRoleArn: {"Fn::GetAtt": ["ExecutionRole", "Arn"]}}}
  }};
  input.configuration.runtime.execution_role_arn = "arn:aws:iam::111111111111:role/opengeo-dev-worker-lifecycle";
  const template = Template.fromStack(new WorkerControllerStack(new App(), "Retained", {...input, retainWorkerRoles: true,
    lifecycleScope: {vpcId: "vpc-abc123", subnetIds: ["subnet-abc123"], routeTableIds: ["rtb-abc123"], databaseSecurityGroupId: "sg-0db12345", taskFamily: "ReviewedWorker"}
  }));
  template.resourceCountIs("AWS::IAM::Role", 4);
  template.hasResourceProperties("AWS::IAM::Role", {RoleName: "opengeo-dev-worker-lifecycle",
    AssumeRolePolicyDocument: {Statement: [{Action: "sts:AssumeRole", Effect: "Allow", Principal: {Service: "cloudformation.amazonaws.com"}}], Version: "2012-10-17"}
  });
  template.hasResourceProperties("AWS::IAM::Role", {RoleName: "opengeo-dev-worker-task", Policies: [{PolicyName: "TaskPolicy", PolicyDocument: {Statement: [{Effect: "Allow", Action: "sqs:GetQueueAttributes", Resource: input.configuration.queueArn}]}}]});
  template.hasOutput("WorkerRoleArn0", {Export: {Name: "Retained:WorkerTaskRoleArn"}});
  template.hasOutput("WorkerRoleArn1", {Export: {Name: "Retained:WorkerExecutionRoleArn"}});
});
