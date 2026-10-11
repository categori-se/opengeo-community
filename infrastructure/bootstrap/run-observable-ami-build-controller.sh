#!/usr/bin/env bash
set -euo pipefail
umask 0077

readonly WORK_ROOT=/opt/opengeo-build

require_match() {
  local value="$1"
  local pattern="$2"
  local label="$3"
  if [[ ! "$value" =~ $pattern ]]; then
    echo "$label is invalid" >&2
    exit 1
  fi
}

archive_has_safe_members() {
  local path="$1"
  local member
  while IFS= read -r member; do
    case "$member" in
      ""|/*|../*|*/../*|*/..)
        echo "Archive contains an unsafe member: $(basename "$path")" >&2
        return 1
        ;;
    esac
  done < <(tar --list --file "$path")
}

require_match "${OPEN_GEO_RELEASE_ID:-}" '^[0-9]{14}-[0-9a-f]{12}$' OPEN_GEO_RELEASE_ID
require_match "${OPEN_GEO_ARTIFACT_BUCKET:-}" '^opengeo-dev-build-222222222222-us-east-1$' OPEN_GEO_ARTIFACT_BUCKET
require_match "${OPEN_GEO_S3_PREFIX:-}" '^observable-runner/[0-9]{14}-[0-9a-f]{12}$' OPEN_GEO_S3_PREFIX
require_match "${OPEN_GEO_SOURCE_AMI_ID:-}" '^ami-[0-9a-f]{17}$' OPEN_GEO_SOURCE_AMI_ID
require_match "${OPEN_GEO_SUBNET_ID:-}" '^subnet-[0-9a-f]{17}$' OPEN_GEO_SUBNET_ID
require_match "${OPEN_GEO_SECURITY_GROUP_ID:-}" '^sg-[0-9a-f]{17}$' OPEN_GEO_SECURITY_GROUP_ID
require_match "${OPEN_GEO_KMS_KEY_ARN:-}" '^arn:aws:kms:us-east-1:222222222222:key/85127539-71a1-4002-a1b5-e523a945ae91$' OPEN_GEO_KMS_KEY_ARN
require_match "${OPEN_GEO_ECR_REPOSITORY_URI:-}" '^222222222222\.dkr\.ecr\.us-east-1\.amazonaws\.com/opengeo/observable-builder$' OPEN_GEO_ECR_REPOSITORY_URI
if [[ "$OPEN_GEO_S3_PREFIX" != "observable-runner/$OPEN_GEO_RELEASE_ID" ]]; then
  echo "S3 prefix is not bound to the release ID" >&2
  exit 1
fi

readonly RELEASE_ROOT="$WORK_ROOT/releases/$OPEN_GEO_RELEASE_ID"
readonly INPUT_DIR="$RELEASE_ROOT/input"
readonly SOURCE_DIR="$RELEASE_ROOT/source"
readonly TOOLS_DIR="$RELEASE_ROOT/tools"
readonly RESULTS_DIR="$RELEASE_ROOT/results"
export HOME=/root
install -d -m 0700 "$INPUT_DIR" "$SOURCE_DIR" "$TOOLS_DIR" "$RESULTS_DIR"
for directory in "$INPUT_DIR" "$SOURCE_DIR" "$TOOLS_DIR" "$RESULTS_DIR"; do
  find "$directory" -mindepth 1 -delete
done
exec > >(tee -a "$RESULTS_DIR/controller.log") 2>&1

upload_results() {
  local exit_code="$?"
  trap - EXIT
  printf '{"schemaVersion":"opengeo.observable-runner-controller-status.1.0.0","releaseId":"%s","exitCode":%d}\n' \
    "$OPEN_GEO_RELEASE_ID" "$exit_code" > "$RESULTS_DIR/controller-status.json"
  aws s3 sync "$RESULTS_DIR" \
    "s3://$OPEN_GEO_ARTIFACT_BUCKET/$OPEN_GEO_S3_PREFIX/results/" \
    --region us-east-1 --sse AES256 --no-progress || true
  exit "$exit_code"
}
trap upload_results EXIT

echo "Installing the bounded controller tool dependencies."
dnf install -y docker jq skopeo unzip tar gzip
dnf clean all
systemctl enable --now docker.service

echo "Downloading the immutable, versioned build inputs."
aws s3 sync \
  "s3://$OPEN_GEO_ARTIFACT_BUCKET/$OPEN_GEO_S3_PREFIX/input/" \
  "$INPUT_DIR/" --region us-east-1 --no-progress
