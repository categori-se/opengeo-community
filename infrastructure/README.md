# OpenGeo AWS Infrastructure

This AWS CDK application creates the first OpenGeo platform foundation. It does not deploy resources unless `cdk deploy` is run explicitly.

## Resources In The Foundation Stack

- a two-AZ VPC with public ingress and isolated data subnets, with no NAT gateway cost in the initial slice;
- a rotating KMS key;
- private, encrypted, versioned application and geodata S3 buckets;
- a dedicated public OpenGeo browser client in the existing shared `auth.categori.se` Cognito pool (no duplicate user pool or domain);
- an isolated Aurora PostgreSQL 16.13 Serverless v2 cluster with Data API, zero-ACU minimum, five-minute automatic pause, and a PostGIS migration;
- an ECS/Fargate cluster and encrypted ECR repositories for the API and worker;
- SQS-managed encrypted processing/dead-letter queues receiving geodata `ObjectCreated` events under the `organizations/` prefix;
- encrypted CloudWatch API and worker log groups; and
- an account-wide monthly budget with forecast and actual-spend notifications.

Production differs intentionally: resources are retained, database deletion protection and an Aurora reader are enabled, backups/logs live longer, and cleanup helpers are disabled. Every instance remains `db.serverless`.

The production account-wide budget limit is `$100` per month. The budget covers the whole AWS account rather than OpenGeo alone, so release evidence records both the configured limit and observed actual/forecast spend. Development and staging retain their separate `$125` and `$250` planning limits.

## S3 Names And Roles

Foundation buckets use readable OpenGeo names, with environment words instead of account-number or generated-number suffixes:

| Environment | Private application bucket | Private managed-data bucket |
| --- | --- | --- |
| Development | `dev.source.opengeo.tools` | `dev.storage.opengeo.tools` |
| Staging | `staging.source.opengeo.tools` | `staging.storage.opengeo.tools` |
| Production | `source.opengeo.tools` | `storage.opengeo.tools` |

The existing `opengeo.tools` bucket remains the public Observable publication origin. It is not a private upload store. `studio.opengeo.tools` is the separate private S3/OAC origin for compiled Studio releases. `source.opengeo.tools` is reserved for private page/source-project revisions, manifests, previews, and build artifacts; `storage.opengeo.tools` holds user uploads, immutable GIS originals, derivatives, and explicit snapshots of external sources. External database credentials never belong in either bucket: connection metadata belongs in the tenant database and credential values belong in Secrets Manager. A live external reference creates no OpenGeo-owned data object until a user explicitly imports or snapshots it.

S3 bucket names are globally unique. Deployment must stop with a clear error if one of these names is unavailable; it must not silently add an opaque numeric suffix. Dotted private names require regional path-style HTTPS in OpenGeo's custom S3 signing and browser validation because S3's wildcard certificate does not match a dotted virtual-host bucket label. Studio uses CloudFront's native S3 origin with OAC; no private bucket is configured as an S3 website.

An independent installation can provide its own exact pair through `OPEN_GEO_APPLICATION_BUCKET` and `OPEN_GEO_DATA_BUCKET`, or the matching `applicationBucket` and `dataBucket` CDK contexts. The installation owner selects both names; they are required together, must be distinct DNS-compatible S3 names, and never receive an appended account number or generated suffix. These are OpenGeo-managed storage locations. Existing external dataset buckets are linked after installation through governed dataset connections and are not imported or modified by the foundation stack.

## Studio Web Edge

`bin/opengeo-studio-web.ts` synthesizes the Studio web edge independently of the database/API foundation. It creates retained, versioned, public-blocked bucket `studio.opengeo.tools`, a read-only SigV4 Origin Access Control, and a separate CloudFront distribution. With no certificate input it exposes only the temporary CloudFront hostname for bootstrap verification and reports that DNS activation is not ready. Supplying an issued same-account `us-east-1` certificate through `OPEN_GEO_STUDIO_CERTIFICATE_ARN` activates the `studio.opengeo.tools` alias and emits the exact DNS Made Easy CNAME handoff. An optional global WAFv2 ARN is accepted through `OPEN_GEO_STUDIO_WEB_ACL_ARN`. The stack never creates Route53 resources.

