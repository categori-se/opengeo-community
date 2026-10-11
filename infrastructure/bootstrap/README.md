# Bootstrap an OpenGeo Studio AWS account

Community deployments use the standard AWS CDK bootstrap stack in the operator's
own account. Follow [the deployment guide](../../docs/community-aws.md).
The [architecture guide](../../docs/community-architecture.md#runtime-boundaries)
explains the components that the installation connects.
Run the command below from the repository root after preparing the configuration
and explicit execution policy in the deployment guide.

```bash
python3 scripts/community-aws.py bootstrap --config .opengeo/aws-config.json \
  --execution-policy-arn arn:aws:iam::123456789012:policy/OpenGeoDeployment --apply
```

The policy ARN is an operator-supplied CloudFormation execution policy. Review
its permissions against the synthesized resources and your organization's IAM
requirements. The command verifies the configured account and region first.

Other files in this directory are retained implementation examples for particular
build components. The community installer does not use original hosting-account
profiles, policy receipts or private deployment contracts.
