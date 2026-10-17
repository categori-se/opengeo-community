import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import * as FS from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, it} from "node:test";
import {buildCoordinatorArchive, PUBLIC_FILE_TRANSPORT_MODULES} from "../scripts/build-ami-coordinator-archive.mjs";
import {installAnalysisRunner, ensureAnalysisDirectory} from "../ami/scripts/install-analysis-runner.mjs";
import {ANALYSIS_PACKAGE_MEMBERS} from "../../analysis-coordinator/scripts/verify-host.mjs";
import {
  cloudWatchAgentConfiguration,
  parseEnvironmentFile
} from "../scripts/configure-host-logs.mjs";
import {prepareAmiBuild, validateBuildInputs} from "../scripts/prepare-ami-build.mjs";
import {createEvidenceReceipt, validateApproval} from "../scripts/record-ami-evidence.mjs";
import {
  validatePodmanInspection,
  validateEvidenceDocument,
  validateRunnerManifest,
  verifyHost
} from "../scripts/verify-host.mjs";

const DIGEST = `sha256:${"d".repeat(64)}`;
const HASH = "a".repeat(64);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

function manifest(overrides = {}) {
  return {
    schemaVersion: "opengeo.observable-runner-ami-manifest.1.0.0",
    architecture: "arm64",
    sourceAmiId: "ami-aaaaaaaaaaaaaaaaa",
    releaseId: "20260823010203-abcdefabcdef",
    coordinatorArchiveSha256: HASH,
    nodeArchiveSha256: HASH,
    cloudWatchAgentPackageSha256: HASH,
    cloudWatchJmxJarRemoved: true,
    gettextJavaBindingsRemoved: true,
    compilerOciArchiveSha256: HASH,
    compilerImageDigest: DIGEST,
    nodeVersion: "v24.19.0",
    podmanVersion: "podman version 5.4.0",
    cloudWatchAgentVersion: "amazon-cloudwatch-agent-1.300056.0-1.aarch64",
    trivyVersion: "Version: 0.65.0",
    hostSbomSha256: HASH,
    hostVulnerabilityReportSha256: HASH,
    compilerSbomSha256: HASH,
    compilerVulnerabilityReportSha256: HASH,
    criticalVulnerabilityCount: 0,
    highVulnerabilityCount: 0,
    ...overrides
  };
}

function environment() {
  return {
    OPEN_GEO_OBSERVABLE_COORDINATOR_STAGE: "dev",
    OPEN_GEO_AWS_REGION: "us-east-1",
    OPEN_GEO_DATA_API_CLUSTER_ARN: "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-dev",
    OPEN_GEO_DATA_API_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:coordinator",
    OPEN_GEO_DB_NAME: "opengeo",
    OPEN_GEO_APPLICATION_BUCKET: "opengeo-dev-application",
    OPEN_GEO_APPLICATION_KMS_KEY_ARN: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000000",
    OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST: DIGEST,
    OPEN_GEO_OBSERVABLE_RUNNER_AMI_EVIDENCE_SHA256: HASH,
    OPEN_GEO_OBSERVABLE_WORKSPACE_ROOT: "/var/lib/opengeo-observable"
  };
}

