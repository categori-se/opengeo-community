#!/usr/bin/env bash
set -euo pipefail
umask 0077

readonly COORDINATOR_ARCHIVE=/tmp/opengeo-observable-coordinator.tar
readonly NODE_ARCHIVE=/tmp/opengeo-node-arm64.tar.xz
readonly CLOUDWATCH_AGENT_PACKAGE=/tmp/amazon-cloudwatch-agent.deb
readonly CLOUDWATCH_JMX_JAR=/opt/aws/amazon-cloudwatch-agent/bin/opentelemetry-jmx-metrics.jar
readonly -a GETTEXT_JAVA_ARCHIVES=(
  /usr/share/java/libintl-0.21.jar
  /usr/share/java/libintl.jar
  /usr/share/maven-repo/org/gnu/gettext/libintl/0.21/libintl-0.21.jar
  /usr/share/maven-repo/org/gnu/gettext/libintl/debian/libintl-debian.jar
)
readonly COMPILER_ARCHIVE=/tmp/opengeo-observable-compiler.oci.tar
readonly COMPILER_OCI_DIR=/tmp/opengeo-observable-compiler-oci
readonly TRIVY_BINARY=/tmp/trivy
readonly TRIVY_CACHE_ARCHIVE=/tmp/trivy-cache.tar
readonly TRIVY_CACHE=/tmp/opengeo-trivy-cache
readonly RUNTIME_HOME=/var/lib/opengeo-observable
readonly RUNTIME_DIR=/run/opengeo-observable

require_match() {
  local value="$1"
  local pattern="$2"
  local label="$3"
  if [[ ! "$value" =~ $pattern ]]; then
    echo "$label is invalid" >&2
    exit 1
  fi
}

require_match "${SOURCE_AMI_ID:-}" '^ami-[0-9a-f]{17}$' SOURCE_AMI_ID
require_match "${RELEASE_ID:-}" '^[0-9]{14}-[0-9a-f]{12}$' RELEASE_ID
require_match "${COORDINATOR_ARCHIVE_SHA256:-}" '^[0-9a-f]{64}$' COORDINATOR_ARCHIVE_SHA256
require_match "${NODE_ARCHIVE_SHA256:-}" '^[0-9a-f]{64}$' NODE_ARCHIVE_SHA256
require_match "${CLOUDWATCH_AGENT_PACKAGE_SHA256:-}" '^[0-9a-f]{64}$' CLOUDWATCH_AGENT_PACKAGE_SHA256
require_match "${COMPILER_OCI_ARCHIVE_SHA256:-}" '^[0-9a-f]{64}$' COMPILER_OCI_ARCHIVE_SHA256
require_match "${COMPILER_IMAGE_DIGEST:-}" '^sha256:[0-9a-f]{64}$' COMPILER_IMAGE_DIGEST
require_match "${TRIVY_BINARY_SHA256:-}" '^[0-9a-f]{64}$' TRIVY_BINARY_SHA256
require_match "${TRIVY_CACHE_ARCHIVE_SHA256:-}" '^[0-9a-f]{64}$' TRIVY_CACHE_ARCHIVE_SHA256
require_match "${INSTALL_ANALYSIS_RUNNER:-false}" '^(true|false)$' INSTALL_ANALYSIS_RUNNER

if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "runner AMI must be built natively on aarch64" >&2
  exit 1
fi

verify_file() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(sha256sum "$path" | cut -d ' ' -f 1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "artifact checksum mismatch: $(basename "$path")" >&2
    exit 1
  fi
}

verify_file "$COORDINATOR_ARCHIVE" "$COORDINATOR_ARCHIVE_SHA256"
verify_file "$NODE_ARCHIVE" "$NODE_ARCHIVE_SHA256"
verify_file "$CLOUDWATCH_AGENT_PACKAGE" "$CLOUDWATCH_AGENT_PACKAGE_SHA256"
verify_file "$COMPILER_ARCHIVE" "$COMPILER_OCI_ARCHIVE_SHA256"
verify_file "$TRIVY_BINARY" "$TRIVY_BINARY_SHA256"
verify_file "$TRIVY_CACHE_ARCHIVE" "$TRIVY_CACHE_ARCHIVE_SHA256"

archive_has_safe_members() {
  local path="$1"
  local member
  while IFS= read -r member; do
    case "$member" in
      ""|/*|../*|*/../*|*/..)
        echo "archive contains an unsafe member: $(basename "$path")" >&2
        return 1
        ;;
    esac
  done < <(tar --list --file "$path")
}