(
  cd "$INPUT_DIR"
  sha256sum --check --strict controller-artifacts.sha256
)

echo "Unpacking the reviewed source bundle and pinned tools."
archive_member_is_unsafe="$(tar --list --file "$INPUT_DIR/controller-bundle.tar" \
  | awk '/^\// || /^\.\.\// || /\/\.\.\// || /\/\.\.$/ { print; exit }')"
if [[ -n "$archive_member_is_unsafe" ]]; then
  echo "Controller source bundle contains an unsafe member" >&2
  exit 1
fi
tar --extract --file "$INPUT_DIR/controller-bundle.tar" --directory "$SOURCE_DIR" \
  --no-same-owner --no-same-permissions
unzip -q "$INPUT_DIR/packer_1.16.0_linux_arm64.zip" -d "$TOOLS_DIR/packer"
install -d -m 0700 "$TOOLS_DIR/packer-plugins/github.com/hashicorp/amazon"
unzip -q "$INPUT_DIR/packer-plugin-amazon_1.8.2_linux_arm64.zip" \
  'packer-plugin-amazon_v1.8.2_x5.0_linux_arm64' \
  -d "$TOOLS_DIR/packer-plugins/github.com/hashicorp/amazon"
readonly PACKER_AMAZON_PLUGIN="$TOOLS_DIR/packer-plugins/github.com/hashicorp/amazon/packer-plugin-amazon_v1.8.2_x5.0_linux_arm64"
sha256sum "$PACKER_AMAZON_PLUGIN" | cut -d ' ' -f 1 | tr -d '\n' \
  > "${PACKER_AMAZON_PLUGIN}_SHA256SUM"
chmod 0500 "$TOOLS_DIR/packer/packer" "$PACKER_AMAZON_PLUGIN"
chmod 0400 "${PACKER_AMAZON_PLUGIN}_SHA256SUM"
install -d -m 0700 "$TOOLS_DIR/node"
tar --extract --xz --file "$INPUT_DIR/node-v24.19.0-linux-arm64.tar.xz" \
  --directory "$TOOLS_DIR/node" --strip-components=1 --no-same-owner --no-same-permissions
if [[ "$($TOOLS_DIR/node/bin/node --version)" != "v24.19.0" ]]; then
  echo "Controller Node.js version is not v24.19.0" >&2
  exit 1
fi
if [[ "$($TOOLS_DIR/packer/packer version | head -n 1)" != "Packer v1.16.0" ]]; then
  echo "Controller Packer version is not 1.16.0" >&2
  exit 1
fi
export PACKER_PLUGIN_PATH="$TOOLS_DIR/packer-plugins"
$TOOLS_DIR/packer/packer plugins installed | tee "$RESULTS_DIR/packer-plugins.txt"
if ! grep -Fq 'packer-plugin-amazon_v1.8.2_x5.0_linux_arm64' "$RESULTS_DIR/packer-plugins.txt"; then
  echo "Pinned Packer Amazon plugin is not installed" >&2
  exit 1
fi

echo "Building the native ARM64 compiler image from the reviewed context."
readonly COMPILER_TAG="opengeo-observable-builder:$OPEN_GEO_RELEASE_ID"
docker build --platform linux/arm64 --pull \
  --tag "$COMPILER_TAG" "$SOURCE_DIR/services/observable-builder"
docker_image_id="$(docker image inspect --format '{{.Id}}' "$COMPILER_TAG")"
require_match "$docker_image_id" '^sha256:[0-9a-f]{64}$' docker_image_id
docker image inspect "$docker_image_id" > "$RESULTS_DIR/compiler-image-inspect.json"
if [[ "$(jq -r '.[0].Architecture' "$RESULTS_DIR/compiler-image-inspect.json")" != "arm64" \
  || "$(jq -r '.[0].Config.User' "$RESULTS_DIR/compiler-image-inspect.json")" != "10001:10001" ]]; then
  echo "Compiler image identity is invalid" >&2
  exit 1
fi
skopeo copy "docker-daemon:$COMPILER_TAG" \
  "oci-archive:$INPUT_DIR/opengeo-observable-compiler.oci.tar:$COMPILER_TAG"
oci_manifest_digest="$(tar --extract --to-stdout \
  --file "$INPUT_DIR/opengeo-observable-compiler.oci.tar" index.json \
  | jq -r '.manifests[0].digest // empty')"
