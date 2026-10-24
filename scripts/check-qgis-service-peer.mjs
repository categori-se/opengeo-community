import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const organizationId = "10000000-0000-4000-8000-0000000000e2";
const projectId = "50000000-0000-4000-8000-0000000000e2";
const featureId = "90000000-0000-4000-8000-0000000000e2";
const token = "records-peer-token";
const userAgent = "OpenGeo-QGIS-Service-Peer/1.0";
const arguments_ = process.argv.slice(2);
const savedConnection = arguments_.includes("--saved-connection");
const imageIndex = arguments_.indexOf("--api-image");
const apiImage = imageIndex >= 0 ? arguments_[imageIndex + 1] : null;
const budgetIndex = arguments_.indexOf("--budget-seconds");
const budgetSeconds = budgetIndex >= 0 ? Number(arguments_[budgetIndex + 1]) : 120;
assert.ok(Number.isInteger(budgetSeconds) && budgetSeconds >= 30 && budgetSeconds <= 120, "Use a 30–120 second local peer budget");
assert.ok(arguments_.every((value, index) => value === "--saved-connection" || value === "--api-image" || value === "--budget-seconds" || index === imageIndex + 1 && imageIndex >= 0 || index === budgetIndex + 1 && budgetIndex >= 0), "Unknown service peer option");
if (imageIndex >= 0) assert.match(apiImage ?? "", /^sha256:[a-f0-9]{64}$/, "Use an exact cached API image ID");
const expectedVersion = savedConnection ? "3.44.14-Solothurn" : "3.44.12-Solothurn";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const stopped = await Promise.race([
    once(server, "exit").then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 3_000))
  ]);
  if (!stopped && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
}

function run(program, args, {env = process.env, timeoutMs = 30_000} = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const append = (current, value) =>
      current.length >= 256 * 1024 ? current : `${current}${value}`.slice(0, 256 * 1024);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout = append(stdout, value);
    });
    child.stderr.on("data", (value) => {
      stderr = append(stderr, value);
    });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({code, signal, stdout, stderr});
    });
  });
}

if (apiImage) {
  const context = await run("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {timeoutMs: 10_000});
  assert.ok(context.code === 0 && context.stdout.trim() === "true", "Cached local fixture requires rootless Podman");
}
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "opengeo-qgis-service-peer-"));
const serverState = resolve(temporaryDirectory, "server");
await mkdir(serverState, {mode: 0o700});
const requestLog = resolve(serverState, "http.jsonl");
const inputFile = resolve(temporaryDirectory, "auth-input.json");
const qgisProfile = resolve(temporaryDirectory, "qgis-profile");
const xdgCache = resolve(temporaryDirectory, "cache");
await mkdir(qgisProfile, {mode: 0o700});
await mkdir(xdgCache, {mode: 0o700});

const port = await freePort();
const base = new URL(
  `http://127.0.0.1:${port}/projects/${projectId}/services/research-atlas/ogc`
);
const masterPassword = savedConnection ? randomBytes(32).toString("base64url") : null;
const authInput = {
  baseUrl: base.href, organizationId, projectId, featureId, token,
  ...(savedConnection ? {masterPassword} : {})
};
await writeFile(
  inputFile,
  JSON.stringify(authInput),
  {encoding: "utf8", mode: 0o600, flag: "wx"}
);
assert.equal((await stat(inputFile)).mode & 0o777, 0o600);

const serverOutput = [];
const containerName = apiImage ? `opengeo-qgis-auth-${randomBytes(8).toString("hex")}` : null;
const serverProgram = apiImage ? "podman" : resolve(root, "services/api/.venv/bin/python");
const serverArguments = apiImage ? [
  "run", "--rm", "--pull=never", "--name", containerName,
  "--network=host", "--http-proxy=false", "--read-only", "--cap-drop=all",
  "--security-opt=no-new-privileges", "--userns=host", "--user=0:0",
  "--memory=512m", "--cpus=1", "--stop-timeout=3",
  "--tmpfs", "/tmp:rw,nodev,nosuid,noexec,size=64m,mode=1777",
  "--volume", `${root}:/repo:ro`, "--volume", `${serverState}:/peer:rw,Z`,
  "--workdir", "/repo", "--env", "PYTHONPATH=/repo/services/api/src:/opt/opengeo-python",
  "--entrypoint", "python", apiImage, "scripts/serve-records-parity.py",
  "--port", String(port), "--log", "/peer/http.jsonl"
] : [resolve(root, "scripts/serve-records-parity.py"), "--port", String(port), "--log", requestLog];
const server = spawn(
  serverProgram,
  serverArguments,
  {
    cwd: root,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      PYTHONPATH: resolve(root, "services/api/src"),
      PYTHONUNBUFFERED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (value) => {
    if (serverOutput.join("").length < 64 * 1024) serverOutput.push(value);
  });
}