archive_has_safe_members "$COORDINATOR_ARCHIVE"
archive_has_safe_members "$NODE_ARCHIVE"
archive_has_safe_members "$COMPILER_ARCHIVE"
archive_has_safe_members "$TRIVY_CACHE_ARCHIVE"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get purge --yes apport apport-core-dump-handler python3-apport python3-problem-report
apt-get dist-upgrade --yes
apt-get install --yes jq podman logrotate
dpkg --install "$CLOUDWATCH_AGENT_PACKAGE"
apt-get clean
find /var/lib/apt/lists -mindepth 1 -delete
if [[ ! -f "$CLOUDWATCH_JMX_JAR" ]]; then
  echo "CloudWatch Agent JMX extension is absent from the pinned package" >&2
  exit 1
fi
rm -f "$CLOUDWATCH_JMX_JAR"
for archive in "${GETTEXT_JAVA_ARCHIVES[@]}"; do
  if [[ ! -f "$archive" && ! -L "$archive" ]]; then
    printf 'gettext Java binding is absent from the pinned Ubuntu source: %q\n' "$archive" >&2
    exit 1
  fi
done
rm -f "${GETTEXT_JAVA_ARCHIVES[@]}"

if getent passwd 10001 >/dev/null || getent group 10001 >/dev/null; then
  echo "uid/gid 10001 is already allocated" >&2
  exit 1
fi
groupadd --system --gid 10001 opengeo-coordinator
useradd --system --uid 10001 --gid 10001 --home-dir "$RUNTIME_HOME" \
  --create-home --shell /sbin/nologin opengeo-coordinator
for subid_file in /etc/subuid /etc/subgid; do
  touch "$subid_file"
  if awk -F: '$2 <= 265535 && ($2 + $3 - 1) >= 200000 { found = 1 } END { exit(found ? 0 : 1) }' "$subid_file"; then
    echo "rootless subordinate id range 200000-265535 is already allocated" >&2
    exit 1
  fi
  printf 'opengeo-coordinator:200000:65536\n' >> "$subid_file"
done

install -d -m 0755 -o root -g root /opt/opengeo /opt/opengeo/observable-coordinator
tar --extract --file "$COORDINATOR_ARCHIVE" \
  --directory /opt/opengeo/observable-coordinator --no-same-owner --no-same-permissions
chown -R root:root /opt/opengeo/observable-coordinator
chmod -R a-w /opt/opengeo/observable-coordinator

install -d -m 0755 -o root -g root /opt/node-v24.19.0
tar --extract --xz --file "$NODE_ARCHIVE" --directory /opt/node-v24.19.0 \
  --strip-components=1 --no-same-owner --no-same-permissions
if [[ "$(/opt/node-v24.19.0/bin/node --version)" != "v24.19.0" ]]; then
  echo "Node.js archive is not v24.19.0" >&2
  exit 1
fi
find /opt/node-v24.19.0/lib/node_modules -mindepth 1 -delete
rmdir /opt/node-v24.19.0/lib/node_modules
find /opt/node-v24.19.0/bin -maxdepth 1 -type l \
  \( -name npm -o -name npx -o -name corepack -o -name pnpm \
  -o -name pnpx -o -name yarn -o -name yarnpkg \) -delete
ln -s /opt/node-v24.19.0/bin/node /usr/local/bin/node

install -d -m 0700 -o opengeo-coordinator -g opengeo-coordinator \
  "$RUNTIME_HOME" "$RUNTIME_HOME/tmp" "$RUNTIME_DIR"
install -d -m 0750 -o root -g opengeo-coordinator /etc/opengeo
install -d -m 0750 -o root -g root /var/log/opengeo
touch /var/log/opengeo/observable-coordinator.log
chmod 0600 /var/log/opengeo/observable-coordinator.log
chown opengeo-coordinator:opengeo-coordinator "$COMPILER_ARCHIVE"
chmod 0400 "$COMPILER_ARCHIVE"

(
  cd "$RUNTIME_HOME"
  runuser -u opengeo-coordinator -- env \
    HOME="$RUNTIME_HOME" XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    podman load --input "$COMPILER_ARCHIVE"
  runuser -u opengeo-coordinator -- env \
    HOME="$RUNTIME_HOME" XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    podman image exists "$COMPILER_IMAGE_DIGEST"
)