require_match "$oci_manifest_digest" '^sha256:[0-9a-f]{64}$' oci_manifest_digest
compiler_image_digest="$(tar --extract --to-stdout \
  --file "$INPUT_DIR/opengeo-observable-compiler.oci.tar" \
  "blobs/sha256/${oci_manifest_digest#sha256:}" \
  | jq -r '.config.digest // empty')"
require_match "$compiler_image_digest" '^sha256:[0-9a-f]{64}$' compiler_image_digest
tar --extract --to-stdout --file "$INPUT_DIR/opengeo-observable-compiler.oci.tar" \
  "blobs/sha256/${compiler_image_digest#sha256:}" \
  > "$RESULTS_DIR/compiler-oci-config.json"
if [[ "sha256:$(sha256sum "$RESULTS_DIR/compiler-oci-config.json" | cut -d ' ' -f 1)" \
    != "$compiler_image_digest" \
  || "$(jq -r '.architecture' "$RESULTS_DIR/compiler-oci-config.json")" != "arm64" \
  || "$(jq -r '.config.User' "$RESULTS_DIR/compiler-oci-config.json")" != "10001:10001" ]]; then
  echo "Compiler OCI config identity is invalid" >&2
  exit 1
fi

echo "Running the fail-fast offline compiler security gate before Packer."
readonly COMPILER_PREFLIGHT_DIR="$RELEASE_ROOT/compiler-preflight"
install -d -m 0700 "$COMPILER_PREFLIGHT_DIR/cache" "$COMPILER_PREFLIGHT_DIR/oci"
archive_has_safe_members "$INPUT_DIR/trivy-cache.tar"
archive_has_safe_members "$INPUT_DIR/opengeo-observable-compiler.oci.tar"
tar --extract --file "$INPUT_DIR/trivy-cache.tar" \
  --directory "$COMPILER_PREFLIGHT_DIR/cache" --no-same-owner --no-same-permissions
tar --extract --file "$INPUT_DIR/opengeo-observable-compiler.oci.tar" \
  --directory "$COMPILER_PREFLIGHT_DIR/oci" --no-same-owner --no-same-permissions
install -m 0500 "$INPUT_DIR/trivy-linux-arm64" "$COMPILER_PREFLIGHT_DIR/trivy"
trivy_db_version="$(jq -r '.Version // empty' "$COMPILER_PREFLIGHT_DIR/cache/db/metadata.json")"
trivy_db_next_update="$(jq -r '.NextUpdate // empty' "$COMPILER_PREFLIGHT_DIR/cache/db/metadata.json")"
if [[ "$trivy_db_version" != "2" || -z "$trivy_db_next_update" ]] \
  || ! trivy_db_next_update_epoch="$(date --date "$trivy_db_next_update" +%s)" \
  || (( trivy_db_next_update_epoch < $(date +%s) )); then
  echo "Compiler preflight Trivy database is invalid or stale" >&2
  exit 1
fi
readonly PREFLIGHT_TRIVY=(
  "$COMPILER_PREFLIGHT_DIR/trivy"
  --cache-dir "$COMPILER_PREFLIGHT_DIR/cache"
  --offline-scan
  --skip-db-update
)
"${PREFLIGHT_TRIVY[@]}" image --input "$COMPILER_PREFLIGHT_DIR/oci" \
  --scanners vuln --format cyclonedx \
  --output "$RESULTS_DIR/compiler-preflight-sbom.cdx.json"
"${PREFLIGHT_TRIVY[@]}" image --input "$COMPILER_PREFLIGHT_DIR/oci" \
  --scanners vuln --severity HIGH,CRITICAL --format json \
  --output "$RESULTS_DIR/compiler-preflight-vulnerabilities.json"
compiler_high_critical_count="$(jq \
  '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")] | length' \
  "$RESULTS_DIR/compiler-preflight-vulnerabilities.json")"
find "$COMPILER_PREFLIGHT_DIR" -mindepth 1 -delete
rmdir "$COMPILER_PREFLIGHT_DIR"
if [[ "$compiler_high_critical_count" != "0" ]]; then
  echo "Compiler preflight found $compiler_high_critical_count HIGH or CRITICAL vulnerabilities" >&2
  exit 1
fi