The production bootstrap stack is deployed as `OpenGeo-production-StudioWeb`: bucket `studio.opengeo.tools`, distribution `E2GPOVS3D9R9NX`, and temporary hostname `dltvq18ewbys3.cloudfront.net`. It owns the issued Studio certificate and `studio.opengeo.tools` alias and currently has no WAF. The stack parameter `StudioReleaseOriginPath` now owns active prefix `/releases/opengeo-studio-20260821222342-9a7795db1ac1`; exact-release browser smoke and a real CARTO image response pass at the CloudFront hostname while the external Studio CNAME remains absent. The existing apex WAF is tied to its CloudFront pricing-plan distribution and cannot be shared; decide on a separately billed Studio WAF before adding an API edge, not by silently reusing the apex ARN.

Synthesize that dedicated stack independently with:

```bash
AWS_PROFILE=categorise \
CDK_DEFAULT_ACCOUNT=111111111111 \
CDK_DEFAULT_REGION=us-east-1 \
OPEN_GEO_STUDIO_BUCKET=studio.opengeo.tools \
npm run synth:studio-web
```

Omit `OPEN_GEO_STUDIO_CERTIFICATE_ARN` for bootstrap. Supply the already-issued Studio certificate ARN for final alias synthesis and also set the exact active immutable prefix, for example:

```bash
OPEN_GEO_STUDIO_BUCKET=studio.opengeo.tools \
OPEN_GEO_STUDIO_CERTIFICATE_ARN=<issued-certificate-arn> \
OPEN_GEO_STUDIO_RELEASE_ORIGIN_PATH=/releases/opengeo-studio-20260821222342-9a7795db1ac1 \
npm run synth:studio-web
```

The release path is a CloudFormation parameter and is required when the alias is enabled. Studio release and rollback commands update that parameter through the stack, then re-read CloudFront and fail unless the requested immutable prefix is actually active; they do not mutate CloudFront outside CloudFormation. After a reviewed `OpenGeo-production-Api` stack exists, supply only its exact regional API Gateway hostname (no scheme or path) to add the uncached same-origin API behavior:

```bash
OPEN_GEO_STUDIO_BUCKET=studio.opengeo.tools \
OPEN_GEO_STUDIO_API_ORIGIN_DOMAIN=<api-id>.execute-api.us-east-1.amazonaws.com \
npm run synth:studio-web
```

That input permits exactly `/api/*`, forwards all viewer request data except the Studio `Host` header, accepts all API methods over TLS 1.2+, and adds no other origin or behavior. Leave it unset while no production API is deployed. The stack then emits the exact external DNS handoff. Pin the `categorise` profile and verify account `111111111111` before any deployment because the shell's default profile is a different account.

## Anonymous Demo Web Edge

`bin/opengeo-demo-web.ts` synthesizes `OpenGeo-production-DemoWeb` independently of both Studio and the public apex. It owns retained private bucket `demo.studio.opengeo.tools`, a read-only OAC distribution, security headers, and CloudFormation parameter `DemoReleaseOriginPath`. It has no Cognito client, `auth-config.json` behavior, API origin, or Route53 resource. Supply an issued us-east-1 certificate with `OPEN_GEO_DEMO_CERTIFICATE_ARN` and preserve the active immutable prefix with `OPEN_GEO_DEMO_RELEASE_ORIGIN_PATH` when activating the alias.

```bash
npm run synth:demo-web
```

External DNS remains in DNS Made Easy. The stack outputs the exact final CNAME only after a certificate is supplied.

## Private Observable Preview Edge

The production foundation conditionally creates the separate `preview.studio.opengeo.tools` delivery edge when all four inputs are supplied:

- `OPEN_GEO_OBSERVABLE_PREVIEW_API_ORIGIN_DOMAIN` — the exact us-east-1 API Gateway hostname, with no scheme or path;
- `OPEN_GEO_OBSERVABLE_PREVIEW_CERTIFICATE_ARN` — an issued, same-account, us-east-1 certificate for the exact preview hostname;
- `OPEN_GEO_OBSERVABLE_PREVIEW_PUBLIC_KEY_PEM` — an RSA public key of at least 2048 bits, including PEM delimiters and final newline; and
- `OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN` — one same-account, us-east-1 Secrets Manager secret encrypted with the foundation data key.

The secret value is exact JSON with only `key_pair_id` and `private_key_pem`. The first value must be the CloudFront public-key ID emitted by the foundation; the second is the matching unencrypted PKCS#8 RSA PEM inside Secrets Manager. The private key must never be put in CDK context, CloudFormation parameters, environment variables, source control, build logs or the shell bucket. The current single-key contract makes rotation a reviewed maintenance operation: disable issuance, wait out the maximum 15-minute cookie lifetime, deploy the new public key, update the exact secret identity, and recycle any process that had cached the old validated key before re-enabling issuance. Zero-downtime overlapping key rotation remains an explicit follow-up gate rather than an implicit claim.

