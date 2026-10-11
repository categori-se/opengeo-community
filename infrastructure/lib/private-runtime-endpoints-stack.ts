import {
  CfnOutput,
  Stack,
  type StackProps,
  aws_ec2 as ec2
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";

export interface PrivateRuntimeEndpointsStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly enableWorker: boolean;
  readonly enableObservableCoordinator: boolean;
}

export class PrivateRuntimeEndpointsStack extends Stack {
  readonly workerEndpointSecurityGroup?: ec2.SecurityGroup;
  readonly observableCoordinatorEndpointSecurityGroup?: ec2.SecurityGroup;
  readonly interfaceEndpointCount: number;

  constructor(scope: Construct, id: string, props: PrivateRuntimeEndpointsStackProps) {
    super(scope, id, props);

    const {
      config,
      foundation,
      enableWorker,
      enableObservableCoordinator
    } = props;
    if (!enableWorker && !enableObservableCoordinator) {
      throw new Error("Private runtime endpoints require at least one enabled runtime");
    }
    const isolatedSubnets = config.production
      ? foundation.vpc.isolatedSubnets
      : [foundation.vpc.isolatedSubnets[0]!];
    if (isolatedSubnets.length < 1 || isolatedSubnets.some((subnet) => subnet === undefined)) {
      throw new Error("Private runtime endpoints require an isolated subnet");
    }
    const subnetSelection: ec2.SubnetSelection = {subnets: isolatedSubnets};
    if (enableWorker) {
      this.workerEndpointSecurityGroup = new ec2.SecurityGroup(
        this,
        "WorkerEndpointSecurityGroup",
        {
          vpc: foundation.vpc,
          allowAllOutbound: false,
          description: "Shared private APIs accepting only OpenGeo GIS worker traffic"
        }
      );
    }
    if (enableObservableCoordinator) {
      this.observableCoordinatorEndpointSecurityGroup = new ec2.SecurityGroup(
        this,
        "ObservableCoordinatorEndpointSecurityGroup",
        {
          vpc: foundation.vpc,
          allowAllOutbound: false,
          description: "Shared private APIs accepting only OpenGeo Observable coordinator traffic"
        }
      );
    }

    const sharedSecurityGroups = [
      this.workerEndpointSecurityGroup,
      this.observableCoordinatorEndpointSecurityGroup
    ].filter((group): group is ec2.SecurityGroup => group !== undefined);
    const services = new Map<string, {
      service: ec2.InterfaceVpcEndpointService;
      securityGroups: ec2.ISecurityGroup[];
    }>([
      ["LogsEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        securityGroups: sharedSecurityGroups
      }],
      ["SqsEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SQS,
        securityGroups: sharedSecurityGroups
      }]
    ]);
    if (enableWorker) {
      const workerSecurityGroups = [this.workerEndpointSecurityGroup!];
      services.set("EcrApiEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        securityGroups: workerSecurityGroups
      });
      services.set("EcrDockerEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        securityGroups: workerSecurityGroups
      });
      services.set("SecretsEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        securityGroups: workerSecurityGroups
      });
    }
    if (enableObservableCoordinator) {
      services.set("RdsDataEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
        securityGroups: [this.observableCoordinatorEndpointSecurityGroup!]
      });
    }
    for (const [endpointId, definition] of [...services.entries()].sort(([left], [right]) =>
      left.localeCompare(right))) {
      new ec2.InterfaceVpcEndpoint(this, endpointId, {
        vpc: foundation.vpc,
        service: definition.service,
        privateDnsEnabled: true,
        subnets: subnetSelection,
        securityGroups: definition.securityGroups,
        open: false
      });
    }
    this.interfaceEndpointCount = services.size;
    new ec2.GatewayVpcEndpoint(this, "S3GatewayEndpoint", {
      vpc: foundation.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [subnetSelection]
    });

    new CfnOutput(this, "InterfaceEndpointCount", {
      value: String(this.interfaceEndpointCount)
    });
  }
}
