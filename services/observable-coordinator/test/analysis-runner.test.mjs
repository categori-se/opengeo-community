import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import {test} from "node:test";
import {AnalysisRunner, ANALYSIS_RESULT_PREFIX} from "../src/analysis-runner.mjs";
import {podmanArguments} from "../src/podman-runner.mjs";

const profiles = {
  python: {image: `sha256:${"a".repeat(64)}`, interpreter: "/usr/bin/python3"},
  javascript: {image: `sha256:${"b".repeat(64)}`, interpreter: "/nodejs/bin/node"},
  bash: {image: `sha256:${"c".repeat(64)}`, interpreter: "/bin/bash"}
};
const geojson = {type: "FeatureCollection", features: [{type: "Feature", id: "first",
  properties: {name: "Original point"}, geometry: {type: "Point", coordinates: [-71, 42]}}]};
const layers = [{id: "facilities", title: "Facilities", geojson,
  sourcePin: {datasetId: "10000000-0000-4000-8000-000000000001", sourceVersion: 3}}];
const request = {language: "python", code: "print('hello')\n", layers};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const resultLine = value => `${ANALYSIS_RESULT_PREFIX}${JSON.stringify(value)}\n`;

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

function fakePodman({onRun = () => ({stdout: "hello\n"}), holdRun = false,
  holdCleanup = false, cleanupCode = 0} = {}) {
  const calls = [], runStarted = deferred(), cleanupStarted = deferred();
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();child.stdout = new PassThrough();child.stderr = new PassThrough();
    child.kills = [];
    child.kill = signal => {child.kills.push(signal);queueMicrotask(() => child.emit("close", null, signal));return true;};
    const call = {command, args: [...args], options, child};calls.push(call);
    setImmediate(async () => {
      if (args[0] === "rm") {
        cleanupStarted.resolve(call);
        if (!holdCleanup) child.emit("close", cleanupCode, null);
        return;
      }
      runStarted.resolve(call);
      if (holdRun) return;
      try {
        const output = await onRun(call) ?? {};
        if (output.stdout) child.stdout.write(output.stdout);
        if (output.stderr) child.stderr.write(output.stderr);
        child.emit("close", output.exitCode ?? 0, output.signal ?? null);
      } catch (error) {child.emit("error", error);}
    });
    return child;
  };
  return {spawnProcess, calls, runStarted: runStarted.promise, cleanupStarted: cleanupStarted.promise};
}

async function fixture(action) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opengeo-analysis-test-"));
  try {await action(temporaryDirectory);}
  finally {await rm(temporaryDirectory, {recursive: true, force: true});}
}

function makeRunner(temporaryDirectory, fake, options = {}) {
  return new AnalysisRunner({enabled: true, profiles, temporaryDirectory,
    spawnProcess: fake.spawnProcess, ...options});
}

function inputMount(args) {
  const volumes = args.flatMap((value, index) => value.startsWith("--volume=") ? [value.slice(9)]
    : value === "--volume" || value === "-v" ? [args[index + 1]] : []);
  const mount = volumes.find(value => /:\/input:/.test(value));
  assert.ok(mount, "Only a read-only staged input mount is required");
  return {root: mount.split(":/input:")[0], volumes};
}

function containerName(args) {
  const joined = args.find(value => value.startsWith("--name="));
  if (joined) return joined.slice(7);
  return args[args.indexOf("--name") + 1];
}

test("analysis execution is disabled by default and unavailable profiles never launch a process", async () => {
  let calls = 0;
  const spawnProcess = () => {calls++;throw Error("Must not launch");};
  await assert.rejects(new AnalysisRunner({profiles, spawnProcess}).run(request), {code: "analysis_disabled"});
  await assert.rejects(new AnalysisRunner({enabled: true, profiles: {}, spawnProcess}).run(request),
    {code: "analysis_profile_unavailable"});
  assert.equal(calls, 0);
});

test("operator profiles and resource configuration reject mutable images and executable substitution", () => {
  for (const patch of [
    {profiles: {python: {...profiles.python, image: "python:latest"}}},
    {profiles: {python: {...profiles.python, interpreter: "/tmp/python3"}}},
    {profiles: {python: {...profiles.python, interpreter: "/usr/bin/python3 -c"}}},
    {timeoutSeconds: 0}, {timeoutSeconds: 31}, {memoryMiB: 0}
  ]) assert.throws(() => new AnalysisRunner({enabled: true, profiles, ...patch}),
    {code: "analysis_configuration_invalid"});
});

