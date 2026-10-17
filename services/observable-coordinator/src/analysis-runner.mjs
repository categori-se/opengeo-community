import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join} from "node:path";
import {containerIsolationArguments} from "./podman-runner.mjs";

export const ANALYSIS_RESULT_PREFIX = "OPEN_GEO_GEOJSON:";
export const ANALYSIS_LIMITS = Object.freeze({maximumCodeBytes: 65536, maximumInputBytes: 16 * 1024 * 1024,
  maximumLogBytes: 128 * 1024, maximumResultBytes: 8 * 1024 * 1024, maximumLayers: 32,
  timeoutSeconds: 10, memoryMiB: 256, cpuMillis: 1000, pids: 32});
const LANGUAGES = Object.freeze({python: {extension: "py", paths: ["/usr/bin/python3", "/usr/local/bin/python3", "/var/lang/bin/python3.14"], args: ["-I", "-B"]},
  javascript: {extension: "mjs", paths: ["/usr/bin/node", "/usr/local/bin/node", "/nodejs/bin/node", "/var/lang/bin/node"], args: []},
  bash: {extension: "sh", paths: ["/bin/bash", "/usr/bin/bash"], args: ["--noprofile", "--norc"]}});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function failure(code) {const error = new Error(code);error.code = code;return error;}
function closed(value, keys, code = "analysis_request_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure(code);
}
function jsonBytes(value, maximum, code) {
  let text;
  try {text = JSON.stringify(value, (_key, item) => {if (typeof item === "number" && !Number.isFinite(item)) throw Error();return item;});}
  catch {throw failure(code);}
  if (typeof text !== "string" || Buffer.byteLength(text) > maximum) throw failure(code);
  return Buffer.from(text);
}
function validateGeojson(value, code) {
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features) || value.features.length > 50000) throw failure(code);
  let positions = 0;
  const position = point => {
    if (!Array.isArray(point) || point.length < 2 || point.length > 3 || !point.every(Number.isFinite)
      || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90 || ++positions > 1000000) throw failure(code);
  };
  const line = points => {if (!Array.isArray(points) || points.length < 2) throw failure(code);points.forEach(position);};
  const ring = points => {line(points);if (points.length < 4 || JSON.stringify(points[0]) !== JSON.stringify(points.at(-1))) throw failure(code);};
  const polygon = rings => {if (!Array.isArray(rings) || !rings.length) throw failure(code);rings.forEach(ring);};
  function geometry(item, depth = 0) {
    if (item === null) return;
    if (!item || depth > 8) throw failure(code);
    const c = item.coordinates;
    switch (item.type) {
      case "Point": position(c);break;
      case "MultiPoint": if (!Array.isArray(c)) throw failure(code);c.forEach(position);break;
      case "LineString": line(c);break;
      case "MultiLineString": if (!Array.isArray(c)) throw failure(code);c.forEach(line);break;
      case "Polygon": polygon(c);break;
      case "MultiPolygon": if (!Array.isArray(c)) throw failure(code);c.forEach(polygon);break;
      case "GeometryCollection": if (!Array.isArray(item.geometries)) throw failure(code);item.geometries.forEach(g => geometry(g, depth + 1));break;
      default: throw failure(code);
    }
  }
  for (const feature of value.features) {
    if (!feature || feature.type !== "Feature" || !Object.hasOwn(feature, "geometry")
      || feature.properties !== null && (!feature.properties || typeof feature.properties !== "object" || Array.isArray(feature.properties))
      || feature.id !== undefined && !["string", "number"].includes(typeof feature.id)) throw failure(code);
    geometry(feature.geometry);
  }
  return value;
}

