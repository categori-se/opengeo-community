import {spawn} from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve, sep} from "node:path";
import {readPageCacheResult, stagePageCache} from "./page-cache-transport.mjs";
import {
  CoordinatorContractError,
  REQUIRED_SANDBOX,
  maximumOutputFileBytes,
  sha256
} from "./contracts.mjs";

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const INPUT_PATH =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const REPORT_LIMIT_BYTES = 256 * 1024;

export class PodmanRunner {
  constructor({command = "podman", temporaryDirectory = tmpdir(), imageRepository} = {}) {
    if (command !== "podman" || typeof temporaryDirectory !== "string") {
      throw new CoordinatorContractError("runner_configuration_invalid");
    }
    this.command = command;
    this.temporaryDirectory = temporaryDirectory;
    if (imageRepository !== undefined && imageRepository !==
        "977060200223.dkr.ecr.us-east-1.amazonaws.com/opengeo/production/observable-builder") {
      throw new CoordinatorContractError("runner_image_repository_invalid");
    }
    this.imageRepository = imageRepository;
  }

  async run({invocation, inputs, limits, signal, incrementalPageCache}) {
    if (!IMAGE_DIGEST.test(invocation?.request?.compilerImageDigest ?? "")) {
      throw new CoordinatorContractError("runner_image_invalid");
    }
    const root = await mkdtemp(join(this.temporaryDirectory, "opengeo-observable-runner-"));
    try {
      const incrementalPages = incrementalPageCache !== undefined && /\.md$/i.test(invocation.entryPath ?? '');
      const paths = await stage(root, invocation, inputs, incrementalPages ? incrementalPageCache : undefined);
      const args = podmanArguments({
        ...paths,
        imageDigest: invocation.request.compilerImageDigest,
        imageRepository: this.imageRepository,
        incrementalPages,
        limits
      });
      await execute(this.command, args, {
        signal,
        timeoutMilliseconds: limits.timeoutSeconds * 1000 + 5_000
      });
      const report = await readReport(paths.report);
      const outputs = await readOutputTree(paths.output, limits, invocation);
      const pageCache = incrementalPages ? await readPageCacheResult(join(paths.workspace, "job")) : null;
      return {report, outputs, sandbox: structuredClone(REQUIRED_SANDBOX),
        ...(pageCache ? {incrementalPageCache: pageCache} : {})};
    } finally {
      await makeDirectoriesRemovable(root);
      await rm(root, {recursive: true, force: true});
    }
  }
}

export function podmanArguments({contract, input, workspace, result, imageDigest, imageRepository, limits, incrementalPages = false}) {
  if (!IMAGE_DIGEST.test(imageDigest)) {
    throw new CoordinatorContractError("runner_image_invalid");
  }
  return [
    "run",
    "--rm",
    "--pull=never",
    ...containerIsolationArguments(limits),
    `--volume=${contract}:/contract:ro,Z`,
    `--volume=${input}:/input:ro,Z`,
    `--volume=${workspace}:/workspace:rw,Z`,
    `--volume=${result}:/result:rw,Z`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
    imageRepository ? `${imageRepository}@${imageDigest}` : imageDigest,
    ...(incrementalPages ? [
      "--contract", "/contract/invocation.json", "--input", "/input",
      "--workspace", "/workspace/job", "--report", "/result/compiler-report.json",
      "--page-cache", "/contract/page-cache"
    ] : [])
  ];
}

// Shared process isolation only; publication mounts, image and entrypoint stay
// owned by podmanArguments. Its default argument sequence is unchanged.
export function containerIsolationArguments(limits, {pids = 128, nofile = 1024} = {}) {
  return ["--network=none", "--read-only", "--cap-drop=all",
    "--security-opt=no-new-privileges", "--ipc=private", `--pids-limit=${pids}`,
    `--memory=${limits.memoryMiB}m`, `--memory-swap=${limits.memoryMiB}m`,
    `--cpus=${(limits.cpuMillis / 1000).toFixed(3)}`, `--ulimit=nofile=${nofile}:${nofile}`,
    "--userns=keep-id:uid=10001,gid=10001", "--user=10001:10001"];
}

