import {aws_cognito as cognito, aws_ecr as ecr, aws_kms as kms, aws_s3 as s3, aws_secretsmanager as secretsmanager} from "aws-cdk-lib";

/** Imports needed by Framework workers; importing does not redeploy the foundation. */
export interface FrameworkRuntimeFoundation {
  readonly database: {readonly clusterArn: string};
  readonly dataKey: kms.IKey;
  readonly geodataBucket: s3.IBucket;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly runtimeDatabaseSecret: secretsmanager.ISecret;
  readonly apiRepository: ecr.IRepository;
}
