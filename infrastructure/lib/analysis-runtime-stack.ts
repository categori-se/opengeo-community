import {createHash} from "node:crypto";
import {CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Tags, type StackProps,
  aws_autoscaling as autoscaling, aws_ec2 as ec2, aws_iam as iam,
  aws_logs as logs, aws_sqs as sqs} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";

export interface AnalysisProfiles {
  schemaVersion: 1;
  architecture: "arm64" | "amd64";
  profiles: Record<"python" | "javascript" | "bash", {image: string; interpreter: string}>;
}
function ordered(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered((value as Record<string, unknown>)[k])])) : value;
}
export function analysisProfilesSha256(value: AnalysisProfiles): string {
  const interpreters: Record<string, string[]> = {python: ["/usr/bin/python3", "/usr/local/bin/python3"],
    javascript: ["/usr/bin/node", "/usr/local/bin/node"], bash: ["/bin/bash", "/usr/bin/bash"]};
  if (value?.schemaVersion !== 1 || !["arm64", "amd64"].includes(value.architecture)
    || Object.keys(value).sort().join() !== "architecture,profiles,schemaVersion"
    || Object.keys(value.profiles ?? {}).sort().join() !== "bash,javascript,python") throw Error("Closed admitted analysis profiles required");
  for (const [language, profile] of Object.entries(value.profiles)) {
    if (Object.keys(profile).sort().join() !== "image,interpreter" || !/^sha256:[0-9a-f]{64}$/.test(profile.image)
      || !interpreters[language]!.includes(profile.interpreter)) throw Error("Exact cached analysis image and interpreter required");
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

export interface AnalysisResourcesStackProps extends StackProps {
  config: EnvironmentConfig;
  foundation: PlatformFoundationStack;
  /** Existing operator-created analysis-only database credential, never a user value. */
  runtimeSecretArn: string;
}

/** Optional persistent identities only. Never place these in the deletable host stack. */
export class AnalysisResourcesStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly hostRole: iam.Role;
  readonly instanceProfile: iam.CfnInstanceProfile;
  readonly logGroup: logs.LogGroup;
  constructor(scope: Construct, id: string, props: AnalysisResourcesStackProps) {
    super(scope, id, props);
    const {config, foundation, runtimeSecretArn} = props;
    if (!runtimeSecretArn.startsWith(`arn:aws:secretsmanager:${this.region}:${this.account}:secret:`)
      || /[*?$\s]/.test(runtimeSecretArn)) throw Error("Exact same-account analysis runtime secret required");
    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {queueName: `opengeo-${config.stage}-analysis-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14)});
    this.queue = new sqs.Queue(this, "Queue", {queueName: `opengeo-${config.stage}-analysis`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.minutes(2), receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3}});
    this.logGroup = new logs.LogGroup(this, "Logs", {logGroupName: `/opengeo/${config.stage}/analysis-coordinator`,
      encryptionKey: foundation.dataKey, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN});
    this.hostRole = new iam.Role(this, "HostRole", {roleName: `opengeo-${config.stage}-analysis-host`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"), description: "Trusted analysis daemon only; no compiler, GIS or OCR authority"});
    const permit = (actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      this.hostRole.addToPolicy(new iam.PolicyStatement({actions, resources, conditions}));
    permit(["rds-data:ExecuteStatement"], [foundation.database.clusterArn]);
    permit(["secretsmanager:GetSecretValue"], [runtimeSecretArn]);
    permit(["s3:GetObjectVersion"], [foundation.applicationBucket.arnForObjects("organizations/*/projects/*/analysis/*/snapshot.json")]);
    permit(["s3:PutObject"], [foundation.applicationBucket.arnForObjects("organizations/*/projects/*/analysis/*/result.json")]);
    permit(["kms:Decrypt"], [foundation.dataKey.keyArn], {StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
      "kms:EncryptionContext:SecretARN": runtimeSecretArn}});
    permit(["kms:Decrypt", "kms:GenerateDataKey"], [foundation.dataKey.keyArn], {StringEquals: {
      "kms:ViaService": `s3.${this.region}.amazonaws.com`, "kms:EncryptionContext:aws:s3:arn": foundation.applicationBucket.bucketArn}});
    permit(["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"], [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`]);
    this.queue.grantConsumeMessages(this.hostRole);
    this.instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      instanceProfileName: `opengeo-${config.stage}-analysis-host`, roles: [this.hostRole.roleName]});
    new CfnOutput(this, "AnalysisQueueUrl", {value: this.queue.queueUrl});
    new CfnOutput(this, "AnalysisQueueArn", {value: this.queue.queueArn});
    new CfnOutput(this, "AnalysisHostRoleArn", {value: this.hostRole.roleArn});
    new CfnOutput(this, "AnalysisInstanceProfileArn", {value: this.instanceProfile.attrArn});
  }
}

export interface AnalysisRuntimeStackProps extends StackProps {
  config: EnvironmentConfig;
  foundation: PlatformFoundationStack;
  resources: AnalysisResourcesStack;
  runtimeSecretArn: string;
  endpointSecurityGroupId: string;
  runnerAmiId: string;
  runnerAmiEvidenceSha256: string;
  runnerAmiManifestSha256: string;
  profiles: AnalysisProfiles;
  profilesSha256: string;
  /** Only the reviewed activation template enables one host; default is zero. */
  activateForWindow?: boolean;
}