async function stage(root, invocation, inputs, incrementalPageCache) {
  const artifactFiles = (invocation?.artifactInputs?.artifacts ?? []).map(pin => ({
    path: pin.path, contentType: pin.output.mediaType,
    sizeBytes: pin.output.sizeBytes, checksumSha256: pin.output.checksumSha256
  }));
  const files = [...(invocation?.files ?? []), ...(invocation?.dataFiles ?? []), ...artifactFiles];
  if (!(inputs instanceof Map) || !Array.isArray(invocation?.files) || inputs.size !== files.length) {
    throw new CoordinatorContractError("runner_input_invalid");
  }
  const contract = join(root, "contract");
  const input = join(root, "input");
  const workspace = join(root, "workspace");
  const result = join(root, "result");
  for (const path of [contract, input, workspace, result]) await mkdir(path, {mode: 0o700});
  for (const file of files) {
    const bytes = inputs.get(file.path);
    if (
      typeof file.path !== "string" ||
      !INPUT_PATH.test(file.path) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length !== file.sizeBytes ||
      sha256(bytes) !== file.checksumSha256
    ) {
      throw new CoordinatorContractError("runner_input_invalid");
    }
    const target = resolve(input, file.path);
    if (!target.startsWith(`${resolve(input)}${sep}`)) {
      throw new CoordinatorContractError("runner_input_invalid");
    }
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await writeFile(target, bytes, {flag: "wx", mode: 0o400});
  }
  const invocationPath = join(contract, "invocation.json");
  await writeFile(invocationPath, `${JSON.stringify(invocation)}\n`, {flag: "wx", mode: 0o400});
  if (incrementalPageCache !== undefined) await stagePageCache(contract, incrementalPageCache);
  await makeDirectoriesReadOnly(input);
  await makeDirectoriesReadOnly(contract);
  return {
    contract,
    input,
    workspace,
    result,
    report: join(result, "compiler-report.json"),
    output: join(workspace, "job", "dist")
  };
}

async function makeDirectoriesReadOnly(root) {
  const entries = await readdir(root, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    await makeDirectoriesReadOnly(path);
    await chmod(path, 0o500);
  }
  await chmod(root, 0o500);
}

async function makeDirectoriesRemovable(root) {
  try {
    const entries = await readdir(root, {withFileTypes: true});
    await chmod(root, 0o700);
    for (const entry of entries) {
      if (entry.isDirectory()) await makeDirectoriesRemovable(join(root, entry.name));
    }
  } catch {
    // The following recursive removal remains the authoritative cleanup and
    // reports any material failure.
  }
}

async function readReport(path) {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.size < 2 || facts.size > REPORT_LIMIT_BYTES) {
    throw new CoordinatorContractError("runner_report_invalid");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new CoordinatorContractError("runner_report_invalid");
  }
}

export async function readOutputTree(root, limits, invocation) {
  const outputs = new Map();
  let totalBytes = 0;
  async function visit(directory, depth) {
    if (depth > 9) throw new CoordinatorContractError("runner_output_tree_invalid");
    const entries = (await readdir(directory, {withFileTypes: true}))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile()) {
        const facts = await lstat(path);
        const pathFromRoot = relative(root, path).split(sep).join("/");
        const localized = invocation.request.schemaVersion === "opengeo.observable-build-request.4.0.0"
          && invocation.request.outputRepresentation === "single-html";
        if (localized && pathFromRoot !== "index.html") throw new CoordinatorContractError("runner_output_tree_invalid");
        const ceiling = localized && invocation.request.outputProfile === "archive-96m"
          && invocation.request.sizeAcknowledgment === "allow-up-to-96-mib-output" ? 96 * 1024 * 1024
          : invocation.request.schemaVersion === "opengeo.observable-build-request.3.0.0"
          && invocation.request.outputProfile === "archive-96m" ? 64 * 1024 * 1024
          : Boolean(invocation.dataFiles) ? 32 * 1024 * 1024 : 16 * 1024 * 1024;
        if (facts.size < 1 || facts.size > Math.min(ceiling, limits.maxOutputBytes)) {
          throw new CoordinatorContractError("runner_output_tree_invalid");
        }
        const bytes = await readFile(path);
        totalBytes += bytes.length;
        if (
          bytes.length < 1 ||
          bytes.length > maximumOutputFileBytes({path: `dist/${pathFromRoot}`, sizeBytes: bytes.length, checksumSha256: sha256(bytes)},
            invocation.request, invocation.dataFiles ?? [], Boolean(invocation.dataFiles)) ||
          outputs.size + 1 > limits.maxOutputFiles ||
          totalBytes > limits.maxOutputBytes
        ) {
          throw new CoordinatorContractError("runner_output_tree_invalid");
        }
        outputs.set(`dist/${pathFromRoot}`, bytes);
      } else {
        throw new CoordinatorContractError("runner_output_tree_invalid");
      }
    }
  }
  try {
    const facts = await lstat(root);
    if (!facts.isDirectory()) throw new CoordinatorContractError("runner_output_tree_invalid");
    await visit(root, 1);
  } catch (error) {
    if (error instanceof CoordinatorContractError) throw error;
    throw new CoordinatorContractError("runner_output_tree_invalid");
  }
  return new Map([...outputs].sort(([left], [right]) => left.localeCompare(right)));
}

function execute(command, args, {signal, timeoutMilliseconds}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new CoordinatorContractError("runner_cancelled"));
      return;
    }
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let settled = false;
    let outputBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const capture = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new CoordinatorContractError("runner_process_output_too_large"));
      }
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new CoordinatorContractError("runner_cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CoordinatorContractError("runner_timeout"));
    }, timeoutMilliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", abort, {once: true});
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => finish(new CoordinatorContractError("runner_start_failed", {retryable: true})));
    child.once("exit", (code, exitSignal) => {
      if (code !== 0 || exitSignal !== null) {
        finish(new CoordinatorContractError("runner_container_failed"));
      } else {
        finish();
      }
    });
  });
}