Initial provisioning is intentionally two-phase because CloudFront assigns the public-key ID. First create the secret ARN with the final private PEM and a syntactically valid nonmatching placeholder ID, then deploy the reviewed edge. Preview issuance remains unavailable. Read `ObservablePreviewCloudFrontKeyPairId`, replace the secret value with that exact ID plus the unchanged PEM, and verify the next API availability check reloads and accepts it before creating DNS. A mismatched or unavailable secret is never cached as usable and capability issuance returns 503 before token creation.

The edge deploys a retained, public-blocked shell bucket and the three static files under `services/observable-preview/authorize`. Its default behavior reads only exact Observable build-output keys from `source.opengeo.tools` and requires the trusted CloudFront key group. Only `authorize/*` and the exact `observable-preview/exchange` API behavior omit that requirement. Build CSP allows scripts, styles, images, fonts, workers and connections only from the preview origin; the shell has a stricter no-inline CSP and both are no-referrer. The S3 bucket policy is output-prefix and exact-distribution scoped. Because the application bucket uses S3 Bucket Keys, the KMS encryption context is necessarily the exact bucket ARN; S3 remains the object-level enforcement point. The API role receives `GetSecretValue` only on the supplied secret and KMS decrypt only through Secrets Manager for that ARN.

An optional `OPEN_GEO_OBSERVABLE_PREVIEW_WEB_ACL_ARN` must be a same-account us-east-1 global WAFv2 ARN. The stack outputs the distribution, public-key ID and exact DNS Made Easy CNAME handoff but never mutates external DNS. Review a production synth before any deployment, then provision certificate/DNS only as an explicit operator action. No local synth proves browser cookies, KMS reads, revocation races, key rotation, logs, cost or live publication separation.

## Optional External Connection Verifier

`OPEN_GEO_CONNECTION_VERIFIER_IMAGE` (or the matching CDK context) must be one exact lowercase `sha256:` digest. When present, it creates a separate encrypted SQS queue/DLQ, connector database secret, and ARM64 Lambda with no VPC attachment or provisioned concurrency. Dev reserved concurrency is 2; production is 16. The event source consumes one UUID-only command at a time, reports partial batch failures, and sends a message to the DLQ after three receives. Its role can call only the fixed verification Data API functions, read its connector credential and the exact current-stage connection-secret namespace, decrypt those secrets only through Secrets Manager, and consume its queue.

Runtime creation and API advertisement are independent. Set `OPEN_GEO_CONNECTION_VERIFICATION_ADVERTISED=true` only after deployment acceptance; without it, neither API shape receives the queue URL or send permission. Advertising without an image fails synthesis. The activated add-on has a checked fixed-idle estimate of $0.60/month, so it is not part of the default $5 two-rotation idle envelope. Deploy the runtime first, configure the distinct connector database role, collect acceptance evidence, and only then deploy the advertise gate. Roll back the gate before removing the runtime.

## Local Verification

```bash
npm install
npm run build
npm test
npm run test:cost
npm run validate-synth:dev
npm run validate-synth:staging
npm run validate-synth:production
npm run validate-synth:api:dev
npm run validate-synth:api:production
npm run validate-synth:worker:dev
npm run validate-synth:worker:production
npm run validate-synth:connector:dev
npm run validate-synth:connector-api:dev
npm run validate-synth:observable-coordinator:dev
npm run validate-synth:observable-coordinator-api:dev
npm run validate-synth:worker-coordinator-api:dev
```

`OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_ID`, the SHA-256 of its reviewed closed-schema receipt in `OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_EVIDENCE_SHA256`, and the exact builder digest creates the optional coordinator queue/DLQ, database secret, three directly used single-AZ interface endpoints, shared S3 gateway endpoint, isolated zero-to-one trusted-host ASG, logs, alarms, and exact IAM. Creating it does not advertise execution. Set `OPEN_GEO_OBSERVABLE_COORDINATOR_ADVERTISED=true` only after the baked AMI and live acceptance gates pass; advertising without the runtime fails synthesis. The request API then receives only `sqs:SendMessage`, while the trusted host receives consume, fixed Data API, exact source/output S3, exact secret/KMS, and log authority. The compiler container still receives no role or storage facts and runs under rootless Podman with `--network=none`.

