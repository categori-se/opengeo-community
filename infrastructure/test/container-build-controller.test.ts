import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";

const controller = readFileSync(
  new URL("../bootstrap/run-opengeo-container-build-controller.sh", import.meta.url),
  "utf8"
);

describe("native ARM64 container build controller", () => {
  it("validates the three exact target sets without installing tools or touching controller paths", () => {
    const script = fileURLToPath(new URL("../bootstrap/run-opengeo-container-build-controller.sh", import.meta.url));
    const environment = {
      ...process.env,
      OPEN_GEO_RELEASE_ID: "20260907160000-123456abcdef",
      OPEN_GEO_ARTIFACT_BUCKET: "opengeo-dev-build-222222222222-us-east-1",
      OPEN_GEO_S3_PREFIX: "container-images/20260907160000-123456abcdef",
      OPEN_GEO_API_REPOSITORY_URI: "222222222222.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/api",
      OPEN_GEO_BUILDER_REPOSITORY_URI: "222222222222.dkr.ecr.us-east-1.amazonaws.com/opengeo/observable-builder",
      OPEN_GEO_WORKER_REPOSITORY_URI: "222222222222.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/gis-worker"
    };
    for (const targets of ["api", "api,builder", "api,worker"]) {
      const result = spawnSync("bash", [script, "--validate-inputs"], {encoding: "utf8", env: {...environment, OPEN_GEO_BUILD_TARGETS: targets}});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `Validated container build input scope: ${targets}`);
    }
    const runtime = spawnSync("bash", [script, "--validate-inputs"], {encoding: "utf8", env: {...environment, OPEN_GEO_BUILD_TARGETS: "api", OPEN_GEO_RUNTIME_BACKPORTS: "true"}});
    assert.equal(runtime.status, 0, runtime.stderr);
    for (const mutation of [
      {OPEN_GEO_RUNTIME_BACKPORTS: "true"},
      {OPEN_GEO_RUNTIME_BACKPORTS: "unexpected"},
      {OPEN_GEO_BUILD_TARGETS: "api,worker,builder"},
      {OPEN_GEO_BUILD_TARGETS: "worker"},
      {OPEN_GEO_WORKER_REPOSITORY_URI: "111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/demo/gis-worker"},
      {OPEN_GEO_WORKER_REPOSITORY_URI: "222222222222.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/worker"},
      {OPEN_GEO_S3_PREFIX: "container-images/another-release"}
    ]) {
      const result = spawnSync("bash", [script, "--validate-inputs"], {encoding: "utf8", env: {...environment, OPEN_GEO_BUILD_TARGETS: "api,worker", ...mutation}});
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /Installing|Downloading|Validated/);
    }
  });
  it("supports an exact API-only target without changing the established default", () => {
    assert.match(controller, /BUILD_TARGETS="\$\{OPEN_GEO_BUILD_TARGETS:-api,builder\}"/);
    assert.match(controller, /case "\$BUILD_TARGETS" in\s+api\)/);
    assert.match(controller, /api,builder\)/);
    assert.match(controller, /OPEN_GEO_BUILD_TARGETS must be exactly api, api,builder, or api,worker/);
  });

  it("guards every builder build, scan, push, digest, and ECR scan path", () => {
    for (const operation of [
      /if \$BUILD_BUILDER; then[\s\S]*?docker build[\s\S]*?services\/observable-builder[\s\S]*?fi/,
      /if \$BUILD_BUILDER; then[\s\S]*?scan_image builder[\s\S]*?fi/,
      /if \$BUILD_BUILDER; then[\s\S]*?docker push "\$OPEN_GEO_BUILDER_REPOSITORY_URI[\s\S]*?fi/,
      /if \$BUILD_BUILDER; then[\s\S]*?read_ecr_manifest_digest opengeo\/observable-builder[\s\S]*?fi/,
      /if \$BUILD_BUILDER; then[\s\S]*?wait_for_ecr_scan_gate opengeo\/observable-builder[\s\S]*?fi/
    ]) assert.match(controller, operation);
  });

  it("records an explicit API-only receipt with no builder artifact", () => {
    assert.match(controller, /buildTargets:\$buildTargets,builder:null,api:/);
    assert.match(controller, /wait_for_ecr_scan_gate opengeo\/dev\/api/);
    assert.match(controller, /opengeo-api-import-ok/);
    assert.match(controller, /HIGH or CRITICAL vulnerabilities/);
  });

  it("gates the separate worker target through toolchain smoke, both scans and immutable promotion", () => {
    assert.match(controller, /api,worker\)\s+readonly BUILD_BUILDER=false\s+readonly BUILD_WORKER=true/);
    assert.match(controller, /opengeo\/dev\/gis-worker\$' OPEN_GEO_WORKER_REPOSITORY_URI/);
    assert.match(controller, /--network none --read-only --cap-drop ALL/);
    assert.match(controller, /--security-opt no-new-privileges --memory 4g --cpus 2 --pids-limit 256/);
    assert.match(controller, /runpy\.run_path\("scripts\/verify-toolchain\.py"/);
    assert.match(controller, /opengeo-worker-toolchain-ok/);
    assert.match(controller, /worker-clamav-version\.txt/);
    for (const operation of [
      /if \$BUILD_WORKER; then[\s\S]*?docker build[\s\S]*?services\/worker[\s\S]*?fi/,
      /if \$BUILD_WORKER; then[\s\S]*?scan_image worker[\s\S]*?fi/,
      /if \$BUILD_WORKER; then[\s\S]*?docker push "\$OPEN_GEO_WORKER_REPOSITORY_URI[\s\S]*?fi/,
      /if \$BUILD_WORKER; then[\s\S]*?read_ecr_manifest_digest opengeo\/dev\/gis-worker[\s\S]*?fi/,
      /if \$BUILD_WORKER; then[\s\S]*?wait_for_ecr_scan_gate opengeo\/dev\/gis-worker[\s\S]*?fi/
    ]) assert.match(controller, operation);
    assert.ok(controller.indexOf('scan_image worker "$RELEASE_ROOT/worker.image.tar"') < controller.indexOf('docker push "$OPEN_GEO_WORKER_REPOSITORY_URI'));
    assert.match(controller, /scan-native-libraries\.py[\s\S]*?--image "\$worker_config_digest"/);
    assert.match(controller, /--output "\$RESULTS_DIR\/worker-native-scan"/);
    assert.ok(controller.indexOf('scan-native-libraries.py') < controller.indexOf('docker push "$OPEN_GEO_WORKER_REPOSITORY_URI'));
    assert.match(controller, /schemaVersion:"opengeo.container-build-result\.1\.1\.0"/);
    assert.match(controller, /worker:\{configDigest:\$workerConfigDigest,ecrManifestDigest:\$workerManifestDigest/);
  });

  it("rejects empty scanner output and incomplete ECR pages, including aggregate-only findings", () => {
    const trivy = controller.match(/jq -e '([^']+)' \\\n\s+"\$RESULTS_DIR\/\$\{name\}-vulnerabilities\.json"/)?.[1];
    const ecr = controller.match(/jq -e '([^']+)' \\\n\s+<<<"\$response"/)?.[1];
    const counter = controller.match(/findings="\$\(jq '(\[\(\[\.imageScanFindings[^']+)'/)?.[1];
    assert.ok(trivy && ecr && counter);
    const evaluate = (filter: string, input: unknown) => spawnSync("jq", ["-ne", "--argjson", "report", JSON.stringify(input), `$report | (${filter})`], {encoding: "utf8", timeout: 5_000});
    for (const input of [{}, {Results: []}, {Results: ["invalid"]}]) assert.notEqual(evaluate(trivy, input).status, 0);
    assert.equal(evaluate(trivy, {Results: [{Target: "worker", Vulnerabilities: []}]}).status, 0);
    assert.notEqual(evaluate(ecr, {imageScanFindings: {findings: []}, nextToken: "more"}).status, 0);
    assert.notEqual(evaluate(ecr, {}).status, 0);
    assert.equal(evaluate(ecr, {imageScanFindings: {findings: []}}).status, 0);
    assert.equal(evaluate(counter, {imageScanFindings: {findings: [], findingSeverityCounts: {HIGH: 2, CRITICAL: 1}}}).stdout.trim(), "3");
    assert.equal(evaluate(counter, {imageScanFindings: {findings: [{severity: "HIGH"}]}}).stdout.trim(), "1");
  });
});
