import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat, mkdtemp, open, rm} from "node:fs/promises";
import {constants} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {CoordinatorContractError} from "./contracts.mjs";

const HELPER = fileURLToPath(new URL("./public-file-fetch.py", import.meta.url));
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_REPLY_BYTES = 4096;
const TIMEOUT_MILLISECONDS = 125_000;
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^public_file_[a-z0-9_]{1,80}$/;

// The optional execution adapter is trusted host/test configuration. Source,
// request and queue data can select neither a program nor an import path.
export async function readPublicExact({url, contentType, maximumBytes, checksumSha256, signal}, {
  temporaryDirectory = tmpdir(), spawnProcess = spawn
} = {}) {
  if (typeof url !== "string" || url.length < 1 || url.length > 2048
    || !["image/tiff", "image/geotiff"].includes(contentType)
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAXIMUM_FILE_BYTES
    || typeof checksumSha256 !== "string" || !SHA256.test(checksumSha256)) {
    throw new CoordinatorContractError("public_file_request_invalid");
  }
  const requestBody = JSON.stringify({url, contentType, sizeBytes: maximumBytes, checksumSha256});
  if (Buffer.byteLength(requestBody) > MAXIMUM_REPLY_BYTES) {
    throw new CoordinatorContractError("public_file_request_invalid");
  }
  if (signal?.aborted) throw new CoordinatorContractError("public_file_cancelled", {retryable: true});
  const root = await mkdtemp(join(temporaryDirectory, "opengeo-public-file-"));
  try {
    const reply = await fetchFile({requestBody, signal, root, spawnProcess});
    if (signal?.aborted) throw new CoordinatorContractError("public_file_cancelled", {retryable: true});
    if (!reply || typeof reply !== "object" || Array.isArray(reply)
      || Object.keys(reply).sort().join(",") !== "checksumSha256,contentType,sizeBytes"
      || reply.contentType !== contentType || reply.sizeBytes !== maximumBytes
      || reply.checksumSha256 !== checksumSha256) {
      throw new CoordinatorContractError("public_file_response_invalid");
    }
    const path = join(root, "response.bin");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size !== maximumBytes) {
      throw new CoordinatorContractError("public_file_integrity_failed");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const facts = await file.stat();
      if (!facts.isFile() || facts.size !== maximumBytes) {
        throw new CoordinatorContractError("public_file_integrity_failed");
      }
      bytes = Buffer.alloc(maximumBytes);
      let offset = 0;
      while (offset < maximumBytes) {
        if (signal?.aborted) throw new CoordinatorContractError("public_file_cancelled", {retryable: true});
        const {bytesRead} = await file.read(bytes, offset, Math.min(64 * 1024, maximumBytes - offset), offset);
        if (bytesRead === 0) throw new CoordinatorContractError("public_file_integrity_failed");
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await file.read(extra, 0, 1, offset)).bytesRead !== 0
        || createHash("sha256").update(bytes).digest("hex") !== checksumSha256) {
        throw new CoordinatorContractError("public_file_integrity_failed");
      }
    } finally {
      await file.close();
    }
    if (signal?.aborted) throw new CoordinatorContractError("public_file_cancelled", {retryable: true});
    return {bytes, contentType, sizeBytes: bytes.length, checksumSha256};
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function fetchFile({requestBody, signal, root, spawnProcess}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/python3", ["-I", "-B", HELPER], {
      cwd: root, env: {LANG: "C.UTF-8"}, shell: false, stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks = [];
    let replyBytes = 0;
    let diagnosticBytes = 0;
    let failure;
    let killTimer;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    const cancelled = () => stop(new CoordinatorContractError("public_file_cancelled", {retryable: true}));
    const timeout = setTimeout(() => stop(new CoordinatorContractError("public_file_timeout", {retryable: true})), TIMEOUT_MILLISECONDS);
    timeout.unref?.();
    signal?.addEventListener("abort", cancelled, {once: true});
    child.stdout.on("data", (chunk) => {
      replyBytes += chunk.length;
      if (replyBytes > MAXIMUM_REPLY_BYTES) stop(new CoordinatorContractError("public_file_response_invalid"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > MAXIMUM_REPLY_BYTES) stop(new CoordinatorContractError("public_file_response_invalid"));
    });
    child.on("error", () => stop(new CoordinatorContractError("public_file_transport_unavailable", {retryable: true})));
    child.stdin.on("error", () => stop(new CoordinatorContractError("public_file_transport_unavailable", {retryable: true})));
    child.stdout.on("error", () => stop(new CoordinatorContractError("public_file_transport_unavailable", {retryable: true})));
    child.stderr.on("error", () => stop(new CoordinatorContractError("public_file_transport_unavailable", {retryable: true})));
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancelled);
      if (failure) return reject(failure);
      let reply;
      try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reject(new CoordinatorContractError("public_file_response_invalid")); }
      if (code !== 0) {
        const valid = reply && typeof reply === "object" && !Array.isArray(reply)
          && Object.keys(reply).sort().join(",") === "code,retryable"
          && ERROR_CODE.test(reply.code ?? "") && typeof reply.retryable === "boolean";
        return reject(new CoordinatorContractError(valid ? reply.code : "public_file_response_invalid",
          {retryable: valid && reply.retryable}));
      }
      return resolve(reply);
    });
    if (signal?.aborted) cancelled();
    else child.stdin.end(requestBody);
  });
}