The runner receipt is produced only after the pinned Packer build has downloaded and an operator has reviewed the host/compiler CycloneDX SBOMs and offline Trivy reports. The stack rejects a missing or malformed receipt hash. The baked host preflight receives that hash, and boot also fixes the root-owned environment file to the coordinator group, generates the bounded CloudWatch file-log config, starts the agent, and starts the coordinator only after all baked evidence and the preloaded image revalidate. See `services/observable-coordinator/README.md`; local synthesis is fixture evidence, not proof that an AMI exists or was approved.

The optional dev coordinator shape has a checked zero-command fixed cost of $22.50/month, primarily three PrivateLink endpoints, for $25.303 combined current fixed idle or $27.303 after two KMS rotations. It is outside the default $5 idle envelope but below the $125 circuit breaker. Worker and coordinator endpoints now live in one conditional `PrivateRuntimeEndpoints` stack: worker alone uses five paid endpoints, coordinator alone three, and the combined union six rather than eleven, plus one free S3 gateway endpoint. Separate endpoint security groups retain exact source-runtime ingress. The combined optional shape adds $44.60 fixed, for $47.403 current/$49.403 after rotations. The preview edge remains a fail-closed delivery contract and still requires independent TM-52 live gates.

If a legacy worker stack is still deployed with endpoints it owns, drain and destroy that activation-only stack from its prior reviewed assembly before creating `PrivateRuntimeEndpoints`; an in-place create-first migration would collide on private DNS. Do not delete endpoint ENIs outside CloudFormation.

The `validate-synth:*` commands set an explicit OpenGeo stage and invoke the app directly. They synthesize account-agnostic templates without discovering a local AWS account, making them appropriate for credential-free pull-request checks. They must leave no `cdk.context.json` behind. The `synth:*` commands use the CDK CLI and remain available for operator review in a configured AWS environment.

Deployments require explicit AWS account/region configuration, a bootstrapped CDK environment, the final HTTPS application origin, and a monitored budget-alert email. Review the synthesized template, the [dev cost estimate](../docs/dev-cost-estimate.md), and the [threat model](../docs/threat-model.md) before running a deployment. The `opengeo-ci@example.invalid` value in validation scripts is fixture data and must never be deployed. Production validation intentionally uses the Studio application origin `https://studio.opengeo.tools`; that does not authorize deployment or mutation of the existing CloudFront/S3 site.

## Cognito Browser Authentication

`OPEN_GEO_WEB_ORIGIN` is mandatory. It must be an HTTPS origin without a path, query, credentials, or fragment; dev alone may use `http://localhost`. The stack creates one no-secret OpenGeo app client in shared pool `us-east-1_KXUwaZnuQ`, registers `${OPEN_GEO_WEB_ORIGIN}/login` for callback and logout, and enables authorization code with PKCE only. During the Studio cutover, the standalone auth stack may additionally accept exact legacy origin `https://opengeo.tools` through `OPEN_GEO_LEGACY_WEB_ORIGIN`; Studio remains the default redirect, and the legacy entry is removed after the rollback window. It reuses `https://auth.categori.se`; it does not create or own a Cognito user pool, Hosted UI domain, password policy, MFA policy, email sender, or federation provider. Stack outputs include a non-secret `BrowserAuthConfigJson` template.

The stack must therefore deploy in the AWS account that owns the shared pool. Changes to shared email/password, MFA, account recovery, Google, or Entra policy belong to the shared-auth deployment and are rejected by the OpenGeo stack. Identity in that pool grants no OpenGeo access until PostgreSQL membership and resource authorization succeed.

The stack intentionally has no NAT gateway. The default Lambda API is not VPC attached: it reaches Aurora through Data API. The older public-address API task is an explicit transitional stack only; see the threat model for its time-bounded dev exception.

## Request-Driven API Stack

Supplying an immutable image digest through `apiImage` adds API Gateway HTTP API and an ARM64 container Lambda without changing ordinary foundation synthesis. A credential-free validation uses:

```bash
npm run validate-synth:api:dev
```

The function has 1 GiB memory, 512 MiB ephemeral storage, a 29-second timeout, bounded reserved concurrency, no provisioned concurrency, and no VPC attachment. API Gateway uses payload v2 and exact-origin CORS. The function gets only the four transaction/query Data API actions on the exact cluster and read access to the separate `opengeo_runtime` secret; the administrator secret remains reserved for migrations and recovery.

