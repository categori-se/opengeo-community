import assert from "node:assert/strict";
import {mkdtempSync, chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {inspectOutputs, LOCALIZED_INVOCATION_SCHEMA, parseInvocation} from "../src/contract.mjs";
import {executionLimits, maximumOutputFileBytes, parseCompilerReport} from "../../observable-coordinator/src/contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.argv[2] ?? "localhost/opengeo-observable-builder:test";
// Reuse this same isolation check for a supplied exact-revision fixture.
const fixtureRoot = resolve(process.argv[3] ?? join(root, "test", "fixture"));
const retainedOutput = process.argv[4] ? resolve(process.argv[4]) : null;
// Local source acceptance only; an overlay does not produce a release image.
const sourceOverlay = process.argv[5] ? resolve(process.argv[5]) : null;
const temporaryRoot = mkdtempSync(join(tmpdir(), "opengeo-observable-container-"));
const workspace = join(temporaryRoot, "workspace");
const result = join(temporaryRoot, "result");

function run(command, args) {
  const execution = spawnSync(command, args, {encoding: "utf8", maxBuffer: 2 * 1024 * 1024});
  if (execution.error || execution.status !== 0) {
    const detail = `${execution.stderr ?? ""}\n${execution.stdout ?? ""}`
      .replaceAll("must-not-reach-the-compiler", "[redacted]")
      .trim()
      .slice(-2000);
    throw new Error(`${command} failed with status ${execution.status ?? "unknown"}: ${detail}`);
  }
  return execution.stdout;
}

try {
  chmodSync(temporaryRoot, 0o755);
  for (const path of [workspace, result]) {
    mkdirSync(path);
    chmodSync(path, 0o777);
  }

  const inspection = JSON.parse(run("podman", ["image", "inspect", image]));
  assert.equal(inspection.length, 1);
  assert.equal(inspection[0].Config.User, "10001:10001");
  assert.equal(inspection[0].Config.Env.some((value) => value === "OBSERVABLE_TELEMETRY_DISABLE=true"), true);
  assert.deepEqual(inspection[0].Config.Entrypoint.slice(0, 2), [
    "/nodejs/bin/node",
    "/srv/opengeo/src/cli.mjs"
  ]);

  run("podman", [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1024m",
    "--cpus=1",
    "--userns=keep-id:uid=10001,gid=10001",
    "--user=10001:10001",
    "--env=AWS_ACCESS_KEY_ID=must-not-reach-the-compiler",
    "--env=OPEN_GEO_DB_PASSWORD=must-not-reach-the-compiler",
    "--env=HTTP_PROXY=http://127.0.0.1:9",
    `--volume=${fixtureRoot}:/contract:ro,Z`,
    `--volume=${join(fixtureRoot, "input")}:/input:ro,Z`,
    `--volume=${workspace}:/workspace:rw,Z`,
    `--volume=${result}:/result:rw,Z`,
    ...(sourceOverlay ? [
      `--volume=${join(sourceOverlay, "src")}:/srv/opengeo/src:ro,Z`,
      `--volume=${join(sourceOverlay, "notebook-assets.json")}:/srv/opengeo/notebook-assets.json:ro,Z`
    ] : []),
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
    image
  ]);

  const report = JSON.parse(readFileSync(join(result, "compiler-report.json"), "utf8"));
  const invocation = JSON.parse(readFileSync(join(fixtureRoot, "invocation.json"), "utf8"));
  if (invocation.schemaVersion === LOCALIZED_INVOCATION_SCHEMA) {
    const parsed = parseInvocation(invocation);
    const claim = {
      buildJobId: parsed.buildJobId,
      requestChecksumSha256: parsed.requestChecksumSha256,
      inputManifestChecksumSha256: parsed.inputManifestChecksumSha256,
      request: parsed.request,
      inputManifest: {
        entryPath: parsed.entryPath,
        lockfilePath: parsed.lockfilePath,
        files: parsed.files,
        dataAttachments: parsed.dataFiles
      },
      inputFileCount: parsed.allFiles.length,
      inputBytes: parsed.inputBytes
    };
    // Reuse the production report validator, including the canonical manifest
    // seal, exact archive pins, fixed one-file output and output-tree seal.
    const accepted = parseCompilerReport(report, claim);
    const limits = executionLimits(parsed.request);
    const finalOutput = inspectOutputs(join(workspace, "job", "dist"), limits,
      maximumOutputFileBytes(accepted.outputManifest.files[0], parsed.request, parsed.dataFiles, true));
    assert.deepEqual(finalOutput.files, accepted.outputManifest.files);
    assert.equal(finalOutput.outputTreeChecksumSha256, accepted.outputTreeChecksumSha256);
    // Verify the manifest's retained native graph against the actual compiler
    // files before temporary cleanup; metadata alone is not byte acceptance.
    const nativeOutput = inspectOutputs(join(workspace, "job", `.opengeo-native-output-${parsed.buildJobId}`, "dist"),
      limits, Math.min(limits.maxOutputBytes, 32 * 1024 * 1024),
      parsed.request.outputProfile === "archive-96m" ? parsed.dataFiles : []);
    const nativeFiles = new Map(nativeOutput.files.map(file => [file.path, file]));
    for (const file of accepted.localizedOutput.manifest.inputFiles) {
      assert.deepEqual(nativeFiles.get(file.path), file);
    }
    assert.equal(nativeOutput.outputTreeChecksumSha256, accepted.localizedOutput.manifest.sourceOutputTreeChecksumSha256);
  } else {
    assert.equal(report.schemaVersion, "opengeo.observable-compiler-report.1.0.0");
  }
  assert.equal(report.validationReport.frameworkVersion, "1.13.4");
  assert.equal(report.validationReport.publicationAuthorized, false);
  assert.ok(report.outputManifest.files.some(({path}) => path === "dist/index.html"));
  assert.deepEqual(report.routeManifest, [{path: "/", file: "dist/index.html"}]);
  assert.doesNotMatch(JSON.stringify(report), /must-not-reach|bucket|objectKey|s3VersionId|etag/i);
  if (retainedOutput) {
    mkdirSync(retainedOutput, {recursive: true, mode: 0o700});
    cpSync(join(workspace, "job", "dist"), join(retainedOutput, "dist"), {recursive: true, errorOnExist: true, force: false});
    writeFileSync(join(retainedOutput, "compiler-report.json"), JSON.stringify(report, null, 2) + "\n", {flag: "wx", mode: 0o600});
  }
  process.stdout.write(`Credential-free, network-none, read-only-root container ${sourceOverlay ? "source-overlay acceptance" : "build"} passed.\n`);
} finally {
  rmSync(temporaryRoot, {recursive: true, force: true});
}