test("each language runs an exact script file in a credential-free read-only native container", async () => {
  await fixture(async temporaryDirectory => {
    for (const [language, extension, expectedFlags] of [
      ["python", "py", ["-I", "-B"]], ["javascript", "mjs", []],
      ["bash", "sh", ["--noprofile", "--norc"]]
    ]) {
      const code = `# authored code remains bytes: $(touch /tmp/host-injection)\n${language}\n`;
      let staged, metadata, observed;
      const fake = fakePodman({async onRun(call) {
        observed = call;
        const {root, volumes} = inputMount(call.args);
        staged = await readFile(join(root, `main.${extension}`), "utf8");
        metadata = JSON.parse(await readFile(join(root, "layers.json"), "utf8"));
        assert.deepEqual(JSON.parse(await readFile(join(root, "layers", "0.geojson"), "utf8")), geojson);
        assert.ok(volumes.every(value => /:ro(?:,|$)/.test(value)), "No writable host mount");
        return {stdout: `language=${language}\n${resultLine(geojson)}`, stderr: "diagnostic\n"};
      }});
      const result = await makeRunner(temporaryDirectory, fake).run({...request, language, code});
      assert.equal(staged, code);
      assert.deepEqual(metadata, [{id: layers[0].id, title: layers[0].title,
        path: "/input/layers/0.geojson", sourcePin: layers[0].sourcePin}]);
      assert.equal(observed.command, "podman");
      for (const flag of ["--network=none", "--read-only", "--cap-drop=all", "--security-opt=no-new-privileges",
        "--pull=never"]) assert.ok(observed.args.includes(flag), `Missing ${flag}`);
      assert.ok(observed.args.some(value => value.startsWith("--pids-limit=")));
      assert.ok(observed.args.some(value => value.startsWith("--memory=")));
      assert.ok(observed.args.some(value => value.startsWith("--cpus=")));
      for (const path of ["/workspace", "/output", "/tmp"]) {
        const mount = observed.args.find(value => value.startsWith(`--tmpfs=${path}:`));
        assert.ok(mount, `Missing bounded tmpfs ${path}`);
        assert.match(mount, /mode=1777$/);
        assert.doesNotMatch(mount, /(?:uid|gid)=/);
      }
      const imageIndex = observed.args.indexOf(profiles[language].image);
      assert.ok(imageIndex > 0);
      assert.ok(observed.args.includes(`--entrypoint=${profiles[language].interpreter}`));
      assert.deepEqual(observed.args.slice(imageIndex + 1), [...expectedFlags, `/input/main.${extension}`]);
      assert.equal(observed.options.shell, false);
      assert.equal(Object.keys(observed.options.env).some(key => /AWS|TOKEN|SECRET|CREDENTIAL|DATABASE/i.test(key)), false);
      assert.ok(!JSON.stringify(observed.args).includes("host-injection"));
      assert.equal(result.stdout, `language=${language}\n`);assert.equal(result.stderr, "diagnostic\n");
      assert.deepEqual(result.geojson, geojson);
      assert.equal(result.execution.language, language);assert.equal(result.execution.runtimeImage, profiles[language].image);
      assert.equal(result.execution.interpreter, profiles[language].interpreter);
      assert.equal(result.execution.exitCode, 0);assert.equal(result.execution.codeSha256, sha256(code));
      assert.deepEqual(result.execution.inputSha256, [{id: layers[0].id,
        checksumSha256: sha256(JSON.stringify(geojson)), sourcePin: layers[0].sourcePin}]);
      assert.ok(result.execution.durationMs >= 0);
      const cleanup = fake.calls.find(call => call.args[0] === "rm");
      assert.deepEqual(cleanup.args, ["rm", "--force", "--ignore", "--time=0", containerName(observed.args)]);
      assert.deepEqual(await readdir(temporaryDirectory), []);
    }
  });
});