/** Host-only leaf, omitted by the ordinary assembly. No queue, credential, NAT or endpoint ownership. */
export class AnalysisRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props: AnalysisRuntimeStackProps) {
    super(scope, id, props);
    const {config, foundation, resources} = props;
    Tags.of(this).add("Application", "OpenGeo");Tags.of(this).add("Environment", config.stage);
    if (!/^ami-[0-9a-f]{17}$/.test(props.runnerAmiId) || !/^[0-9a-f]{64}$/.test(props.runnerAmiEvidenceSha256)
      || !/^[0-9a-f]{64}$/.test(props.runnerAmiManifestSha256)
      || !/^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(props.endpointSecurityGroupId) || analysisProfilesSha256(props.profiles) !== props.profilesSha256)
      throw Error("Exact admitted analysis AMI, profile and existing endpoint boundary required");
    const subnets = config.production ? foundation.vpc.isolatedSubnets : [foundation.vpc.isolatedSubnets[0]!];
    if (!subnets.length || subnets.some(s => !s)) throw Error("Analysis requires existing isolated subnets");
    const window = new CfnParameter(this, "ActivationWindowId", {type: "String",
      allowedPattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"});
    const group = new ec2.SecurityGroup(this, "HostSecurityGroup", {vpc: foundation.vpc, allowAllOutbound: false,
      description: "Trusted analysis host to existing private APIs only"});
    group.addEgressRule(ec2.Peer.securityGroupId(props.endpointSecurityGroupId), ec2.Port.tcp(443));
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Only existing S3 gateway is routable from isolated subnets");
    new ec2.CfnSecurityGroupIngress(this, "ExistingEndpointIngress", {groupId: props.endpointSecurityGroupId,
      sourceSecurityGroupId: group.securityGroupId, ipProtocol: "tcp", fromPort: 443, toPort: 443});
    const variables: Record<string, string> = {OPEN_GEO_ANALYSIS_ENABLED: "true", OPEN_GEO_ANALYSIS_STAGE: config.stage,
      OPEN_GEO_AWS_REGION: this.region, OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
      OPEN_GEO_DATA_API_SECRET_ARN: props.runtimeSecretArn, OPEN_GEO_DB_NAME: "opengeo",
      OPEN_GEO_APPLICATION_BUCKET: foundation.applicationBucket.bucketName, OPEN_GEO_APPLICATION_KMS_KEY_ARN: foundation.dataKey.keyArn,
      OPEN_GEO_ANALYSIS_QUEUE_URL: resources.queue.queueUrl, OPEN_GEO_ANALYSIS_QUEUE_ARN: resources.queue.queueArn,
      OPEN_GEO_ANALYSIS_PROFILES_JSON: JSON.stringify(ordered(props.profiles)), OPEN_GEO_ANALYSIS_PROFILES_SHA256: props.profilesSha256,
      OPEN_GEO_ANALYSIS_RUNNER_AMI_EVIDENCE_SHA256: props.runnerAmiEvidenceSha256,
      OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256: props.runnerAmiManifestSha256,
      OPEN_GEO_ANALYSIS_WINDOW_ID: window.valueAsString, OPEN_GEO_ANALYSIS_STACK_ID: this.stackId,
      OPEN_GEO_ANALYSIS_WORKSPACE_ROOT: "/var/lib/opengeo-analysis"};
    const lines = Object.entries(variables).map(([key, value]) => `${key}='${value}'`);
    const userdata = ["#!/usr/bin/env bash", "set -euo pipefail", "umask 0027", "id opengeo-analysis >/dev/null",
      "test -r /opt/opengeo/analysis-coordinator/src/runtime.mjs", "test -f /etc/systemd/system/opengeo-analysis-coordinator.service",
      "install -d -m 0750 -o root -g opengeo-analysis /etc/opengeo",
      "cat > /etc/opengeo/analysis.env <<'ANALYSIS_ENV'", ...lines, "ANALYSIS_ENV",
      "chown root:opengeo-analysis /etc/opengeo/analysis.env", "chmod 0640 /etc/opengeo/analysis.env",
      "systemctl enable --now opengeo-analysis-coordinator.service"].join("\n");
    const launch = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {launchTemplateData: {
      imageId: props.runnerAmiId, instanceType: props.profiles.architecture === "arm64" ? "t4g.small" : "t3.small",
      iamInstanceProfile: {arn: resources.instanceProfile.attrArn}, securityGroupIds: [group.securityGroupId],
      metadataOptions: {httpTokens: "required", httpPutResponseHopLimit: 1, instanceMetadataTags: "disabled"},
      userData: Fn.base64(userdata), blockDeviceMappings: [{deviceName: "/dev/xvda", ebs: {encrypted: true,
        kmsKeyId: foundation.dataKey.keyArn, volumeSize: 40, volumeType: "gp3", deleteOnTermination: true}}]}});
    new autoscaling.CfnAutoScalingGroup(this, "AutoScalingGroup", {autoScalingGroupName: `opengeo-${config.stage}-analysis`,
      minSize: "0", maxSize: "1", desiredCapacity: props.activateForWindow === true ? "1" : "0",
      vpcZoneIdentifier: subnets.map(s => s.subnetId), launchTemplate: {launchTemplateId: launch.ref, version: launch.attrLatestVersionNumber},
      tags: [{key: "opengeo:analysis-stack", value: this.stackId, propagateAtLaunch: true},
        {key: "Application", value: "OpenGeo", propagateAtLaunch: true}, {key: "Environment", value: config.stage, propagateAtLaunch: true}]});
    new CfnOutput(this, "AnalysisRunnerAmiEvidenceSha256", {value: props.runnerAmiEvidenceSha256});
    new CfnOutput(this, "AnalysisProfilesSha256", {value: props.profilesSha256});
  }
}