install -m 0500 -o root -g root "$TRIVY_BINARY" /usr/local/sbin/opengeo-trivy
install -d -m 0700 -o root -g root "$TRIVY_CACHE"
install -d -m 0700 -o root -g root "$COMPILER_OCI_DIR"
tar --extract --file "$TRIVY_CACHE_ARCHIVE" --directory "$TRIVY_CACHE" \
  --no-same-owner --no-same-permissions
tar --extract --file "$COMPILER_ARCHIVE" --directory "$COMPILER_OCI_DIR" \
  --no-same-owner --no-same-permissions
if [[ ! -f "$TRIVY_CACHE/db/trivy.db" || ! -f "$TRIVY_CACHE/db/metadata.json" ]]; then
  echo "Trivy cache archive does not contain the required offline database" >&2
  exit 1
fi
trivy_db_version="$(jq -r '.Version // empty' "$TRIVY_CACHE/db/metadata.json")"
trivy_db_next_update="$(jq -r '.NextUpdate // empty' "$TRIVY_CACHE/db/metadata.json")"
if [[ "$trivy_db_version" != "2" || -z "$trivy_db_next_update" ]] \
  || ! trivy_db_next_update_epoch="$(date --date "$trivy_db_next_update" +%s)" \
  || (( trivy_db_next_update_epoch < $(date +%s) )); then
  echo "Trivy offline database is invalid or stale" >&2
  exit 1
fi
readonly TRIVY=(/usr/local/sbin/opengeo-trivy --cache-dir "$TRIVY_CACHE" --offline-scan --skip-db-update)
if [[ "${INSTALL_ANALYSIS_RUNNER:-false}" == "true" ]]; then
  /usr/local/bin/node /tmp/opengeo-install-analysis-runner.mjs /tmp/opengeo-analysis-payload
fi
java_archive_path="$(find / -xdev -type f \
  \( -name '*.jar' -o -name '*.war' -o -name '*.ear' -o -name '*.par' \) \
  -not -path '/tmp/*' -print -quit)"
if [[ -n "$java_archive_path" ]]; then
  printf 'unexpected Java archive remains on the runner host: %q\n' "$java_archive_path" >&2
  exit 1
fi
"${TRIVY[@]}" image --skip-java-db-update --input "$COMPILER_OCI_DIR" \
  --scanners vuln --format cyclonedx \
  --output /opt/opengeo/compiler-sbom.cdx.json
"${TRIVY[@]}" image --skip-java-db-update --input "$COMPILER_OCI_DIR" --scanners vuln \
  --severity HIGH,CRITICAL --format json \
  --output /opt/opengeo/compiler-vulnerabilities.json
"${TRIVY[@]}" rootfs --skip-java-db-update --skip-dirs /tmp \
  --skip-files /usr/local/sbin/opengeo-trivy \
  --scanners vuln --format cyclonedx --output /opt/opengeo/host-sbom.cdx.json /
"${TRIVY[@]}" rootfs --skip-java-db-update --skip-dirs /tmp \
  --skip-files /usr/local/sbin/opengeo-trivy \
  --scanners vuln --severity HIGH,CRITICAL --format json \
  --output /opt/opengeo/host-vulnerabilities.json /
critical_vulnerability_count="$(jq -s \
  '[.[] | .Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' \
  /opt/opengeo/host-vulnerabilities.json /opt/opengeo/compiler-vulnerabilities.json)"
high_vulnerability_count="$(jq -s \
  '[.[] | .Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' \
  /opt/opengeo/host-vulnerabilities.json /opt/opengeo/compiler-vulnerabilities.json)"
jq -n \
  --argjson criticalVulnerabilityCount "$critical_vulnerability_count" \
  --argjson highVulnerabilityCount "$high_vulnerability_count" \
  '{schemaVersion:"opengeo.observable-runner-vulnerability-gate.1.0.0",criticalVulnerabilityCount:$criticalVulnerabilityCount,highVulnerabilityCount:$highVulnerabilityCount}' \
  > /opt/opengeo/vulnerability-gate.json