test("request and UTF-8 byte limits reject code, Layers and unknown fields before Podman starts", async () => {
  await fixture(async temporaryDirectory => {
    const fake = fakePodman(), runner = makeRunner(temporaryDirectory, fake);
    const oversized = structuredClone(layers);oversized[0].geojson.features[0].properties.large = "x".repeat(16 * 1024 * 1024);
    for (const [input, code] of [
      [{...request, language: "ruby"}, "analysis_request_invalid"],
      [{...request, code: "é".repeat(32 * 1024 + 1)}, "analysis_script_too_large"],
      [{...request, layers: oversized}, "analysis_input_too_large"],
      [{...request, command: "whoami"}, "analysis_request_invalid"],
      [{...request, layers: null}, "analysis_request_invalid"],
      [{...request, signal: {aborted: false, addEventListener() {}}}, "analysis_request_invalid"]
    ]) await assert.rejects(runner.run(input), {code});
    assert.deepEqual(fake.calls, []);assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("ordinary output and nonzero exits remain real logs without inventing a GeoJSON result", async () => {
  await fixture(async temporaryDirectory => {
    const fake = fakePodman({onRun: () => ({stdout: `ordinary note ${ANALYSIS_RESULT_PREFIX}not-a-result\n`,
      stderr: "script failed\n", exitCode: 7})});
    const result = await makeRunner(temporaryDirectory, fake).run(request);
    assert.equal(result.geojson, null);assert.equal(result.execution.exitCode, 7);
    assert.equal(result.stdout, `ordinary note ${ANALYSIS_RESULT_PREFIX}not-a-result\n`);
    assert.equal(result.stderr, "script failed\n");assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("the result protocol rejects duplicate lines, malformed JSON and non-GeoJSON values", async () => {
  await fixture(async temporaryDirectory => {
    for (const stdout of [resultLine(geojson) + resultLine(geojson), `${ANALYSIS_RESULT_PREFIX}{bad}\n`,
      resultLine({type: "FeatureCollection", features: "wrong"}), resultLine({type: "Feature", geometry: null})]) {
      const fake = fakePodman({onRun: () => ({stdout})});
      await assert.rejects(makeRunner(temporaryDirectory, fake).run(request), {code: "analysis_result_invalid"});
      assert.ok(fake.calls.some(call => call.args[0] === "rm"));assert.deepEqual(await readdir(temporaryDirectory), []);
    }
  });
});

test("combined diagnostics and GeoJSON have independent hard byte ceilings", async () => {
  await fixture(async temporaryDirectory => {
    for (const [output, code] of [
      [{stdout: "x".repeat(64 * 1024), stderr: "y".repeat(64 * 1024 + 1)}, "analysis_logs_too_large"],
      [{stdout: resultLine({type: "FeatureCollection", features: [], payload: "x".repeat(8 * 1024 * 1024)})}, "analysis_result_too_large"]
    ]) {
      const fake = fakePodman({onRun: () => output});
      await assert.rejects(makeRunner(temporaryDirectory, fake).run(request), {code});
      assert.ok(fake.calls.some(call => call.args[0] === "rm"));assert.deepEqual(await readdir(temporaryDirectory), []);
    }
  });
});

test("cancellation retains the one-job guard until exact container cleanup has closed", async () => {
  await fixture(async temporaryDirectory => {
    const fake = fakePodman({holdRun: true, holdCleanup: true}), runner = makeRunner(temporaryDirectory, fake);
    const controller = new AbortController();let settled = false;
    const pending = runner.run({...request, signal: controller.signal});
    const rejected = assert.rejects(pending, {code: "analysis_cancelled"}).then(() => {settled = true;});
    const run = await fake.runStarted;
    await assert.rejects(runner.run(request), {code: "analysis_busy"});
    controller.abort();
    const cleanup = await fake.cleanupStarted;
    assert.equal(settled, false);
    assert.deepEqual(cleanup.args, ["rm", "--force", "--ignore", "--time=0", containerName(run.args)]);
    await assert.rejects(runner.run(request), {code: "analysis_busy"});
    cleanup.child.emit("close", 0, null);await rejected;
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("already cancelled work never launches and timeout always removes its named container", async () => {
  await fixture(async temporaryDirectory => {
    const controller = new AbortController();controller.abort();
    const fake = fakePodman(), runner = makeRunner(temporaryDirectory, fake);
    await assert.rejects(runner.run({...request, signal: controller.signal}), {code: "analysis_cancelled"});
    assert.equal(fake.calls.length, 0);
    const hung = fakePodman({holdRun: true});
    const keepAlive = setInterval(() => {}, 1000);
    try {await assert.rejects(makeRunner(temporaryDirectory, hung, {timeoutSeconds: 1}).run(request), {code: "analysis_timeout"});}
    finally {clearInterval(keepAlive);}
    assert.equal(hung.calls.filter(call => call.args[0] === "rm").length, 1);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("cleanup failure is visible instead of reporting a successful isolated run", async () => {
  await fixture(async temporaryDirectory => {
    const fake = fakePodman({cleanupCode: 1}), runner = makeRunner(temporaryDirectory, fake);
    let cleanupFailure;
    await assert.rejects(runner.run(request), error => {
      assert.equal(error.code, "analysis_cleanup_failed");cleanupFailure = error;return true;
    });
    const callsAfterFailure = fake.calls.length;
    await assert.rejects(runner.run(request), {code: "analysis_cleanup_failed"});
    assert.equal(fake.calls.length, callsAfterFailure, "Failed cleanup quarantines this runner");
    assert.equal(runner.capabilities().cleanupRequired, true);
    assert.equal(cleanupFailure.containerName, containerName(fake.calls[0].args));
    assert.equal(cleanupFailure.stagingDirectory, join(temporaryDirectory, (await readdir(temporaryDirectory))[0]));
    assert.equal(await readFile(join(cleanupFailure.stagingDirectory, "input", "main.py"), "utf8"), request.code,
      "Retain the staged input while exact container removal remains uncertain");
  });
});

test("Run snapshots staged data and source pins before the caller can mutate its request", async () => {
  await fixture(async temporaryDirectory => {
    const submitted = structuredClone(request), before = structuredClone(submitted);
    let manifest, stagedData;
    const fake = fakePodman({async onRun(call) {
      const {root} = inputMount(call.args);
      manifest = JSON.parse(await readFile(join(root, "layers.json"), "utf8"));
      stagedData = JSON.parse(await readFile(join(root, "layers", "0.geojson"), "utf8"));
      return {};
    }});
    const pending = makeRunner(temporaryDirectory, fake).run(submitted);
    submitted.layers[0].sourcePin.sourceVersion = 99;
    submitted.layers[0].geojson.features[0].properties.name = "Changed after Run";
    submitted.code = "changed after Run";
    const result = await pending;
    assert.deepEqual(stagedData, before.layers[0].geojson);
    assert.deepEqual(manifest[0].sourcePin, before.layers[0].sourcePin);
    assert.equal(result.execution.codeSha256, sha256(before.code));
    assert.deepEqual(result.execution.inputSha256[0].sourcePin, manifest[0].sourcePin);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("the streaming result protocol preserves UTF-8 and prefixes split across process chunks", async () => {
  await fixture(async temporaryDirectory => {
    const output = structuredClone(geojson);output.features[0].properties.name = "Café";
    const fake = fakePodman({onRun(call) {
      const bytes = Buffer.from(`started café\n${resultLine(output)}finished\n`);
      for (let index = 0; index < bytes.length; index++) call.child.stdout.write(bytes.subarray(index, index + 1));
      return {};
    }});
    const result = await makeRunner(temporaryDirectory, fake).run(request);
    assert.equal(result.stdout, "started café\nfinished\n");assert.deepEqual(result.geojson, output);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});


test("a script failure cannot admit an otherwise valid GeoJSON result", async () => {
  await fixture(async temporaryDirectory => {
    const fake = fakePodman({onRun: () => ({stdout: `before failure\n${resultLine(geojson)}`,
      stderr: "analysis failed\n", exitCode: 7})});
    const result = await makeRunner(temporaryDirectory, fake).run(request);
    assert.equal(result.execution.exitCode, 7);assert.equal(result.geojson, null);
    assert.equal(result.stdout, "before failure\n");assert.equal(result.stderr, "analysis failed\n");
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("invalid UTF-8 diagnostics are rejected instead of expanding bytes through replacement", async () => {
  await fixture(async temporaryDirectory => {
    for (const output of [{stdout: Buffer.from([0xc3])}, {stderr: Buffer.from([0xff])}]) {
      const fake = fakePodman({onRun: () => output});
      await assert.rejects(makeRunner(temporaryDirectory, fake).run(request), {code: "analysis_logs_invalid"});
      assert.ok(fake.calls.some(call => call.args[0] === "rm"));
      assert.deepEqual(await readdir(temporaryDirectory), []);
    }
  });
});


test("shared isolation extraction preserves the complete existing publication argv", () => {
  const imageDigest = `sha256:${"d".repeat(64)}`;
  assert.deepEqual(podmanArguments({contract: "/tmp/job/contract", input: "/tmp/job/input",
    workspace: "/tmp/job/workspace", result: "/tmp/job/result", imageDigest,
    limits: {memoryMiB: 2048, cpuMillis: 1000}}), [
    "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=all",
    "--security-opt=no-new-privileges", "--ipc=private", "--pids-limit=128",
    "--memory=2048m", "--memory-swap=2048m", "--cpus=1.000", "--ulimit=nofile=1024:1024",
    "--userns=keep-id:uid=10001,gid=10001", "--user=10001:10001",
    "--volume=/tmp/job/contract:/contract:ro,Z", "--volume=/tmp/job/input:/input:ro,Z",
    "--volume=/tmp/job/workspace:/workspace:rw,Z", "--volume=/tmp/job/result:/result:rw,Z",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m", imageDigest
  ]);
});
