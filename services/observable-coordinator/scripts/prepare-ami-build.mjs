import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir, readFile, realpath, stat, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const INPUT_KEYS = Object.freeze([
  "cloudWatchAgentPackagePath",
  "compilerImageDigest",
  "compilerOciArchivePath",
  "coordinatorArchivePath",
  "kmsKeyArn",
  "nodeArchivePath",
  "region",
  "releaseId",
  "schemaVersion",
  "securityGroupId",
  "sourceAmiId",
  "subnetId",
  "trivyBinaryPath",
  "trivyCacheArchivePath"
]);
const FILE_INPUTS = Object.freeze([
  ["coordinatorArchivePath", "coordinator_archive", 1, 32 * 1024 * 1024],
  ["nodeArchivePath", "node_archive", 1, 256 * 1024 * 1024],
  ["cloudWatchAgentPackagePath", "cloudwatch_agent_package", 1, 512 * 1024 * 1024],
  ["compilerOciArchivePath", "compiler_oci_archive", 1, 8 * 1024 * 1024 * 1024],
  ["trivyBinaryPath", "trivy_binary", 1, 256 * 1024 * 1024],
  ["trivyCacheArchivePath", "trivy_cache_archive", 1, 2 * 1024 * 1024 * 1024]
]);

export function validateBuildInputs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== [...INPUT_KEYS].sort().join("\n")
    || value.schemaVersion !== "opengeo.observable-runner-ami-inputs.1.0.0"
    || !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/.test(value.region ?? "")
    || !/^ami-[0-9a-f]{17}$/.test(value.sourceAmiId ?? "")
    || !/^subnet-[0-9a-f]{17}$/.test(value.subnetId ?? "")
    || !/^sg-[0-9a-f]{17}$/.test(value.securityGroupId ?? "")
    || !/^[0-9]{14}-[0-9a-f]{12}$/.test(value.releaseId ?? "")
    || !/^sha256:[0-9a-f]{64}$/.test(value.compilerImageDigest ?? "")
    || FILE_INPUTS.some(([key]) => typeof value[key] !== "string" || value[key].length === 0)) {
    throw new Error("runner AMI build inputs are invalid");
  }
  const kms = /^arn:(aws|aws-us-gov):kms:([^:]+):(\d{12}):key\/([0-9a-f-]{36})$/.exec(
    value.kmsKeyArn ?? ""
  );
  if (!kms || kms[2] !== value.region) {
    throw new Error("runner AMI KMS key must be an exact ARN in the build region");
  }
  return value;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareAmiBuild(inputPath, outputPath) {
  if (!inputPath || !outputPath || !outputPath.endsWith(".pkrvars.json")) {
    throw new Error("input JSON and a .pkrvars.json output path are required");
  }
  const raw = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(raw) > 32_768) throw new Error("runner AMI build inputs are too large");
  let inputs;
  try {
    inputs = validateBuildInputs(JSON.parse(raw));
  } catch (error) {
    if (error.message.startsWith("runner AMI")) throw error;
    throw new Error("runner AMI build inputs are invalid");
  }
  const artifacts = Object.create(null);
  for (const [inputKey, variablePrefix, minimum, maximum] of FILE_INPUTS) {
    const path = await realpath(resolve(dirname(resolve(inputPath)), inputs[inputKey]));
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) {
      throw new Error(`${inputKey} must resolve to one bounded regular file`);
    }
    artifacts[`${variablePrefix}_path`] = path;
    artifacts[`${variablePrefix}_sha256`] = await sha256File(path);
  }
  const output = resolve(outputPath);
  const outputDirectory = dirname(output);
  await mkdir(outputDirectory, {recursive: true, mode: 0o700});
  const variables = {
    region: inputs.region,
    source_ami_id: inputs.sourceAmiId,
    subnet_id: inputs.subnetId,
    security_group_id: inputs.securityGroupId,
    kms_key_arn: inputs.kmsKeyArn,
    release_id: inputs.releaseId,
    compiler_image_digest: inputs.compilerImageDigest,
    ...artifacts,
    packer_manifest_path: resolve(outputDirectory, "packer-manifest.json"),
    host_sbom_path: resolve(outputDirectory, "host-sbom.cdx.json"),
    host_vulnerability_report_path: resolve(outputDirectory, "host-vulnerabilities.json"),
    compiler_sbom_path: resolve(outputDirectory, "compiler-sbom.cdx.json"),
    compiler_vulnerability_report_path: resolve(outputDirectory, "compiler-vulnerabilities.json"),
    vulnerability_gate_report_path: resolve(outputDirectory, "vulnerability-gate.json")
  };
  await writeFile(output, `${JSON.stringify(variables, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return variables;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await prepareAmiBuild(process.argv[2], process.argv[3]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
