import assert from "node:assert/strict";
import {test} from "node:test";
import {workerLifecyclePolicy, type WorkerLifecycleScope} from "../lib/worker-lifecycle-policy.js";

const scope: WorkerLifecycleScope = {vpcId: "vpc-abc123", subnetIds: ["subnet-abc123"],
  routeTableIds: ["rtb-abc123"], databaseSecurityGroupId: "sg-0db12345", taskFamily: "ReviewedWorker"};
const cluster = "arn:aws:ecs:us-east-1:111111111111:cluster/existing";
const policy = () => workerLifecyclePolicy("111111111111", "us-east-1", "dev", cluster, scope).toJSON();

test("v2 lifecycle binds only the isolated PMTiles service", () => {
  const json = workerLifecyclePolicy("111111111111", "us-east-1", "dev", cluster,
    {...scope, taskFamily: "opengeo-dev-pmtiles-v2"}, "pmtiles-v2").toJSON();
  const service = json.Statement.find((s: any) => [s.Action].flat().includes("ecs:UpdateService"));
  assert.equal(service.Resource, "arn:aws:ecs:us-east-1:111111111111:service/existing/opengeo-dev-pmtiles-v2-worker");
  assert.doesNotMatch(JSON.stringify(json), /opengeo-dev-gis-worker/);
});

test("lifecycle permissions exclude data access, IAM mutation and unrelated compute", () => {
  const json = policy();
  const statements = json.Statement;
  const actions: string[] = statements.flatMap((s: any) => s.Action);
  assert.ok(actions.every(a => !a.includes("*")));
  assert.deepEqual([...new Set(actions.filter(a => a.startsWith("iam:")))], ["iam:PassRole"]);
  assert.ok(!actions.some(a => /^(s3|secretsmanager|kms|rds|rds-data|cloudformation|lambda|sqs):/.test(a)));
  assert.ok(!actions.includes("ec2:RunInstances") && !actions.includes("ecs:RunTask"));
  const pass = statements.filter((s: any) => [s.Action].flat().includes("iam:PassRole"));
  assert.equal(pass.flatMap((s: any) => s.Resource).length, 3);
  assert.ok(pass.every((s: any) => !JSON.stringify(s.Resource).includes("*") && s.Condition.StringEquals["iam:PassedToService"]));
  const database = statements.filter((s: any) => JSON.stringify(s.Resource).includes("security-group/sg-0db12345"));
  assert.equal(database.length, 1);
  assert.deepEqual(database[0].Action, ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]);
  const deletion = statements.find((s: any) => [s.Action].flat().includes("ec2:DeleteSecurityGroup"));
  assert.deepEqual(deletion.Condition.StringEquals["aws:ResourceTag/aws:cloudformation:stack-name"],
    ["OpenGeo-dev-Worker", "OpenGeo-dev-PrivateRuntimeEndpoints"]);
  const service = statements.find((s: any) => [s.Action].flat().includes("ecs:UpdateService"));
  assert.equal(service.Resource, "arn:aws:ecs:us-east-1:111111111111:service/existing/opengeo-dev-gis-worker");
  const retire = statements.find((s: any) => [s.Action].flat().includes("ecs:DeregisterTaskDefinition"));
  assert.equal(retire.Action, "ecs:DeregisterTaskDefinition");
  assert.equal(retire.Resource, "*");
  assert.deepEqual(retire.Condition, {StringEquals: {"aws:RequestedRegion": "us-east-1"}});
  assert.ok(JSON.stringify(json).length < 10_240, "Role's inline policy fits IAM limit");
});

test("scope rejects wildcard or cross-account resource identifiers", () => {
  for (const bad of [{vpcId: "vpc-*"}, {subnetIds: []}, {routeTableIds: ["*"]}, {taskFamily: "worker:*"}, {databaseSecurityGroupId: "sg-*"}]) {
    assert.throws(() => workerLifecyclePolicy("111111111111", "us-east-1", "dev", cluster, {...scope, ...bad}));
  }
  assert.throws(() => workerLifecyclePolicy("111111111111", "us-east-1", "dev", cluster.replace("111111111111", "222222222222"), scope));
});
