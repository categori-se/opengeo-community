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
  assert.match(scope.databaseSecurityGroupId, /^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/);
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

export interface AnalysisLifecycleScope {
  vpcId: string;
  subnetIds: string[];
  endpointSecurityGroupId: string;
  hostRoleArn: string;
  instanceProfileArn: string;
}

/** Analysis host lifecycle only. Existing private endpoint services are read-only. */
export function analysisLifecyclePolicy(account: string, region: string, stage: string,
  scope: AnalysisLifecycleScope): iam.PolicyDocument {
  assert.match(account, /^[0-9]{12}$/);assert.match(region, /^[a-z]{2}-[a-z]+-[0-9]+$/);
  assert.match(stage, /^(dev|staging|demo|production)$/);assert.match(scope.vpcId, /^vpc-[0-9a-f]+$/);
  assert.match(scope.endpointSecurityGroupId, /^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/);assert.ok(scope.subnetIds.length);
  scope.subnetIds.forEach(value => assert.match(value, /^subnet-[0-9a-f]+$/));
  assert.equal(scope.hostRoleArn, `arn:aws:iam::${account}:role/opengeo-${stage}-analysis-host`);
  assert.equal(scope.instanceProfileArn, `arn:aws:iam::${account}:instance-profile/opengeo-${stage}-analysis-host`);
  const arn = (service: string, resource: string) => `arn:aws:${service}:${region}:${account}:${resource}`;
  const document = new iam.PolicyDocument();
  const allow = (actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
    document.addStatements(new iam.PolicyStatement({actions, resources, conditions}));
  const owned = {StringEquals: {"aws:ResourceTag/aws:cloudformation:stack-name": `OpenGeo-${stage}-AnalysisRuntime`}};
  const requested = {StringEquals: {"aws:RequestTag/Application": "OpenGeo", "aws:RequestTag/Environment": stage}};
  const security = arn("ec2", "security-group/*"), launch = arn("ec2", "launch-template/*");
  allow(["ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeVpcs", "ec2:DescribeSubnets",
    "ec2:DescribeLaunchTemplates", "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeImages"], ["*"],
  {StringEquals: {"aws:RequestedRegion": region}});
  allow(["ec2:CreateSecurityGroup"], [security], requested);
  allow(["ec2:CreateSecurityGroup"], [arn("ec2", `vpc/${scope.vpcId}`)]);
  allow(["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
    "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress"], [security], owned);
  allow(["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
    [arn("ec2", `security-group/${scope.endpointSecurityGroupId}`)]);
  allow(["ec2:CreateLaunchTemplate"], [launch], requested);
  allow(["ec2:CreateLaunchTemplateVersion", "ec2:DeleteLaunchTemplateVersions", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate"], [launch], owned);
  allow(["ec2:CreateTags"], [security, launch], {StringEquals: {"ec2:CreateAction": ["CreateSecurityGroup", "CreateLaunchTemplate"], ...requested.StringEquals}});
  allow(["ec2:CreateTags", "ec2:DeleteTags"], [security, launch], owned);
  const group = arn("autoscaling", `autoScalingGroup:*:autoScalingGroupName/opengeo-${stage}-analysis`);
  allow(["autoscaling:CreateAutoScalingGroup", "autoscaling:UpdateAutoScalingGroup", "autoscaling:DeleteAutoScalingGroup",
    "autoscaling:CreateOrUpdateTags", "autoscaling:DeleteTags"], [group]);
  allow(["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeScalingActivities", "autoscaling:DescribeLaunchConfigurations"], ["*"],
    {StringEquals: {"aws:RequestedRegion": region}});
  allow(["iam:PassRole"], [scope.hostRoleArn], {StringEquals: {"iam:PassedToService": "ec2.amazonaws.com"}});
  allow(["iam:GetInstanceProfile"], [scope.instanceProfileArn]);
  // The operator must already have admitted the Auto Scaling service-linked
  // role and encrypted-volume key grant. This role cannot create either.
  allow(["iam:PassRole"], [`arn:aws:iam::${account}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`],
    {StringEquals: {"iam:PassedToService": "autoscaling.amazonaws.com"}});
  allow(["ssm:GetParameters"], [arn("ssm", "parameter/cdk-bootstrap/hnb659fds/version")]);
  return document;
}
