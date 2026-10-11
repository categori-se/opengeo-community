# OpenGeo account bootstrap

## Production static Studio operator

Production static publication uses a separate role with no API, database, Cognito, DNS, IAM-management, object-delete, stack-delete, or resource-creation authority:

- role: `arn:aws:iam::111111111111:role/opengeo/production/OpenGeoProductionOperatorRole`;
- trusted principal: `arn:aws:iam::111111111111:user/aaron-arch` only;
- retained release bucket: `studio.opengeo.tools`;
- distribution: `E2GPOVS3D9R9NX`; and
- stack: `OpenGeo-production-StudioWeb`.

The reviewed artifacts are [`opengeo-production-operator-trust.json`](opengeo-production-operator-trust.json), [`opengeo-production-operator-policy.json`](opengeo-production-operator-policy.json), the optional source-user [`assume-only policy`](opengeo-production-operator-principal-policy.json), and the no-secret AWS config [`profile`](opengeo-production-operator-profile.ini). Creating the role and attaching these policies is a separately authorized administrator action. The profile stanza belongs in the shared AWS config, while the existing `categorise` credentials remain its source; do not copy credentials into this repository. The role and its single inline release policy were created on 2026-08-28. The optional source-user policy was not attached because the existing source principal could already assume the directly trusted same-account role; it remains a least-privilege template for a future source principal.

The CDK default for a future independently created Studio stack remains `opengeo-studio-111111111111-us-east-1`. The static release configuration defaults to the retained `studio.opengeo.tools` bucket because the retained production stack owns that exact origin. The future-template bucket remains accepted only when an operator selects it explicitly. Production releases never synthesize or deploy the future template. The release script reads the processed deployed template, proves that the stack owns the exact distribution and current origin path, and calls CloudFormation with `--use-previous-template`. Every previous parameter uses `UsePreviousValue=true`; only `StudioReleaseOriginPath` receives the new sealed release prefix. The deployed stack retains its exact CloudFormation execution role. The operator cannot call `cloudfront:UpdateDistribution` directly.

Use this exact tuple for local validation and the later authorized publication:

```bash
OPEN_GEO_STUDIO_ORIGIN=https://studio.opengeo.tools \
OPEN_GEO_STUDIO_BUCKET=studio.opengeo.tools \
OPEN_GEO_STUDIO_STACK_NAME=OpenGeo-production-StudioWeb \
OPEN_GEO_STUDIO_EXPECTED_ACCOUNT=111111111111 \
OPEN_GEO_AWS_PROFILE=opengeo-production-operator \
OPEN_GEO_STUDIO_DISTRIBUTION_ID=E2GPOVS3D9R9NX \
npm --prefix app run deploy:studio -- --local-check
```

Omitting `OPEN_GEO_STUDIO_DEPLOY_CONFIRM` makes the online command a read-only preflight. Publication requires the exact value `deploy-studio.opengeo.tools`. Its sealed deployment record contains the prior origin path. Rollback supplies that exact immutable path through `OPEN_GEO_STUDIO_ROLLBACK_ORIGIN`, requires `OPEN_GEO_STUDIO_ROLLBACK_CONFIRM=rollback-studio.opengeo.tools`, downloads and checks every retained object against its manifest, changes the same one CloudFormation parameter with the previous template, and deletes nothing. Current releases contain six application pages and five aliases. Retained Studio and managed-demo releases created before route consolidation contain an exact 14-page, 13-alias inventory. Rollback verification recognizes only that fixed historical inventory through `opengeo.application-route-inventory.legacy-record-pages.1.0.0`; current release validation never accepts the legacy inventory.

The operator can read the exact production budget plus Cost Explorer totals, the Studio stack events, retained-bucket security metadata, and the exact distribution needed for preflight and failure diagnosis. It cannot delete objects, stacks, distributions, or buckets.

