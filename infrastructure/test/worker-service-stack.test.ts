import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {environmentConfig, parseWorkerMaxTasks, type Stage} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {PrivateRuntimeEndpointsStack} from "../lib/private-runtime-endpoints-stack.js";
import {WorkerServiceStack} from "../lib/worker-service-stack.js";
import {PmtilesQueueStack} from "../lib/pmtiles-queue-stack.js";

function workerTemplateFor(stage: Stage, maximum?: unknown, pmtilesOnly = false): Template {
  const app = new App();
  const env = {account: "111111111111", region: "us-east-1"};
  const config = environmentConfig(
    stage,
    stage === "dev"
      ? "http://localhost:3000"
      : `https://${stage}.opengeo.example.com`
  );
  const foundation = new PlatformFoundationStack(app, `Foundation-${stage}`, {
    config,
    budgetAlertEmail: "opengeo-ci@example.invalid",
    existingUserPoolClientId: "5l2abc123def456ghi789jklmn",
    env
  });
  const runtimeEndpoints = new PrivateRuntimeEndpointsStack(
    app,
    `PrivateRuntimeEndpoints-${stage}`,
    {
      config,
      foundation,
      enableWorker: true,
      enableObservableCoordinator: false,
      env
    }
  );
  const worker = new WorkerServiceStack(app, `Worker-${stage}`, {
    config: {...config, workerMaxTasks: parseWorkerMaxTasks(maximum, config.workerMaxTasks)},
    foundation,
    runtimeEndpoints,
    imageDigest: `sha256:${"c".repeat(64)}`,
    ...(pmtilesOnly ? (() => {
      const queues = new PmtilesQueueStack(app, `PmtilesQueue-${stage}`, {config, env});
      return {workload: "pmtiles-v2" as const,
        processingQueue: queues.queue, processingDeadLetterQueue: queues.deadLetterQueue};
    })() : {}),
    env
  });
  return Template.fromStack(worker);
}