For membership provisioning, the Lambda role has exactly `cognito-idp:AdminGetUser` and `cognito-idp:AdminCreateUser`, scoped to this environment's exact shared `auth.categori.se` pool ARN. For managed ingestion it has only `s3:GetObject` and `s3:PutObject` on `organizations/*/projects/*/datasets/*/uploads/*`, plus `kms:Decrypt` and `kms:GenerateDataKey` through regional S3 for the matching bucket encryption context. Exact catalog downloads add `s3:GetObjectVersion` only on managed original upload and logical-version derivative prefixes. Governed page-source commits additionally receive the application bucket name and only `GetObject`, `GetObjectVersion`, and `PutObject` on `organizations/*/projects/*/pages/*/versions/*/uploads/*/source.md`; their KMS authority is constrained through S3 to that bucket and organization prefix. The application bucket's browser CORS permits `POST` only from the configured Studio origin. The API cannot list or delete bucket objects, call unrelated KMS operations, list pools, delete users, change passwords, mutate groups, or access another pool. The service signs these calls with execution-role credentials and does not persist credentials.

The geodata bucket permits browser `POST` in its CORS contract but remains private, versioned, and customer-KMS encrypted. S3 publishes only matching object-created notifications to the processing queue. The queue policy grants that exact bucket send authority with source-account/source-ARN conditions. SQS uses its managed server-side encryption rather than the customer data key: using the same customer key for both source bucket and notification queue creates a CloudFormation key↔bucket dependency cycle. Worker receipt and job reconciliation are implemented in the optional worker stack; a raw S3 event is never itself authorization to process data.

Before deployment, build and scan `services/api/Dockerfile.lambda`, push it to the API repository, then pass the registry-reported immutable digest and a real monitored budget address:

```bash
OPEN_GEO_BUDGET_ALERT_EMAIL=platform-alerts@example.com \
OPEN_GEO_WEB_ORIGIN=https://maps.example.com \
  npx cdk deploy -c stage=dev -c apiImage=sha256:<64-hex-digest>
```

The output HTTP API endpoint is public at the network layer; application authentication and authorization still apply. CloudFront/custom TLS/DNS, WAF, headers, throttling, and access-log policy remain separate exposure gates.

To synthesize the old Fargate/internal-ALB implementation for a migration test, use `transitionalApiImage` or `OPEN_GEO_TRANSITIONAL_API_IMAGE`. It is not part of the accepted inactive shape and must not be mistaken for the default `apiImage` path.

## Optional GIS Worker Service Stack

Supplying `workerImage` as an immutable `sha256:<64-hex>` digest adds the activation-only GIS processing stack without changing ordinary foundation synthesis:

```bash
npm run validate-synth:worker:dev
npm run validate-synth:worker:production
```

The worker runs as ARM64 Fargate capacity in isolated subnets, starts at zero, and scales against visible queue messages (maximum two tasks in dev/staging and 20 in production). It has no public address, default egress, ECS Exec, or broad AWS API path. The separate conditional endpoint stack provides five security-group-scoped interface endpoints for ECR API and Docker, CloudWatch Logs, Secrets Manager, and SQS, plus a free S3 gateway endpoint; PostgreSQL is the only non-TLS endpoint, on an exact task-to-database security-group rule.

Although task compute scales to zero, the endpoint ENIs are billed continuously. The worker and endpoint stacks preserve the reviewed malicious-parser isolation boundary and must be deployed only for a bounded processing window. Scaling the service to zero is not deactivation. When no coordinator remains, remove both stacks; when it remains, destroy the worker and shrink the shared endpoint stack to its coordinator-only service set. Follow [`docs/processing-plane-runbook.md`](../docs/processing-plane-runbook.md); a future increment may automate that lifecycle after deletion scope, race, rollback, and cost-abuse controls are proven.

The execution role can pull the worker image and inject only the separate `opengeo_worker` database secret. The task role can receive/delete/change visibility on the exact queue, read exact original S3 versions, write only version derivative prefixes, and use the data key only through S3 with the matching bucket encryption context. It cannot list/delete objects, send queue messages, read the API/admin database secrets, or call arbitrary KMS operations.

The task uses 2 vCPU, 4 GiB memory, 50 GiB ephemeral storage, UID/GID 10001, a read-only root filesystem, dropped Linux capabilities, and a dedicated `/tmp/opengeo-worker` volume. Oldest-message and DLQ alarms make stalled or poisoned work observable. Build, scan, and push `services/worker`, then deploy with both desired immutable digests when the API and worker are promoted:

```bash
OPEN_GEO_BUDGET_ALERT_EMAIL=platform-alerts@example.com \
OPEN_GEO_WEB_ORIGIN=https://maps.example.com \
  npx cdk deploy --all -c stage=dev \
    -c apiImage=sha256:<api-digest> \
    -c workerImage=sha256:<worker-digest>
```