echo "Preparing and validating the exact Packer variable set."
cat > "$WORK_ROOT/ami-build-inputs.json" <<EOF
{
  "schemaVersion": "opengeo.observable-runner-ami-inputs.1.0.0",
  "region": "us-east-1",
  "sourceAmiId": "$OPEN_GEO_SOURCE_AMI_ID",
  "subnetId": "$OPEN_GEO_SUBNET_ID",
  "securityGroupId": "$OPEN_GEO_SECURITY_GROUP_ID",
  "kmsKeyArn": "$OPEN_GEO_KMS_KEY_ARN",
  "releaseId": "$OPEN_GEO_RELEASE_ID",
  "coordinatorArchivePath": "$INPUT_DIR/observable-coordinator.tar",
  "nodeArchivePath": "$INPUT_DIR/node-v24.19.0-linux-arm64.tar.xz",
  "cloudWatchAgentPackagePath": "$INPUT_DIR/amazon-cloudwatch-agent.ubuntu.arm64.deb",
  "compilerOciArchivePath": "$INPUT_DIR/opengeo-observable-compiler.oci.tar",
  "compilerImageDigest": "$compiler_image_digest",
  "trivyBinaryPath": "$INPUT_DIR/trivy-linux-arm64",
  "trivyCacheArchivePath": "$INPUT_DIR/trivy-cache.tar"
}
EOF
$TOOLS_DIR/node/bin/node \
  "$SOURCE_DIR/services/observable-coordinator/scripts/prepare-ami-build.mjs" \
  "$WORK_ROOT/ami-build-inputs.json" "$RESULTS_DIR/runner.pkrvars.json"
cp "$WORK_ROOT/ami-build-inputs.json" "$RESULTS_DIR/ami-build-inputs.json"
$TOOLS_DIR/packer/packer fmt -check \
  "$SOURCE_DIR/services/observable-coordinator/ami/runner.pkr.hcl"
$TOOLS_DIR/packer/packer validate \
  -var-file="$RESULTS_DIR/runner.pkrvars.json" \
  "$SOURCE_DIR/services/observable-coordinator/ami/runner.pkr.hcl"

echo "Baking the private ARM64 runner AMI."
$TOOLS_DIR/packer/packer build -color=false -on-error=cleanup \
  -var-file="$RESULTS_DIR/runner.pkrvars.json" \
  "$SOURCE_DIR/services/observable-coordinator/ami/runner.pkr.hcl"

ami_id="$(jq -r --arg region us-east-1 \
  '.builds[0].artifact_id | select(startswith($region + ":")) | split(":")[1]' \
  "$RESULTS_DIR/packer-manifest.json")"
require_match "$ami_id" '^ami-[0-9a-f]{17}$' ami_id
aws ec2 describe-images --region us-east-1 --image-ids "$ami_id" \
  > "$RESULTS_DIR/ami-description.json"
if [[ "$(jq -r '.Images[0].Architecture' "$RESULTS_DIR/ami-description.json")" != "arm64" \
  || "$(jq -r '.Images[0].State' "$RESULTS_DIR/ami-description.json")" != "available" ]]; then
  echo "Baked AMI is not an available ARM64 image" >&2
  exit 1
fi

echo "Publishing the exact reviewed compiler image to the private repository."
registry="${OPEN_GEO_ECR_REPOSITORY_URI%%/*}"
aws ecr get-login-password --region us-east-1 \
  | skopeo login --username AWS --password-stdin "$registry"
repository_tag="$OPEN_GEO_ECR_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
skopeo copy --digestfile "$RESULTS_DIR/ecr-manifest-digest.txt" \
  "docker-daemon:$COMPILER_TAG" "docker://$repository_tag"

jq -n \
  --arg releaseId "$OPEN_GEO_RELEASE_ID" \
  --arg amiId "$ami_id" \
  --arg compilerImageDigest "$compiler_image_digest" \
  --arg dockerImageId "$docker_image_id" \
  --arg compilerRepositoryTag "$repository_tag" \
  --arg ecrManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/ecr-manifest-digest.txt")" \
  '{schemaVersion:"opengeo.observable-runner-controller-result.1.0.0",releaseId:$releaseId,amiId:$amiId,compilerImageDigest:$compilerImageDigest,dockerImageId:$dockerImageId,compilerRepositoryTag:$compilerRepositoryTag,ecrManifestDigest:$ecrManifestDigest}' \
  > "$RESULTS_DIR/controller-result.json"
echo "AMI build completed: $ami_id"
