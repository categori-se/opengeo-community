#!/usr/bin/env bash
set -euo pipefail
umask 0077

readonly WORK_ROOT=/opt/opengeo-build
readonly REGION=us-east-1
readonly ACCOUNT_ID=222222222222
readonly SCANNER_PREFIX=observable-runner/20260824180734-ba4c78d2752c/input
readonly SCANNER_BINARY_VERSION_ID=TIFae5c2gi6gTAeazfKM0gJ6P_6RtkcV
readonly SCANNER_BINARY_SHA256=829aca12d32bc3cee0b01cbb76197e9377790c6b78eb67a703d8033bcf7b3c3d

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
require_match "${OPEN_GEO_S3_PREFIX:-}" '^container-images/[0-9]{14}-[0-9a-f]{12}$' OPEN_GEO_S3_PREFIX
require_match "${OPEN_GEO_API_REPOSITORY_URI:-}" '^222222222222\.dkr\.ecr\.us-east-1\.amazonaws\.com/opengeo/dev/api$' OPEN_GEO_API_REPOSITORY_URI
readonly BUILD_TARGETS="${OPEN_GEO_BUILD_TARGETS:-api,builder}"
case "$BUILD_TARGETS" in
  api)
    readonly BUILD_BUILDER=false
    readonly BUILD_WORKER=false
    ;;
  api,worker)
    readonly BUILD_BUILDER=false
    readonly BUILD_WORKER=true
    require_match "${OPEN_GEO_WORKER_REPOSITORY_URI:-}" '^222222222222\.dkr\.ecr\.us-east-1\.amazonaws\.com/opengeo/dev/gis-worker$' OPEN_GEO_WORKER_REPOSITORY_URI
    ;;
  api,builder)
    readonly BUILD_BUILDER=true
    readonly BUILD_WORKER=false
    require_match "${OPEN_GEO_BUILDER_REPOSITORY_URI:-}" '^222222222222\.dkr\.ecr\.us-east-1\.amazonaws\.com/opengeo/observable-builder$' OPEN_GEO_BUILDER_REPOSITORY_URI
    ;;
  *)
    echo "OPEN_GEO_BUILD_TARGETS must be exactly api, api,builder, or api,worker" >&2
    exit 1
    ;;
esac
readonly RUNTIME_BACKPORTS="${OPEN_GEO_RUNTIME_BACKPORTS:-false}"
case "$RUNTIME_BACKPORTS" in
  false) ;;
  true)
    if [[ "$BUILD_TARGETS" != "api" ]]; then
      echo "Runtime backport acceptance requires the API-only target" >&2
      exit 1
    fi
    ;;
  *) echo "OPEN_GEO_RUNTIME_BACKPORTS must be true or false" >&2; exit 1 ;;
esac
if [[ "$OPEN_GEO_S3_PREFIX" != "container-images/$OPEN_GEO_RELEASE_ID" ]]; then
  echo "S3 prefix is not bound to the release ID" >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  if [[ "$#" == 1 && "$1" == "--validate-inputs" ]]; then
    printf 'Validated container build input scope: %s\n' "$BUILD_TARGETS"
    exit 0
  fi
  echo "Only --validate-inputs is accepted; omit arguments for an authorized build" >&2
  exit 1
fi

readonly RELEASE_ROOT="$WORK_ROOT/releases/$OPEN_GEO_RELEASE_ID"
readonly INPUT_DIR="$RELEASE_ROOT/input"
readonly SOURCE_DIR="$RELEASE_ROOT/source"
readonly RESULTS_DIR="$RELEASE_ROOT/results"
readonly SCANNER_DIR="$RELEASE_ROOT/scanner"
readonly DOCKER_CONFIG_DIR="$RELEASE_ROOT/docker-config"
install -d -m 0700 \
  "$INPUT_DIR" "$SOURCE_DIR" "$RESULTS_DIR" "$SCANNER_DIR" "$DOCKER_CONFIG_DIR"
for directory in \
  "$INPUT_DIR" "$SOURCE_DIR" "$RESULTS_DIR" "$SCANNER_DIR" "$DOCKER_CONFIG_DIR"; do
  find "$directory" -mindepth 1 -delete