/** Operator-local execution only. No API, session, credentials or publication authority. */
export class AnalysisRunner {
  constructor({enabled = false, profiles = {}, spawnProcess = spawn, temporaryDirectory = tmpdir(), timeoutSeconds = 10, memoryMiB = 256} = {}) {
    if (typeof enabled !== "boolean" || typeof spawnProcess !== "function" || !isAbsolute(temporaryDirectory)
      || /[:,\n\r]/.test(temporaryDirectory) || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30
      || ![256, 512].includes(memoryMiB)) throw failure("analysis_configuration_invalid");
    closed(profiles, Object.keys(LANGUAGES), "analysis_configuration_invalid");
    this.profiles = Object.create(null);
    for (const [language, profile] of Object.entries(profiles)) {
      closed(profile, ["image", "interpreter"], "analysis_configuration_invalid");
      if (!/^sha256:[0-9a-f]{64}$/.test(profile.image ?? "") || !LANGUAGES[language].paths.includes(profile.interpreter)) throw failure("analysis_configuration_invalid");
      this.profiles[language] = Object.freeze({...profile});
    }
    this.enabled = enabled;this.spawnProcess = spawnProcess;this.temporaryDirectory = temporaryDirectory;
    this.limits = Object.freeze({...ANALYSIS_LIMITS, timeoutSeconds, memoryMiB});this.busy = false;this.cleanupFailure = null;
  }

  capabilities() {
    return {schemaVersion: "opengeo.local-analysis-capabilities.1", mode: "local-isolated", enabled: this.enabled,
      languages: Object.keys(LANGUAGES).map(language => ({language, configured: Boolean(this.profiles[language]),
        ...(this.profiles[language] ? {runtimeImage: this.profiles[language].image, interpreter: this.profiles[language].interpreter} : {})})),
      limits: this.limits, resultPrefix: ANALYSIS_RESULT_PREFIX, inputManifestPath: "/input/layers.json",
      inputManifestFormat: "array-of-layer-file-references", network: "none", busy: this.busy,
      cleanupRequired: Boolean(this.cleanupFailure)};
  }

