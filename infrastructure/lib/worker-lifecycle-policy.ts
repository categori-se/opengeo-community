import assert from "node:assert/strict";
import {aws_iam as iam} from "aws-cdk-lib";

/** Existing Foundation identifiers, resolved by the operator; never discovered at runtime. */
export interface WorkerLifecycleScope {
  vpcId: string;
  subnetIds: string[];
  routeTableIds: string[];
  databaseSecurityGroupId: string;
  taskFamily: string;
}

/** CloudFormation's execution role, distinct from the controller's invocation role.
 * No IAM writes, data access, Foundation stack access or general compute creation.
 * See processing-plane-runbook.md for remaining permission boundaries.
 */
export function workerLifecyclePolicy(account: string, region: string, stage: string,
  clusterArn: string, scope: WorkerLifecycleScope,
  workload: "shared" | "pmtiles-v2" = "shared"): iam.PolicyDocument {
  assert.match(account, /^[0-9]{12}$/);
  assert.match(region, /^[a-z]{2}-[a-z]+-[0-9]+$/);
  assert.match(stage, /^(dev|staging|demo|production)$/);
  assert.match(scope.vpcId, /^vpc-[0-9a-f]+$/);
  assert.match(scope.databaseSecurityGroupId, /^sg-[0-9a-f]+$/);
  assert.ok(scope.subnetIds.length && scope.routeTableIds.length, "Private subnet and route table scope required");
  scope.subnetIds.forEach(id => assert.match(id, /^subnet-[0-9a-f]+$/));
  scope.routeTableIds.forEach(id => assert.match(id, /^rtb-[0-9a-f]+$/));
  assert.match(scope.taskFamily, /^[A-Za-z0-9_-]+$/);
  assert.ok(workload === "shared" || workload === "pmtiles-v2", "Reviewed workload required");
  const arn = (service: string, resource: string) => `arn:aws:${service}:${region}:${account}:${resource}`;
  const clusterPrefix = arn("ecs", "cluster/");
  assert.ok(clusterArn.startsWith(clusterPrefix) && /^[A-Za-z0-9_-]+$/.test(clusterArn.slice(clusterPrefix.length)), "Exact existing ECS cluster required");
  const cluster = clusterArn.slice(clusterPrefix.length);
  const document = new iam.PolicyDocument();
  const allow = (actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
    document.addStatements(new iam.PolicyStatement({actions, resources, conditions}));
  const stacks = [`OpenGeo-${stage}-Worker`, `OpenGeo-${stage}-PrivateRuntimeEndpoints`];
  const owned = {StringEquals: {"aws:ResourceTag/aws:cloudformation:stack-name": stacks}};
  const requested = {StringEquals: {"aws:RequestTag/Application": "OpenGeo", "aws:RequestTag/Environment": stage}};
  const sg = arn("ec2", "security-group/*"), endpoint = arn("ec2", "vpc-endpoint/*");
  const vpc = arn("ec2", `vpc/${scope.vpcId}`);
  const network = [vpc, ...scope.subnetIds.map(id => arn("ec2", `subnet/${id}`)),
    ...scope.routeTableIds.map(id => arn("ec2", `route-table/${id}`))];

  allow(["ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeVpcEndpoints",
    "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables", "ec2:DescribePrefixLists"], ["*"],
  {StringEquals: {"aws:RequestedRegion": region}});
  allow(["ec2:CreateSecurityGroup"], [sg], requested);
  allow(["ec2:CreateSecurityGroup"], [vpc]);
  allow(["ec2:CreateVpcEndpoint"], [endpoint], {StringEquals: {
    ...requested.StringEquals, "ec2:VpceServiceName": ["ecr.api", "ecr.dkr", "logs", "sqs", "secretsmanager", "s3"].map(s => `com.amazonaws.${region}.${s}`)
  }});
  allow(["ec2:CreateVpcEndpoint", "ec2:ModifyVpcEndpoint"], network);
  allow(["ec2:CreateVpcEndpoint", "ec2:ModifyVpcEndpoint"], [sg], owned);
  allow(["ec2:ModifyVpcEndpoint", "ec2:DeleteVpcEndpoints"], [endpoint], owned);
  allow(["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
    "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress"], [sg], owned);
  // Only ingress changes on the existing database group; deletion/egress are absent.
  allow(["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
    [arn("ec2", `security-group/${scope.databaseSecurityGroupId}`)]);
  allow(["ec2:CreateTags"], [sg, endpoint], {StringEquals: {
    "ec2:CreateAction": ["CreateSecurityGroup", "CreateVpcEndpoint"], ...requested.StringEquals
  }});
  allow(["ec2:CreateTags", "ec2:DeleteTags"], [sg, endpoint], owned);

  const service = arn("ecs", `service/${cluster}/opengeo-${stage}-${workload === "pmtiles-v2" ? "pmtiles-v2" : "gis"}-worker`);
  const task = arn("ecs", `task-definition/${scope.taskFamily}:*`);
  allow(["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices"], [service],
    {ArnEquals: {"ecs:cluster": clusterArn}});
  allow(["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"], [task]);
  // ECS DeregisterTaskDefinition has no resource-level authorization support.
  // Keep this unavoidable region-wide permission separate for explicit review.
  // https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html
  allow(["ecs:DeregisterTaskDefinition"], ["*"],
    {StringEquals: {"aws:RequestedRegion": region}});
  allow(["ecs:TagResource", "ecs:UntagResource", "ecs:ListTagsForResource"], [task, service]);
  allow(["iam:PassRole"], ["worker-task", "worker-task-execution"].map(name =>
    `arn:aws:iam::${account}:role/opengeo-${stage}-${name}`),
  {StringEquals: {"iam:PassedToService": "ecs-tasks.amazonaws.com"}});
  allow(["iam:PassRole"], [`arn:aws:iam::${account}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService`],
    {StringEquals: {"iam:PassedToService": "application-autoscaling.amazonaws.com"}});

  // Target ARNs have generated IDs. AWS exposes namespace/dimension, not ResourceId,
  // as conditions. This wider ECS scaling boundary needs explicit rollout review.
  allow(["application-autoscaling:RegisterScalableTarget", "application-autoscaling:DeregisterScalableTarget",
    "application-autoscaling:PutScalingPolicy", "application-autoscaling:DeleteScalingPolicy"],
  [arn("application-autoscaling", "scalable-target/*")], {StringEquals: {
    "application-autoscaling:service-namespace": "ecs", "application-autoscaling:scalable-dimension": "ecs:service:DesiredCount"
  }});
  allow(["application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies"], ["*"],
    {StringEquals: {"aws:RequestedRegion": region}});
  allow(["application-autoscaling:ListTagsForResource"], [arn("application-autoscaling", "scalable-target/*")]);
  allow(["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms",
    "cloudwatch:TagResource", "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource"],
  [arn("cloudwatch", `alarm:OpenGeo-${stage}-Worker-*`)]);
  allow(["ssm:GetParameters"], [arn("ssm", "parameter/cdk-bootstrap/hnb659fds/version")]);
  return document;
}
