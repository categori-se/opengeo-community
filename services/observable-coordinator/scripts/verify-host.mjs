import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {ObservableCoordinatorSettings} from "../src/production-adapters.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_KEYS = Object.freeze([
  "architecture",
  "cloudWatchAgentPackageSha256",
  "cloudWatchAgentVersion",
  "cloudWatchJmxJarRemoved",
  "compilerImageDigest",
  "compilerOciArchiveSha256",
  "compilerSbomSha256",
  "compilerVulnerabilityReportSha256",
  "coordinatorArchiveSha256",
  "criticalVulnerabilityCount",
  "gettextJavaBindingsRemoved",
  "highVulnerabilityCount",
  "hostSbomSha256",
  "hostVulnerabilityReportSha256",
  "nodeArchiveSha256",
  "nodeVersion",
  "podmanVersion",
  "releaseId",
  "schemaVersion",
  "sourceAmiId",
  "trivyVersion"
]);
const EVIDENCE_FILES = Object.freeze([
  ["/opt/opengeo/host-sbom.cdx.json", "hostSbomSha256", "sbom"],
  ["/opt/opengeo/host-vulnerabilities.json", "hostVulnerabilityReportSha256", "vulnerabilities"],
  ["/opt/opengeo/compiler-sbom.cdx.json", "compilerSbomSha256", "sbom"],
  ["/opt/opengeo/compiler-vulnerabilities.json", "compilerVulnerabilityReportSha256", "vulnerabilities"]
]);

export function validateRunnerManifest(value, expectedCompilerImageDigest) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== [...MANIFEST_KEYS].sort().join("\n")
    || value.schemaVersion !== "opengeo.observable-runner-ami-manifest.1.0.0"
    || value.architecture !== "arm64"
    || value.nodeVersion !== "v24.19.0"
    || value.cloudWatchJmxJarRemoved !== true
    || value.gettextJavaBindingsRemoved !== true
    || value.compilerImageDigest !== expectedCompilerImageDigest
    || !IMAGE_DIGEST.test(value.compilerImageDigest ?? "")
    || !/^ami-[0-9a-f]{17}$/.test(value.sourceAmiId ?? "")
    || !/^[0-9]{14}-[0-9a-f]{12}$/.test(value.releaseId ?? "")
    || !/^podman version [1-9][0-9]*(?:\.[0-9]+){1,3}$/.test(value.podmanVersion ?? "")
    || !/^amazon-cloudwatch-agent-[A-Za-z0-9._+~-]{1,128}$/.test(value.cloudWatchAgentVersion ?? "")
    || !/^Version: [A-Za-z0-9._+~-]{1,128}$/.test(value.trivyVersion ?? "")
    || value.criticalVulnerabilityCount !== 0
    || value.highVulnerabilityCount !== 0
    || !["coordinatorArchiveSha256", "nodeArchiveSha256", "cloudWatchAgentPackageSha256", "compilerOciArchiveSha256", "hostSbomSha256", "hostVulnerabilityReportSha256", "compilerSbomSha256", "compilerVulnerabilityReportSha256"]
      .every((key) => SHA256.test(value[key] ?? ""))) {
    throw new Error("runner AMI manifest is invalid");
  }
  return value;
}

export function validatePodmanInspection(value, expectedDigest) {
  const inspection = Array.isArray(value) ? value[0] : value;
  if (!inspection || (Array.isArray(value) && value.length !== 1)
    || inspection.Id !== expectedDigest
    || inspection.Architecture !== "arm64"
    || inspection.Config?.User !== "10001:10001") {
    throw new Error("preloaded compiler image is invalid");
  }
  return inspection;
}

export function validateEvidenceDocument(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 64 * 1024 * 1024) {
    throw new Error("runner AMI evidence is invalid");
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("runner AMI evidence is invalid");
  }
  if (kind === "sbom") {
    if (value.bomFormat !== "CycloneDX" || typeof value.specVersion !== "string"
      || value.version !== 1 || !Array.isArray(value.components)) {
      throw new Error("runner AMI SBOM is invalid");
    }
    return value;
  }
  if (value.SchemaVersion !== 2 || !Array.isArray(value.Results)) {
    throw new Error("runner AMI vulnerability evidence is invalid");
  }
  const vulnerabilities = value.Results
    .flatMap((result) => Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []);
  if (vulnerabilities.some((item) => item?.Severity === "HIGH" || item?.Severity === "CRITICAL")) {
    throw new Error("runner AMI vulnerability evidence is invalid");
  }
  return value;
}

export async function verifyHost({
  environment = process.env,
  architecture = process.arch,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
  manifestPath = "/opt/opengeo/observable-runner-ami-manifest.json",
  workspacePath = "/var/lib/opengeo-observable",
  inspect = inspectCompilerImage,
  readText = (path) => readFile(path, "utf8"),
  readBytes = (path) => readFile(path),
  statPath = stat
} = {}) {
  const settings = ObservableCoordinatorSettings.fromEnvironment(environment);
  const evidenceSha256 = environment.OPEN_GEO_OBSERVABLE_RUNNER_AMI_EVIDENCE_SHA256;
  if (architecture !== "arm64" || uid !== 10001 || gid !== 10001) {
    throw new Error("trusted host identity is invalid");
  }
  if (environment.OPEN_GEO_OBSERVABLE_WORKSPACE_ROOT !== workspacePath) {
    throw new Error("trusted host workspace is invalid");
  }
  if (!SHA256.test(evidenceSha256 ?? "")) {
    throw new Error("runner AMI deployment evidence is invalid");
  }
  const workspace = await statPath(workspacePath);
  if (!workspace.isDirectory() || workspace.uid !== 10001 || workspace.gid !== 10001
    || (workspace.mode & 0o777) !== 0o700) {
    throw new Error("trusted host workspace is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readText(manifestPath));
  } catch {
    throw new Error("runner AMI manifest is invalid");
  }
  validateRunnerManifest(manifest, settings.compilerImageDigest);
  for (const [path, hashKey, kind] of EVIDENCE_FILES) {
    const bytes = await readBytes(path);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest[hashKey]) {
      throw new Error("runner AMI evidence checksum is invalid");
    }
    validateEvidenceDocument(bytes, kind);
  }
  validatePodmanInspection(await inspect(settings.compilerImageDigest), settings.compilerImageDigest);
  return {
    releaseId: manifest.releaseId,
    compilerImageDigest: settings.compilerImageDigest,
    evidenceSha256
  };
}

function inspectCompilerImage(digest) {
  const result = spawnSync("podman", ["image", "inspect", digest], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
    env: {
      HOME: process.env.HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      PATH: process.env.PATH
    }
  });
  if (result.error || result.status !== 0 || Buffer.byteLength(result.stdout) > 1_048_576) {
    throw new Error("preloaded compiler image is unavailable");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("preloaded compiler image is invalid");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyHost();
    process.stdout.write(`${JSON.stringify({status: "ready", ...result})}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({status: "failed", code: "trusted_host_preflight_failed"})}\n`);
    process.exitCode = 1;
  }
}