chmod 0444 /opt/opengeo/*-sbom.cdx.json /opt/opengeo/*-vulnerabilities.json
chmod 0444 /opt/opengeo/vulnerability-gate.json

install -m 0644 -o root -g root /tmp/opengeo-observable-coordinator.service \
  /etc/systemd/system/opengeo-observable-coordinator.service
install -m 0644 -o root -g root /tmp/opengeo-observable-logrotate \
  /etc/logrotate.d/opengeo-observable

systemctl daemon-reload
if [[ "${INSTALL_ANALYSIS_RUNNER:-false}" == "true" ]]; then
  systemctl disable opengeo-observable-coordinator.service
else
  systemctl enable opengeo-observable-coordinator.service
fi
systemctl disable amazon-cloudwatch-agent.service 2>/dev/null || true
systemctl disable amazon-ssm-agent.service 2>/dev/null || true
systemctl disable snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null || true
systemctl disable sshd.service 2>/dev/null || true
systemctl disable ssh.service 2>/dev/null || true

podman_version="$(podman --version | tr -d '\n')"
cloudwatch_version="$(dpkg-query --show \
  --showformat='${Package}-${Version}-${Architecture}' amazon-cloudwatch-agent | tr -d '\n')"
node_version="$(/usr/local/bin/node --version | tr -d '\n')"
trivy_version="$(/usr/local/sbin/opengeo-trivy --version | head -n 1 | tr -d '\n')"
host_sbom_sha256="$(sha256sum /opt/opengeo/host-sbom.cdx.json | cut -d ' ' -f 1)"
host_vulnerability_sha256="$(sha256sum /opt/opengeo/host-vulnerabilities.json | cut -d ' ' -f 1)"
compiler_sbom_sha256="$(sha256sum /opt/opengeo/compiler-sbom.cdx.json | cut -d ' ' -f 1)"
compiler_vulnerability_sha256="$(sha256sum /opt/opengeo/compiler-vulnerabilities.json | cut -d ' ' -f 1)"
cat > /opt/opengeo/observable-runner-ami-manifest.json <<EOF
{"schemaVersion":"opengeo.observable-runner-ami-manifest.1.0.0","architecture":"arm64","sourceAmiId":"$SOURCE_AMI_ID","releaseId":"$RELEASE_ID","coordinatorArchiveSha256":"$COORDINATOR_ARCHIVE_SHA256","nodeArchiveSha256":"$NODE_ARCHIVE_SHA256","cloudWatchAgentPackageSha256":"$CLOUDWATCH_AGENT_PACKAGE_SHA256","cloudWatchJmxJarRemoved":true,"gettextJavaBindingsRemoved":true,"compilerOciArchiveSha256":"$COMPILER_OCI_ARCHIVE_SHA256","compilerImageDigest":"$COMPILER_IMAGE_DIGEST","nodeVersion":"$node_version","podmanVersion":"$podman_version","cloudWatchAgentVersion":"$cloudwatch_version","trivyVersion":"$trivy_version","hostSbomSha256":"$host_sbom_sha256","hostVulnerabilityReportSha256":"$host_vulnerability_sha256","compilerSbomSha256":"$compiler_sbom_sha256","compilerVulnerabilityReportSha256":"$compiler_vulnerability_sha256","criticalVulnerabilityCount":$critical_vulnerability_count,"highVulnerabilityCount":$high_vulnerability_count}
EOF
chmod 0444 /opt/opengeo/observable-runner-ami-manifest.json

rm -f "$COORDINATOR_ARCHIVE" "$NODE_ARCHIVE" "$CLOUDWATCH_AGENT_PACKAGE" \
  "$COMPILER_ARCHIVE" /tmp/opengeo-observable-coordinator.service \
  /tmp/opengeo-observable-logrotate "$TRIVY_BINARY" "$TRIVY_CACHE_ARCHIVE"
rm -f /usr/local/sbin/opengeo-trivy
find "$TRIVY_CACHE" -mindepth 1 -delete
rmdir "$TRIVY_CACHE"
find "$COMPILER_OCI_DIR" -mindepth 1 -delete
rmdir "$COMPILER_OCI_DIR"
find /var/cache/apt/archives -type f -delete
rm -f /tmp/opengeo-install-analysis-runner.mjs /tmp/opengeo-analysis-coordinator.service
if [[ -e /tmp/opengeo-analysis-payload || -L /tmp/opengeo-analysis-payload ]]; then
  [[ -d /tmp/opengeo-analysis-payload && ! -L /tmp/opengeo-analysis-payload ]]
  find /tmp/opengeo-analysis-payload -mindepth 1 -delete
  rmdir /tmp/opengeo-analysis-payload
fi