  async run(request) {
    if (!this.enabled) throw failure("analysis_disabled");
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.busy) throw failure("analysis_busy");
    closed(request, ["language", "code", "layers", "signal"]);
    const {language, code, layers, signal} = request;
    if (!Object.hasOwn(LANGUAGES, language ?? "")) throw failure("analysis_request_invalid");
    const profile = this.profiles[language];if (!profile) throw failure("analysis_profile_unavailable");
    if (typeof code !== "string" || !code.trim() || code.includes("\0")) throw failure("analysis_request_invalid");
    if (Buffer.byteLength(code) > this.limits.maximumCodeBytes) throw failure("analysis_script_too_large");
    if (!Array.isArray(layers) || layers.length > this.limits.maximumLayers || signal && (typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) throw failure("analysis_request_invalid");
    if (signal?.aborted) throw failure("analysis_cancelled");
    const seen = new Set(), staged = [], inputPins = [];let inputBytes = 0;
    for (const [index, layer] of layers.entries()) {
      closed(layer, ["id", "title", "geojson", "sourcePin"]);
      if (typeof layer.id !== "string" || !layer.id || layer.id.length > 200 || seen.has(layer.id)
        || typeof layer.title !== "string" || layer.title.length > 500) throw failure("analysis_request_invalid");
      seen.add(layer.id);
      const bytes = jsonBytes(layer.geojson, this.limits.maximumInputBytes, "analysis_input_too_large");
      validateGeojson(layer.geojson, "analysis_request_invalid");inputBytes += bytes.length;
      if (inputBytes > this.limits.maximumInputBytes) throw failure("analysis_input_too_large");
      const sourcePin = layer.sourcePin === undefined ? undefined : JSON.parse(jsonBytes(layer.sourcePin, 8192, "analysis_request_invalid"));
      staged.push({id: layer.id, title: layer.title, path: `/input/layers/${index}.geojson`, ...(sourcePin === undefined ? {} : {sourcePin}), bytes});
      inputPins.push({id: layer.id, checksumSha256: sha(bytes), ...(layer.sourcePin === undefined ? {} : {sourcePin: structuredClone(layer.sourcePin)})});
    }
    this.busy = true;
    const started = Date.now(), name = `opengeo-analysis-${randomUUID()}`;let root, spawned = false, result, executionError;
    try {
      root = await mkdtemp(join(this.temporaryDirectory, "opengeo-analysis-"));const input = join(root, "input");
      await mkdir(join(input, "layers"), {recursive: true, mode: 0o700});
      await writeFile(join(input, `main.${LANGUAGES[language].extension}`), code, {mode: 0o400});
      await writeFile(join(input, "layers.json"), JSON.stringify(staged.map(({bytes, ...item}) => item)), {mode: 0o400});
      for (const [index, item] of staged.entries()) await writeFile(join(input, "layers", `${index}.geojson`), item.bytes, {mode: 0o400});
      if (signal?.aborted) throw failure("analysis_cancelled");
      const args = ["run", "--rm", "--pull=never", `--name=${name}`, ...containerIsolationArguments(this.limits, {pids: 32, nofile: 256}),
        "--unsetenv-all", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=LANG=C.UTF-8", "--env=HOME=/workspace",
        "--env=TMPDIR=/tmp", "--workdir=/workspace", `--volume=${input}:/input:ro,Z`,
        "--tmpfs=/workspace:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--tmpfs=/output:rw,noexec,nosuid,nodev,size=9m,mode=1777",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        `--entrypoint=${profile.interpreter}`, profile.image, ...LANGUAGES[language].args, `/input/main.${LANGUAGES[language].extension}`];
      spawned = true;
      result = await execute(this.spawnProcess, args, {signal, timeoutSeconds: this.limits.timeoutSeconds});
    } catch (error) {executionError = error;}
    finally {
      let containerRemoved = !spawned;
      try {
        if (spawned) await removeContainer(this.spawnProcess, name);
        containerRemoved = true;
      } catch {
        executionError = this.cleanupFailure = failure("analysis_cleanup_failed");
        executionError.containerName = name;executionError.stagingDirectory = root;
      }
      try {if (root && containerRemoved) await rm(root, {recursive: true, force: true});}
      catch {executionError = this.cleanupFailure = failure("analysis_cleanup_failed");}
      this.busy = false;
    }
    if (executionError) throw executionError;
    return {stdout: result.stdout, stderr: result.stderr, geojson: result.geojson, execution: {language, runtimeImage: profile.image, interpreter: profile.interpreter,
      exitCode: result.exitCode, signal: result.signal, durationMs: Date.now() - started, codeSha256: sha(code), inputSha256: inputPins,
      limits: this.limits, cleanup: {containerRemoved: true, stagingRemoved: true}, network: "none"}};
  }
}

