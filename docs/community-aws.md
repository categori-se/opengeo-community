# Deploy OpenGeo Studio to AWS

This guide installs a standalone OpenGeo Studio workspace in your AWS account. The
community command connects the existing CDK stacks, image builds, database
migrations, Cognito authentication and sealed Studio publisher.

The first profile uses **one installation per AWS account in `us-east-1`**, with
a generated CloudFront HTTPS address. It creates its own Cognito pool and
account-qualified buckets. You supply the AWS account, credentials, installation
name and budget notification address.

See [our deployment and Studio demo](community-deployments.md) for examples of
how the same components serve published work, an authenticated workspace and an
anonymous workbench. For managed hosting or enterprise support, see
[fee-based services](../SUPPORT.md#hosting-and-enterprise-support).

## Architecture and operating costs

| Component | Deployment |
| --- | --- |
| Studio | Private S3 bucket, CloudFront with Origin Access Control, immutable releases |
| Identity | Account-owned Cognito pool and public PKCE client, invitation-based users |
| API | ARM64 Lambda container and API Gateway, forwarded through Studio `/api/*` |
| Spatial database | Aurora PostgreSQL 16/PostGIS, Data API, automatic pause/resume |
| Storage | Encrypted, versioned application and geodata buckets with Bucket Keys |
| Processing | SQS; optional ARM64 Fargate GIS worker and private network endpoints |
| Build inputs | Account-owned immutable ECR images and pinned dependency sources |

The profile keeps compute request-driven and retains durable data, encryption
keys and identity resources. AWS charges still include storage, backups, requests,
KMS, logs and network traffic. Aurora resumes when the application reads data;
pausing removes idle database compute charges while retained storage remains
billable. See [AWS automatic pause and resume](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).

`withWorker: false` deploys Catalog, Projects, account permissions and API/Studio
workflows first. Referenced sources and browser operations can use this profile.
Enable `withWorker: true` for queued GIS conversions and server rendering. The
worker starts at zero tasks; **its five private interface endpoints have hourly
charges even when no worker task is running**. Inspect the synthesized resources
and AWS regional pricing before enabling it. Queued work requires the worker;
select the profile that supports your intended workflow.

The budget email receives alerts; a budget is a notification threshold rather
than a spending cap. Build and reuse immutable images and application releases;
bundle Studio changes into one cutover and one invalidation.

## Prepare your workstation and account

Use Git, Node.js 24/npm, Python 3.13, AWS CLI v2, and rootless Podman. The API and
worker builds target `linux/arm64`; the publication compiler targets `linux/amd64`.
Build on compatible hosts or configure container emulation. Internet access is
needed for npm, pinned base images and assets, and the initial Observable build
cache. Lambda images use a single target architecture; see
[AWS container image requirements](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html).

```bash
git clone https://github.com/categori-se/opengeo-community.git
cd opengeo-community
npm ci --prefix app
npm ci --prefix infrastructure
python3 -m venv .venv
.venv/bin/python -m pip install boto3
mkdir -p .opengeo
cp infrastructure/community.example.json .opengeo/aws-config.json
```

Use an authenticated AWS CLI profile for **your** account, for example through
your organization's IAM Identity Center setup. Edit `.opengeo/aws-config.json`:

```json
{
  "account": "123456789012",
  "region": "us-east-1",
  "name": "my-opengeo",
  "profile": "my-opengeo",
  "budgetAlertEmail": "operator@example.org",
  "withWorker": false
}
```

Replace the example account and email. The name becomes part of stack names and
the Cognito domain. Configuration contains identifiers, never secret values.
Keep `.opengeo/` private and out of Git. The wrapper discards inherited OpenGeo Studio
operator settings and verifies STS caller identity before each AWS step.

The deploying principal needs CloudFormation and CDK bootstrap/deployment-role
access, plus the service permissions represented in the synthesized templates:
IAM, KMS, S3, ECR, EC2/VPC, ECS, RDS, Secrets Manager, Cognito, Lambda, API Gateway,
CloudFront, SQS, CloudWatch/Logs and Budgets. Migration/owner steps need RDS Data
API and scoped secret access. Image publishing needs scoped ECR access. Review
these with your account administrator; runtime roles are defined by the stacks.

## Review locally

```bash
.venv/bin/python scripts/community-aws.py plan --config .opengeo/aws-config.json
.venv/bin/python scripts/community-aws.py synth --config .opengeo/aws-config.json
.venv/bin/python database/scripts/apply_migrations.py
npm --prefix infrastructure run build
```

`plan` and `synth` make no AWS calls. Before a Web endpoint exists, synthesis emits
the Web stack. After Web deployment, it also emits the Foundation; after image
builds, it includes the API and any selected worker stacks. Rerun synthesis at
those review points. The assembly is in `infrastructure/cdk.out`.

Every operational command prints an offline plan unless `--apply` is supplied.
CDK retains its IAM broadening review prompt. No deployment runs automatically
on a Git push.

## Install in stages

1. **Bootstrap CDK** using an explicit CloudFormation execution policy selected
   by your account administrator:

   ```bash
   .venv/bin/python scripts/community-aws.py bootstrap --config .opengeo/aws-config.json \
     --execution-policy-arn arn:aws:iam::123456789012:policy/OpenGeoDeployment --apply
   ```

   The policy must already exist. Standard CDK bootstrap creates its asset bucket,
   ECR repository and deployment roles. Review the
   [CDK bootstrap reference](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html)
   for custom execution policies and organization permissions boundaries.

2. **Create the Web endpoint, then the Foundation**:

   ```bash
   .venv/bin/python scripts/community-aws.py web --config .opengeo/aws-config.json --apply
   .venv/bin/python scripts/community-aws.py foundation --config .opengeo/aws-config.json --apply
   ```

   The first command records the generated HTTPS address. Foundation binds its
   own Cognito callbacks and storage origins to that address. The Web endpoint
   becomes usable after the application release is uploaded in step 6.

3. **Build and push your images**:

   ```bash
   .venv/bin/python scripts/community-aws.py images --config .opengeo/aws-config.json --apply
   ```

   This builds the Lambda API and compiler, plus the worker when selected. Inputs
   identify an immutable ECR tag; a previously pushed matching image is reused.
   Exact digests are retained locally. `--component api`, `compiler` or `worker`
   selects a single component after a diagnosed build failure. Builds have a
   one-hour timeout per component; pushes have a thirty-minute timeout. Build
   logs show failures without silently launching repeated attempts.

4. **Initialize the database and runtime credentials**:

   ```bash
   .venv/bin/python scripts/community-aws.py database --config .opengeo/aws-config.json --apply
   ```

   The maintained migration runner verifies the baseline and raw migration
   checksums, initializes PostGIS and configures API/worker database roles. It
   reads secret values inside its process and passes passwords as bound Data API
   parameters. Its ledger preserves committed progress across interruptions.

5. **Deploy the runtime and attach its API to CloudFront**:

   ```bash
   .venv/bin/python scripts/community-aws.py runtime --config .opengeo/aws-config.json --apply
   .venv/bin/python scripts/community-aws.py web --config .opengeo/aws-config.json --apply
   ```

   The second Web update adds the exact API endpoint. API paths retain their own
   CloudFront behavior and cache settings. If you later enable the worker, build
   its image and repeat `runtime` with the same installation configuration.

6. **Build and publish Studio**:

   ```bash
   .venv/bin/python scripts/community-aws.py studio --config .opengeo/aws-config.json --apply
   ```

   This builds from source, renders your non-secret Cognito browser configuration,
   verifies sealed files and uploads an immutable release. The existing publisher
   updates the CloudFormation-owned release pointer and waits for one batched
   CloudFront invalidation. Keep the deployment record for rollback.

7. **Invite and establish the first account owner**. In the AWS Cognito console,
   select this installation's pool and create the intended owner with their exact
   email, marking it verified after verifying ownership. Use the invitation flow
   to set their password. Open `StudioUrl` from
   `.opengeo/aws/my-opengeo/web.outputs.json` and sign in. Then:

   ```bash
   .venv/bin/python scripts/community-aws.py owner --config .opengeo/aws-config.json \
     --email you@example.org --display-name 'Your Name' \
     --organization-name 'Your organization' --organization-slug your-organization --apply
   ```

   The command verifies that exact enabled Cognito user's email and establishes
   their account and initial content permissions through the maintained bootstrap
   transaction. Sign in again to load the account. Subsequent users use the normal
   account invitation and resource permission workflows.

8. **Inspect installation outputs**:

   ```bash
   .venv/bin/python scripts/community-aws.py status --config .opengeo/aws-config.json --apply
   ```

   This reads CloudFormation outputs and refreshes local metadata. It does not
   inspect secret values or constitute an application acceptance check.

## Verify the installation

Run one representative journey in your own deployment: sign in; register a small
supported source; open its Catalog preview; compose and save a Project; sign out
and reopen it; verify a second user sees only their permitted resources. With the
worker enabled, process one small upload and verify the resulting Layer renders.
Keep source custody and data licenses explicit.

Publication source editing is included. The standalone core profile deploys
Studio/API and optional GIS processing. Native Notebook/Framework build coordination
and public delivery use additional components in
`services/observable-*`, `services/api/src/opengeo_api/github_build_controller.py` and
`infrastructure/lib/*publisher*`. Their operator-owned GitHub App, build execution,
and publication destination configuration remain deployment work. The optional
private-preview phase below configures delivery and signing infrastructure; it does
not install a compiler runner or publisher. These integrations stay unadvertised until their
runtimes are configured. Track this work in the [roadmap](../ROADMAP.md).

## Optional private-preview setup

After the core runtime exists, add `nativePreview` to your existing configuration:

```json
{
  "domainName": "preview.maps.example.org",
  "certificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012",
  "publicKeyPath": "preview-public.pem",
  "privateKeySecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:opengeo-preview-AbCd12"
}
```

This object is the value of `nativePreview`, alongside `account`, `name` and the
other existing settings. `publicKeyPath` is relative to the configuration file.
Supply one RSA public SPKI PEM of at least 2048 bits. The certificate and complete
secret ARN must belong to your installation account in `us-east-1`. The preview
hostname must be independent of OpenGeo's managed domains and distinct from Studio
and the API. An optional `publicMapsDomainName` enables a second preview alias;
the certificate must cover both names. Adding the object alone enables no resources.

Keep the matching private key in the referenced operator-owned secret, encrypted
with the Foundation data key. Its JSON has exactly `key_pair_id` and
`private_key_pem`. CloudFront assigns the public-key ID during deployment: initially
use a valid nonmatching placeholder, then update the secret with the
`ObservablePreviewCloudFrontKeyPairId` Foundation output. The API refuses signing
until the IDs match. Keep key material out of the repository, command arguments,
environment and logs. The installer validates the public key without fetching
the private secret. Key rotation requires a maintenance window; stop issuance and
allow existing 15-minute cookies to expire before replacement.

```bash
.venv/bin/python scripts/community-aws.py synth --config .opengeo/aws-config.json --with-preview
.venv/bin/python scripts/community-aws.py preview --config .opengeo/aws-config.json --apply
```

Review the offline assembly first. The explicit apply verifies your AWS account,
records preview intent, updates Foundation, API and Web in order, and uploads the
four authorization-shell files to the installation's versioned private bucket.
The shell accepts messages from that Studio origin only. The next normal `studio`
release includes the exact preview origins in browser configuration. Review the
emitted DNS handoff and verify certificate coverage, signer availability and
authorized/revoked access before directing your hostname to the distribution.

Retain `preview.intent.json` and `preview-shell.json` with the other deployment
records. Subsequent commands preserve the enabled configuration; removing or
changing it cannot silently remove preview resources. Use the explicit `preview`
phase for a deliberate configuration change. Repeating that phase reuses completed
shell writes and reconciles uncertain writes by checksum and object version before
continuing. A conflicting object or access failure stops without rewriting it.

The optional phase adds CloudFront delivery, private versioned S3 storage and
signing configuration, with their storage, request, secret and potential KMS costs.
It adds no compiler execution, running service or private interface endpoint.
The default core profile remains unchanged. Local checks exercise the real CDK
entrypoint, shell origins and interrupted-step recovery; they do not prove domain
ownership, issued certificate coverage or live delivery.

Validation for this profile consists of local TypeScript/CDK checks, synthesized
resource/security assertions, migration plan/tests and sealed Studio release
checks. A new-account live AWS installation has yet to complete its representative
acceptance journey. Local development evidence is recorded in the
[development guide](community-development.md) and `COMMUNITY-RELEASE.json`.

## Operate, upgrade and recover

Keep the source commit, configuration, immutable image digests and `.opengeo/aws/`
metadata with your deployment records. Credentials remain in your normal AWS
credential store. Give access to those records only to installation operators.

Before upgrading, create an Aurora snapshot and verify your restore procedure.
Retain versioned S3 objects and manifests needed by existing Layers and
Publications. Database backups, S3 versioning and retained infrastructure are
separate recovery mechanisms; regularly test a restore into a separate account
or environment. Use [Aurora backup and restore](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Managing.Backups.html)
as the operational reference.

Review changes, run focused checks, rebuild only changed images, apply forward
migrations, deploy the affected runtime, and publish one Studio release. Existing
migration checksums stay immutable. After an interruption, diagnose the failure
and read the existing ledger/deployment record before resuming that step.

Roll Studio back to a retained release pointer from `studio-deployment.json`:

```bash
.venv/bin/python scripts/community-aws.py rollback --config .opengeo/aws-config.json \
  --release-origin /releases/opengeo-studio-YYYYMMDDhhmmss-0123456789ab --apply
```

Rollback restores the frontend and its sealed auth configuration; coordinate API
and schema compatibility separately. Keep older images and database snapshots
until the upgrade is accepted.

Durable resources use retention and database deletion protection. Removing stacks
therefore leaves billable storage, backups, secrets, encryption keys and identity
resources to manage explicitly. Inventory them and preserve data before retiring
an installation. The installer provides no automatic destructive teardown.

For help, use [community support](../SUPPORT.md). Include the source commit and
failed step with redacted output.
