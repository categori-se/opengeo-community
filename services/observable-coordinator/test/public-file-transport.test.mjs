import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import {test} from "node:test";
import {readPublicExact} from "../src/public-file-transport.mjs";

const TIFF = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
const PIN = Object.freeze({url: "https://data.opengeo.tools/source.tif", contentType: "image/tiff",
  maximumBytes: TIFF.length, checksumSha256: createHash("sha256").update(TIFF).digest("hex")});

function childProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "opengeo-public-transport-test-"));
  try { await run(root); }
  finally { await rm(root, {recursive: true, force: true}); }
}

test("public bridge keeps credentials and source URL out of process arguments and rechecks exact bytes", async () => {
  await fixture(async temporaryDirectory => {
    let observed;
    const bytes = await readPublicExact(PIN, {temporaryDirectory, spawnProcess(command, args, options) {
      observed = {command, args, options};
      const child = childProcess(), request = [];
      child.stdin.on("data", chunk => request.push(chunk));
      child.stdin.on("finish", async () => {
        assert.deepEqual(JSON.parse(Buffer.concat(request)), {url: PIN.url, contentType: PIN.contentType,
          sizeBytes: PIN.maximumBytes, checksumSha256: PIN.checksumSha256});
        await writeFile(join(options.cwd, "response.bin"), TIFF);
        child.stdout.write(JSON.stringify({contentType: PIN.contentType, sizeBytes: TIFF.length,
          checksumSha256: PIN.checksumSha256}));
        child.emit("close", 0);
      });
      return child;
    }});
    assert.equal(observed.command, "/usr/bin/python3");
    assert.deepEqual(observed.args.slice(0, 2), ["-I", "-B"]);
    assert.match(observed.args[2], /\/src\/public-file-fetch\.py$/);
    assert.equal(observed.options.shell, false);
    assert.deepEqual(observed.options.env, {LANG: "C.UTF-8"});
    assert.deepEqual(bytes, {bytes: TIFF, contentType: PIN.contentType, sizeBytes: TIFF.length,
      checksumSha256: PIN.checksumSha256});
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("public bridge rejects wrong bytes even when helper metadata matches and removes staging", async () => {
  await fixture(async temporaryDirectory => {
    await assert.rejects(readPublicExact(PIN, {temporaryDirectory, spawnProcess(_command, _args, options) {
      const child = childProcess();
      child.stdin.on("finish", async () => {
        await writeFile(join(options.cwd, "response.bin"), Buffer.alloc(TIFF.length));
        child.stdout.write(JSON.stringify({contentType: PIN.contentType, sizeBytes: TIFF.length,
          checksumSha256: PIN.checksumSha256}));
        child.emit("close", 0);
      });
      return child;
    }}), {code: "public_file_integrity_failed"});
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("public bridge waits for aborted helper exit before removing staging", async () => {
  await fixture(async temporaryDirectory => {
    const controller = new AbortController();
    let child, childRoot, started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = readPublicExact({...PIN, signal: controller.signal}, {temporaryDirectory,
      spawnProcess(_command, _args, options) {
        child = childProcess(); childRoot = options.cwd;
        child.kill = signal => {assert.equal(signal, "SIGTERM"); started(); return true;};
        child.stdin.on("finish", () => controller.abort());
        return child;
      }});
    await ready;
    assert.deepEqual(await readdir(temporaryDirectory), [childRoot.split("/").at(-1)]);
    const rejected = assert.rejects(pending, {code: "public_file_cancelled", retryable: true});
    child.emit("close", null);
    await rejected;
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("public bridge rejects oversized helper output and sanitizes dependency diagnostics", async () => {
  await fixture(async temporaryDirectory => {
    await assert.rejects(readPublicExact(PIN, {temporaryDirectory, spawnProcess() {
      const child = childProcess();
      child.kill = () => {queueMicrotask(() => child.emit("close", null)); return true;};
      child.stdin.on("finish", () => {
        child.stderr.write("diagnostic-secret");
        child.stdout.write("x".repeat(4097));
      });
      return child;
    }}), {code: "public_file_response_invalid"});
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("public bridge propagates only bounded structured helper failures", async () => {
  await fixture(async temporaryDirectory => {
    for (const [reply, expected] of [
      [{code: "public_file_dns_resolution_failed", retryable: true},
        {code: "public_file_dns_resolution_failed", retryable: true}],
      [{code: "diagnostic-secret", retryable: true}, {code: "public_file_response_invalid", retryable: false}]
    ]) {
      await assert.rejects(readPublicExact(PIN, {temporaryDirectory, spawnProcess() {
        const child = childProcess();
        child.stdin.on("finish", () => {
          child.stdout.write(JSON.stringify(reply)); child.emit("close", 1);
        });
        return child;
      }}), expected);
    }
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});

test("public bridge rejects invalid or already cancelled requests before starting helper", async () => {
  const controller = new AbortController(); controller.abort();
  for (const [pin, code] of [
    [{...PIN, maximumBytes: 64 * 1024 * 1024 + 1}, "public_file_request_invalid"],
    [{...PIN, signal: controller.signal}, "public_file_cancelled"]
  ]) {
    await assert.rejects(readPublicExact(pin, {spawnProcess() {throw Error("must not spawn");}}), {code});
  }
});

test("public bridge uses the shared Python transport to deny unsafe targets without network access", async () => {
  await fixture(async temporaryDirectory => {
    await assert.rejects(readPublicExact({...PIN, url: "https://127.0.0.1/source.tif"}, {temporaryDirectory}),
      {code: "public_file_unsafe_network_target", retryable: false});
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});