The managed demo uses a separate bucket, distribution, and CloudFormation pointer. A later static-only demo publication may temporarily attach [`opengeo-production-managed-demo-static-release-policy.json`](opengeo-production-managed-demo-static-release-policy.json) after explicit authorization. That policy can publish immutable objects and move only `OpenGeo-production-DemoWeb`'s existing origin-path parameter. It cannot change the API, database, Cognito, DNS, buckets, source archives, IAM trust, or persistent compute. Remove it immediately after validation and rollback-target verification; it is a reviewed template, not standing access. The authorized August 30 navigation release used this policy to publish `opengeo-demo-20260830164913-3b730c5a9d9b`. Live and prior-release checksum checks passed, then the policy was removed. The operator role again retains only `OpenGeoProductionStaticStudioRelease`; the release receipt is [`../../docs/opengeo-managed-demo-navigation-20260830-deployment-evidence.json`](../../docs/opengeo-managed-demo-navigation-20260830-deployment-evidence.json).

### Coordinated API and MassGIS release of August 30, 2026

One operator-authorized release temporarily attached the reviewed [`opengeo-production-coordinated-release-policy.json`](opengeo-production-coordinated-release-policy.json). It added access only to the existing production API ECR repository and stack, the existing CloudFormation execution role, the exact Aurora cluster and three database secrets, KMS decryption through Secrets Manager for those secrets, and read-only lookup in the exact Cognito pool. The role trust did not change.

After image promotion, migration 0060, the API image update, the MassEnviroScreen bootstrap, Studio publication, and validation, the temporary inline policy was removed. The live role again contains only `OpenGeoProductionStaticStudioRelease`; its canonical policy hash matches the checked-in static policy, API-stack reads are denied, and the retained cost read still passes. The policy file is an audit artifact and a narrowly scoped template. It is not a standing instruction to attach the policy again.

### Managed MassGIS catalog repair

The checked [`opengeo-production-managed-massgis-catalog-repair-policy.json`](opengeo-production-managed-massgis-catalog-repair-policy.json) is a data-only template for correcting the one-layer/three-layer bootstrap records in the existing primary and demo databases. It grants Data API access only to those two Aurora clusters, read/decrypt access only to their admin and runtime secrets through Secrets Manager, read-only owner resolution in the existing Cognito pool, and read-only cluster status. It grants no API image, CloudFormation, static-site, S3, archive, DNS, Cognito-write, or IAM authority.

Using this template still requires explicit authorization to attach it to the production operator role. The guarded bootstrap upgrades only an exact untouched version-one legacy or empty MassGIS definition and verifies 31 maps with 33 layers each through the runtime role. Remove the policy immediately after the two database transactions, verification, cost observation, and any required rollback.

### Proposed demo pilot backend window

The [September 7 demo pilot policy](opengeo-production-managed-demo-pilot-release-policy.json) is checked local preparation, not standing access or approval to attach it. It excludes primary database/API authority, uses the existing CloudFormation execution role without role chaining, and limits stack deletion to the two activation-only demo processing stacks. A temporary deny also blocks the operator's retained primary static authority during this window. AWS Access Analyzer reports no findings, and local policy and template-boundary tests pass.

The [release safeguards](../../docs/demo-pilot-release-guards.md) now cover API/Foundation changes, the full runtime templates, migration sequencing, exact rollback targets, and normal versus failed-window teardown. The [proposed authorization](../../docs/demo-pilot-release-authorization.md) binds these checks to a bounded build and demo processing window, a synthetic acceptance project, and explicit cleanup. No live action is authorized yet. Do not apply this proposal by reusing an August 30 one-release grant.

## Development account bootstrap

This directory contains the reviewed bootstrap scope for account `222222222222`. Root performed the initial handoff: one no-console principal, the fixed operator and service roles, one instance profile, and later the two exact inline-policy updates that allowed the scoped CDK stack. The bootstrap principal can only assume `OpenGeoDevOperatorRole`; ordinary build, deployment, validation, cost monitoring, and rollback operations use that role.