describe("trusted ARM64 runner AMI contract", () => {
  it("pins its builder and inputs and cannot silently pull runtime artifacts", async () => {
    const hcl = await readFile(join(PACKAGE_ROOT, "ami/runner.pkr.hcl"), "utf8");
    const installer = await readFile(join(PACKAGE_ROOT, "ami/scripts/install-runner.sh"), "utf8");
    const unit = await readFile(join(PACKAGE_ROOT, "ami/assets/opengeo-observable-coordinator.service"), "utf8");
    assert.match(hcl, /required_version = "= 1\.16\.0"/);
    assert.match(hcl, /version = "= 1\.8\.2"/);
    assert.match(hcl, /source_ami\s+= var\.source_ami_id/);
    assert.match(hcl, /ssh_username\s+= "ubuntu"/);
    assert.match(hcl, /device_name\s+= "\/dev\/sda1"/);
    assert.match(hcl, /associate_public_ip_address = false/);
    assert.match(hcl, /http_tokens\s+= "required"/);
    assert.match(hcl, /direction\s+= "download"/);
    assert.match(hcl, /vulnerability-gate\.json/);
    assert.match(hcl, /criticalVulnerabilityCount == 0/);
    assert.match(installer, /uname -m.*aarch64/);
    assert.match(installer,
      /apt-get purge --yes apport apport-core-dump-handler python3-apport python3-problem-report/);
    assert.match(installer, /apt-get dist-upgrade --yes/);
    assert.match(installer, /apt-get install --yes jq podman logrotate/);
    assert.match(installer, /dpkg --install "\$CLOUDWATCH_AGENT_PACKAGE"/);
    assert.match(installer, /node --version\)" != "v24\.19\.0"/);
    assert.match(installer, /find \/opt\/node-v24\.19\.0\/lib\/node_modules -mindepth 1 -delete/);
    assert.match(installer, /podman load --input/);
    assert.match(installer, /cd "\$RUNTIME_HOME"/);
    assert.match(installer, /chown opengeo-coordinator:opengeo-coordinator "\$COMPILER_ARCHIVE"/);
    assert.match(installer, /--offline-scan --skip-db-update/);
    assert.match(installer, /--skip-java-db-update/);
    assert.match(installer, /opentelemetry-jmx-metrics\.jar/);
    assert.match(installer, /libintl-0\.21\.jar/);
    assert.match(installer, /gettextJavaBindingsRemoved/);
    assert.match(installer, /unexpected Java archive remains on the runner host/);
    assert.match(installer, /Trivy offline database is invalid or stale/);
    assert.match(installer, /critical_vulnerability_count/);
    assert.match(installer, /high_vulnerability_count/);
    assert.match(installer, /opengeo\.observable-runner-vulnerability-gate\.1\.0\.0/);
    assert.doesNotMatch(installer, /\bcurl\b|\bwget\b|podman pull/);
    assert.doesNotMatch(installer, /rm -rf/);
    assert.match(unit, /^User=opengeo-coordinator$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /scripts\/verify-host\.mjs/);
  });

  it("builds a byte-reproducible coordinator archive containing only runtime members", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeo-ami-archive-"));
    try {
      const first = await buildCoordinatorArchive(join(directory, "first.tar"));
      const second = await buildCoordinatorArchive(join(directory, "second.tar"));
      const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
      assert.equal(await digest(first), await digest(second));
      const archive = await readFile(first), members = new Map();
      for (let offset = 0; archive[offset];) {
        const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
        const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, ""), 8);
        members.set(name, archive.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      assert.ok(members.has("src/public-file-fetch.py"));
      for (const module of PUBLIC_FILE_TRANSPORT_MODULES) {
        assert.deepEqual(members.get(`python/opengeo_api/${module}`),
          await readFile(resolve(PACKAGE_ROOT, "../api/src/opengeo_api", module)));
      }
      assert.equal([...members.keys()].filter(name => name.startsWith("python/")).length, 4);
      assert.ok(!members.has("python/opengeo_api/cognito_provisioning.py"));
      const installer = await readFile(resolve(PACKAGE_ROOT, "../../scripts/install-framework-github-runtime.mjs"), "utf8");
      assert.match(installer, /PUBLIC_FILE_TRANSPORT_MODULES\.map/);
      assert.match(installer, /src\/public-file-fetch\.py/);
      assert.match(installer, /destination: `services\/observable-coordinator\/python\/opengeo_api\/\$\{name\}`/);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("optionally packages only the complete analysis dependency closure without changing the default archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeo-analysis-archive-"));
    try {
      const legacy = await buildCoordinatorArchive(join(directory, "legacy.tar"));
      const explicitLegacy = await buildCoordinatorArchive(join(directory, "explicit-legacy.tar"), {analysis: false});
      assert.deepEqual(await readFile(legacy), await readFile(explicitLegacy));
      const first = await buildCoordinatorArchive(join(directory, "analysis.tar"), {analysis: true});
      const second = await buildCoordinatorArchive(join(directory, "repeat.tar"), {analysis: true});
      const bytes = await readFile(first);
      assert.deepEqual(bytes, await readFile(second));
      assert.ok(bytes.length < 2 * 1024 * 1024);
      const members = new Map();
      for (let offset = 0; bytes[offset];) {
        const name = bytes.subarray(offset, offset + 100).toString().replace(/\0.*$/, "");
        const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, ""), 8);
        assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
        members.set(name, bytes.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      assert.deepEqual([...members.keys()].sort(), [...ANALYSIS_PACKAGE_MEMBERS, "analysis-package.json"].sort());
      const manifest = JSON.parse(members.get("analysis-package.json"));
      assert.equal(manifest.schemaVersion, "opengeo.analysis-package.1");
      for (const file of manifest.files) {
        assert.equal(file.size_bytes, members.get(file.path).length);
        assert.equal(file.checksum_sha256, createHash("sha256").update(members.get(file.path)).digest("hex"));
        const imports = members.get(file.path).toString().matchAll(/\bfrom\s+["'](\.[^"']+)["']/g);
        for (const [, imported] of imports) {
          const target = resolve("/opt/opengeo", file.path, "..", imported).slice("/opt/opengeo/".length);
          assert.ok(members.has(target), `${file.path} import ${imported} is included`);
        }
      }
      assert.equal(manifest.files.length, 11);
    } finally {await rm(directory, {recursive: true, force: true});}
  });

  it("accepts only exact, same-region, closed-schema preparation inputs", () => {
    const valid = {
      schemaVersion: "opengeo.observable-runner-ami-inputs.1.0.0",
      region: "us-east-1",
      sourceAmiId: "ami-aaaaaaaaaaaaaaaaa",
      subnetId: "subnet-aaaaaaaaaaaaaaaaa",
      securityGroupId: "sg-aaaaaaaaaaaaaaaaa",
      kmsKeyArn: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000000",
      releaseId: "20260823010203-abcdefabcdef",
      coordinatorArchivePath: "coordinator.tar",
      nodeArchivePath: "node.tar.xz",
      cloudWatchAgentPackagePath: "agent.deb",
      compilerOciArchivePath: "compiler.tar",
      compilerImageDigest: DIGEST,
      trivyBinaryPath: "trivy",
      trivyCacheArchivePath: "trivy-cache.tar"
    };
    assert.equal(validateBuildInputs(valid), valid);
    assert.throws(() => validateBuildInputs({...valid, sourceAmiId: "ami-latest"}), /inputs are invalid/);
    assert.throws(() => validateBuildInputs({...valid, extra: true}), /inputs are invalid/);
    assert.throws(() => validateBuildInputs({...valid, kmsKeyArn: valid.kmsKeyArn.replace("us-east-1", "us-west-2")}), /build region/);
  });

  it("derives artifact hashes into a private non-overwriting Packer variable file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeo-ami-inputs-"));
    try {
      const files = ["coordinator.tar", "node.tar.xz", "agent.deb", "compiler.tar", "trivy", "trivy-cache.tar"];
      for (const [index, name] of files.entries()) {
        await writeFile(join(directory, name), Buffer.from(`artifact-${index}`));
      }
      const inputs = {
        schemaVersion: "opengeo.observable-runner-ami-inputs.1.0.0",
        region: "us-east-1",
        sourceAmiId: "ami-aaaaaaaaaaaaaaaaa",
        subnetId: "subnet-aaaaaaaaaaaaaaaaa",
        securityGroupId: "sg-aaaaaaaaaaaaaaaaa",
        kmsKeyArn: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000000",
        releaseId: "20260823010203-abcdefabcdef",
        coordinatorArchivePath: files[0],
        nodeArchivePath: files[1],
        cloudWatchAgentPackagePath: files[2],
        compilerOciArchivePath: files[3],
        compilerImageDigest: DIGEST,
        trivyBinaryPath: files[4],
        trivyCacheArchivePath: files[5]
      };
      const inputPath = join(directory, "inputs.json");
      const outputPath = join(directory, "runner.pkrvars.json");
      await writeFile(inputPath, JSON.stringify(inputs));
      const variables = await prepareAmiBuild(inputPath, outputPath);
      assert.equal(variables.coordinator_archive_sha256,
        createHash("sha256").update("artifact-0").digest("hex"));
      assert.equal(variables.coordinator_archive_path, join(directory, files[0]));
      await assert.rejects(() => prepareAmiBuild(inputPath, outputPath), /EEXIST/);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it("creates one bounded CloudWatch file stream without shell interpolation", () => {
    const parsed = parseEnvironmentFile(
      "OPEN_GEO_OBSERVABLE_LOG_GROUP_NAME=/opengeo/production/observable-coordinator\n"
    );
    const config = cloudWatchAgentConfiguration(parsed.OPEN_GEO_OBSERVABLE_LOG_GROUP_NAME);
    assert.deepEqual(config.logs.logs_collected.files.collect_list, [{
      file_path: "/var/log/opengeo/observable-coordinator.log",
      log_group_name: "/opengeo/production/observable-coordinator",
      log_stream_name: "{instance_id}",
      timezone: "UTC",
      multi_line_start_pattern: "^{"
    }]);
    assert.throws(() => parseEnvironmentFile("A=one\nA=two\n"), /environment file is invalid/);
    assert.throws(() => cloudWatchAgentConfiguration("/opengeo/dev/other"), /log group is invalid/);
  });

  it("binds operator approval to one AMI, input set, scanner result, and receipt hash", () => {
    const shaFields = {
      coordinator_archive_sha256: HASH,
      node_archive_sha256: HASH,
      cloudwatch_agent_package_sha256: HASH,
      compiler_oci_archive_sha256: HASH,
      trivy_binary_sha256: HASH,
      trivy_cache_archive_sha256: HASH
    };
    const variables = {
      region: "us-east-1",
      source_ami_id: "ami-aaaaaaaaaaaaaaaaa",
      release_id: "20260823010203-abcdefabcdef",
      compiler_image_digest: DIGEST,
      ...shaFields
    };
    const custom_data = {
      architecture: "arm64",
      source_ami_id: variables.source_ami_id,
      release_id: variables.release_id,
      compiler_image_digest: DIGEST,
      packer_version: "1.16.0",
      packer_amazon_plugin_version: "1.8.2",
      ...shaFields
    };
    const packerManifest = {
      builds: [{
        artifact_id: "us-east-1:ami-bbbbbbbbbbbbbbbbb",
        builder_type: "amazon-ebs",
        custom_data
      }]
    };
    const packerManifestBytes = Buffer.from(JSON.stringify(packerManifest));
    const sbom = Buffer.from(JSON.stringify({bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: []}));
    const vulnerabilities = Buffer.from(JSON.stringify({SchemaVersion: 2, Results: []}));
    const approval = {
      schemaVersion: "opengeo.observable-runner-ami-approval.1.0.0",
      decision: "approved",
      reviewer: "reviewer@example.invalid",
      reviewedAt: "2026-08-23T01:02:03Z",
      notes: "Reviewed exact build inputs and zero-high-or-critical reports."
    };
    assert.equal(validateApproval(approval), approval);
    const receipt = createEvidenceReceipt({
      variables,
      packerManifest,
      packerManifestBytes,
      reports: {
        hostSbom: sbom,
        hostVulnerabilities: vulnerabilities,
        compilerSbom: sbom,
        compilerVulnerabilities: vulnerabilities
      },
      approval
    });
    assert.equal(receipt.amiId, "ami-bbbbbbbbbbbbbbbbb");
    assert.equal(receipt.compilerImageDigest, DIGEST);
    assert.equal(receipt.highVulnerabilityCount, 0);
    assert.throws(() => createEvidenceReceipt({
      variables,
      packerManifest: {builds: [{...packerManifest.builds[0], custom_data: {...custom_data, node_archive_sha256: "b".repeat(64)}}]},
      packerManifestBytes,
      reports: {hostSbom: sbom, hostVulnerabilities: vulnerabilities, compilerSbom: sbom, compilerVulnerabilities: vulnerabilities},
      approval
    }), /does not match/);
  });

  it("fails preflight unless host identity, manifest, workspace, and image agree", async () => {
    const validManifest = manifest();
    const inspection = [{Id: DIGEST, Architecture: "arm64", Config: {User: "10001:10001"}}];
    const sbom = Buffer.from(JSON.stringify({bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: []}));
    const vulnerabilities = Buffer.from(JSON.stringify({SchemaVersion: 2, Results: []}));
    const evidenceHashes = [sbom, vulnerabilities, sbom, vulnerabilities]
      .map((bytes) => createHash("sha256").update(bytes).digest("hex"));
    Object.assign(validManifest, {
      hostSbomSha256: evidenceHashes[0],
      hostVulnerabilityReportSha256: evidenceHashes[1],
      compilerSbomSha256: evidenceHashes[2],
      compilerVulnerabilityReportSha256: evidenceHashes[3]
    });
    assert.equal(validateRunnerManifest(validManifest, DIGEST), validManifest);
    assert.equal(validatePodmanInspection(inspection, DIGEST), inspection[0]);
    assert.equal(validateEvidenceDocument(sbom, "sbom").bomFormat, "CycloneDX");
    const result = await verifyHost({
      environment: environment(),
      architecture: "arm64",
      uid: 10001,
      gid: 10001,
      readText: async () => JSON.stringify(validManifest),
      readBytes: async (path) => path.includes("sbom") ? sbom : vulnerabilities,
      statPath: async () => ({isDirectory: () => true, uid: 10001, gid: 10001, mode: 0o40700}),
      inspect: async () => inspection
    });
    assert.equal(result.compilerImageDigest, DIGEST);
    await assert.rejects(() => verifyHost({
      environment: environment(), architecture: "x64", uid: 10001, gid: 10001
    }), /host identity is invalid/);
    assert.throws(() => validateRunnerManifest({...validManifest, highVulnerabilityCount: 1}, DIGEST), /manifest is invalid/);
    assert.throws(() => validatePodmanInspection([{...inspection[0], Architecture: "amd64"}], DIGEST), /image is invalid/);
    assert.throws(() => validateEvidenceDocument(
      Buffer.from(JSON.stringify({SchemaVersion: 2, Results: [{Vulnerabilities: [{Severity: "HIGH"}]}]})),
      "vulnerabilities"
    ), /vulnerability evidence is invalid/);
  });
});