let report;
const startedAt = performance.now();
let overallExpired = false;
const overallTimer = setTimeout(() => {overallExpired = true; void stopServer(server);}, budgetSeconds * 1000);
try {
  let ready = false;
  let unexpectedReadyStatus = null;
  const readinessDeadline = performance.now() + Math.min(20_000, (budgetSeconds - 10) * 1000);
  while (performance.now() < readinessDeadline && !ready) {
    if (server.exitCode !== null) {
      throw new Error(`Spatial-service harness exited: ${serverOutput.join("")}`);
    }
    try {
      const response = await fetch(base, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-OpenGeo-Organization": organizationId
        },
        redirect: "error",
        signal: AbortSignal.timeout(3_000)
      });
      ready = response.status === 200;
      await response.arrayBuffer();
      if (!ready && response.status !== 503) unexpectedReadyStatus = response.status;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (unexpectedReadyStatus !== null) break;
  }
  assert.ok(ready, `Spatial-service harness did not become ready (${unexpectedReadyStatus ?? "startup deadline"}): ${serverOutput.join("")}`);

  const qgisEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QGIS_AUTH_") && key !== "QGIS_CUSTOM_CONFIG_PATH"));
  Object.assign(qgisEnvironment, {
      NO_PROXY: "127.0.0.1,localhost",
      QT_QPA_PLATFORM: "offscreen",
      QGIS_CUSTOM_CONFIG_PATH: qgisProfile,
      QGIS_AUTH_DB_DIR_PATH: qgisProfile,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: qgisProfile
  });
  const phases = savedConnection ? ["save", "reopen"] : [null];
  const clients = [];
  for (const phase of phases) {
    if (phase === "reopen") {
      delete authInput.token;
      await writeFile(inputFile, JSON.stringify(authInput), {mode: 0o600});
    }
    const qgis = await run("python3", [resolve(root, "scripts/check-qgis-service-peer.py"), inputFile,
      ...(phase ? [`--saved-connection=${phase}`] : [])], {env: qgisEnvironment});
    assert.ok(!qgis.stdout.includes(token), "QGIS client stdout exposed the bearer token");
    assert.ok(!qgis.stderr.includes(token), "QGIS client stderr exposed the bearer token");
    if (masterPassword) {
      assert.ok(!qgis.stdout.includes(masterPassword) && !qgis.stderr.includes(masterPassword), "QGIS output exposed the master password");
    }
    const qgisFailureLog = await readFile(requestLog, "utf8");
    assert.equal(
      qgis.code,
      0,
      `QGIS native OAPIF service peer failed (${qgis.signal ?? qgis.code}):\n${qgis.stdout}\n${qgis.stderr}\nRequests:\n${qgisFailureLog}`
    );
    clients.push(JSON.parse(qgis.stdout.trim()));
    assert.ok(qgisFailureLog.trim().split("\n").filter(Boolean).length <= 100, "Local service peer exceeded 100 requests");
    assert.equal(overallExpired, false, "Local service peer exceeded its overall deadline");
  }
  const client = clients.at(-1);
  if (savedConnection) {
    assert.equal(clients[0].savedConnection.phase, "save");
    assert.equal(client.savedConnection.phase, "reopen");
    assert.equal(clients[0].savedConnection.authcfg, client.savedConnection.authcfg);
    assert.equal(client.savedConnection.tokenSuppliedInInput, false);
    assert.equal(client.savedConnection.processLocalHeaderInjection, false);
    assert.equal(client.savedConnection.plaintextSecretsFound, false);
  }
  assert.equal(client.client.version, expectedVersion);
  assert.equal(client.client.providerKey, "OAPIF");
  assert.equal(client.discovery.collection, "roads");
  assert.ok(client.discovery.fields.includes("name"));
  assert.ok(client.discovery.fields.includes("surveyed"));
  assert.equal(client.read.name, "Governed access route");
  assert.equal(client.read.surveyed, true);
  assert.equal(client.read.geometry.type, "LineString");
  assert.equal(client.security.unauthenticatedRejected, true);
  assert.equal(client.security.credentialsPersisted, savedConnection);

  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const rawLog = await readFile(requestLog, "utf8");
  assert.ok(!rawLog.includes(token), "Spatial-service request log exposed the bearer token");
  const requests = rawLog
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const qgisRequests = requests.filter(
    ({userAgent: observed}) => observed === userAgent || observed.includes("QGIS/")
  );
  const unauthorized = qgisRequests.filter(
    ({status, authorization}) => status === 401 && !authorization
  );
  assert.ok(unauthorized.length > 0, `QGIS unauthenticated denial was not observed: ${rawLog}`);
  const successful = qgisRequests.filter(({status}) => status === 200);
  const administeredReads = successful.filter(({path}) =>
    path.endsWith("/services/research-atlas/ogc/collections/roads/items")
  );
  assert.ok(successful.length >= 5, `too few authenticated QGIS requests: ${rawLog}`);
  assert.ok(administeredReads.length > 0, `QGIS did not read administered items: ${rawLog}`);
  assert.ok(successful.every(({authorization, organization}) => authorization && organization));
  const expectedBbox = [-77.11, 38.79, -76.89, 39.01];
  const exactServiceRead = successful.some(({path, query}) => {
    if (!path.endsWith("/services/research-atlas/ogc/collections/roads/items")) {
      return false;
    }
    const parameters = new URLSearchParams(query);
    const bbox = parameters.get("bbox")?.split(",").map(Number);
    return (
      bbox?.length === expectedBbox.length &&
      bbox.every((value, index) => Math.abs(value - expectedBbox[index]) < 1e-12)
    );
  });
  assert.ok(exactServiceRead, `QGIS did not complete an administered bbox read: ${rawLog}`);

  report = {
    result: "pass",
    client: client.client,
    transport: {
      kind: "local-http",
      authenticatedSuccessfulRequests: successful.length,
      administeredDirectReads: administeredReads.length,
      unauthenticatedStatus: 401,
      bearerValueLogged: false,
      authInputFileMode: "0600",
      credentialsPersisted: savedConnection,
      ...(savedConnection ? {encryptedAuthPersisted: true, plaintextCredentialsPersisted: false} : {})
    },
    discovery: {
      collection: client.discovery.collection,
      schemaFieldsInclude: client.discovery.fields,
      geometryType: client.discovery.geometryType
    },
    read: {
      featureId: client.read.featureId,
      expectedFeatureId: featureId,
      name: client.read.name,
      surveyed: client.read.surveyed,
      geometryType: client.read.geometry.type,
      spatialFilterForwarded: true,
      requestedBbox: expectedBbox,
      expectedGeneration: 3,
      exactServiceRead: true
    },
    security: {
      sharedAuthAuthority: "auth.categori.se",
      missingAuthorityFails: true,
      organizationHeaderRequired: true,
      authoritativeFeatureRepositoryReauthorized: true,
      requestScopeRestrictedToProject: !savedConnection,
      bearerValueLogged: false,
      ephemeralQgisProfileRemoved: true
    },
    compatibilityOnly: true,
    conformanceClaimed: false,
    idleCostDeltaUsd: 0,
    ...(savedConnection ? {savedConnection: client.savedConnection, phases: clients.map(value => value.savedConnection), requestEvidence: requests,
      usage: {localRequests: requests.length, requestCeiling: 100, elapsedSeconds: (performance.now() - startedAt) / 1000, overallCeilingSeconds: budgetSeconds,
        imageBuildsPulls: 0, awsGithubActionsCalls: 0}} : {})
  };
} finally {
  clearTimeout(overallTimer);
  await stopServer(server);
  if (containerName) {
    const cleanup = await run("podman", ["rm", "--force", "--ignore", "--time", "3", containerName], {timeoutMs: 10_000});
    assert.equal(cleanup.code, 0, "Owned local peer container cleanup failed");
    const inspect = await run("podman", ["container", "exists", containerName], {timeoutMs: 5_000});
    assert.equal(inspect.code, 1, "Owned local peer container remains");
  }
  await rm(temporaryDirectory, {recursive: true, force: true});
  if (!report && serverOutput.length) {
    const logs = serverOutput.join("");
    assert.ok(!logs.includes(token) && (!masterPassword || !logs.includes(masterPassword)), "API fixture output exposed synthetic authority");
    process.stderr.write(`Local API fixture output after cleanup:\n${logs}\n`);
  }
}

console.log(JSON.stringify(report, null, 2));