describe("GIS worker service stack", () => {
  it("rejects different API and task image pins before synthesizing PMTiles runtime", () => {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", new URL("../bin/opengeo.ts", import.meta.url).pathname], {
        cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 30000,
        env: {...process.env, OPEN_GEO_STAGE: "dev",
          OPEN_GEO_BUDGET_ALERT_EMAIL: "opengeo-ci@example.invalid",
          OPEN_GEO_WEB_ORIGIN: "http://localhost:3000", OPEN_GEO_PMTILES_ONLY: "true",
          OPEN_GEO_WORKER_IMAGE: `sha256:${"c".repeat(64)}`,
          OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`}
      });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PMTiles API and worker must use the same immutable image digest/);
  });
  it("isolates the v2 converter queue, immutable image and single task capacity", () => {
    const template = workerTemplateFor("production", undefined, true);
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 0, MaxCapacity: 1
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "opengeo-production-pmtiles-v2-worker", DesiredCount: 0,
      DeploymentConfiguration: Match.objectLike({MaximumPercent: 100, MinimumHealthyPercent: 0})
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "opengeo-production-pmtiles-v2",
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        Command: ["python3", "-m", "opengeo_worker.pmtiles_main"],
        Environment: Match.arrayWith([{
          Name: "OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST", Value: `sha256:${"c".repeat(64)}`
        }])
      })])
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.match(serialized, /PmtilesQueue-production/);
    assert.doesNotMatch(serialized, /s3:DeleteObjectVersion/);
    assert.match(serialized, /derivatives\/tiles\/custom\/\*/);
    assert.match(serialized, /derivatives\/working\/\*/);
  });
  it("caps a bounded production processing window at one task without changing stage defaults", () => {
    const template = workerTemplateFor("production", "1");
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 0,
      MaxCapacity: 1
    });
    template.hasResourceProperties("AWS::ECS::Service", {DesiredCount: 0});
    const defaultMaximum = environmentConfig("production", "https://studio.opengeo.tools").workerMaxTasks;
    assert.equal(parseWorkerMaxTasks(undefined, defaultMaximum), 20);
    assert.equal(parseWorkerMaxTasks(1, 2), 1);
    for (const value of [0, -1, 1.5, "", "01", "1e1", "21", true, {}]) {
      assert.throws(() => parseWorkerMaxTasks(value, defaultMaximum), /workerMaxTasks/);
    }
    assert.throws(() => parseWorkerMaxTasks(3, 2), /workerMaxTasks/);
  });
  it("runs an ARM64 non-root parser task with a read-only root and dedicated workspace", () => {
    const template = workerTemplateFor("dev");

    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "2048",
      Memory: "4096",
      EphemeralStorage: {SizeInGiB: 50},
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX"
      },
      Volumes: [{Name: "Workspace"}],
      ContainerDefinitions: [
        Match.objectLike({
          Name: "opengeo-gis-worker",
          Command: [
            "python3", "-c",
            "import runpy; runpy.run_path('/srv/opengeo/scripts/verify-toolchain.py', run_name='__main__'); "
              + "print('opengeo-worker-native-toolchain-ok', flush=True); "
              + "runpy.run_module('opengeo_worker', run_name='__main__')"
          ],
          User: "10001:10001",
          ReadonlyRootFilesystem: true,
          LinuxParameters: Match.objectLike({
            Capabilities: {Drop: ["ALL"]},
            InitProcessEnabled: true
          }),
          MountPoints: [
            {
              ContainerPath: "/tmp/opengeo-worker",
              ReadOnly: false,
              SourceVolume: "Workspace"
            }
          ],
          Environment: Match.arrayWith([
            Match.objectLike({Name: "OPEN_GEO_AWS_REGION", Value: "us-east-1"}),
            Match.objectLike({Name: "OPEN_GEO_GEODATA_BUCKET"}),
            Match.objectLike({Name: "OPEN_GEO_PROCESSING_QUEUE_URL"}),
            Match.objectLike({
              Name: "OPEN_GEO_WORKSPACE_ROOT",
              Value: "/tmp/opengeo-worker"
            })
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({Name: "OPEN_GEO_DB_USER"}),
            Match.objectLike({Name: "OPEN_GEO_DB_PASSWORD"})
          ])
        })
      ]
    });
  });

  it("uses only the worker database secret", () => {
    const serialized = JSON.stringify(workerTemplateFor("dev").toJSON());

    assert.match(serialized, /ExportsOutputRefWorkerDatabaseSecret/);
    assert.doesNotMatch(serialized, /ExportsOutputRefRuntimeDatabaseSecret/);
    assert.doesNotMatch(serialized, /ExportsOutputRefDatabaseSecret/);
  });

  it("allows only exact queue, version reads, derivative writes, exact coverage-version deletes, and scoped KMS calls", () => {
    const template = workerTemplateFor("dev");
    const serialized = JSON.stringify(template.toJSON());

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:ChangeMessageVisibility",
              "sqs:GetQueueAttributes"
            ],
            Effect: "Allow"
          }),
          Match.objectLike({
            Action: "s3:GetObjectVersion",
            Effect: "Allow",
            Resource: Match.arrayWith([
              Match.objectLike({"Fn::Join": Match.anyValue()}),
              Match.objectLike({"Fn::Join": Match.anyValue()})
            ])
          }),
          Match.objectLike({
            Action: "s3:PutObject",
            Effect: "Allow"
          }),
          Match.objectLike({
            Action: "s3:DeleteObjectVersion",
            Effect: "Allow"
          }),
          Match.objectLike({
            Action: ["kms:Decrypt", "kms:GenerateDataKey"],
            Effect: "Allow",
            Condition: {
              StringEquals: Match.objectLike({
                "kms:ViaService": "s3.us-east-1.amazonaws.com",
                "kms:EncryptionContext:aws:s3:arn": Match.anyValue()
              })
            }
          })
        ])
      }
    });
    assert.match(
      serialized,
      /uploads\/\*\/original\/\*/
    );
    assert.match(serialized, /derivatives\/coverages\/\*\.tif/);
    assert.match(serialized, /derivatives\/renders\/\*/);
    assert.doesNotMatch(serialized, /"s3:DeleteObject"/);
    assert.match(
      serialized,
      /versions\/\*\/derivatives\/\*/
    );
    assert.match(serialized, /derivatives\/coverages\/\*\.tif/);
    assert.doesNotMatch(serialized, /"s3:DeleteObject"/);
    assert.doesNotMatch(serialized, /s3:ListBucket/);
    assert.doesNotMatch(serialized, /source-projects/);
    assert.doesNotMatch(serialized, /sqs:SendMessage/);
    assert.doesNotMatch(
      serialized,
      /kms:EncryptionContext:aws:s3:arn[^}]+organizations\/\*/
    );
  });

  it("has no public IP or default egress and reaches AWS only through private endpoints", () => {
    const template = workerTemplateFor("dev");

    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 0,
      EnableExecuteCommand: false,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({AssignPublicIp: "DISABLED"})
      }
    });
    template.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "OpenGeo GIS workers; no public or general internet egress",
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          CidrIp: "0.0.0.0/0",
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          Description: "HTTPS follows isolated-subnet routes; only the S3 gateway endpoint is routable"
        }),
        Match.objectLike({
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          Description: "GIS workers to PostgreSQL"
        })
      ])
    });
    template.hasResourceProperties("AWS::EC2::SecurityGroupEgress", {
      Description: "GIS workers to shared private AWS APIs",
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443
    });
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      Description: "GIS workers to shared private AWS APIs",
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443
    });
    const serialized = JSON.stringify(template.toJSON());
    assert.doesNotMatch(serialized, /CidrIp":"0\.0\.0\.0\/0","Description":"Allow all outbound traffic/);
    assert.doesNotMatch(serialized, /AWS::EC2::NatGateway/);
  });

  it("scales from zero on queue backlog and alarms on old or dead-lettered work", () => {
    const template = workerTemplateFor("dev");

    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 0,
      MaxCapacity: 2
    });
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({TargetValue: 0.5})
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("limits demo processing to two tasks without weakening parser isolation", () => {
    const template = workerTemplateFor("demo");
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 0, MaxCapacity: 2
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 0,
      EnableExecuteCommand: false,
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({AssignPublicIp: "DISABLED"})
      })
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "2048", Memory: "4096",
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        User: "10001:10001", ReadonlyRootFilesystem: true
      })])
    });
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
  });

  it("uses both isolated availability zones in production", () => {
    const template = workerTemplateFor("production");
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 0,
      MaxCapacity: 20
    });
    const serviceResources = Object.values(
      template.toJSON().Resources as Record<
        string, {Type: string; Properties: {NetworkConfiguration?: {
          AwsvpcConfiguration?: {Subnets?: unknown[]};
        }}}
      >
    ).filter((resource) => resource.Type === "AWS::ECS::Service");

    assert.equal(serviceResources.length, 1);
    assert.equal(
      serviceResources[0]!.Properties.NetworkConfiguration
        ?.AwsvpcConfiguration?.Subnets?.length,
      2
    );
  });
});