Current receipt: the initial operator and service roles, controller instance profile, exact no-console bootstrap user, one access key, account-wide cost budget, versioned private artifact bucket, and immutable scan-on-push compiler ECR repository exist. The local `opengeo-dev-bootstrap` credential file is mode `0600`, and assuming `OpenGeoDevOperatorRole` is verified. Root is absent from the operator role trust and its exact IAM bootstrap use has ended. Ubuntu 24.04 Minimal ARM64 was selected and exercised through the private build path. The Observable runner AMI bake was rejected by its zero-High/Critical gate, so no runner AMI was created. The same disposable path later built the API and Observable builder natively for ARM64. Its first release attempt was rejected before publication for two High OpenSSL package findings; the repaired attempt published zero-High/Critical immutable digests and complete SBOMs. Each private stack, NAT gateway, controller, and volume was deleted after evidence capture. The current container-build and deployment result is recorded in [`../../docs/opengeo-dev-basemap-provider-deployment-evidence.json`](../../docs/opengeo-dev-basemap-provider-deployment-evidence.json). A separate bootstrapless `OpenGeo-dev-DemoWeb` stack now serves the sealed anonymous demo through a no-alias CloudFront hostname and a private, versioned S3 origin. Its application deployment, browser acceptance, cost, and first-release rollback state are recorded in [`../../docs/opengeo-dev-demo-deployment-evidence.json`](../../docs/opengeo-dev-demo-deployment-evidence.json). The operator policy also has one data-publication exception: read/write of immutable objects under `dev.storage.opengeo.tools/reference-archives/massgis/` and KMS data-key use only through S3 in `us-east-1` with the exact development storage-bucket encryption context. It has no archive delete permission and no access to other data prefixes. The first archive and deployed-demo result are recorded in [`../../docs/opengeo-dev-massgis-reference-archive-evidence.json`](../../docs/opengeo-dev-massgis-reference-archive-evidence.json). The live, retained, and absent bootstrap state is recorded without credentials in [`opengeo-dev-bootstrap-receipt.json`](opengeo-dev-bootstrap-receipt.json). The three build attempts and retained scanner evidence are recorded in [`../../docs/observable-runner-ami-aws-evidence.json`](../../docs/observable-runner-ami-aws-evidence.json).

The container controller defaults to its established `api,builder` target. Set `OPEN_GEO_BUILD_TARGETS=api` for an explicitly authorized API-only release, or `api,worker` for the separately authorized API/GIS-worker pair. Both omit every Observable-builder build, scan, push, digest lookup, and ECR scan and record `builder: null`. The worker mode requires the existing `opengeo/dev/gis-worker` repository, executes network-isolated toolchain checks, and records its own SBOM, scan, and immutable image receipts. All other target sets fail before dependencies or source inputs are read. `--validate-inputs` exercises only these input checks without touching controller paths.

The [worker-repository supplement](opengeo-dev-controller-gis-worker-release-policy.json) adds only the missing development worker ECR actions to `OpenGeoDevAmiBuildControllerRole`. It does not replace the controller policy or broaden the development operator. Its temporary attachment and removal require a separately authorized development-account administrator. Both the development and demo worker repositories were verified read-only as existing, immutable, and scan-on-push on September 7.

The AMI build stack is deliberately disposable. Its ARM64 controller and Packer builder have no public IP addresses; only a short-lived NAT gateway has public egress. Deleting `OpenGeo-dev-AmiBuildPath` removes the VPC, controller, NAT gateway, EIP, subnets, routes, and security groups. The exact artifact bucket, compiler ECR repository, approved AMI, and evidence remain until an explicit, separately reviewed rollback.

Ubuntu 24.04 Minimal does not include the AWS CLI package. Controller user data installs the AWS-published AWS CLI v2 Snap, exposes it at `/usr/local/bin/aws`, and records the exact installed version before SSM accepts a build command. The controller copies that nonempty bootstrap receipt into every result, falls back to recording its own invocation, and fails if either the executable or receipt is absent. Operators therefore do not need to repair a fresh controller interactively.

The bootstrap resource names are fixed:

- `arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevOperatorRole`
- `arn:aws:iam::222222222222:user/opengeo/dev/OpenGeoDevBootstrapOperator`
- `arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevBuildCloudFormationRole`
- `arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevAmiBuildControllerRole`
- `arn:aws:iam::222222222222:role/opengeo/dev/OpenGeoDevWebCloudFormationRole`
- `arn:aws:iam::222222222222:role/cdk-hnb659fds-file-publishing-role-222222222222-us-east-1`
- `arn:aws:iam::222222222222:role/cdk-hnb659fds-deploy-role-222222222222-us-east-1`
- `arn:aws:iam::222222222222:role/cdk-hnb659fds-lookup-role-222222222222-us-east-1`
- `arn:aws:iam::222222222222:role/cdk-hnb659fds-cfn-exec-role-222222222222-us-east-1`
- `OpenGeoDevAmiBuildControllerProfile`
- `opengeo-dev-build-222222222222-us-east-1`
- `opengeo-dev-demo-222222222222-us-east-1`
- `222222222222.dkr.ecr.us-east-1.amazonaws.com/opengeo/observable-builder`
- CloudFormation stack `OpenGeo-dev-DemoWeb`
- CloudFormation stack `OpenGeo-dev-CdkBootstrap`
- CloudFront distribution `E25Z1R9YMLJT09`
- account-wide monthly budget `opengeo-dev-monthly-account`

The budget name intentionally matches `PlatformFoundationStack`. During this bootstrap phase it is created directly from `opengeo-dev-account-budget.json` and `opengeo-dev-budget-notifications.json` so the cost circuit breaker exists before transient paid resources. A later full foundation deployment must perform an explicit resource-ownership handoff instead of attempting to create a second budget with the same name.

### Scoped CDK roles

The retained `cdk-hnb659fds-assets-222222222222-us-east-1` bucket and bootstrap version 21 existed before a complete bootstrap stack. The installer now checks every required component instead of treating either retained item as proof that deployment is ready.

[`opengeo-dev-cdk-bootstrap.yaml`](opengeo-dev-cdk-bootstrap.yaml) creates four roles and no bucket, repository, key, compute, or network resource:

- the file role can manage objects only in the retained CDK asset bucket;
- the deployment role can manage only `OpenGeo-dev-*` stacks and pass only the four fixed OpenGeo CloudFormation service roles;
- the lookup role can read regional network context, the exact bootstrap version, and metadata/templates for `OpenGeo-dev-*` stacks while secret reads remain explicitly denied; and
- the default CloudFormation execution role has no permissions. A deployment must name its reviewed stack-specific service role.

The general CDK image-publishing role is omitted. OpenGeo publishes container images through its separate private ARM64 build, scan, SBOM, and immutable ECR path. A successful read-only `cdk diff --method template` through these roles proves the tooling path. The current Foundation diff is intentionally unapplied: its separately owned account budget and generated export changes still need an exact ownership and change-set review.

Removing `OpenGeo-dev-CdkBootstrap` is the bounded rollback for these four CDK roles. The retained asset bucket and SSM version parameter are outside this stack and must not be removed as part of that rollback.

Use the checked-in AWS config without persisting assumed-role credentials:

```bash
AWS_CONFIG_FILE="$PWD/infrastructure/bootstrap/aws-config" \
AWS_PROFILE=opengeo-dev-operator \
aws sts get-caller-identity
```

The development demo has no custom alias, certificate, or DNS record. Deploys must set `OPEN_GEO_DEMO_ENVIRONMENT=dev`, select the exact distribution and bootstrap hostname, and provide the hostname-bound confirmation value required by `npm --prefix app run deploy:demo`. Releases are immutable S3 prefixes; after the first successful edition, every deployment receipt carries the exact prior origin path for `npm --prefix app run rollback:demo`.

The CloudFormation template accepts one exact reviewed ARM64 source AMI, AWS-managed EBS KMS key, `us-east-1a`, and `t4g.large` values selected by the operator. The current source lock is Canonical Ubuntu 24.04 Minimal ARM64. The template keeps the Packer SSH boundary private and permits port 22 only from the controller security group.