describe("privileged analysis bake staging", () => {
  // The installer retains its fixed production paths. Only filesystem/command adapters
  // are replaced: actual tar extraction and module/profile parsing run unprivileged.
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "analysis-installer-test-"));
    const root = join(directory, "root"), payload = "/tmp/opengeo-analysis-payload";
    const mapped = path => ["/opt", "/etc", "/var", "/run", payload, "/tmp/opengeo-analysis-coordinator.service"]
      .some(prefix => path === prefix || path.startsWith(prefix + "/")) ? root + path : path;
    for (const path of [payload, "/opt/opengeo", "/etc/systemd/system", "/var/lib", "/run"]) FS.mkdirSync(mapped(path), {recursive: true});
    const owners = new Map(), mutations = [];
    const filesystem = {...FS};
    for (const name of ["existsSync", "readFileSync", "writeFileSync", "chmodSync", "chownSync", "mkdirSync", "lstatSync"]) {
      filesystem[name] = (path, ...args) => {
        if (name === "lstatSync") {
          const info = FS.lstatSync(mapped(path)), [uid, gid] = owners.get(path) ?? [0, 0];
          return Object.assign(Object.create(info), {uid, gid});
        }
        if (["writeFileSync", "chmodSync", "chownSync", "mkdirSync"].includes(name)) mutations.push({name, path});
        if (name === "chownSync") {owners.set(path, args);return;}
        return FS[name](mapped(path), ...args);
      };
    }
    const run = (file, args) => {
      assert.equal(file, "tar", "no account, image, scanner or systemd command is run in this check");
      const result = spawnSync(file, args.map(mapped), {encoding: "utf8", timeout: 2000});
      assert.equal(result.status, 0, result.stderr);return result.stdout;
    };
    const archive = await buildCoordinatorArchive(mapped(payload + "/analysis.tar"), {analysis: true});
    const source = join(directory, "oci");FS.mkdirSync(source);FS.writeFileSync(join(source, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
    run("tar", ["--create", "--file", mapped(payload + "/image.tar"), "--directory", source, "oci-layout"]);
    const architecture = process.arch === "x64" ? "amd64" : process.arch;
    const profiles = {schemaVersion: 1, architecture, profiles: {
      python: {image: DIGEST, interpreter: "/usr/bin/python3"},
      javascript: {image: DIGEST, interpreter: "/usr/local/bin/node"},
      bash: {image: DIGEST, interpreter: "/bin/bash"}
    }};
    const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    const inputs = {schemaVersion: "opengeo.analysis-ami-inputs.1", package: {file: "analysis.tar", sha256: digest(FS.readFileSync(archive))},
      profiles, profilesSha256: digest(canonical(profiles)), images: [{file: "image.tar", image: DIGEST, sha256: digest(FS.readFileSync(mapped(payload + "/image.tar")))}]};
    FS.writeFileSync(mapped("/tmp/opengeo-analysis-coordinator.service"), "[Service]\nUser=opengeo-analysis\n");
    const save = () => FS.writeFileSync(mapped(payload + "/inputs.json"), JSON.stringify(inputs));save();
    const install = () => installAnalysisRunner(payload, {filesystem, run, uid: 0, architecture: process.arch,
      nodeVersion: "v24.19.0", identity: () => false});
    return {directory, mapped, inputs, owners, mutations, filesystem, save, install, digest, canonical};
  }
  it("verifies the actual archive/profile closure before writes and preserves identical installed bytes", async () => {
    const f = await fixture();
    try {
      const installed = await f.install();assert.equal(installed.amiManifest.account.uid, 10002);
      const target = f.mapped("/opt/opengeo/analysis-coordinator/src/runtime.mjs"), before = FS.statSync(target);
      assert.equal(before.mode & 0o777, 0o444);
      assert.equal(FS.statSync(f.mapped("/opt/opengeo/analysis-coordinator/src")).mode & 0o777, 0o755);
      f.mutations.length = 0;await f.install();
      assert.equal(FS.statSync(target).ino, before.ino);assert.equal(FS.statSync(target).mtimeMs, before.mtimeMs);
      assert.equal(f.mutations.length, 0, "an identical package does not rewrite/chmod existing shared files");
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("rejects a complete but invalid interpreter profile before any destination mutation", async () => {
    const f = await fixture();
    try {
      f.inputs.profiles.profiles.python.interpreter = "/tmp/other-python";
      f.inputs.profilesSha256 = f.digest(f.canonical(f.inputs.profiles));f.save();
      await assert.rejects(f.install, /analysis_profile_invalid/);assert.equal(f.mutations.length, 0);
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("rejects missing or corrupt OCI inventories before installing package files", async () => {
    const f = await fixture();
    try {
      f.inputs.images[0].sha256 = "f".repeat(64);f.save();
      await assert.rejects(f.install, /artifact mismatch/);assert.equal(f.mutations.length, 0);
      f.inputs.images[0].sha256 = f.digest(FS.readFileSync(f.mapped("/tmp/opengeo-analysis-payload/image.tar")));
      f.inputs.images[0].image = `sha256:${"e".repeat(64)}`;f.save();
      await assert.rejects(f.install, /image inventory/);assert.equal(f.mutations.length, 0);
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("refuses symlinked or differing shared destinations without touching the link target", async () => {
    const f = await fixture();
    try {
      const external = join(f.directory, "untouched");FS.mkdirSync(external);FS.writeFileSync(join(external, "sentinel"), "keep");
      const destination = f.mapped("/opt/opengeo/analysis-coordinator");FS.symlinkSync(external, destination);
      await assert.rejects(f.install, /Unsafe analysis installation directory/);assert.equal(f.mutations.length, 0);
      assert.equal(FS.readFileSync(join(external, "sentinel"), "utf8"), "keep");FS.unlinkSync(destination);
      FS.mkdirSync(f.mapped("/opt/opengeo/analysis-coordinator/src"), {recursive: true});
      const file = f.mapped("/opt/opengeo/analysis-coordinator/src/runtime.mjs");FS.writeFileSync(file, "different shared runtime");
      await assert.rejects(f.install, /differs from installed shared runtime/);assert.equal(f.mutations.length, 0);
      assert.equal(FS.readFileSync(file, "utf8"), "different shared runtime");
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("rejects duplicate tar members and pre-existing runtime allocation before writes", async () => {
    const f = await fixture();
    try {
      const archive = f.mapped("/tmp/opengeo-analysis-payload/analysis.tar");
      const member = join(f.directory, "analysis-package.json");FS.writeFileSync(member, "{}");
      const appended = spawnSync("tar", ["--append", "--file", archive, "--directory", f.directory, "analysis-package.json"], {timeout: 2000});
      assert.equal(appended.status, 0);f.inputs.package.sha256 = f.digest(FS.readFileSync(archive));f.save();
      await assert.rejects(f.install, /Unsafe analysis archive members/);assert.equal(f.mutations.length, 0);
      await buildCoordinatorArchive(archive, {analysis: true});f.inputs.package.sha256 = f.digest(FS.readFileSync(archive));f.save();
      FS.mkdirSync(f.mapped("/var/lib/opengeo-analysis"));
      await assert.rejects(f.install, /runtime directory already allocated/);assert.equal(f.mutations.length, 0);
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("rejects subordinate-ID symlinks and overlapping allocations without package writes", async () => {
    const f = await fixture();
    try {
      const path = f.mapped("/etc/subuid");FS.symlinkSync(join(f.directory, "missing-subids"), path);
      await assert.rejects(f.install, /Unsafe analysis subordinate ID file/);assert.equal(f.mutations.length, 0);
      FS.unlinkSync(path);FS.writeFileSync(path, "another-account:265535:2\n");
      await assert.rejects(f.install, /subordinate IDs already allocated or invalid/);assert.equal(f.mutations.length, 0);
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
  it("never follows or chowns a pre-existing runtime directory or a dangling symlink", async () => {
    const f = await fixture();
    try {
      const home = f.mapped("/var/lib/opengeo-analysis");FS.symlinkSync(join(f.directory, "missing"), home);
      assert.throws(() => ensureAnalysisDirectory("/var/lib/opengeo-analysis", {filesystem: f.filesystem}), /Unsafe analysis runtime directory/);
      assert.equal(f.mutations.length, 0);FS.unlinkSync(home);FS.mkdirSync(home);
      assert.throws(() => ensureAnalysisDirectory("/var/lib/opengeo-analysis", {filesystem: f.filesystem}), /Unsafe analysis runtime directory/);
      assert.equal(f.mutations.length, 0, "foreign ownership must not be corrected by chown");
      f.owners.set("/var/lib/opengeo-analysis", [10002, 10002]);
      ensureAnalysisDirectory("/var/lib/opengeo-analysis/tmp", {filesystem: f.filesystem});
      assert.equal(FS.statSync(f.mapped("/var/lib/opengeo-analysis/tmp")).mode & 0o777, 0o700);
      assert.deepEqual(f.owners.get("/var/lib/opengeo-analysis/tmp"), [10002, 10002]);
      assert.throws(() => ensureAnalysisDirectory("/tmp/arbitrary", {filesystem: f.filesystem}), /Invalid analysis runtime directory/);
    } finally {await rm(f.directory, {recursive: true, force: true});}
  });
});