done
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
exec > >(tee -a "$RESULTS_DIR/controller.log") 2>&1

upload_results() {
  local exit_code="$?"
  trap - EXIT
  find "$DOCKER_CONFIG_DIR" -mindepth 1 -delete || true
  printf '{"schemaVersion":"opengeo.container-build-controller-status.1.0.0","releaseId":"%s","exitCode":%d}\n' \
    "$OPEN_GEO_RELEASE_ID" "$exit_code" > "$RESULTS_DIR/controller-status.json"
  aws s3 sync "$RESULTS_DIR" \
    "s3://$OPEN_GEO_ARTIFACT_BUCKET/$OPEN_GEO_S3_PREFIX/results/" \
    --region "$REGION" --sse AES256 --no-progress || true
  exit "$exit_code"
}
trap upload_results EXIT

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required on the transient build controller" >&2
  exit 1
fi
if [[ -s "$WORK_ROOT/aws-cli-version.txt" ]]; then
  cp "$WORK_ROOT/aws-cli-version.txt" "$RESULTS_DIR/aws-cli-version.txt"
else
  aws --version 2>&1 | tee "$RESULTS_DIR/aws-cli-version.txt"
fi
if [[ ! -s "$RESULTS_DIR/aws-cli-version.txt" ]]; then
  echo "AWS CLI version receipt is empty" >&2
  exit 1
fi

