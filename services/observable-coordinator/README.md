# OpenGeo Studio Observable Coordinator

The build coordinator connects authorized publication jobs to an isolated
compiler. It stages exact immutable inputs, maintains the job lease, verifies
outputs and stores completion facts. It retains AWS/database authority outside
the compiler and leaves publication as a separate permission-checked action.

Read the [publication architecture](../../docs/community-architecture.md#publication-builds-and-private-previews)
and [compiler README](../observable-builder/README.md) first. The
[AWS guide](../../docs/community-aws.md) records the standalone installation path
and remaining publication work. Technical and dated hosted notes below preserve
their original scope; hosted acceptance does not establish fresh community
installation or production readiness.

Independent GitHub compilation can now use an operator-configured account,
repository identity and immutable runtime SHA. The manual workflow, IAM access
construct, ECR pull check and Podman adapter share those boundaries. See the
[configuration and activation limits](../../docs/community-aws.md#trusted-github-compiler-configuration).
The standalone installer still needs the controller and connection setup;
configuration support does not establish an enabled or accepted runtime.

## Implementation notes and retained acceptance history

The local request-v4/invocation-v5 `single-html` option accepts only the generated
`dist/index.html`. Report-v2 validates its localized-manifest seal, native consumed
file and asset facts, final size/hash and root route. Exact output collection rejects
extra files; the 96 MiB write exception requires the fixed build-output index,
explicit size consent and the expanded profile. Old asset-tree caps remain intact.
Result-v2 retains this representation and sealed metadata, with publication authority
still false. Eight focused local cases pass, including byte verification, malformed
report rejection, no-request write rejection and legacy cap/reconciliation checks.
This is an unadvertised local contract. Database/API/result admission now passes
locally, including exact archive approval, mandatory preview, owner review and
revocation. Publisher adapters retain the seal and exact prior deployed-plan proof
for larger sibling HTML. Those fixtures establish metadata/adapter behavior;
native source-overlay compile and Chromium saved-preview-CSP/offline checks now
pass using one retained 290-byte synthetic GeoTIFF. SDK request-v4 forwarding
preserves the existing client-result-v1 redaction. The corrected immutable AMD64
candidate `7b09709f…` passes the no-overlay runner and produces byte-identical HTML;
its license-only inventory covers 373 components and all nine cached npm packages.
Fresh vulnerability security and runtime admission, live/public delivery,
original-data saved compilation and referenced-file persistence/staging remain
unfinished. No deployed image pin or public output changed.

The local request-v3/invocation-v4 increment accepts approval-bound archive and
retained Artifact release candidates through the existing leased resolvers.
Those resolvers and database completion must recheck current publication authority
and the exact sealed distribution approval; read/download permission alone does
not authorize redistribution. Private previews permit null approval or an existing
exact review selected by the owner; neither makes the preview public.
The compiler continues to report `publicationAuthorized: false`; final publication
is a separate authority-checked action.

An explicitly acknowledged `archive-96m` profile derives a 96 MiB execution
budget without changing the stored source policy or existing default 32 MiB
budget. A file above 32 MiB must match an admitted archive pin's size, checksum
and extension and cannot exceed 64 MiB. Collection, report validation and exact
output writing apply the same bounds. Source/data limits and sandbox isolation
remain unchanged. This increment has no deployed compiler/coordinator image;
the five historical compiler pins are retained. The local policy now permits at
most six distinct, explicitly pinned digests, preserving the configured primary;
no deployment allowlist or default changes with this capacity increase.
Adding a reviewed sixth image and transitioning selected sources through migration
0102 are required before advertising the new build path.

This package is the trusted half of the Observable build pipeline. It owns no publication operation. It claims one exact migration `0045` build, re-reads and revalidates every immutable S3 input version, strips all storage facts from the compiler invocation, maintains the database lease while the credential-free runner executes, re-hashes every local output byte, uploads only the exact build prefix, and completes the job with versioned object facts and an independently constructed sandbox envelope.

The implementation is adapter-driven so contract tests can prove authority flow without credentials. `PodmanRunner` is the concrete local isolation adapter: it runs only the request's exact `sha256:` image ID with pulls and network disabled, a read-only root/input/contract, no capabilities, no-new- privileges, UID/GID 10001, private IPC, bounded CPU/memory/PIDs/file descriptors, and no Docker socket or inherited credential environment inside the container. It safely collects the complete output tree after the compiler exits and emits the sandbox attestation that the coordinator requires before upload.

Version-2 source revisions support private previews with exact archive bindings. Migration 88's `app.resolve_observable_build_data` resolves only the live job's pins under its original actor's current authority. The coordinator rechecks them after staging, after compilation and before completion; completion repeats the check inside the database. `OPEN_GEO_ARCHIVE_BUCKET` selects the managed geodata bucket separately from `OPEN_GEO_APPLICATION_BUCKET`. Exact-version archive reads are restricted to dataset original/derivative prefixes and verify every byte. No storage coordinates reach the compiler, and release candidates remain denied pending archive publication-rights support. See [input custody and publication limits](../../docs/community-architecture.md#publication-builds-and-private-previews).

The production path now has bounded SigV4 Data API and exact-version S3 adapters, an ID-only SQS host loop, deterministic output reconciliation, and migration `0049`'s function-only `opengeo_observable_coordinator` role. The optional CDK stack scales one trusted, operator-baked ARM64 Podman host from zero to one in isolated subnets. The API receives send-only queue authority only through a separate advertisement gate. This is deployable local synthesis, not live acceptance: the AMI must still prove its systemd/log-forwarding contract, native ARM64 compiler image, SBOM/CVE state, metadata and network isolation, cancellation/drain behavior, load/cost, and private preview origin before an operator advertises execution.

```bash
npm test
npm start
```

`npm start` is for the baked trusted host. It reads only the environment file written by the coordinator stack, long-polls one command at a time, renews SQS visibility while work is active, and deletes a command only after a terminal or successfully completed coordination result.

## Retained Project Artifact inputs

The hosted GitHub runtime resolves each frozen Artifact through the trusted API
origin under the build's live lease and original actor, reads the exact S3 object
version, and checks its bytes before compilation. Account-scoped input permission
is separate from Publication source and output permission. The compiler receives
bytes and a storage-free manifest; it has no credentials or network access.

The approved October 3 runtime `f3ea7eaa1314aa0c62a85b4f0fdd43eda467b885`
permitted four explicitly reviewed immutable digests, including the default,
retained all three earlier pins and admitted native Notebook compiler
`sha256:f4ad135eea6cdb714220d4f0b070637e093876340a15d615ea59f9712309a178`. Digest validation,
fixed repository and exact old-job selection remain enforced. The selected Notebook
entry does not use Framework Markdown page caching, so no cache grants change.
A source transition is append-only and explicit; adding a digest does not upgrade
existing Publications. The API new-source default now selects this compiler; one
private source default, eight-file revision, native build and hosted private preview
pass. The output preserves the accepted checksum; authorized access succeeds and
anonymous access receives HTTP403. Source rights remain unreviewed and publication
unauthorized. No existing source pin or public content changed.
These historical hosted checks remain separate from the standalone edition's
[public acceptance limits](../../docs/community-architecture.md#acceptance-and-next-steps).

## Incremental build evidence

For cache-enabled Framework builds, the coordinator returns an `incremental`
summary only after verified output upload and successful job completion. The
GitHub runner logs this summary with the existing job/run identity:

```json
{"cacheRead":"hit","cacheWrite":"unchanged","counts":{"restored":true,"renderedPages":0,"reusedPages":2}}
```

Cache reads distinguish `hit`, `miss`, `invalid`, and `unavailable`. Writes retain
the store's `written`, `unchanged`, `superseded`, or `not_observed` outcome;
exceptions report `failed`, and missing evidence reports `unavailable`. A cache
write failure does not fail an already-completed build. `counts: null` means
compiler counts were unavailable or invalid, not zero work. Count validation
requires the matching bounded cache sidecar; logs exclude cache bytes, hashes,
paths, output objects and credentials. Failed or previously completed jobs do
not manufacture fresh incremental evidence.

These diagnostics do not alter the immutable database result contract or enable
caching for additional sources. They are local changes pending runtime release;
deployed incremental behavior must still be verified from actual build logs.

## Trusted ARM64 runner image

`ami/runner.pkr.hcl` is the operator-only Packer contract for the trusted host. It pins Packer 1.16.0 and the Amazon plugin 1.8.2, accepts one exact source AMI, uses a private IPv4 SSH path and no public address, requires IMDSv2, encrypts the root volume with the supplied KMS key, and produces only an ARM64 image. The caller must run Packer from a network that can reach the private build instance; the checked-in definition does not create a bastion, public ingress, NAT, or an artifact-download path.

All runtime and scanner artifacts are caller-supplied local files. Preparation derives every SHA-256 rather than trusting a checksum copied into the input:

- deterministic coordinator USTAR bundle;
- official Node.js 24.19.0 Linux ARM64 `.tar.xz`;
- ARM64 Amazon CloudWatch Agent Ubuntu DEB;
- OCI archive for the compiler whose image ID is the exact configured digest;
- ARM64 Trivy executable and a prepared offline Trivy database cache archive.

The bake checks every checksum and rejects a stale offline database on the ARM64 instance, installs the coordinator as UID/GID 10001, loads the compiler without pulling, and scans both the host root filesystem and compiler archive offline. Any HIGH or CRITICAL finding fails the bake. The host and compiler CycloneDX SBOMs and vulnerability reports are downloaded alongside the Packer manifest. SSH and SSM are disabled in the resulting image. At boot, CloudWatch configuration is generated without shell evaluation and systemd runs a preflight that rechecks the UID, architecture, workspace ownership/mode, baked manifest, evidence file hashes, zero-finding reports, exact compiler image ID/architecture/user, and deployment evidence hash before the queue loop starts.

Prepare a private, ignored copy of `ami/build-inputs.example.json` with exact artifact and infrastructure values. Then run:

```bash
npm run ami:bundle
npm run ami:prepare -- ami/build-inputs.json build/runner.pkrvars.json
packer init ami/runner.pkr.hcl
packer fmt -check ami/runner.pkr.hcl
packer validate -var-file=build/runner.pkrvars.json ami/runner.pkr.hcl
packer build -var-file=build/runner.pkrvars.json ami/runner.pkr.hcl
```

`packer build` launches an EC2 build instance and creates an AMI, so it requires explicit operator authorization and AWS credentials. Local tests do not run it. After reviewing the exact Packer manifest and all four reports, copy `ami/approval.example.json` to a private approval record, replace every example value, and bind that review to the resulting AMI:

```bash
npm run ami:record-evidence -- \
  build/runner.pkrvars.json \
  build/runner-approval.json \
  build/runner-evidence.json
```

The command prints the AMI ID and SHA-256 of the closed-schema evidence receipt. Supply those exact values as `OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_ID` and `OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_EVIDENCE_SHA256`. Preserve the receipt, Packer manifest, SBOMs, reports, input manifest, and their source artifacts together. Never use the checked-in example approval as evidence.

## Portable Artifact staging (local contract)

The coordinator accepts a sealed Artifact snapshot in preview claims and requires a
lease-authorized `resolveArtifactInputs` adapter. It reads exact retained bytes through
the separately bounded Artifact storage reader, verifies every pin, reuses identical
object reads within the build, and rechecks resolution before/after compilation and
before completion. The compiler receives files and sealed identity, not storage access.
Migration 0114 connects database claim/resolution, build admission/result seals and
preview reauthorization. The API feature flag `publication_artifact_builds_enabled`
remains false by default. The coordinator requires the operator-configured trusted
HTTPS `OPEN_GEO_OBSERVABLE_ARTIFACT_API_ORIGIN`; it posts the live lease token and original
actor/tenant to the capability endpoint before resolving exact retained objects.
The API verifies the lease before checking source permissions. Resolution is repeated
around execution, while cached actor identity is cleared at terminal job transitions.
No runtime API origin, additional IAM grant or compiler-image promotion has been enabled.
Production still requires reviewed image/runtime configuration and exact-version
Artifact read permissions; existing source-upload permissions do not establish these. The maintained
[Artifact overview](../../docs/community-architecture.md#artifacts-and-release-recovery) records verification limits.

### Opt-in GitHub Artifact runtime configuration

The GitHub workflow reads the optional environment variable `STUDIO_ARTIFACT_API_ORIGIN`
into `OPEN_GEO_OBSERVABLE_ARTIFACT_API_ORIGIN`. An unset variable leaves the resolver
unconfigured. Use a reviewed HTTPS API origin with no credentials, path, query or port;
job data never selects the destination. No variable is installed by this source change.

The IAM entrypoint accepts `OPEN_GEO_GITHUB_ARTIFACT_INPUT_ORGANIZATIONS` as a JSON array
of up to twelve unique account UUIDs. Omission or an empty array adds no grant. The
optional `AccountArtifactInputs` policy permits only `s3:GetObjectVersion` on
`source.opengeo.tools/organizations/<account>/projects/*/artifacts/*/uploads/*/map.html`.
It grants neither listing nor current-object reads, writes, deletes or publication
permission. Existing constrained KMS access is reused. The lease API remains responsible
for actor, tenant, live lease and upstream authorization on each pin.

Activation requires the reviewed compiler/runtime SHA and image, migration 0114,
explicit API `publication_artifact_builds_enabled`, scoped IAM grants, and the origin
variable as one reviewed release. The isolated EC2 coordinator still needs a private
API network path; do not enable public egress merely to reuse the GitHub configuration.
Local synthesis does not prove deployed IAM or network connectivity.
