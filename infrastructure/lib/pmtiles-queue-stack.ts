import {CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, aws_sqs as sqs} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";

/** Durable identity-only queue, independent of S3 notifications and shared jobs. */
export class PmtilesQueueStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: StackProps & {config: EnvironmentConfig}) {
    super(scope, id, props);
    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${props.config.stage}-pmtiles-v2-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${props.config.stage}-pmtiles-v2`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(15),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3}
    });
    new CfnOutput(this, "PmtilesQueueUrl", {value: this.queue.queueUrl});
    new CfnOutput(this, "PmtilesQueueArn", {value: this.queue.queueArn});
    new CfnOutput(this, "PmtilesDeadLetterQueueUrl", {value: this.deadLetterQueue.queueUrl});
  }
}