function hostEnvironment() {
  // Podman needs local rootless storage/session facts; none are forwarded to
  // the container. AWS/API/database/provider variables are never inherited.
  return Object.fromEntries(["HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

function execute(spawnProcess, args, {signal, timeoutSeconds}) {
  return new Promise((resolve, reject) => {
    let child, timer, killTimer, pendingError, lineLength = 0, logBytes = 0, stdoutLength = 0, stderrLength = 0, resultBytes;
    const prefix = Buffer.from(ANALYSIS_RESULT_PREFIX), line = Buffer.alloc(ANALYSIS_LIMITS.maximumResultBytes + prefix.length + 1),
      stdout = Buffer.alloc(ANALYSIS_LIMITS.maximumLogBytes), stderr = Buffer.alloc(ANALYSIS_LIMITS.maximumLogBytes);
    const isResult = () => lineLength >= prefix.length && line.subarray(0, prefix.length).equals(prefix);
    const possibleResult = () => line.subarray(0, Math.min(lineLength, prefix.length)).equals(prefix.subarray(0, Math.min(lineLength, prefix.length)));
    function stop(error) {
      if (pendingError) return;pendingError = error;child?.kill("SIGKILL");
      killTimer = setTimeout(() => finish(), 2000);killTimer.unref?.();
    }
    function completeLine(newline) {
      if (isResult()) {
        if (resultBytes !== undefined) throw failure("analysis_result_invalid");
        resultBytes = Buffer.from(line.subarray(prefix.length, lineLength));
      } else {
        const size = lineLength + Number(newline);
        if (logBytes + size > ANALYSIS_LIMITS.maximumLogBytes) throw failure("analysis_logs_too_large");
        line.copy(stdout, stdoutLength, 0, lineLength);stdoutLength += lineLength;
        if (newline) stdout[stdoutLength++] = 10;logBytes += size;
      }
      lineLength = 0;
    }
    function consume(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), stopAt = end < 0 ? chunk.length : end, size = stopAt - offset;
        if (lineLength + size > line.length) throw failure(possibleResult() ? "analysis_result_too_large" : "analysis_logs_too_large");
        chunk.copy(line, lineLength, offset, stopAt);lineLength += size;
        if (possibleResult()) {
          if (lineLength > prefix.length + ANALYSIS_LIMITS.maximumResultBytes) throw failure("analysis_result_too_large");
          if (isResult() && resultBytes !== undefined) throw failure("analysis_result_invalid");
        } else if (logBytes + lineLength > ANALYSIS_LIMITS.maximumLogBytes) throw failure("analysis_logs_too_large");
        if (end >= 0) completeLine(true);offset = stopAt + Number(end >= 0);
      }
    }
    let finished = false;
    function finish(code = null, exitSignal = null) {
      if (finished) return;finished = true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener("abort", abort);
      if (pendingError) {reject(pendingError);return;}
      try {
        if (lineLength) completeLine(false);
        let geojson = null;
        if (resultBytes !== undefined) {
          if (resultBytes.length > ANALYSIS_LIMITS.maximumResultBytes) throw failure("analysis_result_too_large");
          try {geojson = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(resultBytes));} catch {throw failure("analysis_result_invalid");}
          validateGeojson(geojson, "analysis_result_invalid");
        }
        let stdoutText, stderrText;
        try {
          const decoder = new TextDecoder("utf-8", {fatal: true});
          stdoutText = decoder.decode(stdout.subarray(0, stdoutLength));stderrText = decoder.decode(stderr.subarray(0, stderrLength));
        } catch {throw failure("analysis_logs_invalid");}
        // A failed process never hands a partial derived Layer to its caller.
        resolve({stdout: stdoutText, stderr: stderrText, geojson: code === 0 && exitSignal === null ? geojson : null, exitCode: code, signal: exitSignal});
      } catch (error) {reject(error);}
    }
    const abort = () => stop(failure("analysis_cancelled"));
    try {child = spawnProcess("podman", args, {shell: false, stdio: ["ignore", "pipe", "pipe"], env: hostEnvironment()});}
    catch {reject(failure("analysis_start_failed"));return;}
    child.stdout.on("data", chunk => {if (!pendingError) try {consume(Buffer.from(chunk));} catch (error) {stop(error);}});
    child.stderr.on("data", chunk => {
      if (pendingError) return;const bytes = Buffer.from(chunk);
      if (logBytes + bytes.length + (!possibleResult() ? lineLength : 0) > ANALYSIS_LIMITS.maximumLogBytes) {stop(failure("analysis_logs_too_large"));return;}
      bytes.copy(stderr, stderrLength);stderrLength += bytes.length;logBytes += bytes.length;
    });
    child.once("error", () => stop(failure("analysis_start_failed")));child.once("close", finish);
    timer = setTimeout(() => stop(failure("analysis_timeout")), timeoutSeconds * 1000);timer.unref?.();
    signal?.addEventListener("abort", abort, {once: true});if (signal?.aborted) abort();
  });
}

function removeContainer(spawnProcess, name) {
  return new Promise((resolve, reject) => {
    let child, finished = false;
    const timer = setTimeout(() => {child?.kill("SIGKILL");finish(false);}, 5000);timer.unref?.();
    function finish(ok) {if (finished) return;finished = true;clearTimeout(timer);ok ? resolve() : reject(failure("analysis_cleanup_failed"));}
    try {child = spawnProcess("podman", ["rm", "--force", "--ignore", "--time=0", name], {shell: false, stdio: ["ignore", "ignore", "ignore"], env: hostEnvironment()});}
    catch {finish(false);return;}
    child.once("error", () => finish(false));child.once("close", code => finish(code === 0));
  });
}
