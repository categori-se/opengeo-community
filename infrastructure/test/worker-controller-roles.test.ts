import assert from "node:assert/strict";
import {test} from "node:test";
import {retainWorkerRoles} from "../lib/worker-controller-roles.js";
const bindings = {
  task: {arn: "arn:aws:iam::111111111111:role/opengeo-dev-worker-task", exportName: "Controller:Task"},
  execution: {arn: "arn:aws:iam::111111111111:role/opengeo-dev-worker-execution", exportName: "Controller:Execution"}
};
function fixture(): Record<string, any> {
  const role = {Type: "AWS::IAM::Role", Properties: {AssumeRolePolicyDocument: {Statement: [{Effect: "Allow", Action: "sts:AssumeRole", Principal: {Service: "ecs-tasks.amazonaws.com"}}]}}};
  const policy = (id: string) => ({Type: "AWS::IAM::Policy", Properties: {
    PolicyName: `${id}Policy`, PolicyDocument: {Statement: [{Effect: "Allow", Action: "sqs:GetQueueAttributes", Resource: "arn:aws:sqs:us-east-1:111111111111:exact"}]}, Roles: [{Ref: id}]
  }});
  return {Resources: {TaskRole: structuredClone(role), ExecutionRole: structuredClone(role), TaskPolicy: policy("TaskRole"), ExecutionPolicy: policy("ExecutionRole"),
    Task: {Type: "AWS::ECS::TaskDefinition", Properties: {TaskRoleArn: {"Fn::GetAtt": ["TaskRole", "Arn"]}, ExecutionRoleArn: {"Fn::GetAtt": ["ExecutionRole", "Arn"]}, ContainerDefinitions: [{Name: "worker", Image: "pinned", ReadonlyRootFilesystem: true}]}},
    Network: {Type: "AWS::EC2::SecurityGroup", Properties: {GroupDescription: "isolated"}},
    Service: {Type: "AWS::ECS::Service", DependsOn: ["TaskRole", "TaskPolicy", "Network"], Properties: {DesiredCount: 0}}
  }};
}
test("role extraction preserves grants, task definition and networking without input mutation", () => {
  const original = fixture(), before = structuredClone(original);
  const result = retainWorkerRoles(original, bindings);
  assert.deepEqual(original, before);
  assert.equal(result.roles.length, 2);
  assert.deepEqual(result.roles[0]!.definition.Properties.Policies[0].PolicyDocument, original.Resources.TaskPolicy.Properties.PolicyDocument);
  assert.deepEqual(result.roles[1]!.definition.Properties.AssumeRolePolicyDocument, original.Resources.ExecutionRole.Properties.AssumeRolePolicyDocument);
  assert.deepEqual(result.template.Resources.Service.DependsOn, ["Network"]);
  assert.deepEqual(result.template.Resources.Network, original.Resources.Network);
  assert.deepEqual(result.template.Resources.Task.Properties.ContainerDefinitions, original.Resources.Task.Properties.ContainerDefinitions);
  assert.deepEqual(result.template.Resources.Task.Properties.TaskRoleArn, {"Fn::ImportValue": "Controller:Task"});
  assert.ok(Object.values(result.template.Resources).every((r: any) => !r.Type.startsWith("AWS::IAM::")));
});
test("shared policies and unexpected role references require separate review", () => {
  const shared = fixture(); shared.Resources.TaskPolicy.Properties.Roles.push({Ref: "ExecutionRole"});
  assert.throws(() => retainWorkerRoles(shared, bindings), /Shared role policy/);
  const remaining = fixture(); remaining.Outputs = {Unexpected: {Value: {"Fn::GetAtt": ["TaskRole", "Arn"]}}};
  assert.throws(() => retainWorkerRoles(remaining, bindings), /Unexpected remaining reference/);
});
