import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {validateEvidenceDocument} from "./verify-host.mjs";

const APPROVAL_KEYS = Object.freeze([
  "decision", "notes", "reviewedAt", "reviewer", "schemaVersion"
]);

export function validateApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== [...APPROVAL_KEYS].sort().join("\n")
    || value.schemaVersion !== "opengeo.observable-runner-ami-approval.1.0.0"
    || value.decision !== "approved"
    || typeof value.reviewer !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._@+-]{2,127}$/.test(value.reviewer)
    || typeof value.reviewedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.reviewedAt)
    || Number.isNaN(Date.parse(value.reviewedAt))
    || typeof value.notes !== "string" || value.notes.length < 1 || value.notes.length > 1024
    || /[\r\n]/.test(value.notes)) {
    throw new Error("runner AMI approval is invalid");
  }
  return value;
}

export function createEvidenceReceipt({variables, packerManifest, packerManifestBytes, reports, approval}) {
  const build = Array.isArray(packerManifest?.builds) && packerManifest.builds.length === 1
    ? packerManifest.builds[0]
    : undefined;
  const artifact = new RegExp(`^${variables.region}:(ami-[0-9a-f]{17})$`).exec(
    build?.artifact_id ?? ""
  );
  const custom = build?.custom_data;
  if (!artifact || build.builder_type !== "amazon-ebs" || !custom
    || custom.architecture !== "arm64"
    || custom.source_ami_id !== variables.source_ami_id
    || custom.release_id !== variables.release_id
    || custom.compiler_image_digest !== variables.compiler_image_digest
    || custom.coordinator_archive_sha256 !== variables.coordinator_archive_sha256
    || custom.node_archive_sha256 !== variables.node_archive_sha256
    || custom.cloudwatch_agent_package_sha256 !== variables.cloudwatch_agent_package_sha256
    || custom.compiler_oci_archive_sha256 !== variables.compiler_oci_archive_sha256
    || custom.trivy_binary_sha256 !== variables.trivy_binary_sha256
    || custom.trivy_cache_archive_sha256 !== variables.trivy_cache_archive_sha256
    || custom.packer_version !== "1.16.0"
    || custom.packer_amazon_plugin_version !== "1.8.2") {
    throw new Error("Packer manifest does not match the reviewed runner inputs");
  }
  validateApproval(approval);
  const documents = {
    hostSbomSha256: evidenceHash(reports.hostSbom, "sbom"),
    hostVulnerabilityReportSha256: evidenceHash(reports.hostVulnerabilities, "vulnerabilities"),
    compilerSbomSha256: evidenceHash(reports.compilerSbom, "sbom"),
    compilerVulnerabilityReportSha256: evidenceHash(reports.compilerVulnerabilities, "vulnerabilities")
  };
  return {
    schemaVersion: "opengeo.observable-runner-ami-evidence.1.0.0",
    decision: "approved",
    amiId: artifact[1],
    region: variables.region,
    architecture: "arm64",
    releaseId: variables.release_id,
    sourceAmiId: variables.source_ami_id,
    compilerImageDigest: variables.compiler_image_digest,
    packerVersion: "1.16.0",
    packerAmazonPluginVersion: "1.8.2",
    packerManifestSha256: createHash("sha256").update(packerManifestBytes).digest("hex"),
    inputSha256: {
      coordinatorArchive: variables.coordinator_archive_sha256,
      nodeArchive: variables.node_archive_sha256,
      cloudWatchAgentPackage: variables.cloudwatch_agent_package_sha256,
      compilerOciArchive: variables.compiler_oci_archive_sha256,
      trivyBinary: variables.trivy_binary_sha256,
      trivyCacheArchive: variables.trivy_cache_archive_sha256
    },
    ...documents,
    criticalVulnerabilityCount: 0,
    highVulnerabilityCount: 0,
    reviewer: approval.reviewer,
    reviewedAt: approval.reviewedAt,
    notes: approval.notes
  };
}

function evidenceHash(bytes, kind) {
  validateEvidenceDocument(bytes, kind);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function recordAmiEvidence(variablesPath, approvalPath, outputPath) {
  if (!variablesPath || !approvalPath || !outputPath || !outputPath.endsWith(".json")) {
    throw new Error("Packer variables, approval, and evidence output JSON paths are required");
  }
  const variables = JSON.parse(await readFile(variablesPath, "utf8"));
  const packerManifestBytes = await readFile(variables.packer_manifest_path);
  const packerManifest = JSON.parse(packerManifestBytes);
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  const reports = {
    hostSbom: await readFile(variables.host_sbom_path),
    hostVulnerabilities: await readFile(variables.host_vulnerability_report_path),
    compilerSbom: await readFile(variables.compiler_sbom_path),
    compilerVulnerabilities: await readFile(variables.compiler_vulnerability_report_path)
  };
  const receipt = createEvidenceReceipt({
    variables, packerManifest, packerManifestBytes, reports, approval
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(resolve(outputPath), serialized, {encoding: "utf8", mode: 0o600, flag: "wx"});
  return {
    receipt,
    sha256: createHash("sha256").update(serialized).digest("hex")
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await recordAmiEvidence(process.argv[2], process.argv[3], process.argv[4]);
    process.stdout.write(`${JSON.stringify({amiId: result.receipt.amiId, evidenceSha256: result.sha256})}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