echo "Installing the bounded native ARM64 controller dependencies."
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # Canonical's EC2-local ARM64 mirror has returned sustained 503 responses
  # during otherwise healthy private builds. Use the signed global mirror so a
  # regional cache outage cannot strand a paid transient controller.
  while IFS= read -r source_file; do
    sed --in-place --regexp-extended \
      's#https?://[a-z0-9.-]+\.ec2\.ports\.ubuntu\.com/ubuntu-ports#http://ports.ubuntu.com/ubuntu-ports#g' \
      "$source_file"
  done < <(find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -print)
  apt-get -o Acquire::Retries=5 update
  apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    docker.io jq tar ca-certificates curl python3
  rm -rf /var/lib/apt/lists/*
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y docker jq tar gzip curl python3
  dnf clean all
else
  echo "Unsupported controller distribution" >&2
  exit 1
fi
systemctl enable --now docker.service

architecture="$(uname -m)"
if [[ "$architecture" != "aarch64" ]]; then
  echo "Build controller architecture is not native ARM64" >&2
  exit 1
fi

echo "Downloading and checking the exact source build input."
aws s3 sync \
  "s3://$OPEN_GEO_ARTIFACT_BUCKET/$OPEN_GEO_S3_PREFIX/input/" \
  "$INPUT_DIR/" --region "$REGION" --no-progress
(
  cd "$INPUT_DIR"
  sha256sum --check --strict container-build-inputs.sha256
)
archive_has_safe_members "$INPUT_DIR/opengeo-container-contexts.tar"
tar --extract --file "$INPUT_DIR/opengeo-container-contexts.tar" \
  --directory "$SOURCE_DIR" --no-same-owner --no-same-permissions
chmod --recursive u=rwX,go=rX "$SOURCE_DIR"

echo "Downloading the exact previously verified ARM64 Trivy binary."
aws s3api get-object \
  --bucket "$OPEN_GEO_ARTIFACT_BUCKET" \
  --key "$SCANNER_PREFIX/trivy-linux-arm64" \
  --version-id "$SCANNER_BINARY_VERSION_ID" \
  --region "$REGION" \
  "$SCANNER_DIR/trivy" >/dev/null
printf '%s  %s\n' "$SCANNER_BINARY_SHA256" "$SCANNER_DIR/trivy" | sha256sum --check --strict
chmod 0500 "$SCANNER_DIR/trivy"
"$SCANNER_DIR/trivy" --version > "$RESULTS_DIR/trivy-version.txt"
"$SCANNER_DIR/trivy" --cache-dir "$SCANNER_DIR/cache" image --download-db-only
cp "$SCANNER_DIR/cache/db/metadata.json" "$RESULTS_DIR/trivy-db-metadata.json"

echo "Building the reviewed images on native ARM64."
readonly API_TAG="opengeo-api:$OPEN_GEO_RELEASE_ID"
if $BUILD_BUILDER; then
  readonly BUILDER_TAG="opengeo-observable-builder:$OPEN_GEO_RELEASE_ID"
  docker build --platform linux/arm64 --pull \
    --tag "$BUILDER_TAG" "$SOURCE_DIR/services/observable-builder"
fi
api_build_options=(--pull)
if $RUNTIME_BACKPORTS; then
  readonly RUNTIME_TAG="opengeo-runtime:$OPEN_GEO_RELEASE_ID"
  timeout --kill-after=30s 20m docker build --platform linux/arm64 --pull \
    --file "$SOURCE_DIR/services/api/Dockerfile.runtime-backports" \
    --tag "$RUNTIME_TAG" "$SOURCE_DIR/services/api"
  runtime_config_digest="$(docker image inspect --format '{{.Id}}' "$RUNTIME_TAG")"
  require_match "$runtime_config_digest" '^sha256:[0-9a-f]{64}$' runtime_config_digest
  docker image inspect "$RUNTIME_TAG" > "$RESULTS_DIR/runtime-image-inspect.json"
  if [[ "$(jq -r '.[0].Architecture' "$RESULTS_DIR/runtime-image-inspect.json")" != "arm64" ]]; then
    echo "Runtime candidate architecture differs from native controller" >&2
    exit 1
  fi
  # The local tag is bound to this isolated release; do not pull an unrelated registry tag.
  api_build_options=(--pull=false --build-arg "API_RUNTIME_IMAGE=$RUNTIME_TAG")
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 10001:10001 --memory 256m --cpus 1 --pids-limit 64 \
    --entrypoint python "$runtime_config_digest" -c \
    'import pathlib; print(pathlib.Path("/usr/local/share/opengeo-runtime/receipt.json").read_text())' \
    > "$RESULTS_DIR/runtime-backport-receipt.json"
fi
timeout --kill-after=30s 20m docker build --platform linux/arm64 "${api_build_options[@]}" \
  --file "$SOURCE_DIR/services/api/Dockerfile.lambda" \
  --tag "$API_TAG" "$SOURCE_DIR/services/api"
if $RUNTIME_BACKPORTS; then
  if [[ "$(docker image inspect --format '{{.Id}}' "$RUNTIME_TAG")" != "$runtime_config_digest" ]]; then
    echo "Runtime tag changed during API build" >&2
    exit 1
  fi
fi
if $BUILD_WORKER; then
  readonly WORKER_TAG="opengeo-gis-worker:$OPEN_GEO_RELEASE_ID"
  docker build --platform linux/arm64 --pull \
    --tag "$WORKER_TAG" "$SOURCE_DIR/services/worker"
fi

api_config_digest="$(docker image inspect --format '{{.Id}}' "$API_TAG")"
require_match "$api_config_digest" '^sha256:[0-9a-f]{64}$' api_config_digest
docker image inspect "$API_TAG" > "$RESULTS_DIR/api-image-inspect.json"
if [[ "$(jq -r '.[0].Architecture' "$RESULTS_DIR/api-image-inspect.json")" != "arm64" \
  || "$(jq -r '.[0].Config.User' "$RESULTS_DIR/api-image-inspect.json")" != "10001:10001" ]]; then
  echo "Built API image architecture or non-root identity is invalid" >&2
  exit 1
fi
if $BUILD_BUILDER; then
  builder_config_digest="$(docker image inspect --format '{{.Id}}' "$BUILDER_TAG")"
  require_match "$builder_config_digest" '^sha256:[0-9a-f]{64}$' builder_config_digest
  docker image inspect "$BUILDER_TAG" > "$RESULTS_DIR/builder-image-inspect.json"
  if [[ "$(jq -r '.[0].Architecture' "$RESULTS_DIR/builder-image-inspect.json")" != "arm64" \
    || "$(jq -r '.[0].Config.User' "$RESULTS_DIR/builder-image-inspect.json")" != "10001:10001" ]]; then
    echo "Built builder image architecture or non-root identity is invalid" >&2
    exit 1
  fi
  docker run --rm --entrypoint /nodejs/bin/node "$BUILDER_TAG" --version \
    > "$RESULTS_DIR/builder-smoke.txt"
fi
docker run --rm --entrypoint python "$API_TAG" -c \
  'from opengeo_api.lambda_handler import handler; print("opengeo-api-import-ok")' \
  > "$RESULTS_DIR/api-smoke.txt"
if $BUILD_WORKER; then
  worker_config_digest="$(docker image inspect --format '{{.Id}}' "$WORKER_TAG")"
  require_match "$worker_config_digest" '^sha256:[0-9a-f]{64}$' worker_config_digest
  docker image inspect "$WORKER_TAG" > "$RESULTS_DIR/worker-image-inspect.json"
  if [[ "$(jq -r '.[0].Architecture' "$RESULTS_DIR/worker-image-inspect.json")" != "arm64" \
    || "$(jq -r '.[0].Config.User' "$RESULTS_DIR/worker-image-inspect.json")" != "10001:10001" ]]; then
    echo "Built worker image architecture or non-root identity is invalid" >&2
    exit 1
  fi
  # Exercise the installed GIS/OCR/PDF and EICAR controls without network or credentials.
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --memory 4g --cpus 2 --pids-limit 256 \
    --tmpfs /tmp/opengeo-worker:rw,noexec,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700 \
    --entrypoint python3 "$WORKER_TAG" -c \
    'import runpy; runpy.run_path("scripts/verify-toolchain.py", run_name="__main__"); print("opengeo-worker-toolchain-ok")' \
    > "$RESULTS_DIR/worker-smoke.txt"
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint clamscan "$WORKER_TAG" --version \
    > "$RESULTS_DIR/worker-clamav-version.txt"
fi

echo "Exporting and scanning the exact OCI images before publication."
docker image save --output "$RELEASE_ROOT/api.image.tar" "$API_TAG"
if $RUNTIME_BACKPORTS; then
  # Preserve the exact candidate even when the unchanged vulnerability gate rejects it.
  # This is a private evidence artifact, not a published release image.
  if ! timeout --kill-after=10s 2m gzip -1 -c "$RELEASE_ROOT/api.image.tar" \
    > "$RESULTS_DIR/api-runtime-candidate.image.tar.gz"; then
    rm -f "$RESULTS_DIR/api-runtime-candidate.image.tar.gz"
    echo "Runtime evidence compression did not complete within its budget" >&2
    exit 1
  fi
  if [[ "$(stat -c %s "$RESULTS_DIR/api-runtime-candidate.image.tar.gz")" -gt 268435456 ]]; then
    rm "$RESULTS_DIR/api-runtime-candidate.image.tar.gz"
    echo "Runtime evidence archive exceeds the 256 MiB upload budget" >&2
    exit 1
  fi
  (cd "$RESULTS_DIR" && sha256sum api-runtime-candidate.image.tar.gz) \
    > "$RESULTS_DIR/api-runtime-candidate.sha256"
  printf '%s\n' "$architecture" > "$RESULTS_DIR/native-controller-architecture.txt"
fi

scan_image() {
  local name="$1"
  local archive="$2"
  archive_has_safe_members "$archive"
  "$SCANNER_DIR/trivy" --cache-dir "$SCANNER_DIR/cache" \
    image --skip-db-update --offline-scan --input "$archive" \
    --scanners vuln --format cyclonedx \
    --output "$RESULTS_DIR/${name}-sbom.cdx.json"
  "$SCANNER_DIR/trivy" --cache-dir "$SCANNER_DIR/cache" \
    image --skip-db-update --offline-scan --input "$archive" \
    --scanners vuln --severity HIGH,CRITICAL --format json \
    --output "$RESULTS_DIR/${name}-vulnerabilities.json"
  jq -e '.Results | type == "array" and length > 0 and all(.[]; type == "object")' \
    "$RESULTS_DIR/${name}-vulnerabilities.json" >/dev/null
  local findings
  findings="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")] | length' \
    "$RESULTS_DIR/${name}-vulnerabilities.json")"
  if [[ "$findings" != "0" ]]; then
    echo "$name image contains $findings HIGH or CRITICAL vulnerabilities" >&2
    exit 1
  fi
}
if $BUILD_BUILDER; then
  docker image save --output "$RELEASE_ROOT/builder.image.tar" "$BUILDER_TAG"
  scan_image builder "$RELEASE_ROOT/builder.image.tar"
fi
scan_image api "$RELEASE_ROOT/api.image.tar"
if $BUILD_WORKER; then
  docker image save --output "$RELEASE_ROOT/worker.image.tar" "$WORKER_TAG"
  scan_image worker "$RELEASE_ROOT/worker.image.tar"
  # Full-image scanners omit statically bundled native dependencies. Inspect
  # this exact image and retain a separate inventory/advisory matching gate.
  bash "$SOURCE_DIR/services/worker/scripts/install-native-scanner.sh" "$SCANNER_DIR/native"
  python3 "$SOURCE_DIR/services/worker/scripts/scan-native-libraries.py" \
    --image "$worker_config_digest" --grype "$SCANNER_DIR/native/grype" \
    --cache-dir "$SCANNER_DIR/native/cache" --update-db \
    --output "$RESULTS_DIR/worker-native-scan"
fi

echo "Publishing the security-gated image targets to their exact private repositories."
registry="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$registry"
docker tag "$API_TAG" "$OPEN_GEO_API_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
if $BUILD_BUILDER; then
  docker tag "$BUILDER_TAG" "$OPEN_GEO_BUILDER_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
  docker push "$OPEN_GEO_BUILDER_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
fi
docker push "$OPEN_GEO_API_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
if $BUILD_WORKER; then
  docker tag "$WORKER_TAG" "$OPEN_GEO_WORKER_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
  docker push "$OPEN_GEO_WORKER_REPOSITORY_URI:$OPEN_GEO_RELEASE_ID"
fi

read_ecr_manifest_digest() {
  local repository="$1"
  local attempt
  local response
  local digest
  for attempt in $(seq 1 12); do
    response="$(aws ecr describe-images --repository-name "$repository" \
      --image-ids "imageTag=$OPEN_GEO_RELEASE_ID" --region "$REGION" \
      --output json)"
    digest="$(jq -er '.imageDetails[0].imageDigest // empty' <<<"$response" || true)"
    if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$digest"
      return 0
    fi
    sleep 5
  done
  echo "ECR did not return a valid immutable manifest digest for $repository" >&2
  return 1
}

read_ecr_manifest_digest opengeo/dev/api \
  > "$RESULTS_DIR/api-ecr-manifest-digest.txt"
require_match "$(tr -d '\r\n' < "$RESULTS_DIR/api-ecr-manifest-digest.txt")" \
  '^sha256:[0-9a-f]{64}$' api_ecr_manifest_digest
if $BUILD_BUILDER; then
  read_ecr_manifest_digest opengeo/observable-builder \
    > "$RESULTS_DIR/builder-ecr-manifest-digest.txt"
  require_match "$(tr -d '\r\n' < "$RESULTS_DIR/builder-ecr-manifest-digest.txt")" \
    '^sha256:[0-9a-f]{64}$' builder_ecr_manifest_digest
fi
if $BUILD_WORKER; then
  read_ecr_manifest_digest opengeo/dev/gis-worker \
    > "$RESULTS_DIR/worker-ecr-manifest-digest.txt"
  require_match "$(tr -d '\r\n' < "$RESULTS_DIR/worker-ecr-manifest-digest.txt")" \
    '^sha256:[0-9a-f]{64}$' worker_ecr_manifest_digest
fi

wait_for_ecr_scan_gate() {
  local repository="$1"
  local result_path="$2"
  local attempt
  local response
  local status
  local findings
  for attempt in $(seq 1 60); do
    response="$(aws ecr describe-image-scan-findings \
      --repository-name "$repository" \
      --image-id "imageTag=$OPEN_GEO_RELEASE_ID" \
      --region "$REGION" --output json 2>/dev/null || true)"
    status="$(jq -r '.imageScanStatus.status // "PENDING"' <<<"$response")"
    if [[ "$status" == "COMPLETE" ]]; then
      printf '%s\n' "$response" > "$result_path"
      jq -e '((.nextToken // "") == "") and (.imageScanFindings.findings | type == "array")' \
        <<<"$response" >/dev/null
      findings="$(jq '[([.imageScanFindings.findings[] | select(.severity == "HIGH" or .severity == "CRITICAL")] | length), ((.imageScanFindings.findingSeverityCounts.HIGH // 0) + (.imageScanFindings.findingSeverityCounts.CRITICAL // 0))] | max' <<<"$response")"
      if [[ "$findings" != "0" ]]; then
        echo "$repository contains $findings ECR HIGH or CRITICAL findings" >&2
        return 1
      fi
      return 0
    fi
    if [[ "$status" == "FAILED" || "$status" == "UNSUPPORTED_IMAGE" || "$status" == "FINDINGS_UNAVAILABLE" ]]; then
      echo "ECR scan failed closed for $repository with status $status" >&2
      return 1
    fi
    sleep 5
  done
  echo "ECR scan did not complete for $repository" >&2
  return 1
}
wait_for_ecr_scan_gate opengeo/dev/api "$RESULTS_DIR/api-ecr-scan.json"
if $BUILD_BUILDER; then
  wait_for_ecr_scan_gate opengeo/observable-builder "$RESULTS_DIR/builder-ecr-scan.json"
fi
if $BUILD_WORKER; then
  wait_for_ecr_scan_gate opengeo/dev/gis-worker "$RESULTS_DIR/worker-ecr-scan.json"
fi

if $BUILD_BUILDER; then
  jq -n \
    --arg releaseId "$OPEN_GEO_RELEASE_ID" \
    --arg architecture "$architecture" \
    --arg buildTargets "$BUILD_TARGETS" \
    --arg builderConfigDigest "$builder_config_digest" \
    --arg builderManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/builder-ecr-manifest-digest.txt")" \
    --arg apiConfigDigest "$api_config_digest" \
    --arg apiManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/api-ecr-manifest-digest.txt")" \
    '{schemaVersion:"opengeo.container-build-result.1.0.0",releaseId:$releaseId,architecture:$architecture,buildTargets:$buildTargets,builder:{configDigest:$builderConfigDigest,ecrManifestDigest:$builderManifestDigest,highCriticalFindings:0,ecrHighCriticalFindings:0},api:{configDigest:$apiConfigDigest,ecrManifestDigest:$apiManifestDigest,highCriticalFindings:0,ecrHighCriticalFindings:0}}' \
    > "$RESULTS_DIR/container-build-result.json"
elif $BUILD_WORKER; then
  jq -n \
    --arg releaseId "$OPEN_GEO_RELEASE_ID" \
    --arg architecture "$architecture" \
    --arg buildTargets "$BUILD_TARGETS" \
    --arg workerConfigDigest "$worker_config_digest" \
    --arg workerManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/worker-ecr-manifest-digest.txt")" \
    --arg apiConfigDigest "$api_config_digest" \
    --arg apiManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/api-ecr-manifest-digest.txt")" \
    '{schemaVersion:"opengeo.container-build-result.1.1.0",releaseId:$releaseId,architecture:$architecture,buildTargets:$buildTargets,builder:null,api:{configDigest:$apiConfigDigest,ecrManifestDigest:$apiManifestDigest,highCriticalFindings:0,ecrHighCriticalFindings:0},worker:{configDigest:$workerConfigDigest,ecrManifestDigest:$workerManifestDigest,highCriticalFindings:0,ecrHighCriticalFindings:0,toolchainSmokePassed:true}}' \
    > "$RESULTS_DIR/container-build-result.json"
else
  jq -n \
    --arg releaseId "$OPEN_GEO_RELEASE_ID" \
    --arg architecture "$architecture" \
    --arg buildTargets "$BUILD_TARGETS" \
    --arg apiConfigDigest "$api_config_digest" \
    --arg apiManifestDigest "$(tr -d '\n' < "$RESULTS_DIR/api-ecr-manifest-digest.txt")" \
    '{schemaVersion:"opengeo.container-build-result.1.0.0",releaseId:$releaseId,architecture:$architecture,buildTargets:$buildTargets,builder:null,api:{configDigest:$apiConfigDigest,ecrManifestDigest:$apiManifestDigest,highCriticalFindings:0,ecrHighCriticalFindings:0}}' \
    > "$RESULTS_DIR/container-build-result.json"
fi
echo "Native ARM64 container build completed."
